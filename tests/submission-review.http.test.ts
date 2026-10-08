import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
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
  AssignmentReviewService,
  ReviewContext,
  ReviewSubmission,
  ReviewSnapshot,
} from '../apps/api/src/assignments/review/types';

// Real HTTPS/session boundaries with a synthetic review service. PostgreSQL tests own author RLS.
const origin = 'https://workspace.margin.test',
  token = randomBytes(32).toString('base64url'),
  secret = randomBytes(32);
const csrf = createCookieCrypto(secret, origin).csrf(token);
const root = '/api/assignments/review';
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
const reviewContext: ReviewContext = {
  assignment: {
    id: randomUUID(),
    title: 'Synthetic assignment',
    instructions: 'Read the frozen work.',
  },
  mode: 'author-only',
};
const submission: ReviewSubmission = {
  id: randomUUID(),
  frozenCursor: 1,
  frozenAt: new Date().toISOString(),
  revision: 2,
  preparation: 'ready',
  errorCode: null,
};
const pin = 'a'.repeat(64),
  sourceBody = Buffer.from('%PDF synthetic exact source bytes');
const chunkBody = Buffer.from('{"schema":1,"entries":[]}');
const hash = (value: Buffer) => createHash('sha256').update(value).digest('hex');
const snapshot: ReviewSnapshot = {
  assignmentId: reviewContext.assignment.id,
  submission,
  snapshotPin: pin,
  organizationId: principal.organizationId,
  workId: randomUUID(),
  documentId: randomUUID(),
  versionId: randomUUID(),
  pages: [{ id: randomUUID(), index: 0, width: 612, height: 792 }],
  source: { sha256: hash(sourceBody), bytes: sourceBody.length, mimeType: 'application/pdf' },
  annotationCount: 0,
  outputBytes: chunkBody.length,
  outputSha256: hash(chunkBody),
  chunks: [{ index: 0, sha256: hash(chunkBody), bytes: chunkBody.length }],
};
const selected = `${root}/submissions/${submission.id}`;
const source = `${selected}/source?pin=${pin}`,
  chunk = `${selected}/chunks/0?pin=${pin}`;
const service = {
  context: vi.fn<AssignmentReviewService['context']>(),
  list: vi.fn<AssignmentReviewService['list']>(),
  snapshot: vi.fn<AssignmentReviewService['snapshot']>(),
  source: vi.fn<AssignmentReviewService['source']>(),
  chunk: vi.fn<AssignmentReviewService['chunk']>(),
};
let revoked = false,
  federationActive = true,
  directory: string,
  server: Server,
  unconfigured: Server,
  base: string,
  fallback: string,
  certificate: Buffer;
