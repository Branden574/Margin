import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash, generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import type { CustomFetch } from 'openid-client';
import {
  createIdentityService,
  identityLookupKey,
  type IdentityConfig,
  type IdentityRepository,
  type NewSession,
  type ProvisionedIdentity,
  type SessionPrincipal,
  type SessionSummary,
} from '../apps/api/src/identity/index';
import { tokenHash } from '../apps/api/src/identity/crypto';
import { createApi } from '../apps/api/src/server';
import { request as httpsRequest } from 'node:https';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const issuer = 'https://issuer.margin.test/realm';
const origin = 'https://workspace.margin.test';
const userId = '10000000-0000-4000-8000-000000000001';
const organizationId = '20000000-0000-4000-8000-000000000001';
const base: IdentityConfig = {
  issuerUrl: issuer,
  applicationOrigin: origin,
  redirectUri: `${origin}/api/auth/callback`,
  clientId: 'synthetic-bff',
  clientSecret: 'synthetic-test-client-secret',
  sessionSecret: Buffer.alloc(32, 11),
  identityHmacKey: Buffer.alloc(32, 12),
  mfaAcrValues: ['urn:margin:test:mfa'],
};
let keys: ReturnType<typeof generateKeyPairSync>;
let tlsDirectory: string;
let tls: { key: Buffer; cert: Buffer };
beforeAll(async () => {
  keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
  tlsDirectory = mkdtempSync(join(tmpdir(), 'margin-identity-https-'));
  const helper = new URL('../scripts/local-tls.mjs', import.meta.url);
  const { ensureLocalTls } = await import(helper.href);
  const pair = ensureLocalTls(join(tlsDirectory, 'tls'));
  tls = { key: readFileSync(pair.keyPath), cert: readFileSync(pair.certPath) };
});
afterAll(() => {
  if (tlsDirectory) rmSync(tlsDirectory, { recursive: true, force: true });
});
class TestRepository implements IdentityRepository {
  attempts = new Map<string, { expiresAt: number; consumed: boolean }>();
  sessions = new Map<string, NewSession & { revoked?: boolean }>();
  provisioned: ProvisionedIdentity | null = {
    userId,
    memberships: [{ organizationId, role: 'student' }],
  };
  lookup?: string;
  async reserveLogin(hash: string, expiresAt: number) {
    this.attempts.set(hash, { expiresAt, consumed: false });
  }
  async consumeLogin(hash: string, now: number) {
    const value = this.attempts.get(hash);
    if (!value || value.consumed || value.expiresAt <= now) return false;
    value.consumed = true;
    return true;
  }
  async findIdentity(key: string) {
    this.lookup = key;
    return this.provisioned;
  }
  async createSession(session: NewSession, previous?: string) {
    if (previous) await this.revokeSession(previous, 0);
    this.sessions.set(session.sessionHash, session);
  }
  async authenticate(hash: string, now: number): Promise<SessionPrincipal | null> {
    const session = this.sessions.get(hash);
    if (!session || session.revoked || session.expiresAt <= now || session.idleExpiresAt <= now)
      return null;
    const { sessionHash: _, idleExpiresAt: __, ...principal } = session;
    return principal;
  }
  async revokeSession(hash: string, _now: number) {
    const session = this.sessions.get(hash);
    if (session) session.revoked = true;
  }
  async listSessions(hash: string, now: number): Promise<SessionSummary[]> {
    const current = await this.authenticate(hash, now);
    if (!current) return [];
    return [...this.sessions.values()]
      .filter((s) => s.userId === current.userId && !s.revoked)
      .map((s) => ({ ...s, current: s.sessionId === current.sessionId }));
  }
  async revokeOwnedSession(hash: string, id: string, now: number) {
    const current = await this.authenticate(hash, now);
    const target = [...this.sessions.values()].find(
      (s) => s.sessionId === id && s.userId === current?.userId,
    );
    if (!target) return false;
    target.revoked = true;
    return true;
  }
}
function testIssuer() {
  let authorization: URL;
  let nonceOverride: string | undefined;
  let audienceOverride: string | undefined;
  let corruptSignature = false;
  let tokenRequests = 0;
  let jwksRequests = 0;
  let metadataOverride: Record<string, unknown> = {};
  const json = (value: unknown) =>
    new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
  const transport: CustomFetch = async (url, init) => {
    if (url === `${issuer}/.well-known/openid-configuration`)
      return json({
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        jwks_uri: `${issuer}/jwks`,
        response_types_supported: ['code'],
        subject_types_supported: ['public'],
        id_token_signing_alg_values_supported: ['RS256'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['client_secret_basic'],
        ...metadataOverride,
      });
    if (url === `${issuer}/jwks`) {
      jwksRequests++;
      return json({
        keys: [
          {
            ...keys.publicKey.export({ format: 'jwk' }),
            kid: 'synthetic-key',
            alg: 'RS256',
            use: 'sig',
          },
        ],
      });
    }
    if (url === `${issuer}/token`) {
      tokenRequests++;
      const body = new URLSearchParams(String(init.body));
      expect(body.get('grant_type')).toBe('authorization_code');
      expect(body.get('redirect_uri')).toBe(base.redirectUri);
      expect(createHash('sha256').update(body.get('code_verifier')!).digest('base64url')).toBe(
        authorization.searchParams.get('code_challenge'),
      );
      expect(new Headers(init.headers).get('authorization')).toMatch(/^Basic /);
      const now = Math.floor(Date.now() / 1000);
      const head = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'synthetic-key' })).toString(
        'base64url',
      );
      const payload = Buffer.from(
        JSON.stringify({
          iss: issuer,
          sub: 'synthetic-student-subject',
          aud: audienceOverride ?? base.clientId,
          exp: now + 600,
          iat: now,
          auth_time: now,
          nonce: nonceOverride ?? authorization.searchParams.get('nonce'),
          acr: 'urn:margin:test:mfa',
        }),
      ).toString('base64url');
      const signature = sign('RSA-SHA256', Buffer.from(`${head}.${payload}`), keys.privateKey);
      if (corruptSignature) signature[0] ^= 1;
      return json({
        access_token: 'synthetic-access-token-never-persist',
        refresh_token: 'synthetic-refresh-never-persist',
        token_type: 'Bearer',
        expires_in: 600,
        id_token: `${head}.${payload}.${signature.toString('base64url')}`,
      });
    }
    throw new Error(`Unexpected test issuer path: ${url}`);
  };
  return {
    transport,
    setAuthorization: (url: string) => (authorization = new URL(url)),
    setNonce: (value: string) => (nonceOverride = value),
    setAudience: (value: string) => (audienceOverride = value),
    corrupt: () => (corruptSignature = true),
    setMetadata: (value: Record<string, unknown>) => (metadataOverride = value),
    counts: () => ({ tokenRequests, jwksRequests }),
  };
}
async function harness(
  config: Partial<IdentityConfig> = {},
  authorizeLmsSession?: (principal: SessionPrincipal) => Promise<boolean>,
) {
  const repository = new TestRepository();
  const provider = testIssuer();
  const service = await createIdentityService(
    { ...base, ...config },
    repository,
    {
      testFetch: provider.transport,
    },
    authorizeLmsSession ? { authorizeLmsSession } : undefined,
  );
  const begin = async () => {
    const login = await service.startLogin();
    provider.setAuthorization(login.location);
    const state = new URL(login.location).searchParams.get('state');
    return {
      login,
      callback: new URL(`${base.redirectUri}?code=synthetic-code&state=${state}`),
      cookie: login.cookies[0].split(';')[0],
    };
  };
  const login = async (previous?: string) => {
    const flow = await begin();
    const result = await service.completeLogin(
      flow.callback,
      `${flow.cookie}${previous ? `; ${previous}` : ''}`,
    );
    return { ...result, cookie: result.cookies[0].split(';')[0] };
  };
  return { repository, provider, service, begin, login };
}
describe('real OIDC protocol with an explicitly synthetic test issuer', () => {
  it('denies LMS issuance unless a live enrollment guard is configured and rejects privileged roles', async () => {
    const unconfigured = await harness();
    await expect(
      unconfigured.service.issueLmsSession(
        { userId, organizationId, role: 'student' },
        { headers: {} },
      ),
    ).rejects.toMatchObject({ code: 'lms_unavailable' });
    const configured = await harness({}, async () => true);
    await expect(
      configured.service.issueLmsSession(
        { userId, organizationId, role: 'owner' as 'student' },
        { headers: {} },
      ),
    ).rejects.toMatchObject({ code: 'lms_membership_required' });
    expect(configured.repository.sessions.size).toBe(0);
  });
  it('requires the LMS binding on every use while retaining opaque cookies, CSRF and session revocation', async () => {
    let permitted = false;
    let guardCalls = 0;
    const h = await harness({}, async (principal) => {
      guardCalls++;
      expect(principal.authenticationMethod).toBe('lti');
      return permitted;
    });
    const issued = await h.service.issueLmsSession(
      { userId, organizationId, role: 'student' },
      { headers: {} },
    );
    expect(issued.cookies[0]).toContain('Secure; HttpOnly; SameSite=Lax');
    expect(issued.principal.mfa).toBe(false);
    const request = { headers: { cookie: issued.cookies[0].split(';')[0], origin } };
    await expect(h.service.authenticateRequest(request)).rejects.toMatchObject({
      code: 'lms_access_revoked',
    });
    permitted = true;
    const authenticated = await h.service.authenticateRequest(request);
    expect(authenticated.principal.sessionId).toBe(issued.principal.sessionId);
    expect(() => h.service.verifyCsrf(request, authenticated)).toThrow();
    h.service.verifyCsrf(
      { headers: { ...request.headers, 'x-csrf-token': authenticated.csrfToken } },
      authenticated,
    );
    permitted = false;
    await expect(h.service.authenticateRequest(request)).rejects.toMatchObject({
      code: 'lms_access_revoked',
    });
    expect(guardCalls).toBe(3);
    // Ordinary OIDC sessions retain their own policy without depending on LMS availability.
    const oidc = await h.login();
    await expect(
      h.service.authenticateRequest({ headers: { cookie: oidc.cookie, origin } }),
    ).resolves.toMatchObject({ principal: { authenticationMethod: 'oidc' } });
    expect(guardCalls).toBe(3);
  });
  it('uses PKCE/state/nonce, verifies signed tokens, stores only session hashes, and rotates sessions on login', async () => {
    const h = await harness();
    const first = await h.login();
    expect(first.cookies[0]).toContain('__Host-margin-session=');
    expect(first.cookies[0]).toContain('Secure; HttpOnly; SameSite=Lax');
    expect(first.cookies[1]).toContain('Max-Age=0');
    expect(h.provider.counts()).toEqual({ tokenRequests: 1, jwksRequests: 1 });
    expect(h.repository.lookup).toBe(
      identityLookupKey(base.identityHmacKey, issuer, 'synthetic-student-subject'),
    );
    const raw = first.cookie.split('=')[1];
    expect(h.repository.sessions.has(tokenHash(raw))).toBe(true);
    expect(JSON.stringify([...h.repository.sessions.values()])).not.toContain(raw);
    expect(JSON.stringify([...h.repository.sessions.values()])).not.toContain('synthetic-access');
    const auth = await h.service.authenticateRequest({ headers: { cookie: first.cookie } });
    expect(auth.principal.userId).toBe(userId);
    expect(auth.principal.organizationId).toBe(organizationId);
    const second = await h.login(first.cookie);
    expect(second.cookie).not.toBe(first.cookie);
    await expect(
      h.service.authenticateRequest({ headers: { cookie: first.cookie } }),
    ).rejects.toMatchObject({ code: 'session_expired' });
  });
  it('enforces same-origin CSRF, revokes logout immediately, and does not trust body/header identities', async () => {
    const h = await harness();
    const login = await h.login();
    const request = { headers: { cookie: login.cookie, origin } };
    const auth = await h.service.authenticateRequest(request);
    expect(() => h.service.verifyCsrf(request, auth)).toThrow('verified');
    expect(() =>
      h.service.verifyCsrf(
        {
          headers: {
            ...request.headers,
            origin: 'https://evil.test',
            'x-csrf-token': auth.csrfToken,
          },
        },
        auth,
      ),
    ).toThrow('workspace');
    const cookies = await h.service.logoutRequest({
      headers: { ...request.headers, 'x-csrf-token': auth.csrfToken, 'x-user-id': randomUUID() },
    });
    expect(cookies.every((value) => value.includes('Max-Age=0'))).toBe(true);
    await expect(h.service.authenticateRequest(request)).rejects.toMatchObject({ status: 401 });
  });
  it('rejects callback state substitution and replay before exchanging a code', async () => {
    const h = await harness();
    const flow = await h.begin();
    const wrong = new URL(flow.callback);
    wrong.searchParams.set('state', 'attacker');
    await expect(h.service.completeLogin(wrong, flow.cookie)).rejects.toMatchObject({
      code: 'invalid_login',
    });
    expect(h.provider.counts().tokenRequests).toBe(0);
    await h.service.completeLogin(flow.callback, flow.cookie);
    await expect(h.service.completeLogin(flow.callback, flow.cookie)).rejects.toMatchObject({
      code: 'login_used',
    });
    expect(h.provider.counts().tokenRequests).toBe(1);
  });
  it.each(['nonce', 'audience', 'signature'] as const)(
    'rejects a token with invalid %s',
    async (kind) => {
      const h = await harness();
      if (kind === 'nonce') h.provider.setNonce('wrong-nonce');
      if (kind === 'audience') h.provider.setAudience('other-client');
      if (kind === 'signature') h.provider.corrupt();
      await expect(h.login()).rejects.toMatchObject({ code: 'oidc_verification_failed' });
      expect(h.repository.sessions.size).toBe(0);
    },
  );
  it('denies unprovisioned users, forged organization selection and privileged sessions without configured MFA', async () => {
    const h = await harness();
    h.repository.provisioned = null;
    await expect(h.login()).rejects.toMatchObject({ code: 'membership_required' });
    h.repository.provisioned = { userId, memberships: [{ organizationId, role: 'student' }] };
    const flow = await h.service.startLogin({ organizationId: randomUUID() });
    h.provider.setAuthorization(flow.location);
    await expect(
      h.service.completeLogin(
        new URL(
          `${base.redirectUri}?code=c&state=${new URL(flow.location).searchParams.get('state')}`,
        ),
        flow.cookies[0].split(';')[0],
      ),
    ).rejects.toMatchObject({ code: 'organization_required' });
    const noMfa = await harness({ mfaAcrValues: [] });
    noMfa.repository.provisioned!.memberships[0].role = 'owner';
    await expect(noMfa.login()).rejects.toMatchObject({ code: 'mfa_required' });
    h.repository.provisioned.memberships[0].role = 'owner';
    expect((await h.login()).principal.mfa).toBe(true);
  });
  it('rejects insecure configuration, provider endpoint substitution, duplicate cookies and open redirects', async () => {
    const h = await harness();
    await expect(h.service.startLogin({ returnTo: 'https://evil.test' })).rejects.toMatchObject({
      code: 'invalid_return_path',
    });
    await expect(
      createIdentityService({ ...base, issuerUrl: 'http://issuer.test' }, h.repository),
    ).rejects.toThrow('HTTPS');
    await expect(
      createIdentityService({ ...base, identityHmacKey: base.sessionSecret }, h.repository),
    ).rejects.toThrow('independent keys');
    const bad = testIssuer();
    bad.setMetadata({ token_endpoint: 'https://unapproved.test/token' });
    await expect(
      createIdentityService(base, h.repository, { testFetch: bad.transport }),
    ).rejects.toThrow('unapproved');
    const login = await h.login();
    await expect(
      h.service.authenticateRequest({ headers: { cookie: `${login.cookie}; ${login.cookie}` } }),
    ).rejects.toMatchObject({ code: 'invalid_cookie' });
    expect(identityLookupKey(base.identityHmacKey, 'a', 'bc')).not.toBe(
      identityLookupKey(base.identityHmacKey, 'ab', 'c'),
    );
  });
  it('rejects modified encrypted login cookies and expired one-use receipts', async () => {
    const h = await harness();
    const flow = await h.begin();
    const modified = flow.cookie.slice(0, -5) + 'AAAAA';
    await expect(h.service.completeLogin(flow.callback, modified)).rejects.toMatchObject({
      code: 'invalid_login',
    });
    for (const attempt of h.repository.attempts.values()) attempt.expiresAt = 0;
    await expect(h.service.completeLogin(flow.callback, flow.cookie)).rejects.toMatchObject({
      code: 'login_used',
    });
  });
  it('protects the actual HTTPS upload API with OIDC cookies, CSRF and same-organization owner isolation', async () => {
    const h = await harness({}, async () => true);
    const documentId = randomUUID();
    let appended = 0;
    const server = createApi({
      identityService: h.service,
      syncService: {
        async append(principal, input: any) {
          expect(principal.userId).toBe(userId);
          expect(principal.organizationId).toBe(organizationId);
          appended++;
          return {
            operationId: input.operationId,
            cursor: 1,
            annotationRevision: 1,
            duplicate: false,
          };
        },
        async describeDocument() {
          return {
            documentId,
            versionId: randomUUID(),
            cursor: 0,
            permission: 'owner',
            audience: 'members',
            pages: [],
          };
        },
        async catchUp(_principal, input) {
          return {
            documentId,
            versionId: randomUUID(),
            operations: [],
            nextCursor: input.afterCursor ?? 0,
            hasMore: false,
            currentCursor: 0,
          };
        },
      },
      dataDirectory: join(tlsDirectory, 'api-data'),
      keyEncryptionKey: Buffer.alloc(32, 22),
      tls,
      logger: () => {},
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    const request = (
      path: string,
      method = 'GET',
      headers: Record<string, string> = {},
      body?: unknown,
    ) =>
      new Promise<{ status: number; headers: import('node:http').IncomingHttpHeaders; body: any }>(
        (resolve, reject) => {
          const serialized = body === undefined ? undefined : JSON.stringify(body);
          const req = httpsRequest(
            {
              hostname: '127.0.0.1',
              port,
              path,
              method,
              ca: tls.cert,
              rejectUnauthorized: true,
              minVersion: 'TLSv1.2',
              headers: {
                ...headers,
                ...(serialized
                  ? {
                      'content-type': 'application/json',
                      'content-length': String(Buffer.byteLength(serialized)),
                    }
                  : {}),
              },
            },
            (res) => {
              const chunks: Buffer[] = [];
              res.on('data', (chunk) => chunks.push(chunk));
              res.on('end', () => {
                const text = Buffer.concat(chunks).toString('utf8');
                resolve({
                  status: res.statusCode!,
                  headers: res.headers,
                  body: text ? JSON.parse(text) : null,
                });
              });
            },
          );
          req.on('error', reject);
          req.end(serialized);
        },
      );
    try {
      expect((await request('/api/documents')).status).toBe(401);
      const begin = await request('/api/auth/login');
      expect(begin.status).toBe(302);
      h.provider.setAuthorization(begin.headers.location!);
      const loginCookie = begin.headers['set-cookie']![0].split(';')[0];
      const state = new URL(begin.headers.location!).searchParams.get('state');
      const callback = await request(
        `/api/auth/callback?code=synthetic-code&state=${state}`,
        'GET',
        { cookie: loginCookie },
      );
      expect(callback.status).toBe(302);
      const sessionCookie = callback.headers['set-cookie']![0].split(';')[0];
      const auth = await request('/api/auth/session', 'GET', { cookie: sessionCookie });
      expect(auth.status).toBe(200);
      expect(auth.headers['cache-control']).toBe('no-store');
      const input = {
        filename: 'synthetic.pdf',
        mimeType: 'application/pdf',
        totalSize: 64,
        chunkSize: 262144,
      };
      expect(
        (await request('/api/uploads', 'POST', { cookie: sessionCookie, origin }, input)).status,
      ).toBe(403);
      const ownerHeaders = { cookie: sessionCookie, origin, 'x-csrf-token': auth.body.csrfToken };
      const syncPath = `/api/sync/documents/${documentId}/operations`;
      const operation = { documentId, operationId: randomUUID() };
      expect(
        (await request(syncPath, 'POST', { cookie: sessionCookie, origin }, operation)).status,
      ).toBe(403);
      expect(appended).toBe(0);
      expect((await request(syncPath, 'POST', ownerHeaders, operation)).body).toMatchObject({
        cursor: 1,
        operationId: operation.operationId,
      });
      expect(appended).toBe(1);
      expect(
        (await request(syncPath, 'POST', ownerHeaders, { ...operation, documentId: randomUUID() }))
          .status,
      ).toBe(400);
      expect(
        (await request(`${syncPath}?afterCursor=0&afterCursor=1`, 'GET', ownerHeaders)).status,
      ).toBe(400);
      expect((await request(`${syncPath}?afterCursor=-1`, 'GET', ownerHeaders)).status).toBe(400);
      expect(
        (await request(`${syncPath}?afterCursor=0&limit=50`, 'GET', ownerHeaders)).status,
      ).toBe(200);
      expect(
        (
          await request(syncPath, 'POST', ownerHeaders, {
            ...operation,
            padding: 'x'.repeat(66000),
          })
        ).status,
      ).toBe(413);
      expect(appended).toBe(1);
      const lti = await h.service.issueLmsSession(
        { userId, organizationId, role: 'student' },
        { headers: {} },
      );
      const ltiCookie = lti.cookies[0].split(';')[0];
      expect((await request('/api/auth/session', 'GET', { cookie: ltiCookie })).status).toBe(200);
      expect((await request(syncPath, 'GET', { cookie: ltiCookie })).body.error.code).toBe(
        'lms_resource_scope_required',
      );
      expect((await request('/api/documents', 'GET', { cookie: ltiCookie })).status).toBe(403);
      const upload = await request('/api/uploads', 'POST', ownerHeaders, input);
      expect(upload.status).toBe(201);
      h.repository.provisioned = {
        userId: randomUUID(),
        memberships: [{ organizationId, role: 'student' }],
      };
      const peer = await h.login();
      const peerAuth = await h.service.authenticateRequest({ headers: { cookie: peer.cookie } });
      expect(
        (await request(`/api/uploads/${upload.body.id}`, 'GET', { cookie: peer.cookie })).status,
      ).toBe(404);
      expect(
        (
          await request(`/api/uploads/${upload.body.id}`, 'DELETE', {
            cookie: peer.cookie,
            origin,
            'x-csrf-token': peerAuth.csrfToken,
          })
        ).status,
      ).toBe(404);
      expect((await request('/api/auth/logout', 'POST', ownerHeaders)).status).toBe(200);
      expect((await request('/api/documents', 'GET', { cookie: sessionCookie })).status).toBe(401);
      expect((await request('/api/health')).body.authentication).toBe('oidc-session');
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
});
