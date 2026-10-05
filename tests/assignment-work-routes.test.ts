import type { AssignmentWorkService } from '../apps/api/src/assignments/work';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request as httpsRequest, type Server } from 'node:https';
import { Configuration } from 'openid-client';
import { createApi } from '../apps/api/src/server';
import { IdentityService, SESSION_COOKIE } from '../apps/api/src/identity/service';
import { tokenHash, createCookieCrypto } from '../apps/api/src/identity/crypto';
import type { IdentityRepository, SessionPrincipal } from '../apps/api/src/identity/types';
import type { LmsService } from '../apps/api/src/lms';
import { AssignmentError, deepLinkForm, type AssignmentRecord } from '../apps/api/src/assignments';
import type { CanvasAssignmentService } from '../apps/api/src/assignment-routes';

// HTTP composition contract: real TLS/identity/CSRF code, synthetic session and assignment repositories.
// Actual PostgreSQL ownership, launch and RLS behavior is covered in the separate integration suites.
const applicationOrigin = 'https://workspace.margin.test';
const token = randomBytes(32).toString('base64url');
const sessionSecret = randomBytes(32);
const csrf = createCookieCrypto(sessionSecret, applicationOrigin).csrf(token);
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
const record: AssignmentRecord = {
  id: randomUUID(),
  organizationId: principal.organizationId,
  installationId: randomUUID(),
  courseId: randomUUID(),
  createdBy: principal.userId,
  createdAt: new Date().toISOString(),
  title: 'Synthetic assignment',
  instructions: 'Work only in your private copy.',
  policy: {
    allowedTools: ['text'],
    allowExport: false,
    allowCopyPaste: false,
    allowReadAloud: true,
    assessment: false,
  },
  source: {
    organizationId: principal.organizationId,
    ownerId: principal.userId,
    documentId: randomUUID(),
    versionId: randomUUID(),
    artifactId: randomUUID(),
    artifactVersion: 'private-storage-version',
    sha256: 'a'.repeat(64),
    scanReceiptId: randomUUID(),
    inspectionStatus: 'ready',
    encrypted: true,
    pageCount: 2,
  },
};
const selectionId = randomUUID();
let revoked = false,
  federationActive = true;
const assignments: CanvasAssignmentService = {
  create: vi.fn(async () => record),
  currentSelection: vi.fn(async () => ({
    id: selectionId,
    courseId: record.courseId,
    expiresAt: Date.now() + 600000,
  })),
  currentAssignment: vi.fn(async () => record),
  completeDeepLink: vi.fn(async () =>
    deepLinkForm({ returnUrl: 'https://school.test.instructure.com/return', JWT: 'e30.e30.Zg' }),
  ),
  reserveStudentWork: vi.fn(async () => ({
    id: randomUUID(),
    assignmentId: record.id,
    userId: principal.userId,
    documentId: randomUUID(),
    versionId: randomUUID(),
    status: 'pending' as const,
    duplicate: false,
  })),
};
let delivered: Buffer | undefined;
const workId = randomUUID(),
  studentDoc = randomUUID(),
  version = randomUUID();
