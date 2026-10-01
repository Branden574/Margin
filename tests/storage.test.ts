import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { openDB } from 'idb';
import { createVault, lockVault, VAULT_DATABASE } from '../apps/web/src/lib/vault';

import { PDFDocument } from 'pdf-lib';
import type { Annotation, AnnotationOperation, DocumentRecord } from '@margin/core';
import {
  appendAnnotationOperation,
  deleteDocument,
  deleteFolder,
  getDocument,
  getDocumentBlob,
  getPreferences,
  listAnnotationOperations,
  listAssignments,
  listDocuments,
  listFolders,
  listUploadRecords,
  loadAnnotations,
  patchDocument,
  replaceDocumentWithAnnotations,
  replayAnnotationOperations,
  saveAssignment,
  saveDocumentWithBlob,
  saveFolder,
  savePreferences,
  saveUploadRecord,
} from '../apps/web/src/lib/storage';
import { createBlankDocument, importDocument, MAX_IMPORT_BYTES } from '../apps/web/src/lib/imports';
import { detectFileKind } from '../apps/web/src/lib/import.worker';
import { seedWorkspace } from '../apps/web/src/lib/seed';

const document = (id = 'document-a'): DocumentRecord => ({
  id,
  name: 'Test document',
  mimeType: 'application/pdf',
  size: 4,
  pageCount: 2,
  createdAt: 1,
  updatedAt: 1,
  folderId: 'folder-a',
  starred: false,
  trashed: false,
  cover: 'blank',
  source: 'created',
});
const annotation = (id = 'annotation-a'): Annotation => ({
  id,
  pageIndex: 1,
  type: 'text',
  text: 'Observation',
  x: 10,
  y: 10,
  color: '#000000',
  strokeWidth: 1,
  opacity: 1,
  createdAt: 1,
  author: 'Test',
});
const operation = (
  id: string,
  timestamp: number,
  kind: 'put' | 'delete' = 'put',
): AnnotationOperation => ({
  id,
  timestamp,
  documentId: 'document-a',
  annotationId: 'annotation-a',
  kind,
  ...(kind === 'put' ? { annotation: annotation() } : {}),
});
beforeEach(async () => {
  await lockVault();
  await import('../apps/web/src/lib/vault').then((module) => module.vaultStatus());
  const db = await openDB(VAULT_DATABASE, 1);
  const tx = db.transaction([...db.objectStoreNames], 'readwrite');
  await Promise.all([...db.objectStoreNames].map((name) => tx.objectStore(name).clear()));
  await tx.done;
  db.close();
  await createVault('test-only strong vault passphrase');
});

