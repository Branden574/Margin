import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import { request as httpsRequest } from 'node:https';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  createLtiIdentityService,
  type IdentityFederation,
  type IdentityRepository,
  type LtiIdentityConfig,
  type NewSession,
  type SessionPrincipal,
} from '../apps/api/src/identity/index';
import { tokenHash } from '../apps/api/src/identity/crypto';
import { createApi } from '../apps/api/src/server';

const origin = 'https://workspace.margin.test';
const userId = randomUUID(),
  organizationId = randomUUID();
const config = (): LtiIdentityConfig => ({
  applicationOrigin: origin,
  sessionSecret: randomBytes(32),
  identityHmacKey: randomBytes(32),
  sessionMaxAgeSeconds: 900,
  idleTimeoutSeconds: 120,
  allowedReturnPaths: ['/canvas/work', '/canvas/review'],
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
async function harness(input = config()) {
  const sessions = new Map<string, NewSession>();
  const repository = {
    reserveLogin: vi.fn(async (_hash: string, _expiresAt: number) => {}),
    consumeLogin: vi.fn(async (_hash: string, _now: number) => false),
    findIdentity: vi.fn(async (_key: string) => null),
    createSession: vi.fn(async (session: NewSession, previous?: string) => {
      if (previous) sessions.delete(previous);
      sessions.set(session.sessionHash, session);
    }),
    authenticate: vi.fn(async (hash: string, now: number) => {
      const saved = sessions.get(hash);
      if (!saved || saved.expiresAt <= now || saved.idleExpiresAt <= now) return null;
      const { sessionHash: _, idleExpiresAt: __, ...principal } = saved;
      return principal;
    }),
    revokeSession: vi.fn(async (hash: string, _now: number) => {
      sessions.delete(hash);
    }),
    listSessions: vi.fn(async (hash: string, _now: number) => {
      const current = sessions.get(hash);
      return [...sessions.values()]
        .filter((s) => s.userId === current?.userId)
        .map((s) => ({
          sessionId: s.sessionId,
          organizationId: s.organizationId,
          createdAt: s.createdAt,
          expiresAt: s.expiresAt,
          lastSeenAt: s.lastSeenAt,
          current: s.sessionHash === hash,
        }));
    }),
    revokeOwnedSession: vi.fn(async (hash: string, targetId: string, _now: number) => {
      const current = sessions.get(hash);
      for (const [key, value] of sessions) {
        if (value.userId === current?.userId && value.sessionId === targetId) {
          sessions.delete(key);
          return true;
        }
      }
      return false;
    }),
  } satisfies IdentityRepository;
  const authorizeLmsSession = vi.fn(async (_principal: SessionPrincipal) => true);
  const service = await createLtiIdentityService(input, repository, { authorizeLmsSession });
  const issue = async (previous?: string) => {
    const issued = await service.issueLmsSession(
      { userId, organizationId, role: 'student' },
      { headers: { cookie: previous } },
    );
    const cookie = issued.cookies[0].split(';')[0];
    return {
      ...issued,
      cookie,
      hash: tokenHash(cookie.split('=')[1]),
      request: { headers: { cookie, origin } },
    };
  };
  return { service, repository, sessions, authorizeLmsSession, issue };
}

describe('explicit LTI-session-only identity', () => {
  it('starts without OIDC credentials or provider requests outside test mode', async () => {
    const fetch = vi.fn(async () => {
      throw new Error('Unexpected identity provider I/O');
    });
    vi.stubGlobal('fetch', fetch);
    vi.stubEnv('NODE_ENV', 'production');
    const { service, repository } = await harness();
    expect(service.applicationOrigin).toBe(origin);
    expect(service.authenticationMode).toBe('lti-only');
    expect(service.callbackPath).toBe('/api/auth/callback');
    await expect(service.startLogin()).rejects.toMatchObject({
      status: 503,
      code: 'oidc_unconfigured',
    });
    await expect(
      service.completeLogin(new URL(origin + '/api/auth/callback?code=unused&state=unused')),
    ).rejects.toMatchObject({ status: 503, code: 'oidc_unconfigured' });
    expect(fetch).not.toHaveBeenCalled();
    for (const method of ['reserveLogin', 'consumeLogin', 'findIdentity', 'createSession'] as const)
      expect(repository[method]).not.toHaveBeenCalled();
  });
  it('requires the persisted LMS authorizer at construction', async () => {
    const { repository } = await harness();
    for (const bad of [undefined, {}, { authorizeLmsSession: true }])
      await expect(
        createLtiIdentityService(config(), repository, bad as unknown as IdentityFederation),
      ).rejects.toThrow('current LMS session authorizer');
  });
  it.each([
    { applicationOrigin: 'http://workspace.margin.test' },
    { applicationOrigin: origin + '/' },
    { applicationOrigin: origin + '/workspace' },
    { allowedReturnPaths: ['//outside.test'] },
    { sessionMaxAgeSeconds: 1 },
    { idleTimeoutSeconds: 1000 },
    { sessionSecret: Buffer.alloc(31) },
    { identityHmacKey: Buffer.alloc(33) },
  ])('rejects unsafe session configuration %j', async (overrides) => {
    await expect(harness({ ...config(), ...overrides })).rejects.toBeInstanceOf(Error);
  });
  it('retains independent secrets and verified-TLS requirements', async () => {
    const input = config();
    input.identityHmacKey = input.sessionSecret;
    await expect(harness(input)).rejects.toThrow('independent');
    vi.stubEnv('NODE_TLS_REJECT_UNAUTHORIZED', '0');
    await expect(harness()).rejects.toThrow('TLS certificate verification');
  });
  it('issues only LTI sessions with secure cookies and rotates an earlier session', async () => {
    const { service, repository, issue, authorizeLmsSession } = await harness();
    const first = await issue();
    const second = await issue(first.cookie);
    expect(second.principal).toMatchObject({
      authenticationMethod: 'lti',
      role: 'student',
      mfa: false,
    });
    expect(second.principal.expiresAt - second.principal.createdAt).toBe(900000);
    expect(second.cookies[0]).toMatch(/; Path=\/; Secure; HttpOnly; SameSite=Lax; Max-Age=900$/);
    expect(repository.createSession.mock.calls[1][1]).toBe(first.hash);
    await expect(service.authenticateRequest(first.request)).rejects.toMatchObject({
      code: 'session_expired',
    });
    const authenticated = await service.authenticateRequest(second.request);
    expect(authenticated.principal.sessionId).toBe(second.principal.sessionId);
    expect(authenticated.csrfToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(authorizeLmsSession).toHaveBeenCalledWith(second.principal);
  });
  it.each(['oidc', undefined] as const)(
    'refuses existing %s sessions without LMS authorization',
    async (method) => {
      const { service, sessions, issue, authorizeLmsSession } = await harness();
      const issued = await issue();
      sessions.get(issued.hash)!.authenticationMethod = method;
      await expect(service.authenticateRequest(issued.request)).rejects.toMatchObject({
        code: 'lti_session_required',
      });
      await expect(service.listSessions(issued.request)).rejects.toMatchObject({
        code: 'lti_session_required',
      });
      expect(authorizeLmsSession).not.toHaveBeenCalled();
    },
  );
  it('does not issue or accept privileged LTI roles even with a supplied MFA flag', async () => {
    const { service, sessions, issue, repository } = await harness();
    await expect(
      service.issueLmsSession(
        { userId, organizationId, role: 'owner' as 'student' },
        { headers: {} },
      ),
    ).rejects.toMatchObject({ code: 'lms_membership_required' });
    expect(repository.createSession).not.toHaveBeenCalled();
    const issued = await issue();
    Object.assign(sessions.get(issued.hash)!, { role: 'owner', mfa: true });
    await expect(service.authenticateRequest(issued.request)).rejects.toMatchObject({
      code: 'lti_session_required',
    });
  });
  it('reauthorizes each session operation and refuses current enrollment revocation', async () => {
    const { service, authorizeLmsSession, repository, issue } = await harness();
    const issued = await issue();
    await service.authenticateRequest(issued.request);
    await service.listSessions(issued.request);
    expect(authorizeLmsSession).toHaveBeenCalledTimes(2);
    authorizeLmsSession.mockResolvedValue(false);
    await expect(service.authenticateRequest(issued.request)).rejects.toMatchObject({
      code: 'lms_access_revoked',
    });
    await expect(service.listSessions(issued.request)).rejects.toMatchObject({
      code: 'lms_access_revoked',
    });
    await expect(service.logoutRequest(issued.request)).rejects.toMatchObject({
      code: 'lms_access_revoked',
    });
    expect(repository.listSessions).toHaveBeenCalledTimes(1);
    expect(repository.revokeSession).not.toHaveBeenCalled();
  });
  it('preserves same-origin and header-CSRF enforcement for logout and owned-session revocation', async () => {
    const { service, repository, issue } = await harness();
    const current = await issue(),
      other = await issue();
    const authenticated = await service.authenticateRequest(current.request);
    const mutation = {
      headers: { ...current.request.headers, 'x-csrf-token': authenticated.csrfToken },
    };
    await expect(service.logoutRequest(current.request)).rejects.toMatchObject({
      code: 'csrf_rejected',
    });
    await expect(
      service.logoutRequest({ headers: { ...mutation.headers, origin: 'https://outside.test' } }),
    ).rejects.toMatchObject({ code: 'origin_rejected' });
    await expect(
      service.revokeOwnedSession(current.request, other.principal.sessionId),
    ).rejects.toMatchObject({ code: 'csrf_rejected' });
    expect(repository.revokeOwnedSession).not.toHaveBeenCalled();
    expect(await service.revokeOwnedSession(mutation, other.principal.sessionId)).toBe(true);
    await expect(service.authenticateRequest(other.request)).rejects.toMatchObject({
      code: 'session_expired',
    });
    const cleared = await service.logoutRequest(mutation);
    expect(cleared).toHaveLength(2);
    expect(cleared.every((cookie) => cookie.includes('Max-Age=0'))).toBe(true);
    await expect(service.authenticateRequest(current.request)).rejects.toMatchObject({
      code: 'session_expired',
    });
  });
  it('serves real HTTPS session/logout routes while keeping both OIDC routes unavailable', async () => {
    const { service, issue, repository } = await harness();
    const directory = mkdtempSync(join(tmpdir(), 'margin-lti-only-'));
    const { ensureLocalTls } = await import(
      new URL('../scripts/local-tls.mjs', import.meta.url).href
    );
    const pair = ensureLocalTls(join(directory, 'tls'));
    const certificate = readFileSync(pair.certPath);
    const server = createApi({
      identityService: service,
      dataDirectory: join(directory, 'data'),
      keyEncryptionKey: randomBytes(32),
      tls: { key: readFileSync(pair.keyPath), cert: certificate },
      logger: () => {},
    });
    try {
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const port = (server.address() as { port: number }).port;
      const request = (path: string, headers: Record<string, string> = {}, method = 'GET') =>
        new Promise<{
          status: number;
          headers: import('node:http').IncomingHttpHeaders;
          json: any;
        }>((resolve, reject) => {
          const req = httpsRequest(
            {
              hostname: '127.0.0.1',
              port,
              path,
              method,
              headers,
              ca: certificate,
              rejectUnauthorized: true,
              minVersion: 'TLSv1.2',
            },
            (res) => {
              const chunks: Buffer[] = [];
              res.on('data', (chunk) => chunks.push(chunk));
              res.on('end', () =>
                resolve({
                  status: res.statusCode!,
                  headers: res.headers,
                  json: JSON.parse(Buffer.concat(chunks).toString('utf8')),
                }),
              );
            },
          );
          req.on('error', reject);
          req.end();
        });
      const health = await request('/api/health');
      expect(health.status).toBe(200);
      expect(health.json).toMatchObject({
        authentication: 'lti-session',
        scanningConfigured: false,
      });
      for (const path of ['/api/auth/login', '/api/auth/callback?code=unused&state=unused']) {
        const result = await request(path);
        expect(result.status).toBe(503);
        expect(result.json.error.code).toBe('oidc_unconfigured');
        expect(result.headers.location).toBeUndefined();
        expect(result.headers['cache-control']).toBe('no-store');
        expect(
          result.headers['set-cookie']?.some((value) => value.startsWith('__Host-margin-session=')),
        ).toBeFalsy();
      }
      expect(repository.reserveLogin).not.toHaveBeenCalled();
      expect(repository.consumeLogin).not.toHaveBeenCalled();
      const issued = await issue();
      const session = await request('/api/auth/session', { cookie: issued.cookie });
      expect(session.status).toBe(200);
      expect(session.json).toMatchObject({ authenticationMethod: 'lti', authenticated: true });
      expect(
        (await request('/api/auth/logout', { cookie: issued.cookie, origin }, 'POST')).status,
      ).toBe(403);
      expect(
        (
          await request(
            '/api/auth/logout',
            { cookie: issued.cookie, origin, 'x-csrf-token': session.json.csrfToken },
            'POST',
          )
        ).status,
      ).toBe(200);
      expect((await request('/api/auth/session', { cookie: issued.cookie })).status).toBe(401);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
