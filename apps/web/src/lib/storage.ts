import type {
  Annotation,
  AnnotationOperation,
  Assignment,
  DocumentRecord,
  FolderRecord,
  Preferences,
  UploadRecord,
} from '@margin/core';
import {
  listVaultRecords,
  onVaultLock,
  readVaultRecord,
  vaultTransaction,
  type VaultTransaction,
} from './vault';

export const DEFAULT_PREFERENCES: Preferences = {
  name: 'Alex Morgan',
  role: 'teacher',
  theme: 'light',
  dyslexiaFont: false,
  reducedMotion: false,
  shortcuts: true,
};
export const DATA_CHANGE_EVENT = 'margin-data-change';
export interface DataChange {
  entity:
    | 'document'
    | 'folder'
    | 'annotation'
    | 'assignment'
    | 'upload'
    | 'preferences'
    | 'workspace';
  id?: string;
}
let channel: BroadcastChannel | undefined;
onVaultLock(() => {
  channel?.close();
  channel = undefined;
});
function getChannel() {
  if (!channel && typeof window !== 'undefined' && typeof BroadcastChannel !== 'undefined') {
    channel = new BroadcastChannel('margin-encrypted-data-v1');
    channel.onmessage = ({ data }: MessageEvent<DataChange>) =>
      window.dispatchEvent(new CustomEvent<DataChange>(DATA_CHANGE_EVENT, { detail: data }));
  }
  return channel;
}
function notify(change: DataChange) {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent<DataChange>(DATA_CHANGE_EVENT, { detail: change }));
  try {
    getChannel()?.postMessage(change);
  } catch {
    /* The encrypted transaction already committed. */
  }
}
export function subscribeToDataChanges(listener: (change: DataChange) => void): () => void {
  getChannel();
  const handle = (event: Event) => listener((event as CustomEvent<DataChange>).detail);
  window.addEventListener(DATA_CHANGE_EVENT, handle);
  return () => window.removeEventListener(DATA_CHANGE_EVENT, handle);
}
export function localStorageError(error: unknown): Error {
  if (error instanceof Error && error.name === 'QuotaExceededError')
    return new Error(
      'Your browser storage is full. Export encrypted documents you want to keep, then permanently delete unneeded files and try again.',
    );
  return error instanceof Error
    ? error
    : new Error('The encrypted document could not be saved to this browser. Please try again.');
}
async function commit<T>(
  work: (transaction: VaultTransaction) => Promise<T>,
  change: DataChange,
): Promise<T> {
  try {
    const result = await vaultTransaction(work);
    notify(change);
    return result;
  } catch (error) {
    throw localStorageError(error);
  }
}