describe('offline workspace persistence', () => {
  it('persists document bytes and metadata together and returns full preferences', async () => {
    await saveDocumentWithBlob(document(), new Blob(['test']));
    expect((await getDocument('document-a'))?.name).toBe('Test document');
    expect(await (await getDocumentBlob('document-a'))?.text()).toBe('test');
    expect((await getPreferences()).role).toBe('teacher');
    await savePreferences({ ...(await getPreferences()), name: 'Jordan', reducedMotion: true });
    expect(await getPreferences()).toMatchObject({
      name: 'Jordan',
      reducedMotion: true,
      shortcuts: true,
    });
  });
  it('replays out-of-order operations deterministically and respects delete tombstones', async () => {
    await saveDocumentWithBlob(document(), new Blob(['test']));
    await appendAnnotationOperation(operation('late', 30, 'delete'));
    await appendAnnotationOperation(operation('early', 10));
    expect(await loadAnnotations('document-a')).toEqual([]);
    await appendAnnotationOperation(operation('newest', 40));
    expect(await loadAnnotations('document-a')).toEqual([annotation()]);
    const ops = [operation('z', 50, 'delete'), operation('a', 50)];
    expect(replayAnnotationOperations(ops)).toEqual([]);
    expect(replayAnnotationOperations(ops.reverse())).toEqual([]);
  });
  it('merges stale-dialog metadata changes without undoing concurrent document edits', async () => {
    const dialogSnapshot = document();
    await saveDocumentWithBlob(dialogSnapshot, new Blob(['old']));
    await Promise.all([
      replaceDocumentWithAnnotations(dialogSnapshot.id, new Blob(['edited PDF bytes']), 5, []),
      patchDocument(dialogSnapshot.id, { folderId: 'new-folder', trashed: true }),
      patchDocument(dialogSnapshot.id, { starred: true }),
    ]);
    const renamed = await patchDocument(dialogSnapshot.id, { name: 'Renamed from stale dialog' });
    expect(renamed).toMatchObject({
      name: 'Renamed from stale dialog',
      folderId: 'new-folder',
      pageCount: 5,
      size: 16,
      trashed: true,
      starred: true,
      createdAt: dialogSnapshot.createdAt,
    });
    expect(await (await getDocumentBlob(dialogSnapshot.id))?.text()).toBe('edited PDF bytes');
  });
  it('rejects queued edits after deletion without resurrecting metadata or bytes', async () => {
    const stale = document();
    await saveDocumentWithBlob(stale, new Blob(['old']));
    const deleting = deleteDocument(stale.id);
    const saving = patchDocument(stale.id, { name: 'Stale rename' }, new Blob(['replacement']));
    await expect(saving).rejects.toThrow('no longer exists');
    await deleting;
    expect(await getDocument(stale.id)).toBeUndefined();
    expect(await getDocumentBlob(stale.id)).toBeUndefined();
  });
  it('preserves every field from overlapping partial preference saves', async () => {
    await Promise.all([
      savePreferences({ theme: 'dark' }),
      savePreferences({ reducedMotion: true }),
      savePreferences({ name: 'New name', role: 'student' }),
    ]);
    expect(await getPreferences()).toEqual({
      name: 'New name',
      role: 'student',
      theme: 'dark',
      dyslexiaFont: false,
      reducedMotion: true,
      shortcuts: true,
    });
  });
  it('makes operation retries idempotent and rejects conflicting IDs', async () => {
    await saveDocumentWithBlob(document(), new Blob(['test']));
    await appendAnnotationOperation(operation('same', 2));
    await appendAnnotationOperation(operation('same', 2));
    expect(await listAnnotationOperations('document-a')).toHaveLength(1);
    await expect(appendAnnotationOperation(operation('same', 3))).rejects.toThrow('conflicts');
    expect(await listAnnotationOperations('document-a')).toHaveLength(1);
  });
  it('refuses annotation writes to missing documents', async () => {
    await expect(appendAnnotationOperation(operation('missing', 2))).rejects.toThrow(
      'no longer exists',
    );
    expect(await listAnnotationOperations('document-a')).toEqual([]);
  });
  it('remaps page annotations and replaces PDF bytes in one save', async () => {
    await saveDocumentWithBlob(document(), new Blob(['old']));
    await appendAnnotationOperation(operation('initial', 2));
    const moved = { ...annotation(), pageIndex: 0, x: 99 };
    const record = await replaceDocumentWithAnnotations('document-a', new Blob(['new PDF']), 1, [
      moved,
    ]);
    expect(record.pageCount).toBe(1);
    expect(record.size).toBe(7);
    expect(await (await getDocumentBlob('document-a'))?.text()).toBe('new PDF');
    expect(await loadAnnotations('document-a')).toEqual([moved]);
    await replaceDocumentWithAnnotations('document-a', new Blob(['last PDF']), 1, []);
    expect(await loadAnnotations('document-a')).toEqual([]);
  });
  it('removes folders without deleting their documents', async () => {
    await saveFolder({ id: 'folder-a', name: 'Biology', color: '#008000' });
    await saveDocumentWithBlob(document(), new Blob(['test']));
    await deleteFolder('folder-a');
    expect(await listFolders()).toEqual([]);
    expect((await getDocument('document-a'))?.folderId).toBeNull();
    expect(await getDocumentBlob('document-a')).toBeDefined();
  });
  it('permanently deletes a document and dependent records while preserving others', async () => {
    await saveDocumentWithBlob(document(), new Blob(['test']));
    await saveDocumentWithBlob(document('other'), new Blob(['other']));
    await appendAnnotationOperation(operation('initial', 2));
    await saveAssignment({
      id: 'assignment',
      documentId: 'document-a',
      title: 'Read',
      instructions: 'Read carefully',
      dueDate: '2026-10-10',
      className: 'Biology',
      status: 'draft',
      createdAt: 1,
    });
    await saveUploadRecord({
      id: 'upload',
      documentId: 'document-a',
      name: 'Test',
      progress: 100,
      status: 'complete',
      size: 4,
    });
    await deleteDocument('document-a');
    expect(await getDocument('document-a')).toBeUndefined();
    expect(await getDocumentBlob('document-a')).toBeUndefined();
    expect(await listAnnotationOperations('document-a')).toEqual([]);
    expect(await listAssignments()).toEqual([]);
    expect(await listUploadRecords()).toEqual([]);
    expect((await listDocuments()).map((item) => item.id)).toEqual(['other']);
  });
});