const workService: AssignmentWorkService = {
  describe: vi.fn(async () => ({
    assignment: {
      id: record.id,
      title: record.title,
      instructions: record.instructions,
      policy: record.policy,
    },
    work: { id: workId, status: 'pending' as const },
  })),
  source: vi.fn(async () => {
    delivered = Buffer.from('%PDF authenticated synthetic source bytes');
    return delivered;
  }),
  append: vi.fn(async () => ({
    operationId: randomUUID(),
    cursor: 1,
    annotationRevision: 1,
    duplicate: false,
  })),
  catchUp: vi.fn(async () => ({
    documentId: studentDoc,
    versionId: version,
    operations: [],
    nextCursor: 0,
    currentCursor: 0,
    hasMore: false,
  })),
};
let directory: string, server: Server, base: string, certificate: Buffer;
const logs: Record<string, unknown>[] = [];
beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), 'margin-assignment-http-'));
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
  const identity = new IdentityService(
    {
      issuerUrl: 'https://issuer.margin.test',
      clientId: 'synthetic-client',
      clientSecret: 'synthetic-client-secret',
      applicationOrigin,
      redirectUri: applicationOrigin + '/api/auth/callback',
      sessionSecret,
      identityHmacKey: randomBytes(32),
    },
    repository,
    new Configuration({ issuer: 'https://issuer.margin.test' }, 'synthetic-client'),
    { authorizeLmsSession: async () => federationActive },
  );
  server = createApi({
    dataDirectory: join(directory, 'data'),
    identityService: identity,
    // The LMS handler is never invoked in these adapter tests; no synthetic launch is treated as verified.
    lmsService: { applicationOrigin } as LmsService,
    assignmentService: assignments,
    assignmentWorkService: workService,
    keyEncryptionKey: randomBytes(32),
    tls: { key: readFileSync(pair.keyPath), cert: certificate },
    logger: (entry) => logs.push(entry),
  }) as Server;
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `https://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(async () => {
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  if (directory) rmSync(directory, { recursive: true, force: true });
});
beforeEach(() => {
  revoked = false;
  federationActive = true;
  principal.role = 'student';
  principal.authenticationMethod = 'lti';
  vi.clearAllMocks();
  logs.length = 0;
});
function request(
  path: string,
  options: {
    method?: string;
    body?: string | Buffer;
    headers?: Record<string, string | undefined>;
  } = {},
) {
  return new Promise<{
    status: number;
    headers: import('node:http').IncomingHttpHeaders;
    body: string;
  }>((resolve, reject) => {
    const headers: Record<string, string | undefined> = {
      cookie: `${SESSION_COOKIE}=${token}`,
      origin: applicationOrigin,
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
      base + path,
      {
        method: options.method ?? 'GET',
        ca: certificate,
        rejectUnauthorized: true,
        headers: Object.fromEntries(Object.entries(headers).filter(([, v]) => v !== undefined)),
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
const post = (body = '{}') => ({ method: 'POST', body });
describe('Student assignment work HTTPS adapter with real identity/CSRF and synthetic work service', () => {
  it('requires current authenticated LTI student sessions', async () => {
    expect(
      (await request('/api/assignments/work', { headers: { cookie: undefined } })).status,
    ).toBe(401);
    revoked = true;
    expect((await request('/api/assignments/work')).status).toBe(401);
    revoked = false;
    federationActive = false;
    expect((await request('/api/assignments/work')).status).toBe(403);
    federationActive = true;
    principal.authenticationMethod = 'oidc';
    expect((await request('/api/assignments/work')).status).toBe(403);
    principal.authenticationMethod = 'lti';
    for (const role of ['teacher', 'viewer', 'school_admin'] as const) {
      principal.role = role;
      expect((await request('/api/assignments/work')).status).toBe(403);
    }
    expect(workService.describe).not.toHaveBeenCalled();
  });
  it('routes manifest/source/operations and retains reservation behavior', async () => {
    expect(JSON.parse((await request('/api/health')).body)).toMatchObject({
      assignmentsConfigured: true,
      assignmentWorkConfigured: true,
    });
    const view = await request('/api/assignments/work');
    expect(view.status).toBe(200);
    expect(JSON.parse(view.body).work).toEqual({ id: workId, status: 'pending' });
    expect(view.body).not.toContain(record.source.artifactId);
    expect((await request('/api/assignments/work', post())).status).toBe(202);
    expect(assignments.reserveStudentWork).toHaveBeenCalledWith(
      expect.objectContaining({ userId: principal.userId }),
    );
    expect((await request('/api/assignments/work/operations?afterCursor=1&limit=5')).status).toBe(
      200,
    );
    expect(workService.catchUp).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: principal.sessionId }),
      { afterCursor: 1, limit: 5 },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(
      (await request('/api/assignments/work/operations', post('{"synthetic":"operation"}'))).status,
    ).toBe(200);
  });
  it('delivers source bytes intact and clears the server buffer after HTTPS flush', async () => {
    const result = await request('/api/assignments/work/source');
    expect(result.status).toBe(200);
    expect(result.body).toBe('%PDF authenticated synthetic source bytes');
    expect(result.headers['content-type']).toBe('application/pdf');
    expect(result.headers['cache-control']).toBe('no-store');
    expect(result.headers['x-content-type-options']).toBe('nosniff');
    expect(result.headers['content-disposition']).toBe('inline; filename="assignment.pdf"');
    await new Promise((r) => setImmediate(r));
    expect(delivered?.every((v) => v === 0)).toBe(true);
  });
  it('enforces CSRF, exact methods, bounded queries, range denial and body size', async () => {
    expect(
      (
        await request('/api/assignments/work/operations', {
          ...post(),
          headers: { 'x-csrf-token': undefined },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await request('/api/assignments/work/operations', {
          ...post(),
          headers: { origin: 'https://attacker.test' },
        })
      ).status,
    ).toBe(403);
    for (const path of [
      '/api/assignments/work?documentId=x',
      '/api/assignments/work/source?workId=x',
      '/api/assignments/work/operations?afterCursor=1&afterCursor=2',
      '/api/assignments/work/operations?limit=-1',
      '/api/assignments/work/operations?studentId=x',
    ])
      expect((await request(path)).status).toBe(400);
    expect(
      (await request('/api/assignments/work/source', { headers: { range: 'bytes=0-10' } })).status,
    ).toBe(400);
    expect((await request('/api/assignments/work/source', post())).status).toBe(405);
    expect(
      (
        await request(
          '/api/assignments/work/operations',
          post(JSON.stringify({ text: 'x'.repeat(66000) })),
        )
      ).status,
    ).toBe(413);
    expect(workService.append).not.toHaveBeenCalled();
  });
  it('aborts disconnected requests and disposes late source bytes', async () => {
    let release!: (value: Buffer) => void;
    let signal: AbortSignal | undefined;
    let begin!: () => void;
    const started = new Promise<void>((r) => (begin = r));
    vi.mocked(workService.source).mockImplementationOnce(async (_p, options) => {
      signal = options?.signal;
      begin();
      return new Promise<Buffer>((r) => (release = r));
    });
    const req = httpsRequest(base + '/api/assignments/work/source', {
      ca: certificate,
      rejectUnauthorized: true,
      headers: { cookie: `${SESSION_COOKIE}=${token}`, origin: applicationOrigin },
    });
    req.on('error', () => {});
    req.end();
    await started;
    req.destroy();
    const deadline = Date.now() + 1000;
    while (!signal?.aborted && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
    expect(signal?.aborted).toBe(true);
    const late = Buffer.from('private late source');
    release(late);
    await new Promise((r) => setTimeout(r, 20));
    expect(late.every((v) => v === 0)).toBe(true);
  });
  it('preserves generic LTI denial and safe errors without logging plaintext', async () => {
    for (const path of ['/api/documents', '/api/uploads', '/api/sync/documents/' + studentDoc])
      expect((await request(path)).status).toBe(403);
    vi.mocked(workService.source).mockRejectedValueOnce(
      new AssignmentError(
        409,
        'restricted_delivery_unavailable',
        'Restricted delivery is unavailable.',
      ),
    );
    expect(JSON.parse((await request('/api/assignments/work/source')).body).error.code).toBe(
      'restricted_delivery_unavailable',
    );
    await request('/api/assignments/work/operations', post('{"text":"Private student answer"}'));
    expect(JSON.stringify(logs)).not.toContain('Private student answer');
    expect(JSON.stringify(logs)).not.toContain(token);
  });
  it('bounds simultaneous source responses and releases admission after failures', async () => {
    const waiting: Array<{ resolve: (bytes: Buffer) => void; reject: (error: Error) => void }> = [];
    const stalled = async () =>
      new Promise<Buffer>((resolve, reject) => waiting.push({ resolve, reject }));
    vi.mocked(workService.source).mockImplementationOnce(stalled).mockImplementationOnce(stalled);
    const first = request('/api/assignments/work/source'),
      second = request('/api/assignments/work/source');
    try {
      const deadline = Date.now() + 1500;
      while (waiting.length < 2 && Date.now() < deadline)
        await new Promise((r) => setTimeout(r, 5));
      expect(waiting).toHaveLength(2);
      expect((await request('/api/assignments/work/source')).status).toBe(503);
      expect(workService.source).toHaveBeenCalledTimes(2);
      waiting[0].reject(new AssignmentError(503, 'source_unavailable', 'Source unavailable.'));
      expect((await first).status).toBe(503);
      expect((await request('/api/assignments/work/source')).status).toBe(200);
      waiting[1].resolve(Buffer.from('%PDF second'));
      expect((await second).body).toBe('%PDF second');
    } finally {
      for (const w of waiting) w.reject(new Error('Fixture cleanup'));
      await Promise.allSettled([first, second]);
    }
  });
});
