import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { cp, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { get } from 'node:https';
import type { Server } from 'node:http';
import { createApi, type ApiOptions } from '../apps/api/src/server';
import { EncryptedStore, LocalKeyProvider } from '../apps/api/src/encryption';
const master = Buffer.alloc(32, 29);
const owner = {
  token: 'synthetic-owner-a-token-at-least-32-chars',
  tenantId: 'school-a',
  userId: 'student-a',
};
const peer = {
  token: 'synthetic-owner-b-token-at-least-32-chars',
  tenantId: 'school-a',
  userId: 'student-b',
};
const foreign = {
  token: 'synthetic-foreign-token-at-least-32-chars',
  tenantId: 'school-b',
  userId: 'student-c',
};
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const fixture = Buffer.from('%PDF-1.7\nPrivate synthetic student worksheet.\n%%EOF');
let root: string;
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'margin-security-'));
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});
async function files(path: string): Promise<string[]> {
  const result: string[] = [];
  for (const item of await readdir(path, { withFileTypes: true }))
    result.push(
      ...(item.isDirectory() ? await files(join(path, item.name)) : [join(path, item.name)]),
    );
  return result;
}
async function openApi(overrides: Partial<ApiOptions> = {}) {
  const directory = await mkdtemp(join(root, 'api-'));
  const server = createApi({
    dataDirectory: directory,
    keyEncryptionKey: master,
    identities: [owner, peer, foreign],
    allowInsecureTestTransport: true,
    logger: () => {},
    ...overrides,
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const request = (path: string, init: RequestInit = {}, token = owner.token) =>
    fetch(base + path, { ...init, headers: { Authorization: `Bearer ${token}`, ...init.headers } });
  const close = () =>
    new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  const upload = async () => {
    const session = await (
      await request('/api/uploads', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          filename: 'Private worksheet.pdf',
          mimeType: 'application/pdf',
          totalSize: fixture.length,
          chunkSize: 262144,
        }),
      })
    ).json();
    expect(session.id).toBeTruthy();
    expect(
      (
        await request(`/api/uploads/${session.id}/chunks/0`, {
          method: 'PUT',
          headers: { 'X-Chunk-SHA256': hash(fixture) },
          body: new Uint8Array(fixture),
        })
      ).status,
    ).toBe(200);
    return session;
  };
  const finalize = (id: string) =>
    request(`/api/uploads/${id}/finalize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ checksum: hash(fixture) }),
    });
  return { directory, server, request, close, upload, finalize };
}
describe('authenticated encryption and private object boundaries', () => {
  it('uses unique envelope keys, stores no plaintext, rejects wrong keys, tampering and object swapping', async () => {
    const store = new EncryptedStore(root, new LocalKeyProvider(master));
    const first = join(root, 'objects', 'one.enc');
    const second = join(root, 'objects', 'two.enc');
    await store.write(first, fixture);
    await store.write(second, fixture);
    const a = await readFile(first);
    const b = await readFile(second);
    expect(a.equals(b)).toBe(false);
    expect(a.includes(fixture)).toBe(false);
    expect((await store.read(first)).equals(fixture)).toBe(true);
    const wrongKey = new EncryptedStore(root, new LocalKeyProvider(Buffer.alloc(32, 99)));
    await expect(wrongKey.read(first)).rejects.toThrow();
    await writeFile(second, a);
    await expect(store.read(second)).rejects.toThrow();
    a[a.length - 1] ^= 1;
    await writeFile(first, a);
    await expect(store.read(first)).rejects.toThrow();
  });
  it('encrypts source chunks and identifying metadata and quarantines unscanned documents', async () => {
    const api = await openApi();
    try {
      const session = await api.upload();
      let stored = await files(api.directory);
      expect(stored.some((path) => path.endsWith('.chunk.enc'))).toBe(true);
      for (const path of stored) {
        const bytes = await readFile(path);
        expect(bytes.includes(Buffer.from('Private worksheet'))).toBe(false);
        expect(bytes.includes(fixture)).toBe(false);
        expect(bytes.includes(Buffer.from('student-a'))).toBe(false);
      }
      const result = await (await api.finalize(session.id)).json();
      expect(result.securityState).toBe('quarantined');
      const denied = await api.request(`/api/documents/${result.documentId}/content`);
      expect(denied.status).toBe(423);
      expect((await denied.json()).error.code).toBe('document_quarantined');
      stored = await files(api.directory);
      expect(stored.some((path) => path.endsWith('.part.enc'))).toBe(true);
      for (const path of stored) expect((await readFile(path)).includes(fixture)).toBe(false);
    } finally {
      await api.close();
    }
  });
  it('denies another student in the same organization and a foreign organization on every object route', async () => {
    const api = await openApi();
    try {
      const session = await api.upload();
      const document = await (await api.finalize(session.id)).json();
      for (const token of [peer.token, foreign.token]) {
        expect((await api.request(`/api/uploads/${session.id}`, {}, token)).status).toBe(404);
        expect(
          (await api.request(`/api/uploads/${session.id}`, { method: 'DELETE' }, token)).status,
        ).toBe(404);
        expect(
          (await api.request(`/api/documents/${document.documentId}/content`, {}, token)).status,
        ).toBe(404);
        expect(
          (await api.request(`/api/documents/${document.documentId}`, { method: 'DELETE' }, token))
            .status,
        ).toBe(404);
        expect((await (await api.request('/api/documents', {}, token)).json()).documents).toEqual(
          [],
        );
      }
      expect(
        (await api.request(`/api/documents/${document.documentId}`, { method: 'DELETE' })).status,
      ).toBe(200);
      expect((await api.request(`/api/documents/${document.documentId}/content`)).status).toBe(404);
    } finally {
      await api.close();
    }
  });
  it('blocks expired/revoked identities and forged ownership fields', async () => {
    const expired = { ...owner, expiresAt: Date.now() - 1 };
    const revoked = { ...peer, revoked: true };
    const api = await openApi({ identities: [expired, revoked, foreign] });
    try {
      expect((await api.request('/api/documents')).status).toBe(401);
      expect((await api.request('/api/documents', {}, peer.token)).status).toBe(401);
      const forged = await api.request(
        '/api/uploads',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            filename: 'x.pdf',
            mimeType: 'application/pdf',
            totalSize: 12,
            ownerId: owner.userId,
          }),
        },
        foreign.token,
      );
      expect(forged.status).toBe(400);
    } finally {
      await api.close();
    }
  });
  it('fails closed before sending any document bytes after ciphertext tampering', async () => {
    const api = await openApi({
      inspectDocument: async () => ({
        decision: 'clean',
        reason: 'Synthetic known test fixture. No real scanner claim.',
      }),
    });
    try {
      const session = await api.upload();
      const document = await (await api.finalize(session.id)).json();
      const part = (await files(api.directory)).find((path) => path.endsWith('.part.enc'))!;
      const bytes = await readFile(part);
      bytes[bytes.length - 1] ^= 1;
      await writeFile(part, bytes);
      const response = await api.request(`/api/documents/${document.documentId}/content`);
      expect(response.status).toBe(500);
      expect(await response.text()).not.toContain('Private synthetic student');
    } finally {
      await api.close();
    }
  });
  it('restores an encrypted filesystem snapshot only with the separately supplied master key', async () => {
    const api = await openApi({
      inspectDocument: async () => ({ decision: 'clean', reason: 'Synthetic restore fixture.' }),
    });
    const session = await api.upload();
    const document = await (await api.finalize(session.id)).json();
    await api.close();
    const restoredDirectory = join(root, 'restored-snapshot');
    await cp(api.directory, restoredDirectory, { recursive: true });
    const restored = await openApi({ dataDirectory: restoredDirectory });
    try {
      const response = await restored.request(`/api/documents/${document.documentId}/content`);
      expect(response.status).toBe(200);
      expect(Buffer.from(await response.arrayBuffer()).equals(fixture)).toBe(true);
    } finally {
      await restored.close();
    }
    const wrongKey = await openApi({
      dataDirectory: restoredDirectory,
      keyEncryptionKey: Buffer.alloc(32, 11),
    });
    try {
      expect((await wrongKey.request(`/api/documents/${document.documentId}/content`)).status).toBe(
        500,
      );
    } finally {
      await wrongKey.close();
    }
  });
  it('enforces upload reservations and expiration', async () => {
    const api = await openApi({ maxStoredBytesPerUser: fixture.length - 1 });
    try {
      const rejected = await api.request('/api/uploads', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          filename: 'x.pdf',
          mimeType: 'application/pdf',
          totalSize: fixture.length,
        }),
      });
      expect(rejected.status).toBe(429);
    } finally {
      await api.close();
    }
    const expiring = await openApi({ uploadLifetimeMs: 10 });
    try {
      const response = await expiring.request('/api/uploads', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          filename: 'x.pdf',
          mimeType: 'application/pdf',
          totalSize: fixture.length,
        }),
      });
      const session = await response.json();
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect((await expiring.request(`/api/uploads/${session.id}`)).status).toBe(410);
    } finally {
      await expiring.close();
    }
  });
  it('requires HTTPS and encryption configuration outside the explicit synthetic test bypass', () => {
    expect(() =>
      createApi({ dataDirectory: root, identities: [owner], keyEncryptionKey: master }),
    ).toThrow('HTTPS is mandatory');
    expect(() =>
      createApi({ dataDirectory: root, identities: [owner], allowInsecureTestTransport: true }),
    ).toThrow('key-management provider');
  });
  it('serves an authenticated request over TLS 1.2+ using a trusted test certificate', async () => {
    const certificates = await mkdtemp(join(root, 'tls-'));
    const keyPath = join(certificates, 'key.pem');
    const certPath = join(certificates, 'cert.pem');
    execFileSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-sha256',
        '-days',
        '1',
        '-nodes',
        '-keyout',
        keyPath,
        '-out',
        certPath,
        '-subj',
        '/CN=localhost',
        '-addext',
        'subjectAltName=IP:127.0.0.1,DNS:localhost',
      ],
      { stdio: 'ignore' },
    );
    const cert = await readFile(certPath);
    const api = await openApi({
      tls: { key: await readFile(keyPath), cert },
      allowInsecureTestTransport: false,
    });
    try {
      const address = api.server.address() as { port: number };
      const status = await new Promise<number>((resolve) => {
        get(
          {
            hostname: '127.0.0.1',
            port: address.port,
            path: '/api/documents',
            ca: cert,
            minVersion: 'TLSv1.2',
            headers: { Authorization: `Bearer ${owner.token}` },
          },
          (response) => {
            response.resume();
            response.on('end', () => resolve(response.statusCode!));
          },
        ).on('error', (error) => {
          throw error;
        });
      });
      expect(status).toBe(200);
      await expect(
        new Promise((resolve, reject) => {
          get(
            {
              hostname: '127.0.0.1',
              port: address.port,
              path: '/api/documents',
              ca: cert,
              minVersion: 'TLSv1.1',
              maxVersion: 'TLSv1.1',
            },
            (response) => {
              response.resume();
              resolve(response.statusCode);
            },
          ).on('error', reject);
        }),
      ).rejects.toThrow();
    } finally {
      await api.close();
    }
  });
});
