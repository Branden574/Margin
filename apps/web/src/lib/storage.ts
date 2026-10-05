import type {
  Annotation,
  AnnotationOperation,
  Assignment,
  DocumentRecord,
  FolderRecord,
  OcrPageRecord,
  Preferences,
  UploadRecord,
} from '@margin/core';
import {
  createVaultGuard,
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
    | 'ocr'
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
  options: { signal?: AbortSignal } = {},
): Promise<T> {
  try {
    const guard = createVaultGuard();
    const result = await vaultTransaction(work, options);
    guard();
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

export const OCR_MAX_TEXT_CHARACTERS = 200_000;
export const OCR_MAX_WORDS = 20_000;
export const OCR_MAX_RECORD_BYTES = 4 * 1024 * 1024;
const OCR_MAX_PAGES = 2000;
const revisionPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const ocrKey = (id: string, revision: string, page: number) => JSON.stringify([id, revision, page]);
const ocrIndexKey = (id: string) => `ocr-pages:${JSON.stringify(id)}`;
interface OcrIndex {
  schema: 1;
  contentRevision: string;
  pages: number[];
}
function validPageIndex(page: number) {
  return Number.isSafeInteger(page) && page >= 0 && page < OCR_MAX_PAGES;
}
function checkedOcrIndex(value: OcrIndex): OcrIndex {
  if (
    value.schema !== 1 ||
    typeof value.contentRevision !== 'string' ||
    !revisionPattern.test(value.contentRevision) ||
    !Array.isArray(value.pages) ||
    value.pages.length > OCR_MAX_PAGES ||
    Array.from(value.pages).some((page) => !validPageIndex(page)) ||
    new Set(value.pages).size !== value.pages.length
  )
    throw new Error('The encrypted OCR index is damaged.');
  return value;
}
/** An encrypted per-document index avoids decrypting every OCR page to replace a PDF. */
async function clearDocumentOcr(tx: VaultTransaction, documentId: string): Promise<void> {
  const index = await tx.get<OcrIndex>('settings', ocrIndexKey(documentId));
  if (index)
    for (const page of checkedOcrIndex(index).pages)
      tx.delete('ocr', ocrKey(documentId, index.contentRevision, page));
  tx.delete('settings', ocrIndexKey(documentId));
}
async function replacePdfBytes(
  tx: VaultTransaction,
  record: DocumentRecord,
  blob: Blob,
): Promise<DocumentRecord> {
  const next = { ...record, size: blob.size, contentRevision: crypto.randomUUID() };
  await clearDocumentOcr(tx, record.id);
  tx.put('documents', record.id, next);
  tx.put('blobs', record.id, blob);
  return next;
}
/** One consistent byte/revision snapshot, including one-time migration of legacy records. */
export async function getDocumentForOcr(
  id: string,
): Promise<{ record: DocumentRecord & { contentRevision: string }; blob: Blob } | undefined> {
  const guard = createVaultGuard();
  const result = await vaultTransaction(async (tx) => {
    const record = await tx.get<DocumentRecord>('documents', id);
    if (!record || record.mimeType !== 'application/pdf') return undefined;
    const blob = await tx.get<Blob>('blobs', id);
    if (!(blob instanceof Blob) || blob.size === 0) return undefined;
    if (record.contentRevision !== undefined && !revisionPattern.test(record.contentRevision))
      throw new Error('The encrypted PDF content revision is invalid.');
    const current = { ...record, contentRevision: record.contentRevision ?? crypto.randomUUID() };
    const changed = !record.contentRevision;
    if (changed) {
      await clearDocumentOcr(tx, id);
      tx.put('documents', id, current);
    }
    return { record: current, blob, changed };
  });
  guard();
  if (!result) return undefined;
  if (result.changed) notify({ entity: 'document', id });
  return { record: result.record, blob: result.blob };
}
export async function ensureDocumentContentRevision(id: string): Promise<DocumentRecord> {
  const guard = createVaultGuard();
  const snapshot = await getDocumentForOcr(id);
  guard();
  if (!snapshot) throw new Error('This PDF document or its stored bytes are unavailable.');
  return snapshot.record;
}
function splitsSurrogate(text: string, offset: number) {
  if (offset === 0 || offset === text.length) return false;
  const previous = text.charCodeAt(offset - 1),
    next = text.charCodeAt(offset);
  return previous >= 0xd800 && previous <= 0xdbff && next >= 0xdc00 && next <= 0xdfff;
}
/** Copy validated values before any async work so caller mutation cannot change the saved result. */
function checkedPageOcr(value: OcrPageRecord): OcrPageRecord {
  const invalid = () =>
    new Error('The OCR result is invalid or exceeds this page’s storage limits.');
  if (
    !value ||
    value.schema !== 1 ||
    typeof value.documentId !== 'string' ||
    value.documentId.length < 1 ||
    value.documentId.length > 200 ||
    /[\u0000-\u001f\u007f]/.test(value.documentId) ||
    typeof value.contentRevision !== 'string' ||
    !revisionPattern.test(value.contentRevision) ||
    !validPageIndex(value.pageIndex) ||
    typeof value.engine !== 'string' ||
    value.engine.trim().length === 0 ||
    value.engine.length > 120 ||
    /[\u0000-\u001f\u007f]/.test(value.engine) ||
    typeof value.language !== 'string' ||
    !/^[a-z0-9][a-z0-9_+.-]{0,39}(?:\/[a-z0-9][a-z0-9_+.-]{0,39})?$/i.test(value.language) ||
    typeof value.text !== 'string' ||
    value.text.length > OCR_MAX_TEXT_CHARACTERS ||
    !value.text.trim() ||
    !Array.isArray(value.words) ||
    value.words.length < 1 ||
    value.words.length > OCR_MAX_WORDS ||
    typeof value.createdAt !== 'string' ||
    value.createdAt.length > 32 ||
    !Number.isFinite(Date.parse(value.createdAt)) ||
    new Date(value.createdAt).toISOString() !== value.createdAt
  )
    throw invalid();
  let previousEnd = 0;
  const words = Array.from(value.words, (word) => {
    if (
      !word ||
      !Number.isSafeInteger(word.start) ||
      !Number.isSafeInteger(word.end) ||
      word.start < previousEnd ||
      word.end <= word.start ||
      word.end > value.text.length ||
      splitsSurrogate(value.text, word.start) ||
      splitsSurrogate(value.text, word.end) ||
      !value.text.slice(word.start, word.end).trim() ||
      !Number.isFinite(word.confidence) ||
      word.confidence < 0 ||
      word.confidence > 100 ||
      !Array.isArray(word.quad) ||
      word.quad.length !== 8 ||
      Array.from(word.quad).some((n) => !Number.isFinite(n) || Math.abs(n) > 1_000_000)
    )
      throw invalid();
    previousEnd = word.end;
    return {
      start: word.start,
      end: word.end,
      confidence: word.confidence,
      quad: [...word.quad] as OcrPageRecord['words'][number]['quad'],
    };
  });
  const record: OcrPageRecord = {
    schema: 1,
    documentId: value.documentId,
    contentRevision: value.contentRevision,
    pageIndex: value.pageIndex,
    engine: value.engine,
    language: value.language,
    text: value.text,
    words,
    createdAt: value.createdAt,
  };
  if (new TextEncoder().encode(JSON.stringify(record)).byteLength > OCR_MAX_RECORD_BYTES)
    throw invalid();
  return record;
}
export async function getPageOcr(
  documentId: string,
  contentRevision: string,
  pageIndex: number,
): Promise<OcrPageRecord | undefined> {
  const guard = createVaultGuard();
  const result = await vaultTransaction(async (tx) => {
    const document = await tx.get<DocumentRecord>('documents', documentId);
    if (
      !document ||
      document.mimeType !== 'application/pdf' ||
      document.contentRevision !== contentRevision ||
      !Number.isSafeInteger(document.pageCount) ||
      !validPageIndex(pageIndex) ||
      pageIndex >= document.pageCount ||
      !(await tx.has('blobs', documentId))
    )
      return undefined;
    const stored = await tx.get<OcrPageRecord>(
      'ocr',
      ocrKey(documentId, contentRevision, pageIndex),
    );
    if (!stored) return undefined;
    const record = checkedPageOcr(stored);
    if (
      record.documentId !== documentId ||
      record.contentRevision !== contentRevision ||
      record.pageIndex !== pageIndex
    )
      throw new Error('The encrypted OCR result does not match this PDF page.');
    return record;
  });
  guard();
  return result;
}
export async function savePageOcr(
  value: OcrPageRecord,
  options: { signal?: AbortSignal } = {},
): Promise<void> {
  const signal = options.signal;
  if (signal?.aborted) throw new DOMException('OCR saving was cancelled.', 'AbortError');
  const record = checkedPageOcr(value);
  await commit(
    async (tx) => {
      const document = await tx.get<DocumentRecord>('documents', record.documentId);
      if (
        !document ||
        document.mimeType !== 'application/pdf' ||
        document.contentRevision !== record.contentRevision ||
        !Number.isSafeInteger(document.pageCount) ||
        record.pageIndex >= document.pageCount ||
        !(await tx.has('blobs', record.documentId))
      )
        throw new Error('This PDF changed or is unavailable. Run OCR again on its current page.');
      const old = await tx.get<OcrIndex>('settings', ocrIndexKey(record.documentId));
      if (old && checkedOcrIndex(old).contentRevision !== record.contentRevision)
        await clearDocumentOcr(tx, record.documentId);
      const pages = old?.contentRevision === record.contentRevision ? old.pages : [];
      if (signal?.aborted) throw new DOMException('OCR saving was cancelled.', 'AbortError');
      tx.put('ocr', ocrKey(record.documentId, record.contentRevision, record.pageIndex), record);
      tx.put('settings', ocrIndexKey(record.documentId), {
        schema: 1,
        contentRevision: record.contentRevision,
        pages: [...new Set([...pages, record.pageIndex])].sort((a, b) => a - b),
      } satisfies OcrIndex);
    },
    { entity: 'ocr', id: record.documentId },
    { signal },
  );
}
export async function saveDocument(record: DocumentRecord): Promise<void> {
  await commit(
    async (tx) => {
      const current = await tx.get<DocumentRecord>('documents', record.id);
      // Metadata callers cannot revive an earlier byte revision from a stale snapshot.
      tx.put('documents', record.id, { ...record, contentRevision: current?.contentRevision });
    },
    { entity: 'document', id: record.id },
  );
}
export type DocumentPatch = Partial<
  Pick<DocumentRecord, 'name' | 'folderId' | 'starred' | 'trashed' | 'pageCount'>
>;
/** Merge inside the retried vault transaction, never from an open dialog's snapshot. */
export async function patchDocument(
  id: string,
  patch: DocumentPatch,
  blob?: Blob,
): Promise<DocumentRecord> {
  return commit(
    async (tx) => {
      const current = await tx.get<DocumentRecord>('documents', id);
      if (!current) throw new Error('This document no longer exists. Your changes were not saved.');
      const next: DocumentRecord = {
        ...current,
        ...patch,
        contentRevision: current.contentRevision,
        ...(blob ? { size: blob.size } : {}),
        updatedAt: Math.max(current.updatedAt, Date.now()),
      };
      if (blob) return replacePdfBytes(tx, next, blob);
      tx.put('documents', id, next);
      return next;
    },
    { entity: 'document', id },
  );
}
export async function getDocumentBlob(id: string): Promise<Blob | undefined> {
  return readVaultRecord('blobs', id);
}
export async function putDocumentBlob(id: string, blob: Blob): Promise<void> {
  await commit(
    async (tx) => {
      const current = await tx.get<DocumentRecord>('documents', id);
      if (!current) throw new Error('This document no longer exists. Its bytes were not saved.');
      await replacePdfBytes(
        tx,
        { ...current, updatedAt: Math.max(current.updatedAt, Date.now()) },
        blob,
      );
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
      await replacePdfBytes(tx, record, blob);
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
      await clearDocumentOcr(tx, id);
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
export async function savePreferences(patch: Partial<Preferences>): Promise<Preferences> {
  return commit(
    async (tx) => {
      const current = await tx.get<Preferences>('settings', 'preferences');
      const next = { ...DEFAULT_PREFERENCES, ...current, ...patch };
      tx.put('settings', 'preferences', next);
      return next;
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
      const record = await replacePdfBytes(
        tx,
        { ...previous, pageCount, updatedAt: timestamp },
        blob,
      );
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
          await replacePdfBytes(tx, record, blob);
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
