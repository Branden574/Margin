import 'fake-indexeddb/auto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openDB } from 'idb';
import { createVault, lockVault, VAULT_DATABASE } from '../apps/web/src/lib/vault';

import type { Server } from 'node:http';
import type { DocumentRecord } from '@margin/core';
import { createApi } from '../apps/api/src/server';
import {
  getDocumentBlob,
  listDocuments,
  listUploadRecords,
  readLocalSetting,
  saveDocumentWithBlob,
  saveUploadRecord,
} from '../apps/web/src/lib/storage';
import {
  cancelUpload,
  pauseUpload,
  recoverInterruptedUploads,
  resumeUpload,
  sha256,
  syncDocument,
} from '../apps/web/src/lib/uploads';

const token = 'test-only-upload-integration-token-at-least-32';
let server: Server;
let directory: string;
let baseUrl: string;
const nativeFetch = globalThis.fetch;
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'margin-sync-'));
  server = createApi({
    dataDirectory: directory,
    keyEncryptionKey: Buffer.alloc(32, 77),
    allowInsecureTestTransport: true,
    identities: [{ token, tenantId: 'integration', userId: 'integration-user' }],
    inspectDocument: async () => ({
      decision: 'clean',
      reason: 'Known synthetic integration fixture only',
    }),
    logger: () => undefined,
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
beforeEach(async () => {
  vi.unstubAllGlobals();
  await lockVault();
  await import('../apps/web/src/lib/vault').then((module) => module.vaultStatus());
  const db = await openDB(VAULT_DATABASE, 1);
  const tx = db.transaction([...db.objectStoreNames], 'readwrite');
  await Promise.all([...db.objectStoreNames].map((name) => tx.objectStore(name).clear()));
  await tx.done;
  db.close();
  await createVault('test-only strong vault passphrase');
});
afterAll(async () => {
  vi.unstubAllGlobals();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  await rm(directory, { recursive: true, force: true });
});
async function localDocument(size = 1024) {
  const bytes = new Uint8Array(size).fill(32);
  bytes.set(new TextEncoder().encode('%PDF-1.7\n'));
  const blob = new Blob([bytes], { type: 'application/pdf' });
  const record: DocumentRecord = {
    id: crypto.randomUUID(),
    name: 'Sync test',
    size,
    mimeType: 'application/pdf',
    pageCount: 1,
    createdAt: 1,
    updatedAt: 1,
    folderId: null,
    source: 'created',
    cover: 'blank',
    trashed: false,
    starred: false,
  };
  await saveDocumentWithBlob(record, blob);
  return { record, blob };
}
async function uploadRecord(id: string) {
  return (await listUploadRecords()).find((item) => item.id === `sync:${id}`);
}

describe('browser upload engine against the real upload API', () => {
  it('uploads exact bytes, verifies SHA-256, and records complete only after finalization', async () => {
    const { record, blob } = await localDocument();
    expect(await syncDocument(record.id, { baseUrl, token })).toBe('complete');
    expect(await uploadRecord(record.id)).toMatchObject({ progress: 100, status: 'complete' });
    const state = await readLocalSetting<{ remoteDocumentId: string }>(
      `upload-session:sync:${record.id}`,
    );
    const response = await fetch(`${baseUrl}/api/documents/${state?.remoteDocumentId}/content`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(await sha256(await response.arrayBuffer())).toBe(await sha256(await blob.arrayBuffer()));
  });
  it('pauses and resumes from server-confirmed chunks without repeating acknowledged work', async () => {
    const { record, blob } = await localDocument(5 * 1024 * 1024);
    let paused = false;
    const result = await syncDocument(record.id, { baseUrl, token }, (update) => {
      if (update.status === 'uploading' && update.progress > 0 && !paused) {
        paused = true;
        void pauseUpload(update.id);
      }
    });
    expect(result).toBe('paused');
    expect(await uploadRecord(record.id)).toMatchObject({ status: 'paused' });
    const state = await readLocalSetting<{ serverId: string; remoteDocumentId?: string }>(
      `upload-session:sync:${record.id}`,
    );
    const session = await (
      await fetch(`${baseUrl}/api/uploads/${state?.serverId}`, {
        headers: { Authorization: `Bearer ${token}` },
      })
    ).json();
    expect(session.uploadedChunks).toEqual([0]);
    const putPaths: string[] = [];
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'PUT') putPaths.push(String(input));
      return nativeFetch(input, init);
    });
    await resumeUpload(`sync:${record.id}`, { baseUrl, token });
    expect(putPaths).toHaveLength(2);
    expect(putPaths.every((path) => !path.endsWith('/chunks/0'))).toBe(true);
    expect(await uploadRecord(record.id)).toMatchObject({ status: 'complete' });
    expect(await sha256(await (await getDocumentBlob(record.id))!.arrayBuffer())).toBe(
      await sha256(await blob.arrayBuffer()),
    );
  });
  it('retries a transient server error and still finalizes exactly once', async () => {
    const { record } = await localDocument();
    let attempts = 0;
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'PUT' && ++attempts === 1)
        return new Response(JSON.stringify({ error: { message: 'Temporary interruption' } }), {
          status: 503,
        });
      return nativeFetch(input, init);
    });
    await syncDocument(record.id, { baseUrl, token });
    expect(attempts).toBe(2);
    expect(await uploadRecord(record.id)).toMatchObject({ status: 'complete' });
  });
  it('allows only one active run for the same document', async () => {
    const { record } = await localDocument();
    const results = await Promise.allSettled([
      syncDocument(record.id, { baseUrl, token }),
      syncDocument(record.id, { baseUrl, token }),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect(await uploadRecord(record.id)).toMatchObject({ status: 'complete' });
  });
  it('keeps local data and reports an authentication failure truthfully', async () => {
    const { record } = await localDocument();
    await expect(syncDocument(record.id, { baseUrl, token: 'wrong-token' })).rejects.toThrow(
      'token',
    );
    expect(await uploadRecord(record.id)).toMatchObject({ status: 'error', progress: 0 });
    expect(await getDocumentBlob(record.id)).toBeDefined();
  });
  it('cancels the remote session without removing local document content', async () => {
    const { record } = await localDocument(3 * 1024 * 1024);
    let cancellation: Promise<void> | undefined;
    const result = await syncDocument(record.id, { baseUrl, token }, (update) => {
      if (update.status === 'uploading' && update.progress > 0 && !cancellation)
        cancellation = cancelUpload(update.id, { baseUrl, token });
    });
    await cancellation;
    expect(result).toBe('cancelled');
    expect(await uploadRecord(record.id)).toMatchObject({ status: 'cancelled' });
    expect(await readLocalSetting(`upload-session:sync:${record.id}`)).toBeNull();
    expect(await getDocumentBlob(record.id)).toBeDefined();
  });
  it('recovers interrupted records without pretending requests survived a browser reload', async () => {
    await saveUploadRecord({
      id: 'sync:pending',
      documentId: 'pending',
      name: 'Remote',
      size: 100,
      progress: 40,
      status: 'uploading',
    });
    await saveUploadRecord({
      id: 'local-import',
      name: 'Local',
      size: 100,
      progress: 15,
      status: 'processing',
    });
    await recoverInterruptedUploads();
    expect((await listUploadRecords()).find((item) => item.id === 'sync:pending')?.status).toBe(
      'paused',
    );
    expect((await listUploadRecords()).find((item) => item.id === 'local-import')?.status).toBe(
      'error',
    );
  });
});