describe('real file imports', () => {
  it('imports a valid PDF, counts its pages, and keeps original bytes', async () => {
    const pdf = await PDFDocument.create();
    pdf.addPage();
    pdf.addPage();
    const bytes = new Uint8Array(await pdf.save());
    const progress: number[] = [];
    const imported = await importDocument(
      new File([bytes], 'Practice.pdf', { type: 'application/pdf' }),
      (upload) => progress.push(upload.progress),
    );
    expect(imported).toMatchObject({
      name: 'Practice',
      pageCount: 2,
      source: 'upload',
      cover: 'import',
    });
    expect(new Uint8Array(await (await getDocumentBlob(imported.id))!.arrayBuffer())).toEqual(
      bytes,
    );
    expect((await listUploadRecords())[0]).toMatchObject({
      status: 'complete',
      documentId: imported.id,
      progress: 100,
    });
    expect(progress.at(-1)).toBe(100);
  });
  it('converts a signature-validated PNG into an actual single-page PDF', async () => {
    const bytes = Uint8Array.from(
      Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO/aO3sAAAAASUVORK5CYII=',
        'base64',
      ),
    );
    const imported = await importDocument(new File([bytes], 'Photo.png', { type: 'image/png' }));
    const pdf = await PDFDocument.load(await (await getDocumentBlob(imported.id))!.arrayBuffer());
    expect(pdf.getPageCount()).toBe(1);
    expect(imported.mimeType).toBe('application/pdf');
  });
  it('rejects extension spoofing and damaged PDFs without creating documents', async () => {
    await expect(
      importDocument(new File(['<html>fake</html>'], 'fake.pdf', { type: 'application/pdf' })),
    ).rejects.toThrow('not a supported');
    await expect(
      importDocument(new File(['%PDF-this is not a PDF'], 'damaged.pdf')),
    ).rejects.toThrow('damaged');
    expect(await listDocuments()).toEqual([]);
    expect((await listUploadRecords()).every((item) => item.status === 'error')).toBe(true);
  });
  it('enforces the size limit before reading the file', async () => {
    const file = new File(['%PDF-1.7'], 'large.pdf');
    Object.defineProperty(file, 'size', { value: MAX_IMPORT_BYTES + 1 });
    await expect(importDocument(file)).rejects.toThrow('100 MB');
    expect(await listDocuments()).toEqual([]);
  });
  it('creates a real blank PDF and detects supported signatures without trusting MIME', async () => {
    const record = await createBlankDocument('My notebook', 'folder-a');
    expect(record).toMatchObject({
      name: 'My notebook',
      folderId: 'folder-a',
      source: 'created',
      pageCount: 1,
    });
    expect(
      (
        await PDFDocument.load(await (await getDocumentBlob(record.id))!.arrayBuffer())
      ).getPageCount(),
    ).toBe(1);
    expect(detectFileKind(new Uint8Array([255, 216, 255]))).toBe('jpeg');
    expect(detectFileKind(new Uint8Array([0, 1]))).toBeUndefined();
  });
  it('seeds substantive original PDFs once, without restoring samples after deletion', async () => {
    await seedWorkspace();
    const records = await listDocuments();
    expect(records).toHaveLength(5);
    expect(records.map((item) => item.name).slice(0, 4)).toEqual([
      'Cell structure & function',
      'The art of close reading',
      'Quadratic equations',
      'Weekly lesson planner',
    ]);
    expect((await listFolders()).map((folder) => folder.name).sort()).toEqual([
      'Biology',
      'English literature',
      'Mathematics',
    ]);
    for (const record of records) {
      expect(record.source).toBe('sample');
      expect(record.size).toBeGreaterThan(3000);
      expect(
        (
          await PDFDocument.load(await (await getDocumentBlob(record.id))!.arrayBuffer())
        ).getPageCount(),
      ).toBe(record.pageCount);
    }
    await deleteDocument(records[0].id);
    await seedWorkspace();
    expect(await listDocuments()).toHaveLength(4);
  });
});
