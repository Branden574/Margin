import type { UploadRecord } from '@margin/core';
import {
  getDocument,
  getDocumentBlob,
  listUploadRecords,
  readLocalSetting,
  saveUploadRecord,
  writeLocalSetting,
} from './storage';
import { onBeforeVaultLock, onVaultLock } from './vault';

export interface SyncConnection {
  baseUrl?: string;
  token: string;
}
interface ServerSession {
  id: string;
  chunkSize: number;
  totalChunks: number;
  uploadedChunks: number[];
  status: 'uploading' | 'complete';
  documentId?: string;
}
interface ResumeState {
  serverId: string;
  localDocumentId: string;
  size: number;
  checksum: string;
  baseUrl: string;
  remoteDocumentId?: string;
}
interface ActiveUpload {
  controller: AbortController;
  reason?: 'pause' | 'cancel';
}
const active = new Map<string, ActiveUpload>();
onBeforeVaultLock(async () => {
  await Promise.all([...active.keys()].map((id) => pauseUpload(id)));
});
onVaultLock(() => {
  for (const runtime of active.values()) {
    runtime.reason = 'pause';
    runtime.controller.abort();
  }
});
const CHUNK_SIZE = 2 * 1024 * 1024;
const settingKey = (id: string) => `upload-session:${id}`;

export async function sha256(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}
function normalizeConnection(connection: SyncConnection): Required<SyncConnection> {
  if (!connection.token.trim())
    throw new Error(
      'Enter a server access token before uploading. Your local documents are still available.',
    );
  const baseUrl = (connection.baseUrl || '').replace(/\/$/, '');
  if (baseUrl) {
    const url = new URL(baseUrl);
    if (
      url.username ||
      url.password ||
      (url.protocol !== 'https:' && typeof window !== 'undefined')
    ) {
      throw new Error(
        'Document transfers require an HTTPS server address without embedded credentials.',
      );
    }
  }
  if (typeof window !== 'undefined' && window.location.protocol !== 'https:')
    throw new Error('Open Margin over HTTPS before transferring documents.');
  return { baseUrl, token: connection.token.trim() };
}
async function responseError(response: Response): Promise<Error> {
  let message = `The server returned ${response.status}.`;
  try {
    const payload = (await response.json()) as { error?: { message?: string } };
    if (payload.error?.message) message = payload.error.message;
  } catch {
    /* A plain-text proxy failure still has a useful HTTP status. */
  }
  return new Error(message);
}
async function delay(milliseconds: number, signal: AbortSignal) {
  if (signal.aborted) throw new DOMException('Upload interrupted.', 'AbortError');
  await new Promise<void>((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(new DOMException('Upload interrupted.', 'AbortError'));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort);
      resolve();
    }, milliseconds);
    signal.addEventListener('abort', abort, { once: true });
  });
}
async function request<T>(
  connection: Required<SyncConnection>,
  path: string,
  init: RequestInit,
  signal: AbortSignal,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 4; attempt++) {
    if (signal.aborted) throw new DOMException('Upload interrupted.', 'AbortError');
    let response: Response;
    try {
      response = await fetch(`${connection.baseUrl}/api${path}`, {
        ...init,
        signal,
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
        redirect: 'error',
        headers: { Authorization: `Bearer ${connection.token}`, ...init.headers },
      });
    } catch (error) {
      if (signal.aborted) throw error;
      lastError = error;
      if (attempt < 3) {
        await delay(500 * 2 ** attempt, signal);
        continue;
      }
      throw new Error(
        'The upload server could not be reached. Check your connection, then resume the upload.',
      );
    }
    if (response.ok) return (await response.json()) as T;
    const error = await responseError(response);
    if (response.status !== 408 && response.status !== 429 && response.status < 500) throw error;
    lastError = error;
    if (attempt < 3) await delay(500 * 2 ** attempt, signal);
  }
  throw lastError instanceof Error
    ? lastError
    : new Error('The upload could not be completed. You can resume it later.');
}

