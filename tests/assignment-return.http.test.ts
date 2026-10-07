import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request as httpsRequest, type Server } from 'node:https';
import type { IncomingHttpHeaders } from 'node:http';
import { Configuration } from 'openid-client';
import { createApi } from '../apps/api/src/server';
import { IdentityService, SESSION_COOKIE } from '../apps/api/src/identity/service';
import { tokenHash, createCookieCrypto } from '../apps/api/src/identity/crypto';
import type { IdentityRepository, SessionPrincipal } from '../apps/api/src/identity/types';
import type { LmsService } from '../apps/api/src/lms';
import { AssignmentError, deepLinkForm } from '../apps/api/src/assignments';
import type { CanvasAssignmentService } from '../apps/api/src/assignment-routes';

// Real TLS, identity, origin, body parsing and CSRF composition; synthetic assignment service.
// This fixture does not contact Canvas or establish signed-LTI/production-provider interoperability.
const origin = 'https://workspace.margin.test';
const token = randomBytes(32).toString('base64url');
const sessionSecret = randomBytes(32);
const csrf = createCookieCrypto(sessionSecret, origin).csrf(token);
const selectionId = randomUUID(),
  selectedId = randomUUID();
const path = `/api/assignments/selections/${selectionId}/return`;
const principal: SessionPrincipal = {
  sessionId: randomUUID(),
  userId: randomUUID(),
  organizationId: randomUUID(),
  authenticationMethod: 'lti',
  role: 'teacher',
  mfa: false,
  createdAt: Date.now(),
  lastSeenAt: Date.now(),
  expiresAt: Date.now() + 3600000,
};
let revoked = false,
  federationActive = true;
