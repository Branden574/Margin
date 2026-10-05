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
  principal.role = 'teacher';
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
describe('Canvas assignment HTTP boundary', () => {
  it('reports authoring composition independently from student work composition', async () => {
    expect(JSON.parse((await request('/api/health')).body)).toMatchObject({
      assignmentsConfigured: true,
      assignmentWorkConfigured: false,
    });
  });
  it('requires fresh authenticated Canvas sessions before any assignment read', async () => {
    expect(
      (await request('/api/assignments/current', { headers: { cookie: undefined } })).status,
    ).toBe(401);
    revoked = true;
    expect((await request('/api/assignments/current')).status).toBe(401);
    revoked = false;
    federationActive = false;
    expect((await request('/api/assignments/current')).status).toBe(403);
    federationActive = true;
    principal.authenticationMethod = 'oidc';
    expect((await request('/api/assignments/current')).status).toBe(403);
    expect(assignments.currentAssignment).not.toHaveBeenCalled();
  });
  it('checks mutation origin, CSRF and role before creating an assignment', async () => {
    for (const headers of [
      { 'x-csrf-token': undefined },
      { origin: undefined },
      { origin: 'https://attacker.test' },
    ])
      expect((await request('/api/assignments', { ...post(), headers })).status).toBe(403);
    principal.role = 'viewer';
    expect((await request('/api/assignments', post())).status).toBe(403);
    expect(assignments.create).not.toHaveBeenCalled();
  });
  it('returns only the bound assignment view and keeps private source receipts server-side', async () => {
    const result = await request('/api/assignments/current');
    expect(result.status).toBe(200);
    expect(JSON.parse(result.body)).toEqual({
      assignment: {
        id: record.id,
        title: record.title,
        instructions: record.instructions,
        policy: record.policy,
        createdAt: record.createdAt,
      },
    });
    expect(result.body).not.toContain('private-storage-version');
    expect(assignments.currentAssignment).toHaveBeenCalledWith(principal);
    expect(result.headers['cache-control']).toBe('no-store');
  });
  it('forwards validated body scope to the service while ownership comes only from the current principal', async () => {
    const input = { requestId: randomUUID(), title: record.title };
    const result = await request('/api/assignments', post(JSON.stringify(input)));
    expect(result.status).toBe(201);
    expect(assignments.create).toHaveBeenCalledWith(principal, input);
    expect(JSON.parse(result.body).assignment.source).toBeUndefined();
  });
  it('reports only pending work and refuses client-selected users, courses and assignments', async () => {
    principal.role = 'student';
    for (const key of ['userId', 'courseId', 'assignmentId', 'documentId'])
      expect(
        (await request('/api/assignments/work', post(JSON.stringify({ [key]: randomUUID() }))))
          .status,
      ).toBe(400);
    expect(assignments.reserveStudentWork).not.toHaveBeenCalled();
    const result = await request('/api/assignments/work', post());
    expect(result.status).toBe(202);
    expect(JSON.parse(result.body).work.status).toBe('pending');
    expect(assignments.reserveStudentWork).toHaveBeenCalledWith(principal);
  });
  it('returns the signed return document with its restricted CSP for selection or explicit cancellation', async () => {
    for (const assignmentId of [record.id, null]) {
      const result = await request(
        `/api/assignments/selections/${selectionId}/complete`,
        post(JSON.stringify({ assignmentId })),
      );
      expect(result.status).toBe(200);
      expect(result.headers['content-type']).toContain('text/html');
      expect(result.headers['content-security-policy']).toContain(
        'form-action https://school.test.instructure.com',
      );
      expect(result.headers['content-security-policy']).toContain("frame-ancestors 'none'");
      expect(result.headers['x-frame-options']).toBe('DENY');
      expect(assignments.completeDeepLink).toHaveBeenLastCalledWith(
        principal,
        selectionId,
        assignmentId,
      );
    }
    for (const value of [
      {},
      { assignmentId: '' },
      { assignmentId: record.id, returnUrl: 'https://attacker.test' },
    ])
      expect(
        (
          await request(
            `/api/assignments/selections/${selectionId}/complete`,
            post(JSON.stringify(value)),
          )
        ).status,
      ).toBe(400);
    expect(assignments.completeDeepLink).toHaveBeenCalledTimes(2);
  });
  it('bounds and validates bodies, queries and methods without invoking the service', async () => {
    for (const body of ['null', '[]', '{', Buffer.from([0xc0, 0xaf])])
      expect((await request('/api/assignments', { method: 'POST', body })).status).toBe(400);
    expect((await request('/api/assignments', post('x'.repeat(65537)))).status).toBe(413);
    expect(
      (
        await request('/api/assignments', {
          ...post('x'.repeat(65537)),
          headers: { 'content-length': undefined },
        })
      ).status,
    ).toBe(413);
    expect(
      (await request('/api/assignments', { ...post(), headers: { 'content-type': 'text/plain' } }))
        .status,
    ).toBe(415);
    expect(
      (await request('/api/assignments', { ...post(), headers: { 'content-encoding': 'gzip' } }))
        .status,
    ).toBe(415);
    expect((await request('/api/assignments/current?userId=x')).status).toBe(400);
    const method = await request('/api/assignments/current', post());
    expect(method.status).toBe(405);
    expect(method.headers.allow).toBe('GET');
    expect((await request('/api/assignments/capture-launch', post())).status).toBe(404);
    expect(assignments.create).not.toHaveBeenCalled();
  });
  it('ends a stalled body after the bounded deadline and keeps the service available', async () => {
    const status = await new Promise<number>((resolve, reject) => {
      const req = httpsRequest(
        base + '/api/assignments',
        {
          method: 'POST',
          ca: certificate,
          rejectUnauthorized: true,
          headers: {
            cookie: `${SESSION_COOKIE}=${token}`,
            origin: applicationOrigin,
            'x-csrf-token': csrf,
            'content-type': 'application/json',
            'content-length': '100',
          },
        },
        (res) => {
          res.resume();
          res.on('end', () => {
            resolve(res.statusCode!);
            req.destroy();
          });
        },
      );
      req.on('error', reject);
      req.write('{');
    });
    expect(status).toBe(408);
    expect(assignments.create).not.toHaveBeenCalled();
    expect((await request('/api/assignments/current')).status).toBe(200);
  }, 10000);
  it('preserves generic document, upload and sync denial for LTI sessions', async () => {
    for (const path of ['/api/documents', '/api/uploads', '/api/sync/documents/' + randomUUID()]) {
      const result = await request(path);
      expect(result.status).toBe(403);
      expect(JSON.parse(result.body).error.code).toBe('lms_resource_scope_required');
    }
  });
  it('preserves safe service errors and does not log student content or signing responses', async () => {
    vi.mocked(assignments.currentAssignment).mockRejectedValueOnce(
      new AssignmentError(
        409,
        'source_unavailable',
        'The assignment source is no longer approved.',
      ),
    );
    const result = await request('/api/assignments/current');
    expect(result.status).toBe(409);
    expect(JSON.parse(result.body).error.code).toBe('source_unavailable');
    await request(
      '/api/assignments',
      post(JSON.stringify({ instructions: 'Private synthetic answer' })),
    );
    expect(JSON.stringify(logs)).not.toContain('Private synthetic answer');
    expect(JSON.stringify(logs)).not.toContain(token);
  });
});
