import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request as httpsRequest, type Server } from 'node:https';
import { Configuration } from 'openid-client';
import { createApi } from '../apps/api/src/server';
import { IdentityService, SESSION_COOKIE } from '../apps/api/src/identity/service';
import { createCookieCrypto, tokenHash } from '../apps/api/src/identity/crypto';
import type { IdentityRepository, SessionPrincipal } from '../apps/api/src/identity/types';
import type { LmsService } from '../apps/api/src/lms';
import type { SourceUploadInput } from '../apps/api/src/ingestion/types';

// Real certificate-verified HTTPS and session/CSRF boundary; injected upload and identity repositories.
const origin = 'https://source-upload.synthetic.test',
  token = randomBytes(32).toString('base64url'),
  secret = randomBytes(32);
const csrf = createCookieCrypto(secret, origin).csrf(token);
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
const input: SourceUploadInput = {
  requestId: randomUUID(),
  metadata: { name: 'Private lesson.pdf', mimeType: 'application/pdf' },
  plaintextBytes: 12,
  plaintextSha256: 'a'.repeat(64),
};
const upload = { id: randomUUID(), requestId: input.requestId, status: 'pending' as const };
const privateExtra = {
  organizationId: principal.organizationId,
  receipt: 'PRIVATE-STORAGE',
  hash: input.plaintextSha256,
};
const reserve = vi.fn(async (_p: SessionPrincipal, _input: SourceUploadInput) => ({
  upload: { ...upload, ...privateExtra },
  duplicate: false,
}));
const read = vi.fn(async () => ({ ...upload, ...privateExtra }));
const put = vi.fn(async (_p: SessionPrincipal, _id: string, source: AsyncIterable<Uint8Array>) => {
  const chunks: Buffer[] = [];
  for await (const chunk of source) chunks.push(Buffer.from(chunk));
  expect(Buffer.concat(chunks).toString()).toBe('%PDF-fixture');
  return {
    upload: { ...upload, status: 'quarantined' as const, ...privateExtra },
    duplicate: false,
  };
});
let directory: string, server: Server, base: string, certificate: Buffer;
let revoked = false,
  federation = true;