const returned = deepLinkForm({
  returnUrl: 'https://school.test.instructure.com/return?course=synthetic',
  JWT: 'e30.e30.Zg',
});
const complete = vi.fn(async () => returned);
const assignments: CanvasAssignmentService = {
  completeDeepLink: complete,
  create: vi.fn(),
  currentSelection: vi.fn(),
  currentAssignment: vi.fn(),
  reserveStudentWork: vi.fn(),
};
let directory: string, server: Server, base: string, certificate: Buffer, identity: IdentityService;
const logs: Record<string, unknown>[] = [];
beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), 'margin-selection-return-'));
  const { ensureLocalTls } = await import(
    new URL('../scripts/local-tls.mjs', import.meta.url).href
  );
  const pair = ensureLocalTls(join(directory, 'tls'));
  certificate = readFileSync(pair.certPath);
  const repository: IdentityRepository = {
    reserveLogin: async () => {},
    consumeLogin: async () => false,
    findIdentity: async () => null,
    createSession: async () => {},
    authenticate: async (hash) => (!revoked && hash === tokenHash(token) ? { ...principal } : null),
    revokeSession: async () => {},
    listSessions: async () => [],
    revokeOwnedSession: async () => false,
  };
  identity = new IdentityService(
    {
      issuerUrl: 'https://issuer.margin.test',
      clientId: 'synthetic-client',
      clientSecret: 'synthetic-secret',
      applicationOrigin: origin,
      redirectUri: origin + '/api/auth/callback',
      sessionSecret,
      identityHmacKey: randomBytes(32),
    },
    repository,
    new Configuration({ issuer: 'https://issuer.margin.test' }, 'synthetic-client'),
    {
      authorizeLmsSession: async () => federationActive,
    },
  );
  server = createApi({
    dataDirectory: join(directory, 'data'),
    identityService: identity,
    lmsService: { applicationOrigin: origin } as LmsService,
    assignmentService: assignments,
    keyEncryptionKey: randomBytes(32),
    tls: { key: readFileSync(pair.keyPath), cert: certificate },
    logger: (entry) => logs.push(entry),
  }) as Server;
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `https://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(async () => {
  if (server)
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  if (directory) rmSync(directory, { recursive: true, force: true });
});
beforeEach(() => {
  revoked = false;
  federationActive = true;
  principal.role = 'teacher';
  principal.authenticationMethod = 'lti';
  vi.restoreAllMocks();
  complete.mockReset().mockResolvedValue(returned);
  logs.length = 0;
});
const form = (assignment: string = selectedId, supplied: string = csrf) =>
  new URLSearchParams({ csrfToken: supplied, assignmentId: assignment }).toString();
type Reply = { status: number; headers: IncomingHttpHeaders; body: string };
function request(
  target = path,
  options: {
    method?: string;
    body?: string | Buffer;
    headers?: Record<string, string | undefined>;
  } = {},
): Promise<Reply> {
  const body = options.body ?? form();
  return new Promise((resolve, reject) => {
    const headers = {
      cookie: `${SESSION_COOKIE}=${token}`,
      origin,
      'content-type': 'application/x-www-form-urlencoded',
      'content-length': String(Buffer.byteLength(body)),
      ...options.headers,
    };
    const req = httpsRequest(
      base + target,
      {
        method: options.method ?? 'POST',
        ca: certificate,
        rejectUnauthorized: true,
        headers: Object.fromEntries(
          Object.entries(headers).filter(([, value]) => value !== undefined),
        ),
      },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => (text += chunk));
        res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body: text }));
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}
function streaming(
  bodyLength: number,
  onResponse: (reply: Reply) => void,
  onError: (error: Error) => void,
) {
  const req = httpsRequest(
    base + path,
    {
      method: 'POST',
      ca: certificate,
      rejectUnauthorized: true,
      headers: {
        cookie: `${SESSION_COOKIE}=${token}`,
        origin,
        'content-type': 'application/x-www-form-urlencoded',
        'content-length': bodyLength,
      },
    },
    (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () => onResponse({ status: res.statusCode!, headers: res.headers, body }));
    },
  );
  req.on('error', onError);
  return req;
}

describe('native Canvas Deep Linking return', () => {
  it('returns the actual signed document and all of its security headers without a custom CSRF header', async () => {
    const reply = await request();
    expect(reply.status).toBe(200);
    expect(reply.body).toBe(returned.html);
    for (const [key, value] of Object.entries(returned.headers))
      expect(reply.headers[key.toLowerCase()]).toBe(value);
    expect(reply.headers['content-security-policy']).toContain(
      'form-action https://school.test.instructure.com',
    );
    expect(reply.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(reply.headers['content-security-policy']).not.toContain('sandbox');
    expect(reply.body).toContain('name="JWT"');
    expect(complete).toHaveBeenCalledExactlyOnceWith(principal, selectionId, selectedId);
  });
  it('supports explicit cancellation and normalizes valid UUIDs', async () => {
    expect((await request(path, { body: form('') })).status).toBe(200);
    expect(complete).toHaveBeenLastCalledWith(principal, selectionId, null);
    expect(
      (
        await request(
          path
            .toUpperCase()
            .replace('/API/ASSIGNMENTS/SELECTIONS/', '/api/assignments/selections/')
            .replace('/RETURN', '/return'),
          { body: form(selectedId.toUpperCase()) },
        )
      ).status,
    ).toBe(200);
    expect(complete).toHaveBeenLastCalledWith(principal, selectionId, selectedId);
  });
  it('authenticates before inspecting malformed bodies and rejects revoked/federation/role scope', async () => {
    expect(
      (await request(path, { body: 'not-a-form', headers: { cookie: undefined } })).status,
    ).toBe(401);
    revoked = true;
    expect((await request()).status).toBe(401);
    revoked = false;
    federationActive = false;
    expect((await request()).status).toBe(403);
    federationActive = true;
    for (const role of ['student', 'viewer'] as const) {
      principal.role = role;
      expect((await request()).status).toBe(403);
    }
    principal.role = 'teacher';
    principal.authenticationMethod = 'oidc';
    expect((await request()).status).toBe(403);
    expect(complete).not.toHaveBeenCalled();
  });
  it('requires trusted Origin and the body CSRF even if a valid header token is supplied', async () => {
    for (const headers of [
      { origin: undefined },
      { origin: 'https://attacker.test' },
      { 'sec-fetch-site': 'cross-site' },
    ])
      expect((await request(path, { headers })).status).toBe(403);
    for (const supplied of ['', 'wrong', 'x'.repeat(43)])
      expect(
        (
          await request(path, {
            body: form(selectedId, supplied),
            headers: { 'x-csrf-token': csrf },
          })
        ).status,
      ).toBe(403);
    expect(complete).not.toHaveBeenCalled();
  });
  it('verifies copied headers without changing the original request or logging tokens/HTML', async () => {
    const originalHeader = 'synthetic-original-header';
    const auth = vi.spyOn(identity, 'authenticateRequest');
    const verify = vi.spyOn(identity, 'verifyCsrf');
    expect((await request(path, { headers: { 'x-csrf-token': originalHeader } })).status).toBe(200);
    expect(auth).toHaveBeenCalledTimes(2);
    for (const [input] of auth.mock.calls)
      expect(input.headers['x-csrf-token']).toBe(originalHeader);
    for (const [input] of verify.mock.calls) {
      expect(input.headers['x-csrf-token']).toBe(csrf);
      expect(input.headers).not.toBe(auth.mock.calls[0][0].headers);
      expect(input.headers.origin).toBe(origin);
    }
    const logged = JSON.stringify(logs);
    for (const privateValue of [csrf, token, returned.html, 'e30.e30.Zg', originalHeader])
      expect(logged).not.toContain(privateValue);
  });
  it.each([
    'csrfToken=x',
    'assignmentId=',
    'csrfToken=x&csrfToken=y',
    `csrfToken=${csrf}&assignmentId=${selectedId}&assignmentId=`,
    `csrfToken=${csrf}&returnUrl=https%3A%2F%2Fattacker.test`,
    `csrfToken=${csrf}&assignmentId=not-a-uuid`,
    `csrfToken=${csrf}&assignmentId=%`,
    `csrfToken=${csrf}&assignmentId=%C0%AF`,
    `csrfToken=${csrf}&assignmentId=&`,
    `csrfToken=${csrf}&%61ssignmentId=&extra=1`,
    Buffer.from([0xc0, 0xaf]),
  ])(
    'rejects malformed/duplicate/extra form data before completing selection (%#)',
    async (body) => {
      expect((await request(path, { body })).status).toBe(400);
      expect(complete).not.toHaveBeenCalled();
    },
  );
  it('keeps JSON header-CSRF unchanged and refuses content types, encodings, queries and methods', async () => {
    const jsonPath = path.replace('/return', '/complete');
    expect(
      (
        await request(jsonPath, {
          body: JSON.stringify({ assignmentId: selectedId }),
          headers: { 'content-type': 'application/json' },
        })
      ).status,
    ).toBe(403);
    expect(
      (await request(jsonPath, { body: form(), headers: { 'x-csrf-token': csrf } })).status,
    ).toBe(415);
    for (const headers of [
      { 'content-type': 'application/json' },
      { 'content-type': 'text/plain' },
      { 'content-type': 'application/x-www-form-urlencoded; charset=iso-8859-1' },
      { 'content-encoding': 'gzip' },
    ])
      expect((await request(path, { headers })).status).toBe(415);
    expect((await request(path + '?assignmentId=' + selectedId)).status).toBe(400);
    for (const method of ['GET', 'PUT', 'DELETE']) {
      const reply = await request(path, { method });
      expect(reply.status).toBe(405);
      expect(reply.headers.allow).toBe('POST');
    }
    expect(complete).not.toHaveBeenCalled();
    expect(
      (
        await request(jsonPath, {
          body: JSON.stringify({ assignmentId: selectedId }),
          headers: { 'content-type': 'application/json', 'x-csrf-token': csrf },
        })
      ).status,
    ).toBe(200);
  });
  it('bounds declared and chunked forms before calling the service', async () => {
    for (const headers of [{}, { 'content-length': undefined, 'transfer-encoding': 'chunked' }])
      expect((await request(path, { body: 'x'.repeat(1025), headers })).status).toBe(413);
    expect(complete).not.toHaveBeenCalled();
  });
  it('rechecks revocation after a delayed form body before completing the selection', async () => {
    let authenticated!: () => void;
    const initial = new Promise<void>((resolve) => (authenticated = resolve));
    const original = identity.authenticateRequest.bind(identity);
    vi.spyOn(identity, 'authenticateRequest').mockImplementationOnce(async (req) => {
      const result = await original(req);
      authenticated();
      return result;
    });
    const body = form();
    const result = new Promise<Reply>((resolve, reject) => {
      const req = streaming(Buffer.byteLength(body), resolve, reject);
      req.write(body.slice(0, 10));
      void initial.then(() => {
        revoked = true;
        req.end(body.slice(10));
      });
    });
    expect((await result).status).toBe(401);
    expect(complete).not.toHaveBeenCalled();
  });
  it('rejects an interrupted form before completing the selection', async () => {
    const interrupted = new Promise<void>((resolve) =>
      server.once('request', (req) => req.once('aborted', resolve)),
    );
    let requestSeen!: () => void;
    const seen = new Promise<void>((resolve) => (requestSeen = resolve));
    server.once('request', requestSeen);
    const req = streaming(
      100,
      () => {},
      () => {},
    );
    req.write('csrfToken=');
    await seen;
    req.destroy();
    await interrupted;
    expect(complete).not.toHaveBeenCalled();
    expect((await request()).status).toBe(200);
  });
  it('withholds a signed response if the connection closes during one-use completion', async () => {
    let entered!: () => void, release!: (value: typeof returned) => void;
    const completing = new Promise<void>((resolve) => (entered = resolve));
    const result = new Promise<typeof returned>((resolve) => (release = resolve));
    complete.mockImplementationOnce(() => {
      entered();
      return result;
    });
    let ended: ReturnType<typeof vi.spyOn> | undefined;
    const closed = new Promise<void>((resolve) =>
      server.once('request', (_req, res) => {
        ended = vi.spyOn(res, 'end');
        res.once('close', resolve);
      }),
    );
    const body = form();
    const req = streaming(
      Buffer.byteLength(body),
      () => {},
      () => {},
    );
    try {
      req.end(body);
      await completing;
      req.destroy();
      await closed;
      release(returned);
      await vi.waitFor(() => expect(ended).toHaveBeenCalled());
      expect(complete).toHaveBeenCalledExactlyOnceWith(principal, selectionId, selectedId);
      expect(JSON.stringify(ended!.mock.calls)).not.toContain('name=\\"JWT\\"');
      expect(JSON.stringify(ended!.mock.calls)).toContain('request_aborted');
      expect((await request()).status).toBe(200);
    } finally {
      req.destroy();
      release(returned);
    }
  });
  it('ends a stalled form within the body deadline and remains available', async () => {
    const reply = await new Promise<Reply>((resolve, reject) => {
      const req = streaming(
        100,
        (value) => {
          resolve(value);
          req.destroy();
        },
        reject,
      );
      req.write('csrfToken=');
    });
    expect(reply.status).toBe(408);
    expect(complete).not.toHaveBeenCalled();
    expect((await request()).status).toBe(200);
  }, 10000);
  it('preserves selection replay/authorization errors without releasing a signed form', async () => {
    complete.mockRejectedValueOnce(
      new AssignmentError(409, 'selection_replayed', 'Restart selection from Canvas.'),
    );
    const reply = await request();
    expect(reply.status).toBe(409);
    expect(JSON.parse(reply.body).error.code).toBe('selection_replayed');
    expect(reply.headers['content-type']).toContain('application/json');
    expect(reply.body).not.toContain('name="JWT"');
  });
});
