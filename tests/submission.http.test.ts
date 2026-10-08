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
import { AssignmentError } from '../apps/api/src/assignments';
import type {
  AssignmentSubmissionService,
  SubmissionRequest,
  SubmissionReprocessRequest,
  SubmissionStatus,
} from '../apps/api/src/assignments/submissions/types';

// Real HTTPS/session/CSRF/body boundaries with a synthetic submission service. No Canvas delivery.
const origin = 'https://workspace.margin.test';
const token = randomBytes(32).toString('base64url');
const sessionSecret = randomBytes(32);
const csrf = createCookieCrypto(sessionSecret, origin).csrf(token);
const requestId = randomUUID();
const path = '/api/assignments/work/submissions';
const lookup = `/api/assignments/work/submission-requests/${requestId}`;
const principal: SessionPrincipal = {
  sessionId: randomUUID(),
  userId: randomUUID(),
  organizationId: randomUUID(),
  authenticationMethod: 'lti',
  role: 'student',
  mfa: false,
  createdAt: Date.now(),
  lastSeenAt: Date.now(),
  expiresAt: Date.now() + 3600000,
};
const submission: SubmissionStatus = {
  id: randomUUID(),
  requestId,
  attempt: 1,
  frozenCursor: 4,
  frozenAt: new Date().toISOString(),
  revision: 1,
  phase: 'processing',
  confirmedAt: null,
  retryAllowed: false,
  errorCode: null,
};
const captured: SubmissionRequest = { requestId, expectedCursor: 4, state: 'captured', submission };
const rejected: SubmissionRequest = {
  requestId,
  expectedCursor: 4,
  state: 'rejected',
  code: 'cursor_changed',
};
const capture = vi.fn<AssignmentSubmissionService['capture']>();
const lookupRequest = vi.fn<AssignmentSubmissionService['request']>();
const list = vi.fn<AssignmentSubmissionService['list']>();
const reprocess = vi.fn<AssignmentSubmissionService['reprocess']>();
const reprocessRequest = vi.fn<AssignmentSubmissionService['reprocessRequest']>();
const service: AssignmentSubmissionService = {
  capture,
  request: lookupRequest,
  list,
  reprocess,
  reprocessRequest,
};
const retryPath = `${path}/${submission.id}/reprocess`;
const retryLookup = `${path}/${submission.id}/reprocess-requests/2`;
const retryOutcome: SubmissionReprocessRequest = {
  request: { ...captured, submission: { ...submission, revision: 3 } },
  expectedRevision: 2,
  state: 'accepted',
  acceptedRevision: 3,
  code: null,
};
let revoked = false,
  federationActive = true;
let directory: string,
  server: Server,
  unconfigured: Server,
  base: string,
  fallback: string,
  certificate: Buffer,
  identity: IdentityService;
