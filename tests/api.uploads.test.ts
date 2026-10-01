import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import type { Server } from 'node:http';
import { createApi } from '../apps/api/src/server';
const tokenA = 'test-tenant-a-token-that-is-at-least-32-chars';
const tokenB = 'test-tenant-b-token-that-is-at-least-32-chars';
const chunkSize = 256 * 1024;
const checksum = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
function pdf(size = 120) {
  const bytes = Buffer.alloc(size, 32);
  bytes.write('%PDF-1.7\n');
  bytes.write('\n%%EOF', size - 6);
  return bytes;
}
let directory: string;
let server: Server;
let base: string;
async function start() {
  server = createApi({
    dataDirectory: directory,
    keyEncryptionKey: Buffer.alloc(32, 19),
    allowInsecureTestTransport: true,
    identities: [
      { token: tokenA, tenantId: 'school-a', userId: 'student-a' },
      { token: tokenB, tenantId: 'school-b', userId: 'student-b' },
    ],
    inspectDocument: async () => ({
      decision: 'clean',
      reason: 'Known synthetic test fixture; not a production scanner.',
    }),
    logger: () => {},
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}
async function stop() {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}
async function request(path: string, options: RequestInit = {}, token = tokenA) {
  return fetch(`${base}${path}`, {
    ...options,
    headers: { Authorization: `Bearer ${token}`, ...options.headers },
  });
}
async function create(
  bytes: Buffer,
  extra: Record<string, unknown> = {},
  headers: Record<string, string> = {},
) {
  return request('/api/uploads', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({
      filename: 'worksheet.pdf',
      mimeType: 'application/pdf',
      totalSize: bytes.length,
      chunkSize,
      ...extra,
    }),
  });
}
async function put(id: string, index: number, bytes: Buffer, hash = checksum(bytes)) {
  return request(`/api/uploads/${id}/chunks/${index}`, {
    method: 'PUT',
    headers: { 'X-Chunk-SHA256': hash },
    body: new Uint8Array(bytes),
  });
}
async function finalize(id: string, extra = {}) {
  return request(`/api/uploads/${id}/finalize`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(extra),
  });
}
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'margin-api-'));
  await start();
});
afterAll(async () => {
  await stop();
  await rm(directory, { recursive: true, force: true });
});
describe('durable authenticated uploads', () => {
  it('requires authentication and rejects untrusted browser origins', async () => {
    expect((await fetch(`${base}/api/uploads`)).status).toBe(401);
    expect(
      (await request('/api/health', { headers: { Origin: 'https://untrusted.example' } })).status,
    ).toBe(403);
    const allowed = await request('/api/health', { headers: { Origin: 'https://localhost:5173' } });
    expect(allowed.headers.get('access-control-allow-origin')).toBe('https://localhost:5173');
  });
  it('replays upload creation without duplicating sessions and rejects changed input', async () => {
    const bytes = pdf();
    const first = await create(bytes, {}, { 'Idempotency-Key': 'retry-session' });
    const a = await first.json();
    const second = await create(bytes, {}, { 'Idempotency-Key': 'retry-session' });
    expect((await second.json()).id).toBe(a.id);
    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect(
      (await create(bytes, { filename: 'different.pdf' }, { 'Idempotency-Key': 'retry-session' }))
        .status,
    ).toBe(409);
  });
  it('rejects missing, corrupt, undersized and oversized chunks without recording them', async () => {
    const bytes = pdf();
    const { id } = await (await create(bytes)).json();
    expect((await finalize(id)).status).toBe(409);
    expect((await put(id, 0, bytes, '0'.repeat(64))).status).toBe(422);
    expect((await put(id, 0, bytes.subarray(1))).status).toBe(400);
    expect((await put(id, 0, Buffer.concat([bytes, Buffer.from('x')]))).status).toBe(413);
    expect((await put(id, 1, bytes)).status).toBe(400);
    expect((await (await request(`/api/uploads/${id}`)).json()).uploadedChunks).toEqual([]);
  });
  it('supports out-of-order chunks, concurrent duplicate retries, finalize retries and exact download', async () => {
    const bytes = pdf(chunkSize + 99);
    const { id } = await (await create(bytes)).json();
    const last = bytes.subarray(chunkSize);
    const first = bytes.subarray(0, chunkSize);
    const responses = await Promise.all([put(id, 1, last), put(id, 1, last), put(id, 0, first)]);
    expect(responses.map((r) => r.status)).toEqual([200, 200, 200]);
    expect((await responses[1].json()).duplicate).toBe(true);
    expect((await (await request(`/api/uploads/${id}`)).json()).uploadedChunks).toEqual([0, 1]);
    const done = await finalize(id, { checksum: checksum(bytes) });
    expect(done.status).toBe(200);
    const document = await done.json();
    expect((await (await finalize(id)).json()).documentId).toBe(document.documentId);
    const content = await request(`/api/documents/${document.documentId}/content`);
    expect(Buffer.from(await content.arrayBuffer()).equals(bytes)).toBe(true);
    expect(content.headers.get('content-disposition')).toContain('attachment;');
    expect((await put(id, 0, first)).status).toBe(200);
    expect((await finalize(id, { checksum: '0'.repeat(64) })).status).toBe(422);
  });
  it('persists acknowledged chunks across a process restart', async () => {
    const bytes = pdf(chunkSize + 12);
    const { id } = await (await create(bytes)).json();
    expect((await put(id, 0, bytes.subarray(0, chunkSize))).status).toBe(200);
    await stop();
    await start();
    expect((await (await request(`/api/uploads/${id}`)).json()).uploadedChunks).toEqual([0]);
    expect((await put(id, 1, bytes.subarray(chunkSize))).status).toBe(200);
    expect((await finalize(id)).status).toBe(200);
  });
  it('enforces tenant isolation for sessions and stored document bytes', async () => {
    const bytes = pdf();
    const { id } = await (await create(bytes)).json();
    expect((await request(`/api/uploads/${id}`, {}, tokenB)).status).toBe(404);
    await put(id, 0, bytes);
    const { documentId } = await (await finalize(id)).json();
    expect((await request(`/api/documents/${documentId}/content`, {}, tokenB)).status).toBe(404);
    expect((await (await request('/api/documents', {}, tokenB)).json()).documents).toEqual([]);
  });
  it('rejects MIME spoofing and a mismatched final checksum', async () => {
    const spoof = Buffer.from('<html>Not actually a PDF document.</html>');
    const { id } = await (await create(spoof)).json();
    await put(id, 0, spoof);
    const invalid = await finalize(id);
    expect(invalid.status).toBe(415);
    expect((await invalid.json()).error.code).toBe('file_signature_mismatch');
    const bytes = pdf();
    const good = await (await create(bytes)).json();
    await put(good.id, 0, bytes);
    expect((await finalize(good.id, { checksum: '0'.repeat(64) })).status).toBe(422);
    expect((await finalize(good.id, { checksum: checksum(bytes) })).status).toBe(200);
  });
  it('never uses the supplied filename as a filesystem path and supports cancellation', async () => {
    const bytes = pdf();
    const { id } = await (await create(bytes, { filename: '../../outside.pdf' })).json();
    await put(id, 0, bytes);
    expect((await finalize(id)).status).toBe(200);
    expect((await readdir(directory)).sort()).toEqual(['key-envelopes', 'tenants']);
    const another = await (await create(bytes)).json();
    expect((await request(`/api/uploads/${another.id}`, { method: 'DELETE' })).status).toBe(200);
    expect((await request(`/api/uploads/${another.id}`)).status).toBe(404);
  });
});