const logs: Record<string, unknown>[] = [];
beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), 'margin-source-upload-http-'));
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
      clientId: 'fixture',
      clientSecret: 'fixture',
      applicationOrigin: origin,
      redirectUri: origin + '/api/auth/callback',
      sessionSecret: secret,
      identityHmacKey: randomBytes(32),
    },
    repository,
    new Configuration({ issuer: 'https://issuer.synthetic.test' }, 'fixture'),
    { authorizeLmsSession: async () => federation },
  );
  server = createApi({
    dataDirectory: join(directory, 'data'),
    identityService: identity,
    lmsService: { applicationOrigin: origin } as LmsService,
    sourceUploadService: { reserve, read, upload: put },
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
  vi.clearAllMocks();
  logs.length = 0;
  revoked = false;
  federation = true;
  principal.role = 'teacher';
  principal.authenticationMethod = 'lti';
});
type RequestOptions = {
  method?: string;
  body?: string | Buffer;
  headers?: Record<string, string | undefined>;
  stall?: boolean;
  afterWrite?: () => void;
};
function request(path = '/api/assignments/source-uploads', options: RequestOptions = {}) {
  return new Promise<{
    status: number;
    body: string;
    headers: import('node:http').IncomingHttpHeaders;
  }>((resolve, reject) => {
    const headers: Record<string, string | undefined> = {
      cookie: `${SESSION_COOKIE}=${token}`,
      origin,
      'x-csrf-token': csrf,
      'content-type': options.method === 'PUT' ? 'application/pdf' : 'application/json',
      connection: 'close',
      ...(options.body === undefined
        ? {}
        : { 'content-length': String(Buffer.byteLength(options.body)) }),
      ...options.headers,
    };
    const req = httpsRequest(
      base + path,
      {
        method: options.method ?? 'POST',
        ca: certificate,
        rejectUnauthorized: true,
        agent: false,
        headers: Object.fromEntries(Object.entries(headers).filter(([, v]) => v !== undefined)),
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          body += chunk;
        });
        res.on('end', () => {
          req.destroy();
          resolve({ status: res.statusCode!, body, headers: res.headers });
        });
      },
    );
    req.on('error', reject);
    if (options.stall) {
      req.write(options.body ?? '{');
      options.afterWrite?.();
    } else {
      req.end(options.body);
      options.afterWrite?.();
    }
  });
}
describe('teacher upload HTTPS boundary', () => {
  it('reserves and uploads under real session/CSRF checks with public-only status DTOs', async () => {
    const reserved = await request(undefined, { body: JSON.stringify(input) });
    expect(reserved.status).toBe(202);
    expect(JSON.parse(reserved.body)).toEqual({ upload, duplicate: false });
    expect(reserved.headers['cache-control']).toBe('no-store');
    const stored = await request(`/api/assignments/source-uploads/${upload.id}/content`, {
      method: 'PUT',
      body: '%PDF-fixture',
    });
    expect(stored.status).toBe(202);
    expect(JSON.parse(stored.body)).toEqual({
      upload: { ...upload, status: 'quarantined' },
      duplicate: false,
    });
    const status = await request(`/api/assignments/source-uploads/${upload.id}`, { method: 'GET' });
    expect(JSON.parse(status.body)).toEqual({ upload });
    expect(JSON.stringify(logs)).not.toContain(input.metadata.name);
    expect(stored.body).not.toContain('PRIVATE-');
    expect(status.body).not.toContain(principal.organizationId);
  });
  it.each([
    { cookie: undefined },
    { 'x-csrf-token': undefined },
    { 'x-csrf-token': 'wrong' },
    { origin: 'https://untrusted.example' },
  ])('denies missing or changed credentials %# before reservation', async (headers) => {
    const result = await request(undefined, { body: JSON.stringify(input), headers });
    expect([401, 403]).toContain(result.status);
    expect(reserve).not.toHaveBeenCalled();
  });
  it('requires a live teacher LTI session and preserves the generic document-route guard', async () => {
    for (const role of ['student', 'viewer', 'school_admin'] as const) {
      principal.role = role;
      expect((await request(undefined, { body: JSON.stringify(input) })).status).toBe(403);
    }
    principal.role = 'teacher';
    principal.authenticationMethod = 'oidc';
    expect((await request(undefined, { body: JSON.stringify(input) })).status).toBe(403);
    principal.authenticationMethod = 'lti';
    federation = false;
    expect((await request(undefined, { body: JSON.stringify(input) })).status).toBe(403);
    federation = true;
    expect((await request('/api/uploads', { body: '{}' })).status).toBe(403);
    expect(reserve).not.toHaveBeenCalled();
  });
  it.each(['organizationId', 'documentId', 'versionId', 'courseId', 'receipt', 'pageGeometry'])(
    'rejects browser-supplied %s',
    async (key) => {
      expect(
        (await request(undefined, { body: JSON.stringify({ ...input, [key]: randomUUID() }) }))
          .status,
      ).toBe(400);
      expect(reserve).not.toHaveBeenCalled();
    },
  );
  it('bounds input, disallows compressed bodies, rejects malformed UTF-8 and strict metadata extensions', async () => {
    expect((await request(undefined, { body: 'x'.repeat(4097) })).status).toBe(413);
    expect(
      (
        await request(undefined, {
          body: JSON.stringify(input),
          headers: { 'content-encoding': 'gzip' },
        })
      ).status,
    ).toBe(415);
    expect((await request(undefined, { body: Buffer.from([0xc0, 0xaf]) })).status).toBe(400);
    expect(
      (
        await request(undefined, {
          body: JSON.stringify({
            ...input,
            metadata: { ...input.metadata, storagePath: '/tmp/secret' },
          }),
        })
      ).status,
    ).toBe(400);
    expect(reserve).not.toHaveBeenCalled();
  });
  it('rejects repeated JSON fields, including escaped spellings, before assigning a request identity', async () => {
    const text = JSON.stringify(input);
    for (const repeated of [
      '{"requestId":"' + randomUUID() + '",' + text.slice(1),
      '{"request\\u0049d":"' + input.requestId + '",' + text.slice(1),
      text.replace('"name":', '"name":"other.pdf","name":'),
    ])
      expect((await request(undefined, { body: repeated })).status).toBe(400);
    expect(reserve).not.toHaveBeenCalled();
  });
  it('rejects route/method/query/range exceptions and non-PDF content before upload', async () => {
    const path = `/api/assignments/source-uploads/${upload.id}`;
    expect((await request(path + '?courseId=other', { method: 'GET' })).status).toBe(400);
    expect((await request(path, { method: 'GET', headers: { range: 'bytes=0-9' } })).status).toBe(
      400,
    );
    expect((await request(path, { method: 'GET', body: 'x' })).status).toBe(413);
    expect(
      (await request(path + '/content', { method: 'POST', body: '%PDF-fixture' })).status,
    ).toBe(405);
    expect(
      (
        await request(path + '/content', {
          method: 'PUT',
          body: '%PDF-fixture',
          headers: { 'content-type': 'text/plain' },
        })
      ).status,
    ).toBe(415);
    expect(
      (
        await request(path + '/content', {
          method: 'PUT',
          body: '',
          headers: { 'content-length': String(100 * 1024 * 1024 + 1) },
        })
      ).status,
    ).toBe(413);
    expect(put).not.toHaveBeenCalled();
  });
  it('bounds a stalled reservation body and leaves the API usable', async () => {
    const result = await request(undefined, {
      body: '{',
      headers: { 'content-length': '300' },
      stall: true,
    });
    expect(result.status).toBe(408);
    expect(reserve).not.toHaveBeenCalled();
    expect((await request(undefined, { body: JSON.stringify(input) })).status).toBe(202);
  }, 10000);
});
