import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDB } from 'idb';
import { PDFDocument } from 'pdf-lib';
import type { DocumentRecord } from '@margin/core';
import {
  createVault,
  decryptExport,
  encryptExport,
  KDF_ITERATIONS,
  lockVault,
  onBeforeVaultLock,
  unlockVault,
  VAULT_DATABASE,
  vaultStatus,
} from '../apps/web/src/lib/vault';
import {
  appendAnnotationOperation,
  getDocument,
  getDocumentBlob,
  getPreferences,
  listDocuments,
  loadAnnotations,
  saveAssignment,
  saveDocument,
  saveDocumentWithBlob,
  saveFolder,
  savePreferences,
  saveUploadRecord,
  writeLocalSetting,
} from '../apps/web/src/lib/storage';
import { importDocument } from '../apps/web/src/lib/imports';

const passphrase = 'test-only long vault recovery passphrase';
const privateTitle = 'Confidential student assessment 7142';
const privateContent = '%PDF-1.7\nPRIVATE-STUDENT-DOCUMENT-CONTENT-7142';
const record = (id = 'document-secret'): DocumentRecord => ({
  id,
  name: privateTitle,
  mimeType: 'application/pdf',
  size: 100,
  pageCount: 1,
  createdAt: 1,
  updatedAt: 1,
  folderId: null,
  starred: false,
  trashed: false,
  cover: 'import',
  source: 'upload',
});
let unsubscribe: (() => void) | undefined;
async function resetDatabase() {
  await lockVault();
  await vaultStatus();
  const db = await openDB(VAULT_DATABASE, 1);
  const tx = db.transaction(['public', 'records'], 'readwrite');
  await tx.objectStore('public').clear();
  await tx.objectStore('records').clear();
  await tx.done;
  db.close();
}
beforeEach(async () => {
  await resetDatabase();
});
afterEach(async () => {
  unsubscribe?.();
  unsubscribe = undefined;
  vi.restoreAllMocks();
  await lockVault();
});

