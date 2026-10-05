import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDB } from 'idb';
import type { Annotation, AnnotationOperation, DocumentRecord, OcrPageRecord } from '@margin/core';
import {
  createVault,
  listVaultRecords,
  lockVault,
  unlockVault,
  VAULT_DATABASE,
  vaultStatus,
  vaultTransaction,
} from '../apps/web/src/lib/vault';
import {
  appendAnnotationOperation,
  deleteDocument,
  deleteFolder,
  ensureDocumentContentRevision,
  getDocument,
  getDocumentBlob,
  getDocumentForOcr,
  getPageOcr,
  getOcrForExport,
  loadAnnotations,
  OCR_MAX_TEXT_CHARACTERS,
  OCR_MAX_WORDS,
  OCR_MAX_RECORD_BYTES,
  patchDocument,
  putDocumentBlob,
  replaceDocumentWithAnnotations,
  saveDocument,
  saveDocumentWithBlob,
  savePageOcr,
  seedSampleWorkspace,
} from '../apps/web/src/lib/storage';

const passphrase = 'synthetic OCR persistence test passphrase';
const document = (id = 'private-ocr-document'): DocumentRecord => ({
  id,
  name: 'Private OCR worksheet',
  mimeType: 'application/pdf',
  size: 3,
  pageCount: 2,
  createdAt: 1,
  updatedAt: 1,
  folderId: 'folder',
  starred: false,
  trashed: false,
  cover: 'blank',
  source: 'created',
});
const quad: OcrPageRecord['words'][number]['quad'] = [-10, 800, 40, 800, 40, 780, -10, 780];
const ocr = (revision: string, id = document().id, pageIndex = 0): OcrPageRecord => ({
  schema: 1,
  documentId: id,
  contentRevision: revision,
  pageIndex,
  engine: 'local-fixture-1',
  language: 'eng/1.0.0',
  text: 'Private 😀 e\u0301 text',
  words: [
    { start: 0, end: 7, confidence: 99, quad: [...quad] },
    { start: 8, end: 10, confidence: 90.5, quad: [...quad] },
    { start: 11, end: 13, confidence: 0, quad: [...quad] },
    { start: 14, end: 18, confidence: 100, quad: [...quad] },
  ],
  createdAt: '2026-10-02T12:00:00.000Z',
});
async function fixture(id = document().id) {
  await saveDocumentWithBlob(document(id), new Blob(['old PDF']));
  const snapshot = (await getDocumentForOcr(id))!;
  const result = ocr(snapshot.record.contentRevision, id);
  await savePageOcr(result);
  return { ...snapshot, ocr: result };
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
/** Hold actual WebCrypto encryption outside the IDB commit to exercise real cancellation/races. */
function pauseEncryption() {
  const entered = deferred(),
    release = deferred();
  const encrypt = crypto.subtle.encrypt.bind(crypto.subtle);
  const spy = vi.spyOn(crypto.subtle, 'encrypt').mockImplementationOnce(async (...args) => {
    entered.resolve();
    await release.promise;
    return encrypt(...args);
  });
  return { entered: entered.promise, release: release.resolve, spy };
}
async function rawRecords() {
  const db = await openDB(VAULT_DATABASE, 1);
  try {
    return await db.getAll('records');
  } finally {
    db.close();
  }
}
/** A second writer commits an already authenticated snapshot and advances the shared revision. */
async function externalCommit(rows: Awaited<ReturnType<typeof rawRecords>>) {
  const db = await openDB(VAULT_DATABASE, 1);
  try {
    const tx = db.transaction(['public', 'records'], 'readwrite');
    const config = await tx.objectStore('public').get('vault');
    await tx.objectStore('records').clear();
    for (const row of rows) await tx.objectStore('records').put(row);
    await tx.objectStore('public').put({ ...config, revision: config.revision + 1 });
    await tx.done;
  } finally {
    db.close();
  }
}
beforeEach(async () => {
  await lockVault();
  await vaultStatus();
  const db = await openDB(VAULT_DATABASE, 1);
  const tx = db.transaction(['public', 'records'], 'readwrite');
  await tx.objectStore('public').clear();
  await tx.objectStore('records').clear();
  await tx.done;
  db.close();
  await createVault(passphrase);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await lockVault();
  vi.unstubAllGlobals();
});

describe('encrypted OCR bound to local PDF content revisions', () => {
  const annotation: Annotation = {
    id: 'crop-annotation',
    pageIndex: 0,
    type: 'pen',
    x: 12,
    y: 14,
    points: [
      { x: 12, y: 14 },
      { x: 20, y: 22 },
    ],
    color: '#123456',
    strokeWidth: 2,
    opacity: 1,
    createdAt: 1,
    author: 'Synthetic',
  };
  async function addAnnotation(documentId: string, value: Annotation = annotation) {
    await appendAnnotationOperation({
      id: crypto.randomUUID(),
      documentId,
      timestamp: Date.now(),
      kind: 'put',
      annotationId: value.id,
      annotation: value,
    });
  }
  it('refuses stale page-byte replacement before changing annotations or encrypted OCR', async () => {
    const value = await fixture();
    await addAnnotation(value.record.id);
    const original = await rawRecords();
    await expect(
      replaceDocumentWithAnnotations(
        value.record.id,
        new Blob(['stale crop']),
        2,
        [],
        crypto.randomUUID(),
      ),
    ).rejects.toThrow('changed');
    expect(await rawRecords()).toEqual(original);
    expect(await (await getDocumentBlob(value.record.id))!.text()).toBe('old PDF');
    expect(await loadAnnotations(value.record.id)).toEqual([annotation]);
    expect(await getPageOcr(value.record.id, value.record.contentRevision, 0)).toEqual(value.ocr);
  });
  it('commits matching revision with negative annotation positions and invalidates old OCR atomically', async () => {
    const value = await fixture();
    await addAnnotation(value.record.id);
    const shifted = {
      ...annotation,
      x: -18,
      y: -26,
      points: [
        { x: -18, y: -26 },
        { x: -10, y: -18 },
      ],
    };
    const saved = await replaceDocumentWithAnnotations(
      value.record.id,
      new Blob(['cropped PDF']),
      2,
      [shifted],
      value.record.contentRevision,
    );
    expect(saved.contentRevision).not.toBe(value.record.contentRevision);
    expect(await (await getDocumentBlob(value.record.id))!.text()).toBe('cropped PDF');
    expect(await loadAnnotations(value.record.id)).toEqual([shifted]);
    expect(await getPageOcr(value.record.id, value.record.contentRevision, 0)).toBeUndefined();
    expect(await listVaultRecords('ocr')).toEqual([]);
  });
  it('rechecks a crop revision inside transaction retry after another tab commits newer bytes', async () => {
    const value = await fixture();
    await addAnnotation(value.record.id);
    const oldRows = await rawRecords();
    await putDocumentBlob(value.record.id, new Blob(['other tab PDF']));
    const fresh = (await getDocument(value.record.id))!;
    const newerOcr = ocr(fresh.contentRevision!, fresh.id);
    await savePageOcr(newerOcr);
    const newerAnnotation = { ...annotation, x: 66 };
    await addAnnotation(fresh.id, newerAnnotation);
    const newRows = await rawRecords();
    await externalCommit(oldRows);
    const gate = pauseEncryption();
    const pending = replaceDocumentWithAnnotations(
      value.record.id,
      new Blob(['late crop']),
      2,
      [],
      value.record.contentRevision,
    );
    const rejected = expect(pending).rejects.toThrow('changed');
    await gate.entered;
    try {
      await externalCommit(newRows);
    } finally {
      gate.release();
    }
    await rejected;
    gate.spy.mockRestore();
    expect((await getDocument(value.record.id))!.contentRevision).toBe(fresh.contentRevision);
    expect(await (await getDocumentBlob(value.record.id))!.text()).toBe('other tab PDF');
    expect(await loadAnnotations(value.record.id)).toEqual([newerAnnotation]);
    expect(await getPageOcr(value.record.id, fresh.contentRevision!, 0)).toEqual(newerOcr);
    expect(await rawRecords()).toEqual(newRows);
  });
  it.each(['before', 'encryption', 'commit'] as const)(
    'cancels page replacement %s without changing bytes, annotations or OCR',
    async (stage) => {
      const value = await fixture();
      await addAnnotation(value.record.id);
      const original = await rawRecords(),
        controller = new AbortController();
      const gate = stage === 'encryption' ? pauseEncryption() : undefined;
      if (stage === 'before') controller.abort();
      if (stage === 'commit') {
        const put = IDBObjectStore.prototype.put;
        vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (
          this: IDBObjectStore,
          row,
          key,
        ) {
          const request = key === undefined ? put.call(this, row) : put.call(this, row, key);
          if (this.name === 'records' && row.store === 'blobs') controller.abort();
          return request;
        });
      }
      const pending = replaceDocumentWithAnnotations(
        value.record.id,
        new Blob(['cancelled crop']),
        2,
        [],
        value.record.contentRevision,
        controller.signal,
      );
      const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
      if (gate) {
        await gate.entered;
        controller.abort();
        gate.release();
      }
      await rejected;
      vi.restoreAllMocks();
      expect(await rawRecords()).toEqual(original);
      expect(await (await getDocumentBlob(value.record.id))!.text()).toBe('old PDF');
      expect(await loadAnnotations(value.record.id)).toEqual([annotation]);
      expect(await getPageOcr(value.record.id, value.record.contentRevision, 0)).toEqual(value.ocr);
    },
  );
  it('round-trips exact text/UTF-16 offsets and encrypts text, geometry, index and identity', async () => {
    const value = await fixture();
    expect(await getPageOcr(value.record.id, value.record.contentRevision, 0)).toEqual(value.ocr);
    const rows = await rawRecords();
    const raw = JSON.stringify(rows);
    for (const secret of [
      value.ocr.text,
      value.record.id,
      value.record.contentRevision,
      value.ocr.engine,
      'ocr-pages:',
    ])
      expect(raw).not.toContain(secret);
    expect(rows.filter((row) => row.store === 'ocr')).toHaveLength(1);
    await lockVault();
    await expect(getPageOcr(value.record.id, value.record.contentRevision, 0)).rejects.toThrow(
      'locked',
    );
    await expect(savePageOcr(value.ocr)).rejects.toThrow('locked');
    await unlockVault(passphrase);
    expect(await getPageOcr(value.record.id, value.record.contentRevision, 0)).toEqual(value.ocr);
    const db = await openDB(VAULT_DATABASE, 1);
    const encrypted = rows.find((row) => row.store === 'ocr');
    encrypted.ciphertext.bytes[0] ^= 1;
    await db.put('records', encrypted);
    db.close();
    await expect(getPageOcr(value.record.id, value.record.contentRevision, 0)).rejects.toThrow(
      'authenticated',
    );
  });

  it('migrates a legacy byte/revision snapshot once and refuses missing bytes', async () => {
    await vaultTransaction(async (tx) => {
      tx.put('documents', document().id, document());
      tx.put('blobs', document().id, new Blob(['legacy PDF']));
      tx.put('documents', 'missing', document('missing'));
    });
    const [a, b] = await Promise.all([
      getDocumentForOcr(document().id),
      getDocumentForOcr(document().id),
    ]);
    expect(a!.record.contentRevision).toEqual(b!.record.contentRevision);
    expect(a!.record.contentRevision).toMatch(/^[a-f0-9-]{36}$/);
    expect(await a!.blob.text()).toBe('legacy PDF');
    expect(await ensureDocumentContentRevision(document().id)).toEqual(a!.record);
    expect(await getDocumentForOcr('missing')).toBeUndefined();
    expect((await getDocument('missing'))!.contentRevision).toBeUndefined();
    await expect(ensureDocumentContentRevision('missing')).rejects.toThrow('unavailable');
  });

  it('preserves OCR/revision through annotations and metadata, including stale metadata snapshots', async () => {
    const value = await fixture();
    await patchDocument(value.record.id, { name: 'Renamed', starred: true });
    await deleteFolder('folder');
    const operation: AnnotationOperation = {
      id: 'op',
      documentId: value.record.id,
      timestamp: 9,
      kind: 'delete',
      annotationId: 'annotation',
    };
    await appendAnnotationOperation(operation);
    await saveDocument({
      ...value.record,
      contentRevision: crypto.randomUUID(),
      name: 'Stale dialog rename',
    });
    expect((await getDocument(value.record.id))!.contentRevision).toBe(
      value.record.contentRevision,
    );
    expect(await getPageOcr(value.record.id, value.record.contentRevision, 0)).toEqual(value.ocr);
  });

  it.each(['put', 'patch', 'replace', 'save/restore'] as const)(
    'invalidates OCR atomically for the %s byte-write path, even for identical bytes',
    async (path) => {
      const value = await fixture();
      await savePageOcr(ocr(value.record.contentRevision, value.record.id, 1));
      const blob = new Blob(['old PDF']);
      if (path === 'put') await putDocumentBlob(value.record.id, blob);
      else if (path === 'patch')
        await patchDocument(value.record.id, { name: 'Changed PDF' }, blob);
      else if (path === 'replace')
        await replaceDocumentWithAnnotations(value.record.id, blob, 2, []);
      else await saveDocumentWithBlob(value.record, blob);
      const updated = (await getDocumentForOcr(value.record.id))!;
      expect(updated.record.contentRevision).not.toBe(value.record.contentRevision);
      expect(await getPageOcr(value.record.id, value.record.contentRevision, 0)).toBeUndefined();
      expect(await getPageOcr(value.record.id, updated.record.contentRevision, 0)).toBeUndefined();
      expect(await listVaultRecords('ocr')).toEqual([]);
      await expect(savePageOcr(value.ocr)).rejects.toThrow('changed');
      expect(
        (await listVaultRecords('settings')).some((row) => row.key.startsWith('ocr-pages:')),
      ).toBe(false);
    },
  );

  it('gives copies and seeded PDFs fresh revisions without inheriting OCR', async () => {
    const value = await fixture();
    await saveDocumentWithBlob({ ...value.record, id: 'copy' }, value.blob);
    const copy = (await getDocumentForOcr('copy'))!;
    expect(copy.record.contentRevision).not.toBe(value.record.contentRevision);
    expect(await getPageOcr('copy', copy.record.contentRevision, 0)).toBeUndefined();
    await deleteDocument(value.record.id);
    await deleteDocument('copy');
    await seedSampleWorkspace([], [{ record: value.record, blob: value.blob }]);
    const seeded = (await getDocumentForOcr(value.record.id))!;
    expect(seeded.record.contentRevision).not.toBe(value.record.contentRevision);
    expect(await getPageOcr(value.record.id, seeded.record.contentRevision, 0)).toBeUndefined();
  });

  it('deletes OCR and its encrypted index with the document while preserving other documents', async () => {
    const removed = await fixture(),
      retained = await fixture('other');
    await deleteDocument(removed.record.id);
    expect(await getPageOcr(removed.record.id, removed.record.contentRevision, 0)).toBeUndefined();
    await expect(savePageOcr(removed.ocr)).rejects.toThrow('unavailable');
    await expect(putDocumentBlob(removed.record.id, new Blob(['bytes']))).rejects.toThrow(
      'no longer exists',
    );
    expect(await getPageOcr(retained.record.id, retained.record.contentRevision, 0)).toEqual(
      retained.ocr,
    );
    expect(await listVaultRecords('ocr')).toHaveLength(1);
  });

  it('rejects malformed, oversized, blank and out-of-page results without overwriting good OCR', async () => {
    const value = await fixture();
    const invalid = [
      { text: '', words: [] },
      { text: ' '.repeat(20) },
      { words: [] },
      { words: Array(1) },
      { pageIndex: 2 },
      { text: 'x'.repeat(OCR_MAX_TEXT_CHARACTERS + 1) },
      { words: Array(OCR_MAX_WORDS + 1).fill(value.ocr.words[0]) },
      { words: [{ ...value.ocr.words[0], start: -1 }] },
      { words: [{ ...value.ocr.words[0], end: value.ocr.text.length + 1 }] },
      { words: [{ ...value.ocr.words[0], start: 9, end: 10 }] },
      { words: [value.ocr.words[1], value.ocr.words[0]] },
      { words: [{ ...value.ocr.words[0], confidence: 101 }] },
      { words: [{ ...value.ocr.words[0], quad: [NaN, ...quad.slice(1)] }] },
      { words: [{ ...value.ocr.words[0], quad: Array(8) }] },
      { words: [{ ...value.ocr.words[0], quad: [1_000_001, ...quad.slice(1)] }] },
      { createdAt: 'not a date' },
      { engine: '\nprivate log' },
      { language: '../../eng' },
    ];
    for (const patch of invalid)
      await expect(savePageOcr({ ...value.ocr, ...patch } as OcrPageRecord)).rejects.toThrow();
    expect(await getPageOcr(value.record.id, value.record.contentRevision, 0)).toEqual(value.ocr);
    expect(await getPageOcr(value.record.id, crypto.randomUUID(), 0)).toBeUndefined();
    expect(await getPageOcr(value.record.id, value.record.contentRevision, -1)).toBeUndefined();
    expect(await getPageOcr(value.record.id, value.record.contentRevision, 2)).toBeUndefined();
  });

  it('accepts the exact text cap, copies caller data, and avoids reading PDF bytes while saving', async () => {
    const value = await fixture();
    const changed = {
      ...value.ocr,
      text: 'x'.repeat(OCR_MAX_TEXT_CHARACTERS),
      words: [{ ...value.ocr.words[0], end: OCR_MAX_TEXT_CHARACTERS }],
    };
    const decrypt = crypto.subtle.decrypt.bind(crypto.subtle);
    const decryptedStores: string[] = [];
    vi.spyOn(crypto.subtle, 'decrypt').mockImplementation((algorithm, key, data) => {
      decryptedStores.push(new TextDecoder().decode((algorithm as AesGcmParams).additionalData));
      return decrypt(algorithm, key, data);
    });
    const saving = savePageOcr(changed);
    changed.text = 'caller changed after invoking save';
    changed.words[0].quad[0] = 123;
    await saving;
    // Presence uses getKey rather than decrypting the PDF blob again.
    expect(decryptedStores.some((aad) => aad.includes('"documents"'))).toBe(true);
    expect(decryptedStores.some((aad) => aad.includes('"blobs"'))).toBe(false);
    const saved = (await getPageOcr(value.record.id, value.record.contentRevision, 0))!;
    expect(saved.text).toHaveLength(OCR_MAX_TEXT_CHARACTERS);
    expect(saved.words[0].quad[0]).toBe(-10);
  });

  it('enforces the encoded record limit independently of text and word counts', async () => {
    const value = await fixture();
    const large: OcrPageRecord = {
      ...value.ocr,
      text: 'x'.repeat(OCR_MAX_TEXT_CHARACTERS),
      words: Array.from({ length: OCR_MAX_WORDS }, (_, index) => ({
        start: index * 2,
        end: index * 2 + 1,
        confidence: 0.1234567890123456,
        quad: Array(8).fill(-123456.12345678901) as OcrPageRecord['words'][number]['quad'],
      })),
    };
    expect(new TextEncoder().encode(JSON.stringify(large)).byteLength).toBeGreaterThan(
      OCR_MAX_RECORD_BYTES,
    );
    await expect(savePageOcr(large)).rejects.toThrow('storage limits');
    expect(await getPageOcr(value.record.id, value.record.contentRevision, 0)).toEqual(value.ocr);
  });

  it('does not save a pre-cancelled result or an OCR/index write that runs out of space', async () => {
    const value = await fixture();
    const cancelled = new AbortController();
    cancelled.abort();
    await expect(
      savePageOcr({ ...value.ocr, engine: 'cancelled-engine' }, { signal: cancelled.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    const put = IDBObjectStore.prototype.put;
    vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (
      this: IDBObjectStore,
      record,
      key,
    ) {
      if (this.name === 'records' && record.store === 'settings')
        throw new DOMException('Full', 'QuotaExceededError');
      return key === undefined ? put.call(this, record) : put.call(this, record, key);
    });
    await expect(savePageOcr({ ...value.ocr, engine: 'failed-engine' })).rejects.toThrow(
      'storage is full',
    );
    vi.restoreAllMocks();
    expect(await getPageOcr(value.record.id, value.record.contentRevision, 0)).toEqual(value.ocr);
  });

  it('rolls back byte revision, PDF bytes and OCR deletion together on a failed write', async () => {
    const value = await fixture();
    const put = IDBObjectStore.prototype.put;
    vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (
      this: IDBObjectStore,
      record,
      key,
    ) {
      if (this.name === 'records' && record.store === 'blobs')
        throw new DOMException('Full', 'QuotaExceededError');
      return key === undefined ? put.call(this, record) : put.call(this, record, key);
    });
    await expect(putDocumentBlob(value.record.id, new Blob(['replacement PDF']))).rejects.toThrow(
      'storage is full',
    );
    vi.restoreAllMocks();
    expect((await getDocument(value.record.id))!.contentRevision).toBe(
      value.record.contentRevision,
    );
    expect(await (await getDocumentBlob(value.record.id))!.text()).toBe('old PDF');
    expect(await getPageOcr(value.record.id, value.record.contentRevision, 0)).toEqual(value.ocr);
  });

  it('does not overwrite earlier OCR after cancellation during encryption or inside IDB commit', async () => {
    const value = await fixture();
    const controller = new AbortController(),
      gate = pauseEncryption();
    const pending = savePageOcr(
      { ...value.ocr, engine: 'new-engine' },
      { signal: controller.signal },
    );
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await gate.entered;
    controller.abort();
    gate.release();
    await rejected;
    gate.spy.mockRestore();
    const during = new AbortController(),
      put = IDBObjectStore.prototype.put;
    vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (
      this: IDBObjectStore,
      record,
      key,
    ) {
      const request = key === undefined ? put.call(this, record) : put.call(this, record, key);
      if (this.name === 'records' && record.store === 'ocr') during.abort();
      return request;
    });
    await expect(
      savePageOcr({ ...value.ocr, engine: 'new-engine' }, { signal: during.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    vi.restoreAllMocks();
    expect(await getPageOcr(value.record.id, value.record.contentRevision, 0)).toEqual(value.ocr);
  });

  it('rejects an in-flight OCR save across locking and a new unlocked session', async () => {
    const value = await fixture();
    const events = new EventTarget();
    vi.stubGlobal('window', events);
    vi.stubGlobal(
      'BroadcastChannel',
      class {
        onmessage: unknown;
        postMessage() {}
        close() {}
      },
    );
    await unlockVault(passphrase);
    const gate = pauseEncryption();
    const pending = savePageOcr({ ...value.ocr, engine: 'new-engine' });
    const rejected = expect(pending).rejects.toThrow(/locked|stopped/);
    await gate.entered;
    try {
      // Page teardown removes the session immediately rather than awaiting queued writes.
      events.dispatchEvent(new Event('pagehide'));
      expect(await vaultStatus()).toBe('locked');
      await unlockVault(passphrase);
    } finally {
      gate.release();
    }
    await rejected;
    gate.spy.mockRestore();
    expect(await getPageOcr(value.record.id, value.record.contentRevision, 0)).toEqual(value.ocr);
  });

  it('rechecks a stale OCR save after another tab changes the PDF before commit', async () => {
    const value = await fixture(),
      oldRows = await rawRecords();
    await putDocumentBlob(value.record.id, new Blob(['other tab PDF']));
    const newRows = await rawRecords(),
      current = (await getDocument(value.record.id))!;
    await externalCommit(oldRows);
    const gate = pauseEncryption();
    const pending = savePageOcr({ ...value.ocr, engine: 'late-engine' });
    const rejected = expect(pending).rejects.toThrow('changed');
    await gate.entered;
    await externalCommit(newRows);
    gate.release();
    await rejected;
    gate.spy.mockRestore();
    expect((await getDocument(value.record.id))!.contentRevision).toBe(current.contentRevision);
    expect(await listVaultRecords('ocr')).toHaveLength(0);
  });

  it('retries an atomic PDF snapshot when another tab changes bytes between reads', async () => {
    const value = await fixture(),
      oldRows = await rawRecords();
    await putDocumentBlob(value.record.id, new Blob(['other tab PDF']));
    const newRows = await rawRecords(),
      current = (await getDocument(value.record.id))!;
    await externalCommit(oldRows);
    const entered = deferred(),
      release = deferred(),
      decrypt = crypto.subtle.decrypt.bind(crypto.subtle);
    let held = false;
    vi.spyOn(crypto.subtle, 'decrypt').mockImplementation(async (algorithm, key, data) => {
      const aad = new TextDecoder().decode((algorithm as AesGcmParams).additionalData);
      if (!held && aad.includes('"blobs"')) {
        held = true;
        entered.resolve();
        await release.promise;
      }
      return decrypt(algorithm, key, data);
    });
    const pending = getDocumentForOcr(value.record.id);
    await entered.promise;
    await externalCommit(newRows);
    release.resolve();
    const result = (await pending)!;
    expect(result.record.contentRevision).toBe(current.contentRevision);
    expect(await result.blob.text()).toBe('other tab PDF');
  });
});

describe('revision-consistent searchable export collection', () => {
  it('collects only indexed pages for this document in page order and supports one-page export', async () => {
    const value = await fixture();
    await savePageOcr(ocr(value.record.contentRevision, value.record.id, 1));
    await fixture('unrelated');
    expect(
      (await getOcrForExport(value.record.id, value.record.contentRevision)).map(
        (p) => p.pageIndex,
      ),
    ).toEqual([0, 1]);
    expect(
      (await getOcrForExport(value.record.id, value.record.contentRevision, 1)).map(
        (p) => p.pageIndex,
      ),
    ).toEqual([1]);
    await expect(getOcrForExport(value.record.id, value.record.contentRevision, 2)).rejects.toThrow(
      'unavailable',
    );
  });
  it('rejects stale revisions, missing indexed results and mismatched records instead of silently losing OCR', async () => {
    const value = await fixture();
    await expect(getOcrForExport(value.record.id, crypto.randomUUID())).rejects.toThrow('changed');
    const key = JSON.stringify([value.record.id, value.record.contentRevision, 0]);
    await vaultTransaction(async (tx) => {
      tx.put('ocr', key, { ...value.ocr, pageIndex: 1 });
    });
    await expect(getOcrForExport(value.record.id, value.record.contentRevision)).rejects.toThrow(
      'does not match',
    );
    await vaultTransaction(async (tx) => {
      tx.delete('ocr', key);
    });
    await expect(getOcrForExport(value.record.id, value.record.contentRevision)).rejects.toThrow(
      'missing',
    );
  });
  it('requires an unlocked vault and respects cancellation', async () => {
    const value = await fixture();
    const controller = new AbortController();
    controller.abort();
    await expect(
      getOcrForExport(value.record.id, value.record.contentRevision, undefined, controller.signal),
    ).rejects.toMatchObject({ name: 'AbortError' });
    await lockVault();
    await expect(getOcrForExport(value.record.id, value.record.contentRevision)).rejects.toThrow(
      'locked',
    );
  });
  it('rejects a stale export snapshot when another tab changes the PDF during OCR decryption', async () => {
    const value = await fixture(),
      oldRows = await rawRecords();
    await putDocumentBlob(value.record.id, new Blob(['other tab PDF']));
    const newRows = await rawRecords();
    await externalCommit(oldRows);
    const entered = deferred(),
      release = deferred();
    const decrypt = crypto.subtle.decrypt.bind(crypto.subtle);
    let held = false;
    vi.spyOn(crypto.subtle, 'decrypt').mockImplementation(async (algorithm, key, data) => {
      const aad = new TextDecoder().decode((algorithm as AesGcmParams).additionalData);
      if (!held && aad.includes('"ocr"')) {
        held = true;
        entered.resolve();
        await release.promise;
      }
      return decrypt(algorithm, key, data);
    });
    const pending = getOcrForExport(value.record.id, value.record.contentRevision);
    const rejection = expect(pending).rejects.toThrow('changed');
    await entered.promise;
    await externalCommit(newRows);
    release.resolve();
    await rejection;
  });

  it('caps aggregate pages before decrypting page records while allowing a selected page', async () => {
    const value = await fixture();
    await patchDocument(value.record.id, { pageCount: 102 });
    await vaultTransaction(async (tx) => {
      tx.put('settings', `ocr-pages:${JSON.stringify(value.record.id)}`, {
        schema: 1,
        contentRevision: value.record.contentRevision,
        pages: Array.from({ length: 101 }, (_, i) => i),
      });
    });
    await expect(getOcrForExport(value.record.id, value.record.contentRevision)).rejects.toThrow(
      'limits',
    );
    expect(await getOcrForExport(value.record.id, value.record.contentRevision, 0)).toEqual([
      value.ocr,
    ]);
  });
});