const logs: Record<string, unknown>[] = [];
beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), 'margin-submission-http-'));
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
  const options = {
    dataDirectory: join(directory, 'data'),
    identityService: identity,
    lmsService: { applicationOrigin: origin } as LmsService,
    keyEncryptionKey: randomBytes(32),
    tls: { key: readFileSync(pair.keyPath), cert: certificate },
    logger: (entry: Record<string, unknown>) => logs.push(entry),
  };
  server = createApi({ ...options, assignmentSubmissionService: service }) as Server;
  unconfigured = createApi(options) as Server;
  for (const s of [server, unconfigured])
    await new Promise<void>((resolve) => s.listen(0, '127.0.0.1', resolve));
  base = `https://127.0.0.1:${(server.address() as { port: number }).port}`;
  fallback = `https://127.0.0.1:${(unconfigured.address() as { port: number }).port}`;
});
afterAll(async () => {
  const closed = await Promise.allSettled(
    [server, unconfigured]
      .filter(Boolean)
      .map(
        (s) =>
          new Promise<void>((resolve, reject) =>
            s.close((error) => (error ? reject(error) : resolve())),
          ),
      ),
  );
  const errors = closed.filter(
    (result): result is PromiseRejectedResult => result.status === 'rejected',
  );
  if (errors.length)
    throw new AggregateError(
      errors.map((result) => result.reason),
      'HTTP fixture shutdown failed.',
    );
  if (directory) rmSync(directory, { recursive: true, force: true });
});
beforeEach(() => {
  revoked = false;
  federationActive = true;
  principal.role = 'student';
  principal.authenticationMethod = 'lti';
  vi.restoreAllMocks();
  capture.mockReset().mockResolvedValue({ request: captured, duplicate: false });
  lookupRequest.mockReset().mockResolvedValue({ request: captured });
  list.mockReset().mockResolvedValue({ submissions: [submission], nextCursor: null });
  reprocess.mockReset().mockResolvedValue(retryOutcome);
  reprocessRequest.mockReset().mockResolvedValue(retryOutcome);
  logs.length = 0;
});
type Reply = { status: number; headers: IncomingHttpHeaders; body: string };
const payload = () => JSON.stringify({ requestId, expectedCursor: 4 });
function request(
  target = path,
  options: {
    method?: string;
    body?: string | Buffer;
    headers?: Record<string, string | undefined>;
    endpoint?: string;
  } = {},
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const headers = {
      cookie: `${SESSION_COOKIE}=${token}`,
      origin,
      'x-csrf-token': csrf,
      ...(options.body !== undefined
        ? {
            'content-type': 'application/json',
            'content-length': String(Buffer.byteLength(options.body)),
          }
        : {}),
      ...options.headers,
    };
    const req = httpsRequest(
      (options.endpoint ?? base) + target,
      {
        method: options.method ?? 'GET',
        ca: certificate,
        rejectUnauthorized: true,
        headers: Object.fromEntries(
          Object.entries(headers).filter(([, value]) => value !== undefined),
        ),
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body }));
      },
    );
    req.on('error', reject);
    req.end(options.body);
  });
}
const post = (body: string | Buffer = payload()) => ({ method: 'POST', body });
function streaming(
  length: number,
  resolve: (r: Reply) => void,
  reject: (e: Error) => void,
  target = path,
) {
  const req = httpsRequest(
    base + target,
    {
      method: 'POST',
      ca: certificate,
      rejectUnauthorized: true,
      headers: {
        cookie: `${SESSION_COOKIE}=${token}`,
        origin,
        'x-csrf-token': csrf,
        'content-type': 'application/json',
        'content-length': length,
      },
    },
    (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body }));
    },
  );
  req.on('error', reject);
  return req;
}