describe('encrypted local vault', () => {
  it('requires a passphrase, uses a supported KDF, and never grants access while locked', async () => {
    expect(await vaultStatus()).toBe('new');
    await expect(createVault('short')).rejects.toThrow('at least 12');
    await createVault(passphrase);
    await saveDocumentWithBlob(record(), new Blob([privateContent], { type: 'application/pdf' }));
    const db = await openDB(VAULT_DATABASE, 1);
    const configuration = await db.get('public', 'vault');
    db.close();
    expect(configuration.iterations).toBe(KDF_ITERATIONS);
    expect(configuration.salt.byteLength).toBe(32);
    expect(configuration.verifier.iv.byteLength).toBe(12);
    await lockVault();
    expect(await vaultStatus()).toBe('locked');
    await expect(listDocuments()).rejects.toThrow('locked');
    await expect(getDocumentBlob(record().id)).rejects.toThrow('locked');
    await expect(saveDocument(record())).rejects.toThrow('locked');
    await expect(unlockVault('wrong long passphrase')).rejects.toThrow('incorrect');
    expect(await vaultStatus()).toBe('locked');
    await unlockVault(passphrase);
    expect((await getDocument(record().id))?.name).toBe(privateTitle);
    expect(await (await getDocumentBlob(record().id))?.text()).toBe(privateContent);
  });
  it('encrypts file bytes, names, preferences, folders, annotations, assignments and upload state', async () => {
    await createVault(passphrase);
    await saveDocumentWithBlob(record(), new Blob([privateContent]));
    await savePreferences({ ...(await getPreferences()), name: 'Private Learner 7142' });
    await saveFolder({ id: 'folder-secret', name: 'Private Class 7142', color: '#123456' });
    await appendAnnotationOperation({
      id: 'op-secret',
      timestamp: 3,
      documentId: record().id,
      kind: 'put',
      annotationId: 'note-secret',
      annotation: {
        id: 'note-secret',
        pageIndex: 0,
        type: 'text',
        text: 'Private Feedback 7142',
        author: 'Private Teacher 7142',
        x: 2,
        y: 3,
        color: '#000000',
        opacity: 1,
        strokeWidth: 1,
        createdAt: 3,
      },
    });
    await saveAssignment({
      id: 'assignment-secret',
      documentId: record().id,
      title: 'Private Assessment 7142',
      instructions: 'Private Instructions 7142',
      className: 'Private Class 7142',
      dueDate: '2026-10-30',
      status: 'draft',
      createdAt: 3,
    });
    await saveUploadRecord({
      id: 'upload-secret',
      name: privateTitle,
      documentId: record().id,
      size: 100,
      progress: 10,
      status: 'paused',
    });
    await writeLocalSetting('upload-session:private', {
      remoteDocumentId: 'private-remote-id-7142',
      checksum: 'private-checksum-7142',
    });
    const db = await openDB(VAULT_DATABASE, 1);
    const rows = await db.getAll('records');
    const raw = JSON.stringify(rows);
    for (const secret of [
      privateTitle,
      privateContent,
      'Private Learner',
      'Private Class',
      'Private Feedback',
      'Private Teacher',
      'Private Instructions',
      'private-remote-id',
      'note-secret',
      'document-secret',
    ])
      expect(raw).not.toContain(secret);
    for (const row of rows) {
      expect(Object.keys(row).sort()).toEqual(['ciphertext', 'storageKey', 'store', 'vaultId']);
      expect(row.storageKey).toMatch(/^[a-f0-9]{64}$/);
      expect(row.ciphertext.iv).toHaveLength(12);
      expect(row.ciphertext.bytes).toBeInstanceOf(Uint8Array);
    }
    expect(new Set(rows.map((row) => Array.from(row.ciphertext.iv).join(','))).size).toBe(
      rows.length,
    );
    db.close();
    await lockVault();
    await unlockVault(passphrase);
    expect((await loadAnnotations(record().id))[0].text).toBe('Private Feedback 7142');
  });
  it('authenticates ciphertext and binds records to their vault, store, and address', async () => {
    await createVault(passphrase);
    await saveDocumentWithBlob(record(), new Blob([privateContent]));
    await saveDocument({ ...record('another-document'), name: 'Another secret' });
    const db = await openDB(VAULT_DATABASE, 1);
    const documents = (await db.getAll('records')).filter((row) => row.store === 'documents');
    const original = structuredClone(documents[0]);
    documents[0].ciphertext.bytes[0] ^= 1;
    await db.put('records', documents[0]);
    await expect(listDocuments()).rejects.toThrow('authenticated');
    await db.put('records', original);
    await db.put('records', { ...documents[1], ciphertext: original.ciphertext });
    await expect(listDocuments()).rejects.toThrow('authenticated');
    db.close();
  });
  it('rolls back metadata and bytes together if a storage write fails', async () => {
    await createVault(passphrase);
    await saveDocumentWithBlob(record(), new Blob(['original encrypted bytes']));
    const put = IDBObjectStore.prototype.put;
    vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (
      this: IDBObjectStore,
      value,
      key,
    ) {
      if (this.name === 'records' && value.store === 'blobs')
        throw new DOMException('Storage is full.', 'QuotaExceededError');
      return key === undefined ? put.call(this, value) : put.call(this, value, key);
    });
    await expect(
      saveDocumentWithBlob({ ...record(), name: 'Changed title' }, new Blob(['changed bytes'])),
    ).rejects.toThrow('storage is full');
    vi.restoreAllMocks();
    expect((await getDocument(record().id))?.name).toBe(privateTitle);
    expect(await (await getDocumentBlob(record().id))?.text()).toBe('original encrypted bytes');
  });
  it('refuses a manual lock if unsaved edits cannot be flushed', async () => {
    await createVault(passphrase);
    await saveDocument(record());
    unsubscribe = onBeforeVaultLock(async () => {
      throw new Error('Save failed.');
    });
    await expect(lockVault()).rejects.toThrow("Couldn't save latest edits");
    expect(await vaultStatus()).toBe('unlocked');
    expect((await getDocument(record().id))?.name).toBe(privateTitle);
    unsubscribe();
    unsubscribe = undefined;
    await lockVault();
    expect(await vaultStatus()).toBe('locked');
  });
});

