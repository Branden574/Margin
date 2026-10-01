import type { ImportResult, ImportTask } from './import.worker';
import type { DocumentRecord, UploadRecord } from '@margin/core';
import { saveDocumentWithBlob, saveUploadRecord } from './storage';
import { createVaultGuard, decryptExport, onVaultLock } from './vault';

export const MAX_IMPORT_BYTES = 100 * 1024 * 1024;
async function processInWorker(
  task: ImportTask,
  onProgress: (progress: number) => Promise<void> = async () => undefined,
): Promise<ImportResult> {
  const guard = createVaultGuard();
  // Node tests use the identical processor. Browser work always stays off the UI thread.
  if (typeof window === 'undefined') {
    const { processImportTask } = await import('./import.worker');
    let updates = Promise.resolve();
    const result = await processImportTask(task, (value) => {
      updates = updates.then(() => onProgress(value));
    });
    await updates;
    guard();
    return result;
  }
  if (typeof Worker === 'undefined')
    throw new Error(
      'This browser does not support document-processing workers. Use a current browser to import a document.',
    );
  const worker = new Worker(new URL('./import.worker.ts', import.meta.url), { type: 'module' });
  const id = crypto.randomUUID();
  return new Promise<ImportResult>((resolve, reject) => {
    let updates = Promise.resolve();
    let unsubscribe: () => void = () => undefined;
    const timeout = setTimeout(
      () => finish(new Error('The file took too long to process. Try a smaller document.')),
      120_000,
    );
    const finish = (error?: Error, result?: ImportResult) => {
      clearTimeout(timeout);
      worker.terminate();
      unsubscribe();
      void updates.then(() => {
        try {
          guard();
          if (error) reject(error);
          else if (result) resolve(result);
          else reject(new Error('The file could not be processed.'));
        } catch (reason) {
          reject(reason);
        }
      }, reject);
    };
    worker.onmessage = (
      event: MessageEvent<{ id: string; progress?: number; result?: ImportResult; error?: string }>,
    ) => {
      if (event.data.id !== id) return;
      if (typeof event.data.progress === 'number') {
        const progress = event.data.progress;
        updates = updates.then(() => onProgress(progress));
        return;
      }
      finish(event.data.error ? new Error(event.data.error) : undefined, event.data.result);
    };
    worker.onerror = () =>
      finish(new Error('The document-processing worker stopped unexpectedly. Please try again.'));
    worker.onmessageerror = () =>
      finish(
        new Error(
          'The document-processing worker returned an unreadable response. Please try again.',
        ),
      );
    unsubscribe = onVaultLock(() =>
      finish(new Error('Your vault was locked. Import stopped before saving.')),
    );
    worker.postMessage({ id, task });
  });
}

function fileDisplayName(name: string): string {
  return name.replace(/\.(pdf|png|jpe?g)$/i, '').trim() || 'Untitled document';
}

export async function importDocument(
  file: File,
  onProgress?: (upload: UploadRecord) => void,
  exportPassphrase?: string,
): Promise<DocumentRecord> {
  const guard = createVaultGuard();
  const upload: UploadRecord = {
    id: crypto.randomUUID(),
    name: file.name || 'Untitled document',
    size: file.size,
    progress: 0,
    status: 'queued',
  };
  const report = async (patch: Partial<UploadRecord>) => {
    Object.assign(upload, patch);
    await saveUploadRecord({ ...upload });
    onProgress?.({ ...upload });
  };
  try {
    await report({ status: 'queued' });
    let source = file;
    if ((await file.slice(0, 8).text()) === 'MARGIN1\n') {
      const decrypted = await decryptExport(file, exportPassphrase);
      const extension =
        decrypted.mimeType === 'image/png'
          ? '.png'
          : decrypted.mimeType === 'image/jpeg'
            ? '.jpg'
            : '.pdf';
      const name = /\.(pdf|png|jpe?g)$/i.test(decrypted.name)
        ? decrypted.name
        : `${decrypted.name}${extension}`;
      source = new File([decrypted.blob], name, { type: decrypted.mimeType });
    }
    guard();
    const { blob: output, pageCount } = await processInWorker(
      { kind: 'import', file: source },
      (progress) => report({ status: 'processing', progress }),
    );
    const now = Date.now();
    const record: DocumentRecord = {
      id: crypto.randomUUID(),
      name: fileDisplayName(source.name),
      mimeType: 'application/pdf',
      size: output.size,
      pageCount,
      createdAt: now,
      updatedAt: now,
      folderId: null,
      starred: false,
      trashed: false,
      cover: 'import',
      source: 'upload',
    };
    // The document and its bytes are one transaction: a visible record always has its content.
    Object.assign(upload, { progress: 100, status: 'complete', documentId: record.id });
    guard();
    await saveDocumentWithBlob(record, output, upload);
    onProgress?.({ ...upload });
    return record;
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'The file could not be imported. Please try again.';
    await report({ status: 'error', error: message }).catch(() => undefined);
    throw error instanceof Error ? error : new Error(message);
  }
}

export async function createBlankDocument(
  name: string,
  folderId: string | null = null,
): Promise<DocumentRecord> {
  const title = name.trim() || 'Untitled document';
  const { blob, pageCount } = await processInWorker({ kind: 'blank', title });
  const now = Date.now();
  const record: DocumentRecord = {
    id: crypto.randomUUID(),
    name: title,
    mimeType: 'application/pdf',
    size: blob.size,
    pageCount,
    createdAt: now,
    updatedAt: now,
    folderId,
    starred: false,
    trashed: false,
    cover: 'blank',
    source: 'created',
  };
  await saveDocumentWithBlob(record, blob);
  return record;
}