describe('current-launch submission HTTP boundary', () => {
  it('is optional and reports unavailable without routing into general assignment authoring', async () => {
    expect(JSON.parse((await request('/api/health')).body).assignmentSubmissionsConfigured).toBe(
      true,
    );
    expect(
      JSON.parse((await request('/api/health', { endpoint: fallback })).body)
        .assignmentSubmissionsConfigured,
    ).toBe(false);
    for (const [target, options] of [
      [path, {}],
      [path, post()],
      [lookup, {}],
      [retryPath, post(JSON.stringify({ expectedRevision: 2 }))],
      [retryLookup, {}],
    ] as const) {
      const result = await request(target, { ...options, endpoint: fallback });
      expect(result.status).toBe(503);
      expect(JSON.parse(result.body).error.code).toBe('submission_unconfigured');
    }
    expect(capture).not.toHaveBeenCalled();
  });
  it('delegates only the current principal and two canonical capture fields', async () => {
    const result = await request(
      path,
      post(JSON.stringify({ requestId: requestId.toUpperCase(), expectedCursor: 4 })),
    );
    expect(result.status).toBe(202);
    expect(JSON.parse(result.body)).toEqual({ request: captured, duplicate: false });
    expect(capture).toHaveBeenCalledExactlyOnceWith(
      principal,
      { requestId, expectedCursor: 4 },
      { signal: expect.any(AbortSignal) },
    );
    expect(result.headers['cache-control']).toBe('no-store');
    expect(result.headers['content-security-policy']).toContain("default-src 'none'");
    expect(result.headers['x-content-type-options']).toBe('nosniff');
    const logged = JSON.stringify(logs);
    for (const secret of [csrf, token, requestId, principal.userId, principal.sessionId])
      expect(logged).not.toContain(secret);
  });
  it('distinguishes incomplete, durable rejected and future confirmed receipts without claiming delivery', async () => {
    capture.mockResolvedValueOnce({ request: captured, duplicate: true });
    expect((await request(path, post())).status).toBe(202);
    capture.mockResolvedValueOnce({ request: rejected, duplicate: false });
    const rejection = await request(path, post());
    expect(rejection.status).toBe(409);
    expect(JSON.parse(rejection.body)).toEqual({ request: rejected, duplicate: false });
    lookupRequest.mockResolvedValueOnce({ request: rejected });
    expect((await request(lookup)).status).toBe(200);
    const confirmed: SubmissionRequest = {
      ...captured,
      submission: {
        ...submission,
        phase: 'confirmed',
        confirmedAt: new Date().toISOString(),
        revision: 2,
      },
    };
    capture.mockResolvedValueOnce({ request: confirmed, duplicate: true });
    lookupRequest.mockResolvedValueOnce({ request: confirmed });
    expect((await request(path, post())).status).toBe(200);
    expect((await request(lookup)).status).toBe(200);
  });
  it('allowlists public capture/list/lookup fields and propagates bounded cursors', async () => {
    const privateStatus = {
      ...submission,
      storageKey: 'private object',
      wrappedKey: 'private key',
    };
    const privateRequest = { ...captured, submission: privateStatus, snapshot: 'private snapshot' };
    capture.mockResolvedValueOnce({ request: privateRequest, duplicate: false });
    lookupRequest.mockResolvedValueOnce({ request: privateRequest });
    list.mockResolvedValueOnce({ submissions: [privateStatus], nextCursor: 'cursor' });
    expect(JSON.parse((await request(path, post())).body)).toEqual({
      request: captured,
      duplicate: false,
    });
    expect(JSON.parse((await request(lookup)).body)).toEqual({ request: captured });
    expect(JSON.parse((await request(path + '?after=cursor')).body)).toEqual({
      submissions: [submission],
      nextCursor: 'cursor',
    });
    expect(list).toHaveBeenCalledExactlyOnceWith(
      principal,
      { after: 'cursor' },
      { signal: expect.any(AbortSignal) },
    );
    expect(lookupRequest).toHaveBeenCalledExactlyOnceWith(principal, requestId, {
      signal: expect.any(AbortSignal),
    });
  });
  it('requires live LTI student sessions before parsing capture input or releasing status', async () => {
    expect(
      (await request(path, { ...post('malformed'), headers: { cookie: undefined } })).status,
    ).toBe(401);
    revoked = true;
    expect((await request(lookup)).status).toBe(401);
    revoked = false;
    federationActive = false;
    expect((await request(path)).status).toBe(403);
    federationActive = true;
    for (const role of ['teacher', 'viewer', 'school_admin', 'support'] as const) {
      principal.role = role;
      expect((await request(path)).status).toBe(403);
      expect((await request(path, post())).status).toBe(403);
    }
    principal.role = 'student';
    principal.authenticationMethod = 'oidc';
    expect((await request(path)).status).toBe(403);
    expect(capture).not.toHaveBeenCalled();
    expect(list).not.toHaveBeenCalled();
    expect(lookupRequest).not.toHaveBeenCalled();
  });
  it('keeps trusted Origin and header-CSRF mandatory on capture', async () => {
    for (const headers of [
      { origin: undefined },
      { origin: 'https://attacker.test' },
      { 'x-csrf-token': undefined },
      { 'x-csrf-token': 'wrong' },
      { 'sec-fetch-site': 'cross-site' },
    ])
      expect((await request(path, { ...post(), headers })).status).toBe(403);
    expect(capture).not.toHaveBeenCalled();
  });
  it.each([
    '{}',
    '[]',
    'null',
    '{',
    JSON.stringify({ requestId, expectedCursor: '4' }),
    JSON.stringify({ requestId, expectedCursor: -1 }),
    JSON.stringify({ requestId, expectedCursor: 100001 }),
    JSON.stringify({ requestId, expectedCursor: 1.1 }),
    JSON.stringify({ requestId: 'invalid', expectedCursor: 4 }),
    JSON.stringify({ requestId, expectedCursor: 4, userId: principal.userId }),
    Buffer.from([0xc0, 0xaf]),
  ])('rejects malformed or authority-bearing input (%#)', async (body) => {
    expect((await request(path, post(body))).status).toBe(400);
    expect(capture).not.toHaveBeenCalled();
  });
  it('bounds declared/chunked bodies and rejects alternate encodings', async () => {
    for (const headers of [{}, { 'content-length': undefined, 'transfer-encoding': 'chunked' }])
      expect((await request(path, { ...post('x'.repeat(1025)), headers })).status).toBe(413);
    for (const headers of [
      { 'content-type': 'text/plain' },
      { 'content-type': 'application/json; charset=latin1' },
      { 'content-encoding': 'gzip' },
    ])
      expect((await request(path, { ...post(), headers })).status).toBe(415);
    expect(capture).not.toHaveBeenCalled();
  });
  it('bounds query/method/read bodies before service entry', async () => {
    for (const target of [
      path + '?after=a&after=b',
      path + '?after=',
      path + '?after=' + 'a'.repeat(129),
      path + '?userId=x',
      lookup + '?after=x',
      lookup + '/extra',
    ])
      expect((await request(target)).status).toBe(400);
    expect((await request(path + '?after=x', post())).status).toBe(400);
    expect((await request(path, { method: 'GET', body: '{}' })).status).toBe(400);
    expect((await request(lookup, { headers: { range: 'bytes=0-5' } })).status).toBe(400);
    const wrong = await request(lookup, post());
    expect(wrong.status).toBe(405);
    expect(wrong.headers.allow).toBe('GET');
    expect((await request(path, { method: 'DELETE' })).status).toBe(405);
    expect(capture).not.toHaveBeenCalled();
    expect(list).not.toHaveBeenCalled();
    expect(lookupRequest).not.toHaveBeenCalled();
  });
  it('rechecks revocation after a partial body before capture', async () => {
    let seen!: () => void;
    const initial = new Promise<void>((resolve) => (seen = resolve));
    const original = identity.authenticateRequest.bind(identity);
    vi.spyOn(identity, 'authenticateRequest').mockImplementationOnce(async (req) => {
      const value = await original(req);
      seen();
      return value;
    });
    const body = payload();
    const result = new Promise<Reply>((resolve, reject) => {
      const req = streaming(Buffer.byteLength(body), resolve, reject);
      req.write(body.slice(0, 10));
      void initial.then(() => {
        revoked = true;
        req.end(body.slice(10));
      });
    });
    expect((await result).status).toBe(401);
    expect(capture).not.toHaveBeenCalled();
  });
  it('does not call capture for an aborted partial body', async () => {
    let arrived!: () => void;
    const seen = new Promise<void>((resolve) => (arrived = resolve));
    const closed = new Promise<void>((resolve) =>
      server.once('request', (req) => {
        arrived();
        req.once('aborted', resolve);
      }),
    );
    const req = streaming(
      100,
      () => {},
      () => {},
    );
    req.write('{');
    await seen;
    req.destroy();
    await closed;
    expect(capture).not.toHaveBeenCalled();
  });
  it('propagates cancellation during a capture and withholds the late receipt', async () => {
    let entered!: () => void,
      release!: (value: Awaited<ReturnType<AssignmentSubmissionService['capture']>>) => void;
    const active = new Promise<void>((resolve) => (entered = resolve));
    const pending = new Promise<Awaited<ReturnType<AssignmentSubmissionService['capture']>>>(
      (resolve) => (release = resolve),
    );
    let signal: AbortSignal | undefined;
    capture.mockImplementationOnce((_p, _input, options) => {
      signal = options?.signal;
      entered();
      return pending;
    });
    let ended: ReturnType<typeof vi.spyOn> | undefined;
    const closed = new Promise<void>((resolve) =>
      server.once('request', (_req, res) => {
        ended = vi.spyOn(res, 'end');
        res.once('close', resolve);
      }),
    );
    const req = streaming(
      Buffer.byteLength(payload()),
      () => {},
      () => {},
    );
    try {
      req.end(payload());
      await active;
      req.destroy();
      await closed;
      expect(signal?.aborted).toBe(true);
      release({ request: captured, duplicate: false });
      await vi.waitFor(() => expect(ended).toHaveBeenCalled());
      expect(JSON.stringify(ended!.mock.calls)).not.toContain(submission.id);
      expect((await request(path)).status).toBe(200);
    } finally {
      req.destroy();
      release({ request: captured, duplicate: false });
    }
  });
  it('preserves semantic service errors without private details', async () => {
    lookupRequest.mockRejectedValueOnce(
      new AssignmentError(404, 'submission_request_not_found', 'Request not found.'),
    );
    const result = await request(lookup);
    expect(result.status).toBe(404);
    expect(JSON.parse(result.body).error.code).toBe('submission_request_not_found');
  });
  it('ends a stalled body at five seconds and releases the HTTP slot', async () => {
    const result = await new Promise<Reply>((resolve, reject) => {
      const req = streaming(
        100,
        (reply) => {
          resolve(reply);
          req.destroy();
        },
        reject,
      );
      req.write('{');
    });
    expect(result.status).toBe(408);
    expect(capture).not.toHaveBeenCalled();
    expect((await request(path)).status).toBe(200);
  }, 8000);
});