describe('portable encrypted exports', () => {
  it('round-trips without plaintext document metadata in the package', async () => {
    await createVault(passphrase);
    const encrypted = await encryptExport(new Blob([privateContent]), {
      name: privateTitle,
      mimeType: 'application/pdf',
    });
    expect(await encrypted.slice(0, 8).text()).toBe('MARGIN1\n');
    const bytes = new Uint8Array(await encrypted.arrayBuffer());
    expect(new TextDecoder().decode(bytes)).not.toContain(privateTitle);
    expect(new TextDecoder().decode(bytes)).not.toContain(privateContent);
    const restored = await decryptExport(encrypted);
    expect(restored.name).toBe(privateTitle);
    expect(await restored.blob.text()).toBe(privateContent);
  });
  it('recovers in a different vault only with the original export passphrase', async () => {
    await createVault(passphrase);
    const encrypted = await encryptExport(new Blob([privateContent]), {
      name: privateTitle,
      mimeType: 'application/pdf',
    });
    await resetDatabase();
    await createVault('a completely different vault passphrase');
    await expect(decryptExport(encrypted)).rejects.toThrow('another vault');
    await expect(decryptExport(encrypted, 'wrong archive passphrase')).rejects.toThrow(
      'authenticated',
    );
    expect(await (await decryptExport(encrypted, passphrase)).blob.text()).toBe(privateContent);
  });
  it('rejects modified content, modified KDF salt, and unsafe headers', async () => {
    await createVault(passphrase);
    const encrypted = await encryptExport(new Blob([privateContent]), {
      name: privateTitle,
      mimeType: 'application/pdf',
    });
    const bytes = new Uint8Array(await encrypted.arrayBuffer());
    const damaged = bytes.slice();
    damaged[damaged.length - 1] ^= 1;
    await expect(decryptExport(new Blob([damaged]))).rejects.toThrow('authenticated');
    const size = new DataView(bytes.buffer).getUint32(8);
    const header = JSON.parse(new TextDecoder().decode(bytes.subarray(12, 12 + size)));
    const container = (value: unknown) => {
      const encoded = new TextEncoder().encode(JSON.stringify(value));
      const prefix = bytes.slice(0, 12);
      new DataView(prefix.buffer).setUint32(8, encoded.length);
      return new Blob([prefix, encoded, bytes.subarray(12 + size)]);
    };
    await expect(decryptExport(container({ ...header, iterations: 1 }))).rejects.toThrow('unsafe');
    await expect(
      decryptExport(container({ ...header, salt: btoa('x'.repeat(32)) })),
    ).rejects.toThrow('authenticated');
    const oversizedHeader = bytes.slice();
    new DataView(oversizedHeader.buffer).setUint32(8, 2 ** 30);
    await expect(decryptExport(new Blob([oversizedHeader]))).rejects.toThrow('header');
  });
  it('imports a valid encrypted PDF through the same structural-validation pipeline', async () => {
    await createVault(passphrase);
    const pdf = await PDFDocument.create();
    pdf.addPage();
    const encrypted = await encryptExport(new Blob([new Uint8Array(await pdf.save())]), {
      name: privateTitle,
      mimeType: 'application/pdf',
    });
    const imported = await importDocument(
      new File([encrypted], 'document.margin', { type: 'application/vnd.margin.encrypted' }),
    );
    expect(imported).toMatchObject({ name: privateTitle, pageCount: 1, source: 'upload' });
    expect(await getDocumentBlob(imported.id)).toBeDefined();
  });
  it('does not release plaintext from an explicit-passphrase decryption after the vault locks', async () => {
    await createVault(passphrase);
    const encrypted = await encryptExport(new Blob([privateContent]), {
      name: privateTitle,
      mimeType: 'application/pdf',
    });
    const pending = decryptExport(encrypted, passphrase);
    const rejected = expect(pending).rejects.toThrow(/locked|stopped|authenticated/);
    await lockVault();
    await rejected;
    expect(await vaultStatus()).toBe('locked');
  });
  it('does not start importing an encrypted package into a re-unlocked session after locking', async () => {
    await createVault(passphrase);
    const pdf = await PDFDocument.create();
    pdf.addPage();
    const encrypted = await encryptExport(new Blob([new Uint8Array(await pdf.save())]), {
      name: privateTitle,
      mimeType: 'application/pdf',
    });
    const pending = importDocument(new File([encrypted], 'private.margin'), undefined, passphrase);
    const rejected = expect(pending).rejects.toThrow(/locked|stopped|authenticated/);
    await lockVault();
    await unlockVault(passphrase);
    await rejected;
    expect(await listDocuments()).toEqual([]);
  });
});