/** Explicit opt-in server upload. A local save never calls this function automatically. */
export async function syncDocument(
  documentId: string,
  connection: SyncConnection,
  onProgress?: (upload: UploadRecord) => void,
): Promise<'complete' | 'paused' | 'cancelled'> {
  const config = normalizeConnection(connection);
  const uploadId = `sync:${documentId}`;
  if (active.has(uploadId)) throw new Error('This document is already being uploaded.');
  const [document, blob] = await Promise.all([
    getDocument(documentId),
    getDocumentBlob(documentId),
  ]);
  if (!document || !blob) throw new Error('The local document could not be found.');
  if (active.has(uploadId)) throw new Error('This document is already being uploaded.');
  const runtime: ActiveUpload = { controller: new AbortController() };
  active.set(uploadId, runtime);
  const upload: UploadRecord = {
    id: uploadId,
    name: document.name,
    size: blob.size,
    documentId,
    progress: 0,
    status: 'queued',
  };
  const report = async (patch: Partial<UploadRecord>) => {
    Object.assign(upload, patch);
    await saveUploadRecord({ ...upload });
    onProgress?.({ ...upload });
  };
  try {
    await report({ status: 'processing', progress: 0 });
    const checksum = await sha256(await blob.arrayBuffer());
    let state = await readLocalSetting<ResumeState | null>(settingKey(uploadId));
    // A page edit creates new bytes. It must not accidentally resume an older remote document.
    if (
      state &&
      (state.checksum !== checksum || state.size !== blob.size || state.baseUrl !== config.baseUrl)
    )
      state = undefined;
    let session: ServerSession;
    if (state) {
      session = await request<ServerSession>(
        config,
        `/uploads/${encodeURIComponent(state.serverId)}`,
        { method: 'GET' },
        runtime.controller.signal,
      );
    } else {
      session = await request<ServerSession>(
        config,
        '/uploads',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Idempotency-Key': `${documentId}:${checksum}`,
          },
          body: JSON.stringify({
            filename: `${document.name}.pdf`,
            mimeType: 'application/pdf',
            totalSize: blob.size,
            chunkSize: CHUNK_SIZE,
          }),
        },
        runtime.controller.signal,
      );
      state = {
        serverId: session.id,
        localDocumentId: documentId,
        size: blob.size,
        checksum,
        baseUrl: config.baseUrl,
      };
      await writeLocalSetting(settingKey(uploadId), state);
    }
    if (
      !Number.isSafeInteger(session.chunkSize) ||
      session.chunkSize <= 0 ||
      !Number.isSafeInteger(session.totalChunks) ||
      session.totalChunks !== Math.ceil(blob.size / session.chunkSize)
    ) {
      throw new Error(
        'The server returned an invalid upload session. No document was marked as uploaded.',
      );
    }
    const completed = new Set(session.uploadedChunks);
    const uploadedBytes = () =>
      [...completed].reduce(
        (sum, index) => sum + Math.min(session.chunkSize, blob.size - index * session.chunkSize),
        0,
      );
    await report({
      status: session.status === 'complete' ? 'processing' : 'uploading',
      progress: Math.min(98, Math.floor((uploadedBytes() / blob.size) * 98)),
      error: undefined,
    });
    for (let index = 0; index < session.totalChunks; index++) {
      if (completed.has(index)) continue;
      const chunk = blob.slice(
        index * session.chunkSize,
        Math.min((index + 1) * session.chunkSize, blob.size),
      );
      const chunkChecksum = await sha256(await chunk.arrayBuffer());
      await request(
        config,
        `/uploads/${encodeURIComponent(session.id)}/chunks/${index}`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/octet-stream', 'X-Chunk-SHA256': chunkChecksum },
          body: chunk,
        },
        runtime.controller.signal,
      );
      completed.add(index);
      await report({
        status: 'uploading',
        progress: Math.min(98, Math.floor((uploadedBytes() / blob.size) * 98)),
      });
    }
    await report({ status: 'processing', progress: 98 });
    const finalized = await request<{ documentId: string; checksum: string }>(
      config,
      `/uploads/${encodeURIComponent(session.id)}/finalize`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ checksum }),
      },
      runtime.controller.signal,
    );
    if (finalized.checksum !== checksum || !finalized.documentId)
      throw new Error(
        'The server did not confirm the document checksum. Resume the upload to verify it.',
      );
    await writeLocalSetting(settingKey(uploadId), {
      ...state,
      remoteDocumentId: finalized.documentId,
    });
    await report({ status: 'complete', progress: 100, error: undefined });
    return 'complete';
  } catch (error) {
    if (runtime.reason) {
      await report({
        status: runtime.reason === 'cancel' ? 'cancelled' : 'paused',
        error: undefined,
      }).catch(() => undefined);
      return runtime.reason === 'cancel' ? 'cancelled' : 'paused';
    }
    const message =
      error instanceof Error
        ? error.message
        : 'The upload failed. Your local document is still available.';
    await report({ status: 'error', error: message }).catch(() => undefined);
    throw error instanceof Error ? error : new Error(message);
  } finally {
    active.delete(uploadId);
  }
}