const logs: Record<string, unknown>[] = [];
beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), 'margin-review-http-'));
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
    authenticate: async (value) =>
      !revoked && value === tokenHash(token) ? { ...principal } : null,
    revokeSession: async () => {},
    listSessions: async () => [],
    revokeOwnedSession: async () => false,
  };
  const identity = new IdentityService(
    {
      issuerUrl: 'https://issuer.margin.test',
      clientId: 'synthetic-client',
      clientSecret: 'synthetic-secret',
      applicationOrigin: origin,
      redirectUri: origin + '/api/auth/callback',
      sessionSecret: secret,
      identityHmacKey: randomBytes(32),
    },
    repository,
    new Configuration({ issuer: 'https://issuer.margin.test' }, 'synthetic-client'),
    { authorizeLmsSession: async () => federationActive },
  );
  const options = {
    dataDirectory: join(directory, 'data'),
    identityService: identity,
    lmsService: { applicationOrigin: origin } as LmsService,
    keyEncryptionKey: randomBytes(32),
    tls: { key: readFileSync(pair.keyPath), cert: certificate },
    logger: (entry: Record<string, unknown>) => logs.push(entry),
  };
  server = createApi({ ...options, assignmentReviewService: service }) as Server;
  unconfigured = createApi(options) as Server;
  for (const instance of [server, unconfigured])
    await new Promise<void>((resolve) => instance.listen(0, '127.0.0.1', resolve));
  base = `https://127.0.0.1:${(server.address() as { port: number }).port}`;
  fallback = `https://127.0.0.1:${(unconfigured.address() as { port: number }).port}`;
});
afterAll(async () => {
  const results = await Promise.allSettled(
    [server, unconfigured]
      .filter(Boolean)
      .map(
        (instance) =>
          new Promise<void>((resolve, reject) =>
            instance.close((error) => (error ? reject(error) : resolve())),
          ),
      ),
  );
  if (directory) rmSync(directory, { recursive: true, force: true });
  const failed = results.filter(
    (result): result is PromiseRejectedResult => result.status === 'rejected',
  );
  if (failed.length)
    throw new AggregateError(
      failed.map((item) => item.reason),
      'Review HTTP cleanup failed.',
    );
});
beforeEach(() => {
  revoked = false;
  federationActive = true;
  principal.role = 'teacher';
  principal.authenticationMethod = 'lti';
  vi.restoreAllMocks();
  service.context.mockReset().mockResolvedValue(reviewContext);
  service.list.mockReset().mockResolvedValue({ submissions: [submission], nextCursor: null });
  service.snapshot.mockReset().mockResolvedValue(snapshot);
  service.source.mockReset().mockImplementation(async () => Buffer.from(sourceBody));
  service.chunk.mockReset().mockImplementation(async () => Buffer.from(chunkBody));
  logs.length = 0;
});
type Reply = { status: number; headers: IncomingHttpHeaders; bytes: Buffer };
function raw(
  target: string,
  options: {
    method?: string;
    body?: string;
    headers?: Record<string, string | undefined>;
    endpoint?: string;
  },
  done: (value: Reply) => void,
  fail: (error: Error) => void,
) {
  const req = httpsRequest(
    (options.endpoint ?? base) + target,
    {
      method: options.method ?? 'GET',
      ca: certificate,
      rejectUnauthorized: true,
      headers: Object.fromEntries(
        Object.entries({
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
        }).filter(([, value]) => value !== undefined),
      ),
    },
    (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () =>
        done({ status: res.statusCode!, headers: res.headers, bytes: Buffer.concat(chunks) }),
      );
    },
  );
  req.on('error', fail);
  return req;
}
function request(target: string = root, options: Parameters<typeof raw>[1] = {}) {
  return new Promise<Reply>((resolve, reject) =>
    raw(target, options, resolve, reject).end(options.body),
  );
}
const json = (reply: Reply) => JSON.parse(reply.bytes.toString());
const unused = () => {
  for (const method of Object.values(service)) expect(method).not.toHaveBeenCalled();
};