export async function listDocuments(): Promise<DocumentRecord[]> {
  getChannel();
  return (await listVaultRecords<DocumentRecord>('documents'))
    .map((row) => row.value)
    .sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
}
export async function getDocument(id: string): Promise<DocumentRecord | undefined> {
  return readVaultRecord('documents', id);
}
export async function saveDocument(record: DocumentRecord): Promise<void> {
  await commit(
    async (tx) => {
      tx.put('documents', record.id, record);
    },
    { entity: 'document', id: record.id },
  );
}
export async function getDocumentBlob(id: string): Promise<Blob | undefined> {
  return readVaultRecord('blobs', id);
}
export async function putDocumentBlob(id: string, blob: Blob): Promise<void> {
  await commit(
    async (tx) => {
      tx.put('blobs', id, blob);
    },
    { entity: 'document', id },
  );
}
export async function saveDocumentWithBlob(
  record: DocumentRecord,
  blob: Blob,
  upload?: UploadRecord,
): Promise<void> {
  await commit(
    async (tx) => {
      tx.put('documents', record.id, record);
      tx.put('blobs', record.id, blob);
      if (upload) tx.put('uploads', upload.id, upload);
    },
    { entity: 'document', id: record.id },
  );
}
export async function deleteDocument(id: string): Promise<void> {
  await commit(
    async (tx) => {
      tx.delete('documents', id);
      tx.delete('blobs', id);
      for (const row of await tx.list<AnnotationOperation>('annotations'))
        if (row.value.documentId === id) tx.delete('annotations', row.key);
      for (const row of await tx.list<Assignment>('assignments'))
        if (row.value.documentId === id) tx.delete('assignments', row.key);
      for (const row of await tx.list<UploadRecord>('uploads'))
        if (row.value.documentId === id) tx.delete('uploads', row.key);
      // Remove encrypted resume receipts and document versions alongside the original.
      for (const row of await tx.list<unknown>('settings'))
        if (
          row.key === `upload-session:sync:${id}` ||
          row.key.startsWith(`version:${id}:`) ||
          row.key === `versions:${id}`
        )
          tx.delete('settings', row.key);
    },
    { entity: 'document', id },
  );
}
export async function listFolders(): Promise<FolderRecord[]> {
  return (await listVaultRecords<FolderRecord>('folders')).map((row) => row.value);
}
export async function saveFolder(folder: FolderRecord): Promise<void> {
  await commit(
    async (tx) => {
      tx.put('folders', folder.id, folder);
    },
    { entity: 'folder', id: folder.id },
  );
}
export async function deleteFolder(id: string): Promise<void> {
  await commit(
    async (tx) => {
      tx.delete('folders', id);
      for (const { value: document } of await tx.list<DocumentRecord>('documents'))
        if (document.folderId === id)
          tx.put('documents', document.id, { ...document, folderId: null });
    },
    { entity: 'folder', id },
  );
}
export async function listAssignments(): Promise<Assignment[]> {
  return (await listVaultRecords<Assignment>('assignments'))
    .map((row) => row.value)
    .sort((a, b) => b.createdAt - a.createdAt);
}
export async function saveAssignment(assignment: Assignment): Promise<void> {
  await commit(
    async (tx) => {
      tx.put('assignments', assignment.id, assignment);
    },
    { entity: 'assignment', id: assignment.id },
  );
}
export async function getPreferences(): Promise<Preferences> {
  const stored = await readVaultRecord<Preferences>('settings', 'preferences');
  return { ...DEFAULT_PREFERENCES, ...stored };
}
export async function savePreferences(preferences: Preferences): Promise<void> {
  await commit(
    async (tx) => {
      tx.put('settings', 'preferences', preferences);
    },
    { entity: 'preferences' },
  );
}
export async function listUploadRecords(): Promise<UploadRecord[]> {
  return (await listVaultRecords<UploadRecord>('uploads')).map((row) => row.value);
}
export async function saveUploadRecord(upload: UploadRecord): Promise<void> {
  await commit(
    async (tx) => {
      tx.put('uploads', upload.id, upload);
    },
    { entity: 'upload', id: upload.id },
  );
}
export async function listAnnotationOperations(documentId: string): Promise<AnnotationOperation[]> {
  return (await listVaultRecords<AnnotationOperation>('annotations'))
    .map((row) => row.value)
    .filter((operation) => operation.documentId === documentId)
    .sort(compareOperations);
}
function compareOperations(a: AnnotationOperation, b: AnnotationOperation) {
  return a.timestamp - b.timestamp || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}
