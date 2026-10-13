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
import {
  MAX_FEEDBACK_BYTES,
  type AssignmentFeedbackService,
  type FeedbackCommand,
  type TeacherFeedback,
} from '../apps/api/src/assignments/feedback/types';

// Real HTTPS, session, CSRF and streaming-body boundaries. Service responses are synthetic;
// submission-feedback.postgres.test.ts separately executes the actual encrypted/RLS service.
const origin = 'https://workspace.margin.test',
  token = randomBytes(32).toString('base64url'),
  secret = randomBytes(32);
const csrf = createCookieCrypto(secret, origin).csrf(token);
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
const id = randomUUID(),
  requestId = randomUUID(),
  pin = 'a'.repeat(64);
const teacher = `/api/assignments/review/submissions/${id}/feedback`,
  student = `/api/assignments/work/submissions/${id}/feedback`,
  release = teacher + '/release',
  command = teacher + '/commands/' + requestId;
const content = { comment: 'Explain how the image supports your answer.', annotations: [] };
const state: TeacherFeedback = {
  capture: {
    submissionId: id,
    snapshotPin: pin,
    documentId: randomUUID(),
    versionId: randomUUID(),
    frozenCursor: 1,
    frozenAt: new Date().toISOString(),
    pages: [{ id: randomUUID(), index: 0, width: 612, height: 792 }],
    source: { sha256: 'b'.repeat(64), bytes: 100, mimeType: 'application/pdf' },
  },
  revision: 1,
  savedAt: new Date().toISOString(),
  content,
  released: null,
};
const saved: FeedbackCommand = {
  requestId,
  action: 'save',
  expectedRevision: 0,
  snapshotPin: pin,
  state: 'accepted',
  revision: 1,
  code: null,
  savedAt: state.savedAt,
  releasedAt: null,
};
const returned: FeedbackCommand = {
  ...saved,
  action: 'release',
  expectedRevision: 1,
  releasedAt: new Date().toISOString(),
};
const released = { revision: 1, releasedAt: returned.releasedAt!, content };
const service = {
  teacher: vi.fn<AssignmentFeedbackService['teacher']>(),
  student: vi.fn<AssignmentFeedbackService['student']>(),
  save: vi.fn<AssignmentFeedbackService['save']>(),
  release: vi.fn<AssignmentFeedbackService['release']>(),
  command: vi.fn<AssignmentFeedbackService['command']>(),
};
let revoked = false,
  federationActive = true,
  directory: string,
  server: Server,
  unconfigured: Server,
  base: string,
  fallback: string,
  certificate: Buffer,
  identity: IdentityService;
const logs: Record<string, unknown>[] = [];
beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), 'margin-feedback-http-'));
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
  identity = new IdentityService(
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
  server = createApi({ ...options, assignmentFeedbackService: service }) as Server;
  unconfigured = createApi(options) as Server;
  for (const s of [server, unconfigured])
    await new Promise<void>((resolve) => s.listen(0, '127.0.0.1', resolve));
  base = `https://127.0.0.1:${(server.address() as { port: number }).port}`;
  fallback = `https://127.0.0.1:${(unconfigured.address() as { port: number }).port}`;
});
afterAll(async () => {
  const outcomes = await Promise.allSettled(
    [server, unconfigured]
      .filter(Boolean)
      .map(
        (s) => new Promise<void>((resolve, reject) => s.close((e) => (e ? reject(e) : resolve()))),
      ),
  );
  if (directory) rmSync(directory, { recursive: true, force: true });
  const failed = outcomes.filter((o) => o.status === 'rejected');
  if (failed.length) throw new AggregateError(failed, 'Feedback HTTPS cleanup failed.');
});
beforeEach(() => {
  revoked = false;
  federationActive = true;
  principal.role = 'teacher';
  principal.authenticationMethod = 'lti';
  vi.restoreAllMocks();
  service.teacher.mockReset().mockResolvedValue(state);
  service.student.mockReset().mockResolvedValue({ capture: state.capture, released });
  service.save.mockReset().mockResolvedValue(saved);
  service.release.mockReset().mockResolvedValue(returned);
  service.command.mockReset().mockResolvedValue(returned);
  logs.length = 0;
});
type Reply = { status: number; headers: IncomingHttpHeaders; bytes: Buffer };
function raw(
  target: string,
  options: {
    method?: string;
    body?: string | Buffer;
    headers?: Record<string, string | undefined>;
    endpoint?: string;
  },
  done: (r: Reply) => void,
  fail: (e: Error) => void,
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
        }).filter(([, v]) => v !== undefined),
      ),
    },
    (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (b: Buffer) => chunks.push(b));
      res.on('end', () =>
        done({ status: res.statusCode!, headers: res.headers, bytes: Buffer.concat(chunks) }),
      );
    },
  );
  req.on('error', fail);
  return req;
}
function request(target = teacher, options: Parameters<typeof raw>[1] = {}) {
  return new Promise<Reply>((resolve, reject) =>
    raw(target, options, resolve, reject).end(options.body),
  );
}
const json = (r: Reply) => JSON.parse(r.bytes.toString());
const saveBody = () =>
  JSON.stringify({ requestId, snapshotPin: pin, expectedRevision: 0, content });