describe('current author teacher frozen-review HTTP boundary', () => {
  it('is explicitly configured, and every route fails closed without its service', async () => {
    expect(json(await request('/api/health')).assignmentReviewConfigured).toBe(true);
    expect(
      json(await request('/api/health', { endpoint: fallback })).assignmentReviewConfigured,
    ).toBe(false);
    for (const target of [root, root + '/submissions', selected, chunk, source]) {
      const reply = await request(target, { endpoint: fallback });
      expect(reply.status).toBe(503);
      expect(json(reply).error.code).toBe('review_unconfigured');
    }
    unused();
  });
  it('delegates only current principal, canonical identifiers, bounded cursor and exact pin', async () => {
    expect(json(await request())).toEqual(reviewContext);
    expect(json(await request(root + '/submissions?after=bounded_cursor'))).toEqual({
      submissions: [submission],
      nextCursor: null,
    });
    expect(
      json(await request(selected.replace(submission.id, submission.id.toUpperCase()))),
    ).toEqual(snapshot);
    const chunks = await request(chunk),
      pdf = await request(source);
    expect(chunks.bytes.equals(chunkBody)).toBe(true);
    expect(pdf.bytes.equals(sourceBody)).toBe(true);
    expect(service.context).toHaveBeenCalledExactlyOnceWith(principal, {
      signal: expect.any(AbortSignal),
    });
    expect(service.list).toHaveBeenCalledExactlyOnceWith(
      principal,
      { after: 'bounded_cursor' },
      { signal: expect.any(AbortSignal) },
    );
    expect(service.snapshot).toHaveBeenCalledExactlyOnceWith(principal, submission.id, {
      signal: expect.any(AbortSignal),
    });
    expect(service.chunk).toHaveBeenCalledExactlyOnceWith(
      principal,
      submission.id,
      0,
      { snapshotPin: pin },
      { signal: expect.any(AbortSignal) },
    );
    expect(service.source).toHaveBeenCalledExactlyOnceWith(
      principal,
      submission.id,
      { snapshotPin: pin },
      { signal: expect.any(AbortSignal) },
    );
    expect(pdf.headers['content-type']).toBe('application/pdf');
    expect(pdf.headers['content-disposition']).toBe('inline; filename="assignment.pdf"');
    expect(chunks.headers['content-type']).toBe('application/json; charset=utf-8');
    for (const reply of [chunks, pdf]) {
      expect(reply.headers['cache-control']).toBe('no-store');
      expect(reply.headers['content-security-policy']).toContain("default-src 'none'");
      expect(reply.headers['x-content-type-options']).toBe('nosniff');
    }
    for (const value of [token, csrf, pin, submission.id, principal.userId, principal.sessionId])
      expect(JSON.stringify(logs)).not.toContain(value);
  });
  it('allowlists metadata at every nested public boundary', async () => {
    service.context.mockResolvedValueOnce({
      ...reviewContext,
      storage: 'private',
      assignment: { ...reviewContext.assignment, wrappedKey: 'private' },
    } as ReviewContext);
    service.list.mockResolvedValueOnce({
      submissions: [{ ...submission, providerToken: 'private' }],
      nextCursor: null,
    } as never);
    service.snapshot.mockResolvedValueOnce({
      ...snapshot,
      claim: 'private',
      submission: { ...submission, requestId: 'private' },
      pages: snapshot.pages.map((value) => ({ ...value, key: 'private' })),
      source: { ...snapshot.source, storageReceipt: 'private' },
      chunks: snapshot.chunks.map((value) => ({ ...value, wrappedKey: 'private' })),
    } as ReviewSnapshot);
    expect(json(await request())).toEqual(reviewContext);
    expect(json(await request(root + '/submissions'))).toEqual({
      submissions: [submission],
      nextCursor: null,
    });
    expect(json(await request(selected))).toEqual(snapshot);
  });
  it('requires current LTI teacher authentication before routing or reading', async () => {
    expect((await request(root, { headers: { cookie: undefined } })).status).toBe(401);
    for (const role of ['student', 'viewer', 'school_admin', 'support'] as const) {
      principal.role = role;
      for (const target of [root, selected, source, chunk])
        expect((await request(target)).status).toBe(403);
    }
    principal.role = 'teacher';
    principal.authenticationMethod = 'oidc';
    expect((await request()).status).toBe(403);
    principal.authenticationMethod = 'lti';
    federationActive = false;
    expect((await request()).status).toBe(403);
    federationActive = true;
    revoked = true;
    expect((await request(source)).status).toBe(401);
    unused();
  });
  it('rejects cross-origin reads and every mutation method', async () => {
    for (const headers of [{ origin: 'https://attacker.test' }, { 'sec-fetch-site': 'cross-site' }])
      expect((await request(source, { headers })).status).toBe(403);
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'HEAD']) {
      const reply = await request(selected, { method });
      expect(reply.status).toBe(405);
      expect(reply.headers.allow).toBe('GET');
    }
    unused();
  });
  it.each([
    '/submissions?after=',
    '/submissions?after=x&after=y',
    '/submissions?userId=foreign',
    '?pin=' + pin,
    `/submissions/${submission.id}?pin=${pin}`,
    `/submissions/${submission.id}/source`,
    `/submissions/${submission.id}/source?pin=${pin}&pin=${pin}`,
    `/submissions/${submission.id}/source?pin=${pin.toUpperCase()}`,
    `/submissions/${submission.id}/source?pin=${pin}&userId=foreign`,
    `/submissions/${submission.id}/chunks/0`,
    `/submissions/${submission.id}/chunks/01?pin=${pin}`,
    `/submissions/${submission.id}/chunks/-1?pin=${pin}`,
    `/submissions/${submission.id}/chunks/2048?pin=${pin}`,
    `/submissions/${submission.id}/chunks/1.5?pin=${pin}`,
    `/submissions/not-a-uuid`,
    '/submissions?after=' + 'a'.repeat(129),
  ])('rejects noncanonical, unbounded or authority-bearing selectors %s', async (suffix) => {
    expect((await request(root + suffix)).status).toBe(400);
    unused();
  });
  it('rejects missing routes, bodies and ranges without invoking content services', async () => {
    for (const target of [selected + '/source/extra', selected + '/chunks', root + '/unknown'])
      expect((await request(target)).status).toBe(404);
    expect((await request(source, { headers: { range: 'bytes=0-1' } })).status).toBe(400);
    expect((await request(selected, { body: '{}' })).status).toBe(400);
    expect((await request(root + '?' + 'x'.repeat(2048))).status).toBe(414);
    unused();
  });
  it('preserves safe authority errors and hides internal/provider error details', async () => {
    service.snapshot.mockRejectedValueOnce(
      new AssignmentError(403, 'review_access_denied', 'This launch does not permit review.'),
    );
    expect(json(await request(selected)).error).toEqual({
      code: 'review_access_denied',
      message: 'This launch does not permit review.',
    });
    service.source.mockRejectedValueOnce(new Error('private key and bucket location'));
    const failed = await request(source);
    expect(failed.status).toBe(503);
    expect(failed.bytes.toString()).not.toContain('private key');
    expect(JSON.stringify(logs)).not.toContain('private key');
  });
  it('erases completed raw content only after the exact bytes have been flushed', async () => {
    const pdf = Buffer.from(sourceBody),
      annotations = Buffer.from(chunkBody);
    service.source.mockResolvedValueOnce(pdf);
    service.chunk.mockResolvedValueOnce(annotations);
    expect((await request(source)).bytes.equals(sourceBody)).toBe(true);
    expect((await request(chunk)).bytes.equals(chunkBody)).toBe(true);
    expect(pdf.every((byte) => byte === 0)).toBe(true);
    expect(annotations.every((byte) => byte === 0)).toBe(true);
  });
  it('rejects oversized chunk results and erases their buffer', async () => {
    const tooLarge = Buffer.alloc(262145, 1);
    service.chunk.mockResolvedValueOnce(tooLarge);
    expect((await request(chunk)).status).toBe(503);
    expect(tooLarge.every((byte) => byte === 0)).toBe(true);
  });
  it('keeps content admission occupied until cancelled service calls actually settle and wipes late bytes', async () => {
    const releases: Array<(bytes: Buffer) => void> = [],
      values: Buffer[] = [];
    try {
      for (let i = 0; i < 2; i++) {
        let entered!: () => void;
        const ready = new Promise<void>((resolve) => {
          entered = resolve;
        });
        let signal: AbortSignal | undefined;
        service.source.mockImplementationOnce((_p, _id, _pin, options) => {
          signal = options?.signal;
          entered();
          return new Promise((resolve) => releases.push(resolve));
        });
        const closed = new Promise<void>((resolve) =>
          server.once('request', (_req, res) => res.once('close', resolve)),
        );
        const req = raw(
          source,
          {},
          () => {},
          () => {},
        );
        req.end();
        await ready;
        req.destroy();
        await closed;
        expect(signal?.aborted).toBe(true);
      }
      const blocked = await request(source);
      expect(blocked.status).toBe(503);
      expect(json(blocked).error.code).toBe('review_reader_busy');
      expect(service.source).toHaveBeenCalledTimes(2);
      expect((await request()).status).toBe(200);
      for (const resolve of releases) {
        const bytes = Buffer.from(sourceBody);
        values.push(bytes);
        resolve(bytes);
      }
      await vi.waitFor(() =>
        expect(values.every((bytes) => bytes.every((byte) => byte === 0))).toBe(true),
      );
      expect((await request(source)).status).toBe(200);
    } finally {
      for (const resolve of releases) resolve(Buffer.from(sourceBody));
    }
  });
});