export function replayAnnotationOperations(operations: AnnotationOperation[]): Annotation[] {
  const annotations = new Map<string, Annotation>();
  for (const operation of [...operations].sort(compareOperations)) {
    if (operation.kind === 'delete') annotations.delete(operation.annotationId);
    else if (operation.annotation) annotations.set(operation.annotationId, operation.annotation);
  }
  return [...annotations.values()].sort(
    (a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
}
export async function loadAnnotations(documentId: string): Promise<Annotation[]> {
  return replayAnnotationOperations(await listAnnotationOperations(documentId));
}
export async function appendAnnotationOperation(operation: AnnotationOperation): Promise<void> {
  if (
    !Number.isFinite(operation.timestamp) ||
    !operation.id ||
    !operation.documentId ||
    !operation.annotationId
  )
    throw new Error('The annotation operation is invalid.');
  if (
    operation.kind === 'put' &&
    (!operation.annotation || operation.annotation.id !== operation.annotationId)
  )
    throw new Error('The annotation does not match its operation.');
  await commit(
    async (tx) => {
      const document = await tx.get<DocumentRecord>('documents', operation.documentId);
      if (!document)
        throw new Error('This document no longer exists. Your annotation was not saved.');
      const existing = await tx.get<AnnotationOperation>('annotations', operation.id);
      if (existing && JSON.stringify(existing) !== JSON.stringify(operation))
        throw new Error('This annotation operation conflicts with an existing save.');
      tx.put('annotations', operation.id, operation);
      tx.put('documents', document.id, {
        ...document,
        updatedAt: Math.max(document.updatedAt, operation.timestamp),
      });
    },
    { entity: 'annotation', id: operation.documentId },
  );
}
/** Page transformations encrypt first, then atomically commit bytes, count, and remapped operations. */
export async function replaceDocumentWithAnnotations(
  documentId: string,
  blob: Blob,
  pageCount: number,
  annotations: Annotation[],
): Promise<DocumentRecord> {
  return commit(
    async (tx) => {
      const previous = await tx.get<DocumentRecord>('documents', documentId);
      if (!previous)
        throw new Error('This document no longer exists. The page changes were not saved.');
      const operations = (await tx.list<AnnotationOperation>('annotations'))
        .map((row) => row.value)
        .filter((operation) => operation.documentId === documentId);
      const timestamp = operations.reduce(
        (latest, operation) => Math.max(latest, operation.timestamp + 1),
        Date.now(),
      );
      const record = { ...previous, size: blob.size, pageCount, updatedAt: timestamp };
      tx.put('documents', documentId, record);
      tx.put('blobs', documentId, blob);
      const remaining = new Set(annotations.map((annotation) => annotation.id));
      for (const annotation of replayAnnotationOperations(operations))
        if (!remaining.has(annotation.id)) {
          const operation: AnnotationOperation = {
            id: crypto.randomUUID(),
            documentId,
            timestamp,
            kind: 'delete',
            annotationId: annotation.id,
          };
          tx.put('annotations', operation.id, operation);
        }
      for (const annotation of annotations) {
        const operation: AnnotationOperation = {
          id: crypto.randomUUID(),
          documentId,
          timestamp,
          kind: 'put',
          annotationId: annotation.id,
          annotation,
        };
        tx.put('annotations', operation.id, operation);
      }
      return record;
    },
    { entity: 'document', id: documentId },
  );
}
export async function isWorkspaceSeeded(): Promise<boolean> {
  return Boolean(await readVaultRecord('settings', 'seeded'));
}
export async function seedSampleWorkspace(
  folders: FolderRecord[],
  documents: { record: DocumentRecord; blob: Blob }[],
): Promise<void> {
  await commit(
    async (tx) => {
      if (await tx.get('settings', 'seeded')) return;
      if ((await tx.list('documents')).length === 0) {
        for (const folder of folders) tx.put('folders', folder.id, folder);
        for (const { record, blob } of documents) {
          tx.put('documents', record.id, record);
          tx.put('blobs', record.id, blob);
        }
      }
      tx.put('settings', 'seeded', true);
    },
    { entity: 'workspace' },
  );
}
export async function readLocalSetting<T>(key: string): Promise<T | undefined> {
  return readVaultRecord('settings', key);
}
export async function writeLocalSetting<T>(key: string, value: T): Promise<void> {
  await commit(
    async (tx) => {
      tx.put('settings', key, value);
    },
    { entity: 'workspace' },
  );
}
