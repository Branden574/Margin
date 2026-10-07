import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request as httpsRequest, type Server } from 'node:https';
import { Configuration } from 'openid-client';
import { createApi } from '../apps/api/src/server';
import { IdentityService, SESSION_COOKIE } from '../apps/api/src/identity/service';
import { tokenHash } from '../apps/api/src/identity/crypto';
import type { IdentityRepository, SessionPrincipal } from '../apps/api/src/identity/types';
import type { LmsService, VerifiedLmsEnrollment } from '../apps/api/src/lms';
import { AssignmentService, type AssignmentRepository } from '../apps/api/src/assignments';
import type { CanvasAssignmentService } from '../apps/api/src/assignment-routes';

// Real HTTPS/authenticated route/service; synthetic identity and catalog repositories.
// Ownership/scan/envelope tests use actual PostgreSQL in the companion suite.
const origin = 'https://catalog.synthetic.test',
  token = randomBytes(32).toString('base64url');
const principal: SessionPrincipal = {
  sessionId: randomUUID(),
  userId: randomUUID(),
  organizationId: randomUUID(),
  role: 'teacher',
  authenticationMethod: 'lti',
  mfa: false,
  createdAt: Date.now(),
  lastSeenAt: Date.now(),
  expiresAt: Date.now() + 3600000,
};
const enrollment: VerifiedLmsEnrollment = {
  installationId: randomUUID(),
  registrationVersion: 1,
  organizationId: principal.organizationId,
  userId: principal.userId,
  courseId: randomUUID(),
  role: 'teacher',
  subjectDigest: 'a'.repeat(64),
  courseDigest: 'b'.repeat(64),
};
const candidate = {
  documentId: randomUUID(),
  versionId: randomUUID(),
  name: 'Private owned worksheet.pdf',
  pageCount: 2,
  bytes: 1234,
  inspection: 'approved' as const,
  availability: 'not-checked' as const,
};
let revoked = false,
  federationActive = true,
  enrolled = true,
  configured = true;