const releaseBody = () => JSON.stringify({ requestId, snapshotPin: pin, expectedRevision: 1 });
const unused = () => {
  for (const fn of Object.values(service)) expect(fn).not.toHaveBeenCalled();
};
describe('teacher feedback HTTPS boundary', () => {
  it('projects public fields at every nested boundary and bounds serialized feedback', async () => {
    const annotation = {
      id: randomUUID(),
      pageIndex: 0,
      type: 'pen' as const,
      x: 20,
      y: 30,
      points: [{ x: 20, y: 30, pressure: 0.5 }],
      color: '#123456',
      strokeWidth: 2,
      opacity: 1,
      createdAt: 1,
      author: 'Teacher',
    };
    const clean = {
      ...state,
      content: { ...content, annotations: [annotation] },
      released: { ...released, content: { ...content, annotations: [annotation] } },
    };
    const privateContent = {
      ...clean.content,
      wrappedKey: 'private',
      annotations: [
        {
          ...annotation,
          ownerId: 'private',
          points: [{ ...annotation.points[0], accessToken: 'private' }],
        },
      ],
    };
    service.teacher.mockResolvedValueOnce({
      ...clean,
      privateKey: 'private',
      capture: {
        ...clean.capture,
        organizationId: 'private',
        pages: [{ ...clean.capture.pages[0], hidden: 'private' }],
        source: { ...clean.capture.source, storageKey: 'private' },
      },
      content: privateContent,
      released: { ...clean.released, providerToken: 'private', content: privateContent },
    } as unknown as TeacherFeedback);
    expect(json(await request())).toEqual(clean);
    service.command.mockResolvedValueOnce({
      ...returned,
      wrappedKey: 'private',
    } as FeedbackCommand);
    expect(json(await request(command))).toEqual(returned);
    service.teacher.mockResolvedValueOnce({
      ...state,
      content: { comment: 'x'.repeat(1048577), annotations: [] },
    });
    const oversized = await request();
    expect(oversized.status).toBe(503);
    expect(json(oversized).error.code).toBe('feedback_response_too_large');
  });
  it('reports optional configuration and routes teacher/student actions before read-only review', async () => {
    expect(json(await request('/api/health')).assignmentFeedbackConfigured).toBe(true);
    expect(
      json(await request('/api/health', { endpoint: fallback })).assignmentFeedbackConfigured,
    ).toBe(false);
    expect(json(await request())).toEqual(state);
    expect(json(await request(teacher, { method: 'PUT', body: saveBody() }))).toEqual(saved);
    expect(json(await request(release, { method: 'POST', body: releaseBody() }))).toEqual(returned);
    expect(json(await request(command))).toEqual(returned);
    expect(service.save).toHaveBeenCalledExactlyOnceWith(principal, id, JSON.parse(saveBody()), {
      signal: expect.any(AbortSignal),
    });
    principal.role = 'student';
    expect(json(await request(student))).toEqual({ capture: state.capture, released });
    expect(service.student).toHaveBeenCalledExactlyOnceWith(principal, id, {
      signal: expect.any(AbortSignal),
    });
  });
  it('fails closed without feedback composition while preserving an explicit unavailable result', async () => {
    for (const [path, method, body] of [
      [teacher, 'GET', undefined],
      [teacher, 'PUT', saveBody()],
      [release, 'POST', releaseBody()],
      [command, 'GET', undefined],
    ] as const) {
      const r = await request(path, { endpoint: fallback, method, body });
      expect(r.status).toBe(503);
      expect(json(r).error.code).toBe('feedback_unconfigured');
    }
    principal.role = 'student';
    expect((await request(student, { endpoint: fallback })).status).toBe(503);
    unused();
  });
  it('keeps accepted, rejected and recovered exact command outcomes distinct', async () => {
    const rejected = { ...saved, state: 'rejected' as const, code: 'revision_changed' as const };
    service.save.mockResolvedValueOnce(rejected);
    service.command.mockResolvedValueOnce(rejected);
    const response = await request(teacher, { method: 'PUT', body: saveBody() });
    expect(response.status).toBe(409);
    expect(json(response)).toEqual(rejected);
    const recovered = await request(command);
    expect(recovered.status).toBe(200);
    expect(json(recovered)).toEqual(rejected);
    service.command.mockRejectedValueOnce(
      new AssignmentError(404, 'feedback_command_not_found', 'Retry the exact request.'),
    );
    expect((await request(command)).status).toBe(404);
  });
  it('requires live role-bound LTI authentication before parsing content or returning feedback', async () => {
    expect(
      (await request(teacher, { method: 'PUT', body: 'malformed', headers: { cookie: undefined } }))
        .status,
    ).toBe(401);
    revoked = true;
    expect((await request(command)).status).toBe(401);
    revoked = false;
    federationActive = false;
    expect((await request()).status).toBe(403);
    federationActive = true;
    for (const role of ['student', 'viewer', 'school_admin', 'support'] as const) {
      principal.role = role;
      expect((await request()).status).toBe(403);
      expect((await request(release, { method: 'POST', body: '{' })).status).toBe(403);
    }
    principal.role = 'teacher';
    expect((await request(student)).status).toBe(403);
    principal.authenticationMethod = 'oidc';
    expect((await request()).status).toBe(403);
    unused();
  });
  it('requires trusted Origin and header CSRF for every save and explicit return', async () => {
    for (const headers of [
      { origin: undefined },
      { origin: 'https://attacker.test' },
      { 'x-csrf-token': undefined },
      { 'x-csrf-token': 'wrong' },
      { 'sec-fetch-site': 'cross-site' },
    ])
      for (const [path, method, body] of [
        [teacher, 'PUT', saveBody()],
        [release, 'POST', releaseBody()],
      ] as const)
        expect((await request(path, { method, body, headers })).status).toBe(403);
    unused();
  });
  it.each([
    '{',
    '{"a":1,"a":2}',
    '{"a":1,"\\u0061":2}',
    '['.repeat(17) + '0' + ']'.repeat(17),
    Buffer.from([0xc0, 0xaf]),
  ])('rejects malformed, duplicate-key, deep or non-UTF8 input %#', async (body) => {
    expect((await request(teacher, { method: 'PUT', body })).status).toBe(400);
    unused();
  });
  it('bounds declared and chunked bodies and refuses unsupported encoding', async () => {
    for (const headers of [{}, { 'content-length': undefined, 'transfer-encoding': 'chunked' }])
      expect(
        (
          await request(teacher, {
            method: 'PUT',
            body: 'x'.repeat(MAX_FEEDBACK_BYTES + 1025),
            headers,
          })
        ).status,
      ).toBe(413);
    for (const headers of [
      { 'content-type': 'text/plain' },
      { 'content-type': 'application/json; charset=latin1' },
      { 'content-encoding': 'gzip' },
    ])
      expect((await request(teacher, { method: 'PUT', body: saveBody(), headers })).status).toBe(
        415,
      );
    unused();
  });
  it('bounds route identifiers, query, methods, read bodies and range before service entry', async () => {
    for (const path of [
      teacher + '?studentId=x',
      command + '?x=1',
      teacher.replace(id, 'not-an-id'),
    ])
      expect((await request(path)).status).toBe(400);
    for (const path of [teacher + '/commands', release + '/extra', teacher + '/unknown'])
      expect((await request(path)).status).toBeGreaterThanOrEqual(400);
    expect((await request(teacher, { body: '{}' })).status).toBe(400);
    expect((await request(command, { headers: { range: 'bytes=0-9' } })).status).toBe(400);
    const wrong = await request(release);
    expect(wrong.status).toBe(405);
    expect(wrong.headers.allow).toBe('POST');
    expect((await request(teacher, { method: 'DELETE' })).status).toBe(405);
    principal.role = 'student';
    expect((await request(student, { method: 'PUT', body: saveBody() })).status).toBe(405);
    unused();
  });
  it('rechecks session revocation after a partial body before saving', async () => {
    let entered!: () => void;
    const checked = new Promise<void>((r) => (entered = r));
    const original = identity.authenticateRequest.bind(identity);
    vi.spyOn(identity, 'authenticateRequest').mockImplementationOnce(async (req) => {
      const value = await original(req);
      entered();
      return value;
    });
    const body = saveBody();
    const reply = new Promise<Reply>((resolve, reject) => {
      const req = raw(teacher, { method: 'PUT', body }, resolve, reject);
      req.write(body.slice(0, 10));
      void checked.then(() => {
        revoked = true;
        req.end(body.slice(10));
      });
    });
    expect((await reply).status).toBe(401);
    unused();
  });
  it('rejects a principal replacement between body admission and mutation', async () => {
    const original = identity.authenticateRequest.bind(identity);
    let calls = 0;
    vi.spyOn(identity, 'authenticateRequest').mockImplementation(async (req) => {
      const value = await original(req);
      calls++;
      return calls === 2
        ? { ...value, principal: { ...value.principal, userId: randomUUID() } }
        : value;
    });
    const r = await request(teacher, { method: 'PUT', body: saveBody() });
    expect(r.status).toBe(409);
    expect(json(r).error.code).toBe('session_changed');
    unused();
  });
  it('does not cache feedback or log document content, identifiers or credentials', async () => {
    for (const r of [
      await request(),
      await request(teacher, { method: 'PUT', body: saveBody() }),
      await request(command),
    ]) {
      expect(r.headers['cache-control']).toBe('no-store');
      expect(r.headers['x-content-type-options']).toBe('nosniff');
    }
    for (const value of [
      token,
      csrf,
      id,
      requestId,
      pin,
      content.comment,
      principal.userId,
      principal.sessionId,
    ])
      expect(JSON.stringify(logs)).not.toContain(value);
  });
  it('does not save an aborted partial request and propagates cancellation to an active save', async () => {
    let arrived!: () => void;
    const seen = new Promise<void>((resolve) => (arrived = resolve));
    const closed = new Promise<void>((resolve) =>
      server.once('request', (req) => {
        arrived();
        req.once('aborted', resolve);
      }),
    );
    const req = raw(
      teacher,
      { method: 'PUT', headers: { 'content-type': 'application/json', 'content-length': '100' } },
      () => {},
      () => {},
    );
    req.write('{');
    await seen;
    req.destroy();
    await closed;
    expect(service.save).not.toHaveBeenCalled();
    let started!: () => void, completed!: () => void;
    const executing = new Promise<void>((resolve) => (started = resolve));
    const cancelled = new Promise<void>((resolve) => (completed = resolve));
    service.save.mockImplementationOnce(async (_principal, _id, _value, options) => {
      started();
      await new Promise<void>((resolve) =>
        options!.signal!.addEventListener(
          'abort',
          () => {
            completed();
            resolve();
          },
          { once: true },
        ),
      );
      return saved;
    });
    const active = raw(
      teacher,
      { method: 'PUT', body: saveBody() },
      () => {},
      () => {},
    );
    active.end(saveBody());
    await executing;
    active.destroy();
    await cancelled;
    expect(service.save).toHaveBeenCalledTimes(1);
  });
});