export async function pauseUpload(uploadId: string): Promise<void> {
  const runtime = active.get(uploadId);
  if (runtime) {
    runtime.reason = 'pause';
    runtime.controller.abort();
  }
  const upload = (await listUploadRecords()).find((item) => item.id === uploadId);
  if (upload && upload.status !== 'complete')
    await saveUploadRecord({ ...upload, status: 'paused', error: undefined });
}
export async function resumeUpload(
  uploadId: string,
  connection: SyncConnection,
  onProgress?: (upload: UploadRecord) => void,
): Promise<'complete' | 'paused' | 'cancelled'> {
  const record = (await listUploadRecords()).find((item) => item.id === uploadId);
  if (!record?.documentId || !uploadId.startsWith('sync:'))
    throw new Error(
      'Only server uploads can be resumed. Import the source file again to retry a local import.',
    );
  return syncDocument(record.documentId, connection, onProgress);
}
export async function cancelUpload(uploadId: string, connection: SyncConnection): Promise<void> {
  const runtime = active.get(uploadId);
  if (runtime) {
    runtime.reason = 'cancel';
    runtime.controller.abort();
  }
  const state = await readLocalSetting<ResumeState | null>(settingKey(uploadId));
  if (state) {
    const config = normalizeConnection(connection);
    await request(
      config,
      `/uploads/${encodeURIComponent(state.serverId)}`,
      { method: 'DELETE' },
      new AbortController().signal,
    );
    await writeLocalSetting(settingKey(uploadId), null);
  }
  const record = (await listUploadRecords()).find((item) => item.id === uploadId);
  if (record) await saveUploadRecord({ ...record, status: 'cancelled', error: undefined });
}

/** A reload interrupts requests; preserve resumable work without claiming it is still running. */
export async function recoverInterruptedUploads(): Promise<void> {
  for (const upload of await listUploadRecords()) {
    if (!['queued', 'uploading', 'processing'].includes(upload.status)) continue;
    await saveUploadRecord({
      ...upload,
      status: upload.id.startsWith('sync:') ? 'paused' : 'error',
      error: upload.id.startsWith('sync:')
        ? 'Upload interrupted. Resume to continue from verified chunks.'
        : 'Import interrupted before completion. Choose the source file again.',
    });
  }
}

if (typeof window !== 'undefined')
  window.addEventListener('margin-vault-change', (event) => {
    if ((event as CustomEvent<{ status: string }>).detail?.status === 'locked') {
      for (const runtime of active.values()) {
        runtime.reason = 'pause';
        runtime.controller.abort();
      }
    }
  });