const list = vi.fn(
  async (_principal: SessionPrincipal, _after?: string, _options?: { signal?: AbortSignal }) => ({
    sources: [
      {
        ...candidate,
        artifactId: 'PRIVATE-ARTIFACT',
        receipt: 'PRIVATE-RECEIPT',
        sha256: 'PRIVATE-HASH',
      },
    ],
    nextCursor: null as string | null,
  }),
);
const authorizer = {
  resolveEnrollment: async () => null,
  getSessionEnrollment: vi.fn(async () => (enrolled ? { ...enrollment } : null)),
};
const service = new AssignmentService({
  repository: {} as AssignmentRepository,
  authorizer,
  installations: { findById: async () => null },
  sourceCatalog: { list },
  resourceHmacKey: randomBytes(32),
});
const unconfigured = new AssignmentService({
  repository: {} as AssignmentRepository,
  authorizer,
  installations: { findById: async () => null },
  resourceHmacKey: randomBytes(32),
});
const unused = async () => {
  throw new Error('Unrelated assignment action invoked');
};
const assignments: CanvasAssignmentService = {
  create: unused,
  currentSelection: unused,
  currentAssignment: unused,
  completeDeepLink: unused,
  reserveStudentWork: unused,
  listSources: (...args) => (configured ? service : unconfigured).listSources(...args),
};
let directory: string, server: Server, base: string, certificate: Buffer;
const logs: Record<string, unknown>[] = [];
beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), 'margin-source-catalog-http-'));
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
      issuerUrl: 'https://issuer.synthetic.test',
      clientId: 'synthetic-client',
      clientSecret: 'synthetic-secret',
      applicationOrigin: origin,
      redirectUri: origin + '/api/auth/callback',
      sessionSecret: randomBytes(32),
      identityHmacKey: randomBytes(32),
    },
    repository,
    new Configuration({ issuer: 'https://issuer.synthetic.test' }, 'synthetic-client'),
    { authorizeLmsSession: async () => federationActive },
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
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  base = `https://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(async () => {
  service.close();
  unconfigured.close();
  if (server) await new Promise<void>((done) => server.close(() => done()));
  if (directory) rmSync(directory, { recursive: true, force: true });
});
beforeEach(() => {
  revoked = false;
  federationActive = true;
  enrolled = true;
  configured = true;
  principal.role = 'teacher';
  principal.authenticationMethod = 'lti';
  vi.clearAllMocks();
  logs.length = 0;
});
function request(
  path = '/api/assignments/sources',
  options: { method?: string; body?: string; cookie?: boolean } = {},
) {
  return new Promise<{
    status: number;
    headers: import('node:http').IncomingHttpHeaders;
    body: string;
  }>((resolve, reject) => {
    const req = httpsRequest(
      base + path,
      {
        method: options.method ?? 'GET',
        ca: certificate,
        rejectUnauthorized: true,
        headers: {
          ...(options.cookie === false ? {} : { cookie: `${SESSION_COOKIE}=${token}` }),
          ...(options.body !== undefined
            ? { 'content-length': String(Buffer.byteLength(options.body)) }
            : {}),
        },
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (part) => {
          body += part;
        });
        res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body }));
      },
    );
    req.on('error', reject);
    req.end(options.body);
  });
}
describe('teacher source catalog HTTPS boundary', () => {
  it('returns a metadata allowlist with no-store and explicit unchecked availability', async () => {
    const response = await request();
    expect(response.status).toBe(200);
    expect(response.headers['cache-control']).toContain('no-store');
    expect(JSON.parse(response.body)).toEqual({ sources: [candidate], nextCursor: null });
    expect(response.body).not.toContain('PRIVATE-');
    expect(list).toHaveBeenCalledWith(principal, undefined, { signal: expect.any(AbortSignal) });
    expect(authorizer.getSessionEnrollment).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(logs)).not.toContain(candidate.name);
  });
  it('passes only a bounded optional cursor and denies browser-provided authority', async () => {
    const cursor = Buffer.from(`${candidate.documentId}:${candidate.versionId}`).toString(
      'base64url',
    );
    expect((await request('/api/assignments/sources?after=' + cursor)).status).toBe(200);
    expect(list.mock.calls[0][1]).toBe(cursor);
    for (const query of [
      'after=',
      'after=a&after=b',
      'ownerId=' + principal.userId,
      'courseId=' + enrollment.courseId,
      'limit=500',
      'after=' + 'a'.repeat(129),
      'after=%2F',
    ])
      expect((await request('/api/assignments/sources?' + query)).status).toBe(400);
    expect(list).toHaveBeenCalledTimes(1);
  });
  it('requires a live teacher LTI session before catalog disclosure', async () => {
    expect((await request(undefined, { cookie: false })).status).toBe(401);
    revoked = true;
    expect((await request()).status).toBe(401);
    revoked = false;
    federationActive = false;
    expect((await request()).status).toBe(403);
    federationActive = true;
    principal.authenticationMethod = 'oidc';
    expect((await request()).status).toBe(403);
    principal.authenticationMethod = 'lti';
    for (const role of ['student', 'viewer', 'school_admin'] as const) {
      principal.role = role;
      expect((await request()).status).toBe(403);
    }
    expect(list).not.toHaveBeenCalled();
  });
  it('denies expired enrollment and missing catalog composition without making up an empty result', async () => {
    enrolled = false;
    expect((await request()).status).toBe(403);
    expect(list).not.toHaveBeenCalled();
    enrolled = true;
    configured = false;
    const response = await request();
    expect(response.status).toBe(503);
    expect(JSON.parse(response.body).error.code).toBe('source_catalog_unconfigured');
    expect(list).not.toHaveBeenCalled();
  });
  it('rechecks course enrollment after discovery and withholds the complete metadata result on revocation', async () => {
    list.mockImplementationOnce(async () => {
      enrolled = false;
      return {
        sources: [
          {
            ...candidate,
            artifactId: 'PRIVATE-ARTIFACT',
            receipt: 'PRIVATE-RECEIPT',
            sha256: 'PRIVATE-HASH',
          },
        ],
        nextCursor: null,
      };
    });
    const response = await request();
    expect(response.status).toBe(403);
    expect(response.body).not.toContain(candidate.name);
  });
  it('rejects bodies, unsupported methods and query exceptions on other assignment routes', async () => {
    expect((await request(undefined, { body: '{}' })).status).toBe(400);
    expect((await request(undefined, { method: 'HEAD' })).status).toBe(405);
    // No CSRF grant exists for a mutation; it cannot reach the read-only catalog.
    expect((await request(undefined, { method: 'POST', body: '{}' })).status).toBe(403);
    expect((await request('/api/assignments/current?after=a')).status).toBe(400);
    expect(list).not.toHaveBeenCalled();
  });
});