describe('same-capture reprocessing HTTP boundary', () => {
  const retryBody = () => JSON.stringify({ expectedRevision: 2 });
  it('returns an accepted command and recovers that exact durable outcome by revision', async () => {
    const accepted = await request(
      retryPath.replace(submission.id, submission.id.toUpperCase()),
      post(retryBody()),
    );
    expect(accepted.status).toBe(202);
    expect(JSON.parse(accepted.body)).toEqual(retryOutcome);
    expect(reprocess).toHaveBeenCalledExactlyOnceWith(
      principal,
      submission.id,
      { expectedRevision: 2 },
      { signal: expect.any(AbortSignal) },
    );
    const recovered = await request(retryLookup);
    expect(recovered.status).toBe(200);
    expect(JSON.parse(recovered.body)).toEqual(retryOutcome);
    expect(reprocessRequest).toHaveBeenCalledExactlyOnceWith(principal, submission.id, 2, {
      signal: expect.any(AbortSignal),
    });
    expect(recovered.headers['cache-control']).toBe('no-store');
    expect(capture).not.toHaveBeenCalled();
    for (const secret of [csrf, token, submission.id, requestId, principal.userId])
      expect(JSON.stringify(logs)).not.toContain(secret);
  });
  it('distinguishes durable rejection, unknown response and future-revision conflict', async () => {
    const rejected: SubmissionReprocessRequest = {
      ...retryOutcome,
      state: 'rejected',
      acceptedRevision: null,
      code: 'revision_changed',
    };
    reprocess.mockResolvedValueOnce(rejected);
    reprocessRequest.mockResolvedValueOnce(rejected);
    const response = await request(retryPath, post(retryBody()));
    expect(response.status).toBe(409);
    expect(JSON.parse(response.body)).toEqual(rejected);
    expect(JSON.parse((await request(retryLookup)).body)).toEqual(rejected);
    reprocessRequest.mockRejectedValueOnce(
      new AssignmentError(404, 'submission_reprocess_not_found', 'No saved command.'),
    );
    const unknown = await request(retryLookup);
    expect(unknown.status).toBe(404);
    expect(JSON.parse(unknown.body)).not.toHaveProperty('state');
    reprocess.mockRejectedValueOnce(
      new AssignmentError(409, 'submission_revision_ahead', 'Refresh the saved status.'),
    );
    const ahead = await request(retryPath, post(retryBody()));
    expect(ahead.status).toBe(409);
    expect(JSON.parse(ahead.body)).not.toHaveProperty('state');
  });
  it('allowlists the retry outcome and nested frozen capture', async () => {
    const privateValue = {
      ...retryOutcome,
      providerToken: 'secret',
      request: {
        ...retryOutcome.request,
        snapshot: 'secret',
        submission: { ...retryOutcome.request.submission, wrappedKey: 'secret' },
      },
    };
    reprocess.mockResolvedValueOnce(privateValue);
    reprocessRequest.mockResolvedValueOnce(privateValue);
    expect(JSON.parse((await request(retryPath, post(retryBody()))).body)).toEqual(retryOutcome);
    expect(JSON.parse((await request(retryLookup)).body)).toEqual(retryOutcome);
  });
  it.each([
    {},
    [],
    null,
    { expectedRevision: 0 },
    { expectedRevision: -1 },
    { expectedRevision: 2.1 },
    { expectedRevision: '2' },
    { expectedRevision: Number.MAX_SAFE_INTEGER },
    { expectedRevision: 2, expectedCursor: 4 },
    { expectedRevision: 2, userId: principal.userId },
  ])('rejects malformed or authority-bearing retry input %#', async (value) => {
    expect((await request(retryPath, post(JSON.stringify(value)))).status).toBe(400);
    expect(reprocess).not.toHaveBeenCalled();
  });
  it('bounds URL revisions, methods, query, read bodies and encodings', async () => {
    for (const revision of ['0', '-1', '01', '1.5', '1e1', String(Number.MAX_SAFE_INTEGER)])
      expect((await request(retryLookup.replace(/2$/, revision))).status).toBe(400);
    for (const target of [retryPath + '?after=x', retryLookup + '?after=x'])
      expect(
        (await request(target, target.startsWith(retryPath + '?') ? post(retryBody()) : {})).status,
      ).toBe(400);
    expect((await request(retryLookup, { body: '{}' })).status).toBe(400);
    expect((await request(retryLookup, { headers: { range: 'bytes=0-1' } })).status).toBe(400);
    expect((await request(retryPath)).status).toBe(405);
    expect((await request(retryLookup, post(retryBody()))).status).toBe(405);
    expect((await request(path + '/unknown')).status).toBe(404);
    expect((await request(retryPath, post('x'.repeat(1025)))).status).toBe(413);
    expect((await request(retryPath, post(Buffer.from([0xc0, 0xaf])))).status).toBe(400);
    expect(
      (await request(retryPath, { ...post(retryBody()), headers: { 'content-encoding': 'gzip' } }))
        .status,
    ).toBe(415);
    expect(reprocess).not.toHaveBeenCalled();
    expect(reprocessRequest).not.toHaveBeenCalled();
  });
  it('requires a current LTI student and CSRF for reprocessing', async () => {
    for (const headers of [
      { origin: undefined },
      { origin: 'https://attacker.test' },
      { 'x-csrf-token': undefined },
      { 'x-csrf-token': 'wrong' },
    ])
      expect((await request(retryPath, { ...post(retryBody()), headers })).status).toBe(403);
    principal.role = 'teacher';
    expect((await request(retryPath, post(retryBody()))).status).toBe(403);
    expect((await request(retryLookup)).status).toBe(403);
    principal.role = 'student';
    principal.authenticationMethod = 'oidc';
    expect((await request(retryPath, post(retryBody()))).status).toBe(403);
    principal.authenticationMethod = 'lti';
    federationActive = false;
    expect((await request(retryLookup)).status).toBe(403);
    expect(reprocess).not.toHaveBeenCalled();
    expect(reprocessRequest).not.toHaveBeenCalled();
  });
  it('rechecks revocation after a partial retry body before recording a command', async () => {
    let seen!: () => void;
    const initial = new Promise<void>((resolve) => {
      seen = resolve;
    });
    const original = identity.authenticateRequest.bind(identity);
    vi.spyOn(identity, 'authenticateRequest').mockImplementationOnce(async (req) => {
      const value = await original(req);
      seen();
      return value;
    });
    const body = retryBody();
    const result = new Promise<Reply>((resolve, reject) => {
      const req = streaming(Buffer.byteLength(body), resolve, reject, retryPath);
      req.write(body.slice(0, 10));
      void initial.then(() => {
        revoked = true;
        req.end(body.slice(10));
      });
    });
    expect((await result).status).toBe(401);
    expect(reprocess).not.toHaveBeenCalled();
  });
});
