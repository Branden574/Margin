import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PDFDocument, PDFName, PDFNumber, degrees } from 'pdf-lib';
import { openDB } from 'idb';
import type { AnnotationOperation, DocumentRecord } from '@margin/core';
vi.mock('pdfjs-dist', async () => import('pdfjs-dist/legacy/build/pdf.mjs'));
import {
  createAssignmentWorkClient,
  type VerifiedAssignmentSnapshot,
} from '../apps/web/src/lib/assignment-work/client';
import {
  createVerifiedWorkCopy,
  findVerifiedWorkCopy,
  enqueueAssignmentOperation,
  readAssignmentSnapshot,
  prepareAssignmentSend,
  acknowledgeAssignmentOperation,
  markAssignmentOutcome,
  applyAssignmentCatchUp,
} from '../apps/web/src/lib/assignment-work/repository';
import {
  AssignmentRetryError,
  MAX_OUTBOX_OPERATIONS,
} from '../apps/web/src/lib/assignment-work/repositoryTypes';
import {
  createVault,
  lockVault,
  unlockVault,
  VAULT_DATABASE,
  vaultStatus,
  listVaultRecords,
  readVaultRecord,
  vaultTransaction,
} from '../apps/web/src/lib/vault';
import {
  appendAnnotationOperation,
  deleteDocument,
  getDocumentBlob,
  isAssignmentCopy,
  listDocuments,
  patchDocument,
  putDocumentBlob,
  replaceDocumentWithAnnotations,
  saveDocument,
  saveDocumentWithBlob,
} from '../apps/web/src/lib/storage';
import type {
  AppendOperation,
  CatchUpResult,
  WorkManifest,
} from '../apps/web/src/lib/assignment-work/types';

const passphrase = 'synthetic assignment vault testing only';
const origin = 'https://assignment.synthetic.test';
const id = (n: number) => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const time = 1_800_000_000_000;
async function source(rotation = 0, unit = 1) {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([500, 700]);
  page.setCropBox(30, 40, 400, 600);
  page.setRotation(degrees(rotation));
  page.node.set(PDFName.of('UserUnit'), PDFNumber.of(unit));
  pdf.setTitle('Private synthetic assignment source');
  return new Blob([(await pdf.save()) as BlobPart], { type: 'application/pdf' });
}
async function harness(rotation = 0, unit = 1) {
  const state = {
    now: time,
    sessionId: id(1),
    userId: id(2),
    blob: await source(rotation, unit),
    manifest: {
      assignment: {
        id: id(4),
        title: 'Private synthetic coursework',
        instructions: 'Private teacher instruction',
        policy: {
          allowedTools: ['text', 'pen', 'line', 'eraser'],
          assessment: false,
          allowExport: true,
          allowCopyPaste: true,
          allowReadAloud: true,
        },
      },
      work: {
        id: id(5),
        status: 'provisioned',
        document: {
          documentId: id(6),
          versionId: id(7),
          cursor: 0,
          permission: 'owner',
          audience: 'members',
          pages: [
            {
              id: id(8),
              index: 0,
              width: (rotation % 180 ? 600 : 400) * unit,
              height: (rotation % 180 ? 400 : 600) * unit,
            },
          ],
        },
      },
    } as WorkManifest,
  };
  const fetcher = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input),
      isSource = url.endsWith('/source');
    const value = url.endsWith('/session')
      ? {
          authenticated: true,
          sessionId: state.sessionId,
          userId: state.userId,
          organizationId: id(3),
          role: 'student',
          authenticationMethod: 'lti',
          mfa: false,
          createdAt: time - 1000,
          lastSeenAt: time,
          expiresAt: time + 120_000,
          csrfToken: 'a'.repeat(43),
        }
      : state.manifest;
    const response = new Response(isSource ? state.blob : JSON.stringify(value), {
      headers: { 'Content-Type': isSource ? 'application/pdf' : 'application/json' },
    });
    Object.defineProperty(response, 'url', { value: url });
    return response;
  });
  const client = createAssignmentWorkClient({
    expectedOrigin: origin,
    fetch: fetcher,
    now: () => state.now,
  });
  return {
    state,
    client,
    fetcher,
    snapshot: () => client.verifiedSnapshot({ includeSource: true }),
  };
}
async function fixture() {
  const h = await harness();
  const verified = await h.snapshot();
  const document = await createVerifiedWorkCopy(verified);
  return { ...h, verified, document };
}
function edit(
  document: DocumentRecord,
  n = 10,
  text = 'Private student draft',
  annotationId = id(9),
): AnnotationOperation {
  return {
    id: id(n),
    documentId: document.id,
    timestamp: time + n,
    kind: 'put',
    annotationId,
    annotation: {
      id: annotationId,
      pageIndex: 0,
      type: 'text',
      x: 20,
      y: 30,
      text,
      color: '#123456',
      strokeWidth: 1,
      opacity: 1,
      createdAt: time,
      author: 'You',
    },
  };
}
const ack = (op: AppendOperation, cursor: number) => ({
  operationId: op.operationId,
  cursor,
  annotationRevision: op.baseRevision + 1,
  duplicate: false,
});
function events(ops: AppendOperation[], after = 0): CatchUpResult {
  return {
    documentId: id(6),
    versionId: id(7),
    operations: ops.map((op, i) => ({
      ...op,
      actorId: id(2),
      cursor: after + i + 1,
      annotationRevision: op.baseRevision + 1,
      committedAt: new Date(time + i).toISOString(),
    })),
    nextCursor: after + ops.length,
    currentCursor: after + ops.length,
    hasMore: false,
  };
}
async function raw() {
  const db = await openDB(VAULT_DATABASE, 1);
  try {
    return await db.getAll('records');
  } finally {
    db.close();
  }
}
function pauseEncryption() {
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const original = crypto.subtle.encrypt.bind(crypto.subtle);
  vi.spyOn(crypto.subtle, 'encrypt').mockImplementationOnce(async (...args) => {
    entered();
    await gate;
    return original(...args);
  });
  return { started, release };
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

describe('encrypted assignment repository', () => {
  it('finds only the verified identity and resumes the same copy after a fresh launch and vault unlock', async () => {
    const h = await harness();
    const verified = await h.snapshot();
    const before = await raw();
    expect(await findVerifiedWorkCopy(verified)).toBeUndefined();
    expect(await raw()).toEqual(before);
    const document = await createVerifiedWorkCopy(verified);
    await patchDocument(document.id, { name: 'Saved local label' });
    h.client.dispose();
    await lockVault();
    await unlockVault(passphrase);
    const resumed = await harness();
    resumed.state.sessionId = id(80);
    const fresh = await resumed.client.verifiedSnapshot();
    resumed.fetcher.mockClear();
    const found = await findVerifiedWorkCopy(fresh);
    expect(found).toMatchObject({
      id: document.id,
      contentRevision: document.contentRevision,
      name: 'Saved local label',
    });
    expect(resumed.fetcher).not.toHaveBeenCalled();
    found!.name = 'Caller mutation';
    expect((await findVerifiedWorkCopy(fresh))!.name).toBe('Saved local label');
    const other = await harness();
    other.state.userId = id(81);
    expect(await findVerifiedWorkCopy(await other.client.verifiedSnapshot())).toBeUndefined();
  });
  it.each([
    ['null', null],
    ['non-object', 'damaged'],
    ['noncanonical ID', { localDocumentId: 'ABCDEF01-ABCD-4000-8000-ABCDEF012345' }],
    ['extra properties', { localDocumentId: id(90), unrelated: true }],
  ])('refuses a corrupt %s copy index instead of treating it as absent', async (_, damaged) => {
    const h = await fixture();
    const index = (await listVaultRecords('settings')).find((row) =>
      row.key.startsWith('assignment-copy:'),
    )!;
    await vaultTransaction(async (tx) => tx.put('settings', index.key, damaged));
    const before = await raw();
    await expect(findVerifiedWorkCopy(h.verified)).rejects.toMatchObject({
      code: 'invalid_copy_index',
    });
    expect(await raw()).toEqual(before);
  });
  it.each([
    'missing-document',
    'missing-binding',
    'revision-mismatch',
    'missing-revision',
    'wrong-document-ID',
    'wrong-identity',
    'missing-blob',
    'dangling-index',
  ])('refuses an indexed copy with %s atomically', async (fault) => {
    const h = await fixture();
    await vaultTransaction(async (tx) => {
      const document = await tx.get<any>('documents', h.document.id);
      const binding = await tx.get<any>('assignment-bindings', h.document.id);
      if (fault === 'missing-document') tx.delete('documents', h.document.id);
      if (fault === 'missing-binding') tx.delete('assignment-bindings', h.document.id);
      if (fault === 'revision-mismatch') {
        document.contentRevision = id(90);
        tx.put('documents', h.document.id, document);
      }
      if (fault === 'missing-revision') {
        delete document.contentRevision;
        delete binding.contentRevision;
        tx.put('documents', h.document.id, document);
        tx.put('assignment-bindings', h.document.id, binding);
      }
      if (fault === 'wrong-document-ID') {
        document.id = id(90);
        tx.put('documents', h.document.id, document);
      }
      if (fault === 'wrong-identity') {
        binding.identity.userId = id(90);
        tx.put('assignment-bindings', h.document.id, binding);
      }
      if (fault === 'missing-blob') tx.delete('blobs', h.document.id);
      if (fault === 'dangling-index') {
        const index = (await tx.list('settings')).find((row) =>
          row.key.startsWith('assignment-copy:'),
        )!;
        tx.put('settings', index.key, { localDocumentId: id(90) });
      }
    });
    const before = await raw();
    await expect(findVerifiedWorkCopy(h.verified)).rejects.toMatchObject({
      code:
        fault === 'missing-blob'
          ? 'source_missing'
          : fault === 'wrong-identity'
            ? 'binding_mismatch'
            : 'stale_binding',
    });
    expect(await raw()).toEqual(before);
  });
  it.each(['expiry', 'dispose', 'abort'] as const)(
    'withholds lookup results after %s while reading the encrypted index',
    async (reason) => {
      const h = await fixture(),
        controller = new AbortController(),
        before = await raw();
      const decrypt = crypto.subtle.decrypt.bind(crypto.subtle);
      vi.spyOn(crypto.subtle, 'decrypt').mockImplementationOnce(async (...args) => {
        const result = await decrypt(...args);
        if (reason === 'expiry') h.state.now += 60_000;
        else if (reason === 'dispose') h.client.dispose();
        else controller.abort();
        return result;
      });
      await expect(findVerifiedWorkCopy(h.verified, controller.signal)).rejects.toMatchObject(
        reason === 'abort'
          ? { name: 'AbortError' }
          : { code: reason === 'expiry' ? 'verification_required' : 'session_invalidated' },
      );
      expect(await raw()).toEqual(before);
    },
  );
  it('returns the single committed copy after concurrent verified creation attempts', async () => {
    const h = await harness(),
      verified = await h.snapshot();
    const results = await Promise.allSettled([
      createVerifiedWorkCopy(verified),
      createVerifiedWorkCopy(verified),
    ]);
    const created = results.filter((result) => result.status === 'fulfilled');
    const refused = results.filter((result) => result.status === 'rejected');
    expect(created).toHaveLength(1);
    expect(refused).toHaveLength(1);
    expect(refused[0].reason).toMatchObject({ code: 'already_bound' });
    expect(await findVerifiedWorkCopy(verified)).toEqual(created[0].value);
    expect(await listDocuments()).toHaveLength(1);
    expect(await listVaultRecords('assignment-bindings')).toHaveLength(1);
  });
  it.each(['records', 'public'] as const)(
    'aborts active IDB changes when provenance is invalidated on the %s write response',
    async (store) => {
      const h = await fixture(),
        revision = h.document.contentRevision!;
      await enqueueAssignmentOperation(h.document.id, revision, edit(h.document));
      const before = await raw();
      const put = IDBObjectStore.prototype.put;
      let invalidated = false;
      vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (
        this: IDBObjectStore,
        value,
        key,
      ) {
        const request = put.call(this, value, key);
        if (!invalidated && this.name === store) {
          invalidated = true;
          request.addEventListener('success', () => h.client.invalidate(), { once: true });
        }
        return request;
      });
      await expect(
        prepareAssignmentSend(h.document.id, revision, h.verified),
      ).rejects.toMatchObject({ code: 'session_invalidated' });
      expect(invalidated).toBe(true);
      expect(await raw()).toEqual(before);
    },
  );
  it('withholds a wire result after synchronous post-commit invalidation without claiming rollback', async () => {
    const h = await fixture(),
      revision = h.document.contentRevision!;
    await enqueueAssignmentOperation(h.document.id, revision, edit(h.document));
    vi.stubGlobal('window', {
      dispatchEvent(event: Event) {
        if (event.type === 'margin-data-change') h.client.invalidate();
        return true;
      },
    });
    await expect(prepareAssignmentSend(h.document.id, revision, h.verified)).rejects.toMatchObject({
      code: 'session_invalidated',
    });
    // The transaction was already durable before the notification invalidated its issuer.
    // No payload is returned; a later verified caller must resolve this saved sending state.
    expect((await readAssignmentSnapshot(h.document.id, revision)).pending[0].status).toBe(
      'sending',
    );
  });
  it.each(['dispose', 'expiry'] as const)(
    'withholds an outbound operation and its sending transition after %s during encryption',
    async (reason) => {
      const h = await fixture(),
        revision = h.document.contentRevision!;
      await enqueueAssignmentOperation(h.document.id, revision, edit(h.document));
      const before = await raw(),
        pause = pauseEncryption();
      const pending = prepareAssignmentSend(h.document.id, revision, h.verified);
      const observed = expect(pending).rejects.toMatchObject({
        code: reason === 'dispose' ? 'session_invalidated' : 'verification_required',
      });
      await pause.started;
      if (reason === 'dispose') h.client.dispose();
      else h.state.now += 60_000;
      pause.release();
      await observed;
      expect(await raw()).toEqual(before);
      expect((await readAssignmentSnapshot(h.document.id, revision)).pending[0].status).toBe(
        'queued',
      );
    },
  );
  it.each(['dispose', 'expiry'] as const)(
    'does not commit a verified copy after %s while its PDF and metadata are encrypting',
    async (reason) => {
      const h = await harness(),
        verified = await h.snapshot(),
        before = await raw();
      const pause = pauseEncryption();
      const pending = createVerifiedWorkCopy(verified);
      const observed = expect(pending).rejects.toMatchObject({
        code: reason === 'dispose' ? 'session_invalidated' : 'verification_required',
      });
      await pause.started;
      if (reason === 'dispose') h.client.dispose();
      else h.state.now += 60_000;
      pause.release();
      await observed;
      expect(await raw()).toEqual(before);
      expect(await listDocuments()).toEqual([]);
    },
  );
  it('retains the baseline, cursor and acknowledged overlay if provenance expires during catch-up encryption', async () => {
    const h = await fixture(),
      revision = h.document.contentRevision!;
    await enqueueAssignmentOperation(h.document.id, revision, edit(h.document));
    const operation = (await prepareAssignmentSend(h.document.id, revision, h.verified))!;
    await acknowledgeAssignmentOperation(h.document.id, revision, ack(operation, 1));
    const before = await raw(),
      pause = pauseEncryption();
    const pending = applyAssignmentCatchUp(
      h.document.id,
      revision,
      h.verified,
      0,
      events([operation]),
    );
    const observed = expect(pending).rejects.toMatchObject({ code: 'verification_required' });
    await pause.started;
    h.state.now += 60_000;
    pause.release();
    await observed;
    expect(await raw()).toEqual(before);
    const snapshot = await readAssignmentSnapshot(h.document.id, revision);
    expect(snapshot.binding.appliedCursor).toBe(0);
    expect(snapshot.pending[0].status).toBe('acknowledged');
  });
  it.each(['operation', 'annotation'] as const)(
    'rejects noncanonical uppercase %s UUIDs before writing any local or outbox record',
    async (kind) => {
      const h = await fixture(),
        revision = h.document.contentRevision!,
        local = edit(h.document);
      const uppercase = 'ABCDEF01-ABCD-4000-8000-ABCDEF012345';
      if (kind === 'operation') local.id = uppercase;
      else {
        local.annotationId = uppercase;
        local.annotation!.id = uppercase;
      }
      const before = await raw();
      await expect(
        enqueueAssignmentOperation(h.document.id, revision, local),
      ).rejects.toMatchObject({ code: 'invalid_local_operation' });
      expect(await raw()).toEqual(before);
      if (kind === 'operation') local.id = uppercase.toLowerCase();
      else {
        local.annotationId = uppercase.toLowerCase();
        local.annotation!.id = local.annotationId;
      }
      await enqueueAssignmentOperation(h.document.id, revision, local);
      const outbound = await prepareAssignmentSend(h.document.id, revision, h.verified);
      expect(outbound?.[kind === 'operation' ? 'operationId' : 'annotationId']).toBe(
        uppercase.toLowerCase(),
      );
      expect((await readAssignmentSnapshot(h.document.id, revision)).pending).toHaveLength(1);
    },
  );
  it.each([0, 90, 180, 270])(
    'creates a new encrypted copy with actual CropBox/rotation/UserUnit geometry (%s)',
    async (rotation) => {
      const h = await harness(rotation, 2),
        verified = await h.snapshot(),
        doc = await createVerifiedWorkCopy(verified);
      expect(doc.id).not.toBe(id(6));
      expect(doc.pageCount).toBe(1);
      const snapshot = await readAssignmentSnapshot(doc.id);
      expect(snapshot.binding.sourceSha256).toMatch(/^[a-f0-9]{64}$/);
      expect(snapshot.binding.identity).toMatchObject({
        origin,
        organizationId: id(3),
        userId: id(2),
        documentId: id(6),
        versionId: id(7),
      });
      expect(await (await getDocumentBlob(doc.id))!.arrayBuffer()).toEqual(
        await h.state.blob.arrayBuffer(),
      );
      const serialized = JSON.stringify(await raw());
      for (const privateValue of ['Private synthetic', 'Private teacher', id(2), id(6), doc.id])
        expect(serialized).not.toContain(privateValue);
      await expect(createVerifiedWorkCopy(verified)).rejects.toMatchObject({
        code: 'already_bound',
      });
      expect(await listDocuments()).toHaveLength(1);
    },
  );
  it('rejects forged provenance, missing source, geometry mismatch, and malformed PDF without saving a copy', async () => {
    await expect(createVerifiedWorkCopy({} as VerifiedAssignmentSnapshot)).rejects.toMatchObject({
      code: 'verification_required',
    });
    const h = await harness();
    await expect(createVerifiedWorkCopy(await h.client.verifiedSnapshot())).rejects.toMatchObject({
      code: 'source_required',
    });
    h.client.dispose();
    const mismatch = await harness();
    if (mismatch.state.manifest.work?.status !== 'provisioned') throw Error();
    mismatch.state.manifest.work.document.pages[0].width = 123;
    await expect(createVerifiedWorkCopy(await mismatch.snapshot())).rejects.toMatchObject({
      code: 'source_geometry_mismatch',
    });
    const malformed = await harness();
    malformed.state.blob = new Blob(['%PDF-1.7\nsynthetic broken PDF'], {
      type: 'application/pdf',
    });
    await expect(createVerifiedWorkCopy(await malformed.snapshot())).rejects.toThrow();
    expect(await listDocuments()).toEqual([]);
  });
  it('atomically saves local edits and exact ordered wire revisions, retaining acknowledgements until contiguous echoes', async () => {
    const h = await fixture(),
      r = h.document.contentRevision!;
    const first = edit(h.document),
      second = edit(h.document, 11, 'Second offline draft');
    const third: AnnotationOperation = {
      id: id(12),
      documentId: h.document.id,
      timestamp: time + 12,
      kind: 'delete',
      annotationId: id(9),
    };
    for (const op of [first, second, third]) await enqueueAssignmentOperation(h.document.id, r, op);
    expect(await listVaultRecords('annotations')).toHaveLength(3);
    const sent: AppendOperation[] = [];
    for (let i = 0; i < 3; i++) {
      const op = (await prepareAssignmentSend(h.document.id, r, h.verified))!;
      expect(op).toMatchObject({ operationId: id(10 + i), baseRevision: i });
      sent.push(op);
      await expect(prepareAssignmentSend(h.document.id, r, h.verified)).rejects.toMatchObject({
        code: 'uncertain_save',
      });
      await acknowledgeAssignmentOperation(h.document.id, r, ack(op, i + 1));
    }
    let saved = await readAssignmentSnapshot(h.document.id, r);
    expect(saved.binding.appliedCursor).toBe(0);
    expect(saved.binding.observedCursor).toBe(3);
    expect(saved.pending.map((p) => p.status)).toEqual([
      'acknowledged',
      'acknowledged',
      'acknowledged',
    ]);
    expect(saved.annotations).toEqual([]);
    await applyAssignmentCatchUp(h.document.id, r, h.verified, 0, events(sent));
    saved = await readAssignmentSnapshot(h.document.id, r);
    expect(saved.binding.appliedCursor).toBe(3);
    expect(saved.pending).toEqual([]);
    expect(saved.annotations).toEqual([]);
    const baseline = await listVaultRecords<{ revision: number; annotation: unknown }>(
      'assignment-baseline',
    );
    expect(baseline[0].value).toMatchObject({ revision: 3, annotation: null });
    await acknowledgeAssignmentOperation(h.document.id, r, { ...ack(sent[2], 3), duplicate: true });
    await enqueueAssignmentOperation(h.document.id, r, first);
    expect((await readAssignmentSnapshot(h.document.id, r)).pending).toEqual([]);
  });
  it('refuses a stale rendered edit when concurrent catch-up advances the baseline before enqueue runs', async () => {
    const h = await fixture(),
      r = h.document.contentRevision!,
      saved = edit(h.document);
    await enqueueAssignmentOperation(h.document.id, r, saved, undefined, 0);
    const first = (await prepareAssignmentSend(h.document.id, r, h.verified))!;
    await applyAssignmentCatchUp(h.document.id, r, h.verified, 0, events([first]));
    const rendered = await readAssignmentSnapshot(h.document.id, r);
    const otherDevice = {
      ...first,
      operationId: id(70),
      baseRevision: 1,
      annotation: { ...first.annotation!, text: 'Newer other-device answer' },
    };
    const pause = pauseEncryption();
    const refreshing = applyAssignmentCatchUp(
      h.document.id,
      r,
      h.verified,
      1,
      events([otherDevice], 1),
    );
    await pause.started;
    const local = edit(h.document, 11, 'Stale rendered answer');
    const original = structuredClone(local);
    const saving = enqueueAssignmentOperation(
      h.document.id,
      r,
      local,
      undefined,
      rendered.binding.appliedCursor,
    );
    const outcome = expect(saving).rejects.toMatchObject({ code: 'stale_editor_cursor' });
    pause.release();
    await refreshing;
    await outcome;
    expect(local).toEqual(original);
    const snapshot = await readAssignmentSnapshot(h.document.id, r);
    expect(snapshot.binding.appliedCursor).toBe(2);
    expect(snapshot.annotations[0].text).toBe('Newer other-device answer');
    expect(snapshot.pending).toEqual([]);
    expect(await readVaultRecord('annotations', local.id)).toBeUndefined();
    expect(await listVaultRecords('assignment-outbox')).toEqual([]);
    // A separately refreshed editor may submit its deliberate new edit at the current cursor.
    await enqueueAssignmentOperation(h.document.id, r, local, undefined, 2);
    expect((await prepareAssignmentSend(h.document.id, r, h.verified))!.baseRevision).toBe(2);
  });
  it('confirms an exact committed retry at an older cursor without accepting a new stale edit', async () => {
    const h = await fixture(),
      r = h.document.contentRevision!,
      original = edit(h.document);
    await enqueueAssignmentOperation(h.document.id, r, original, undefined, 0);
    const sent = (await prepareAssignmentSend(h.document.id, r, h.verified))!;
    await applyAssignmentCatchUp(h.document.id, r, h.verified, 0, events([sent]));
    const before = await raw();
    await enqueueAssignmentOperation(h.document.id, r, structuredClone(original), undefined, 0);
    expect(await raw()).toEqual(before);
    await expect(
      enqueueAssignmentOperation(
        h.document.id,
        r,
        edit(h.document, 11, 'New edit from stale editor'),
        undefined,
        0,
      ),
    ).rejects.toMatchObject({ code: 'stale_editor_cursor' });
    await expect(
      enqueueAssignmentOperation(
        h.document.id,
        r,
        { ...original, annotation: { ...original.annotation!, text: 'Changed duplicate payload' } },
        undefined,
        0,
      ),
    ).rejects.toMatchObject({ code: 'local_operation_conflict' });
    expect(await raw()).toEqual(before);
  });
  it.each([-1, 0.5, 100_001, Number.MAX_SAFE_INTEGER + 1, Infinity, NaN])(
    'rejects invalid rendered cursor %s without local writes',
    async (cursor) => {
      const h = await fixture(),
        before = await raw();
      await expect(
        enqueueAssignmentOperation(
          h.document.id,
          h.document.contentRevision!,
          edit(h.document),
          undefined,
          cursor,
        ),
      ).rejects.toMatchObject({ code: 'invalid_editor_cursor' });
      expect(await raw()).toEqual(before);
    },
  );
  it('snapshots caller edits, preserves exact retries over lock/reload, and invalidates old capabilities', async () => {
    const h = await fixture(),
      r = h.document.contentRevision!,
      local = edit(h.document);
    const saving = enqueueAssignmentOperation(h.document.id, r, local);
    local.annotation!.text = 'mutated after call';
    await saving;
    const sent = (await prepareAssignmentSend(h.document.id, r, h.verified))!;
    expect(sent.annotation?.text).toBe('Private student draft');
    await lockVault();
    await unlockVault(passphrase);
    await expect(
      prepareAssignmentSend(h.document.id, r, h.verified, sent.operationId),
    ).rejects.toThrow('locked');
    const fresh = await h.client.verifiedSnapshot();
    await expect(prepareAssignmentSend(h.document.id, r, fresh)).rejects.toMatchObject({
      code: 'uncertain_save',
    });
    expect(await prepareAssignmentSend(h.document.id, r, fresh, sent.operationId)).toEqual(sent);
    await markAssignmentOutcome(h.document.id, r, sent.operationId, 'uncertain');
    expect(await prepareAssignmentSend(h.document.id, r, fresh, sent.operationId)).toEqual(sent);
    expect((await readAssignmentSnapshot(h.document.id, r)).annotations[0].text).toBe(
      'Private student draft',
    );
  });
  it('refuses expired, disposed, swapped-principal and stale-content bindings before exposing outbound rows', async () => {
    const h = await fixture(),
      r = h.document.contentRevision!;
    await enqueueAssignmentOperation(h.document.id, r, edit(h.document));
    await expect(prepareAssignmentSend(h.document.id, id(99), h.verified)).rejects.toMatchObject({
      code: 'stale_binding',
    });
    h.state.now += 60_000;
    await expect(prepareAssignmentSend(h.document.id, r, h.verified)).rejects.toMatchObject({
      code: 'verification_required',
    });
    const fresh = await h.client.verifiedSnapshot();
    h.client.dispose();
    await expect(prepareAssignmentSend(h.document.id, r, fresh)).rejects.toMatchObject({
      code: 'session_invalidated',
    });
    const other = await harness();
    other.state.userId = id(80);
    await expect(
      prepareAssignmentSend(h.document.id, r, await other.client.verifiedSnapshot()),
    ).rejects.toMatchObject({ code: 'binding_mismatch' });
    expect((await readAssignmentSnapshot(h.document.id, r)).pending[0].status).toBe('queued');
  });
  it.each(['acknowledged', 'applied'] as const)(
    'never retries a replacement queue head when the intended operation was %s during a concurrent transaction',
    async (state) => {
      const h = await fixture(),
        r = h.document.contentRevision!;
      await enqueueAssignmentOperation(h.document.id, r, edit(h.document));
      await enqueueAssignmentOperation(h.document.id, r, edit(h.document, 11, 'Later draft'));
      const original = (await prepareAssignmentSend(h.document.id, r, h.verified))!;
      await markAssignmentOutcome(h.document.id, r, original.operationId, 'uncertain');
      // Reconciliation wins the transaction queue after a caller has observed the uncertain row.
      // An exact retry queued during that save must see the new head without choosing it.
      const pause = pauseEncryption();
      const reconcile =
        state === 'acknowledged'
          ? acknowledgeAssignmentOperation(h.document.id, r, ack(original, 1))
          : applyAssignmentCatchUp(h.document.id, r, h.verified, 0, events([original]));
      await pause.started;
      const retry = prepareAssignmentSend(h.document.id, r, h.verified, original.operationId);
      const outcome = retry.catch((error: unknown) => error);
      pause.release();
      await reconcile;
      const error = await outcome;
      expect(error).toBeInstanceOf(AssignmentRetryError);
      expect(error).toMatchObject({
        code: 'retry_reconciled',
        operationId: original.operationId,
      });
      const saved = await readAssignmentSnapshot(h.document.id, r);
      expect(saved.pending.find((row) => row.operationId === id(11))!.status).toBe('queued');
      expect(saved.annotations[0].text).toBe('Later draft');
      // Deliberately preparing the next normal send is a separate caller decision.
      expect((await prepareAssignmentSend(h.document.id, r, h.verified))!.operationId).toBe(id(11));
    },
  );
  it.each([
    ['noncanonical', 'ABCDEF01-ABCD-4000-8000-ABCDEF012345', 'invalid_retry_operation'],
    ['unknown', id(99), 'retry_not_pending'],
    ['queued', id(10), 'retry_not_pending'],
  ])('refuses a %s retry ID without sending a queued row', async (_, retryId, code) => {
    const h = await fixture(),
      r = h.document.contentRevision!;
    await enqueueAssignmentOperation(h.document.id, r, edit(h.document));
    const before = await raw();
    const error = await prepareAssignmentSend(h.document.id, r, h.verified, retryId).catch(
      (value: unknown) => value,
    );
    expect(error).toBeInstanceOf(AssignmentRetryError);
    expect(error).toMatchObject({ code, operationId: retryId });
    expect(await raw()).toEqual(before);
    expect((await readAssignmentSnapshot(h.document.id, r)).pending[0].status).toBe('queued');
  });
  it('requires an exact unresolved retry to remain the first eligible row', async () => {
    const h = await fixture(),
      r = h.document.contentRevision!;
    await enqueueAssignmentOperation(h.document.id, r, edit(h.document));
    await enqueueAssignmentOperation(h.document.id, r, edit(h.document, 11, 'Later draft'));
    const first = (await prepareAssignmentSend(h.document.id, r, h.verified))!;
    await acknowledgeAssignmentOperation(h.document.id, r, ack(first, 1));
    const later = (await prepareAssignmentSend(h.document.id, r, h.verified))!;
    // A competing operation conflicts with both retained drafts, including the earlier head.
    await applyAssignmentCatchUp(
      h.document.id,
      r,
      h.verified,
      0,
      events([{ ...first, operationId: id(70) }]),
    );
    const before = await raw();
    await expect(
      prepareAssignmentSend(h.document.id, r, h.verified, later.operationId),
    ).rejects.toMatchObject({ code: 'retry_not_head', operationId: later.operationId });
    expect(await raw()).toEqual(before);
  });
  it('keeps a newer offline overlay when an older acknowledged echo arrives', async () => {
    const h = await fixture(),
      r = h.document.contentRevision!;
    await enqueueAssignmentOperation(h.document.id, r, edit(h.document));
    await enqueueAssignmentOperation(h.document.id, r, edit(h.document, 11, 'Newer offline draft'));
    const first = (await prepareAssignmentSend(h.document.id, r, h.verified))!;
    await acknowledgeAssignmentOperation(h.document.id, r, ack(first, 1));
    await applyAssignmentCatchUp(h.document.id, r, h.verified, 0, events([first]));
    const snapshot = await readAssignmentSnapshot(h.document.id, r);
    expect(snapshot.annotations[0].text).toBe('Newer offline draft');
    expect(snapshot.pending).toHaveLength(1);
    expect((await prepareAssignmentSend(h.document.id, r, h.verified))?.baseRevision).toBe(1);
  });
  it('preserves conflicting payloads and drafts, stopping later sends without automatic rebasing', async () => {
    const h = await fixture(),
      r = h.document.contentRevision!;
    await enqueueAssignmentOperation(h.document.id, r, edit(h.document));
    await enqueueAssignmentOperation(
      h.document.id,
      r,
      edit(h.document, 11, 'Second offline draft'),
    );
    const original = (await prepareAssignmentSend(h.document.id, r, h.verified))!;
    const remote = {
      ...original,
      operationId: id(70),
      annotation: { ...original.annotation!, text: 'Other device edit' },
    };
    await applyAssignmentCatchUp(h.document.id, r, h.verified, 0, events([remote]));
    const snapshot = await readAssignmentSnapshot(h.document.id, r);
    expect(snapshot.annotations[0].text).toBe('Second offline draft');
    expect(snapshot.pending.every((p) => p.status === 'conflict')).toBe(true);
    await expect(
      prepareAssignmentSend(h.document.id, r, h.verified, original.operationId),
    ).rejects.toMatchObject({
      code: 'outbox_conflict',
    });
    const stored = await readVaultRecord<{ operation: AppendOperation }>(
      'assignment-outbox',
      `${h.document.id}:${original.operationId}`,
    );
    expect(stored!.operation).toEqual(original);
  });
  it('refuses malformed echoes, cursor gaps, and false acknowledgements atomically', async () => {
    const h = await fixture(),
      r = h.document.contentRevision!;
    await enqueueAssignmentOperation(h.document.id, r, edit(h.document));
    const sent = (await prepareAssignmentSend(h.document.id, r, h.verified))!;
    await expect(
      acknowledgeAssignmentOperation(h.document.id, r, { ...ack(sent, 1), annotationRevision: 2 }),
    ).rejects.toThrow();
    const changed = events([
      { ...sent, annotation: { ...sent.annotation!, text: 'different payload' } },
    ]);
    await expect(
      applyAssignmentCatchUp(h.document.id, r, h.verified, 0, changed),
    ).rejects.toMatchObject({ code: 'echo_mismatch' });
    const gap = events([sent]);
    gap.operations[0].cursor = 2;
    gap.nextCursor = 2;
    gap.currentCursor = 2;
    await expect(applyAssignmentCatchUp(h.document.id, r, h.verified, 0, gap)).rejects.toThrow();
    expect((await readAssignmentSnapshot(h.document.id, r)).binding.appliedCursor).toBe(0);
    await expect(
      applyAssignmentCatchUp(h.document.id, r, h.verified, 1, events([])),
    ).rejects.toMatchObject({ code: 'stale_cursor' });
  });
  it.each(['signature', 'arrow', 'stamp', 'dashed', 'fontSize', 'strokes', 'too-many-points'])(
    'refuses unsupported %s without partial local/outbox persistence',
    async (kind) => {
      const h = await fixture(),
        r = h.document.contentRevision!,
        local = edit(h.document);
      if (['signature', 'arrow', 'stamp'].includes(kind))
        Object.assign(local.annotation!, { type: kind });
      else if (kind === 'dashed') local.annotation!.lineStyle = 'dashed';
      else if (kind === 'fontSize') local.annotation!.fontSize = 18;
      else if (kind === 'strokes') local.annotation!.strokes = [[{ x: 1, y: 2 }]];
      else
        Object.assign(local.annotation!, {
          type: 'pen',
          points: Array.from({ length: 2001 }, () => ({ x: 1, y: 2 })),
        });
      await expect(enqueueAssignmentOperation(h.document.id, r, local)).rejects.toMatchObject({
        code: 'unsupported_appearance',
      });
      expect(await listVaultRecords('annotations')).toEqual([]);
      expect((await readAssignmentSnapshot(h.document.id, r)).pending).toEqual([]);
    },
  );
  it('blocks generic PDF/annotation replacement and deletion for bound copies', async () => {
    const h = await fixture(),
      doc = h.document,
      blob = (await getDocumentBlob(doc.id))!;
    expect(await isAssignmentCopy(doc.id)).toBe(true);
    expect(await isAssignmentCopy(id(999))).toBe(false);
    for (const run of [
      () => appendAnnotationOperation(edit(doc)),
      () => putDocumentBlob(doc.id, blob),
      () => saveDocumentWithBlob(doc, blob),
      () => replaceDocumentWithAnnotations(doc.id, blob, 1, []),
      () => patchDocument(doc.id, { pageCount: 2 }),
      () => patchDocument(doc.id, {}, blob),
      () => saveDocument({ ...doc, pageCount: 2 }),
      () => deleteDocument(doc.id),
    ])
      await expect(run()).rejects.toThrow('assignment');
    await patchDocument(doc.id, { name: 'Renamed local label' });
    expect((await readAssignmentSnapshot(doc.id)).document.name).toBe('Renamed local label');
  });
  it('rolls back local journal and outbox together if encryption fails or aborts', async () => {
    const h = await fixture(),
      r = h.document.contentRevision!,
      before = await raw();
    vi.spyOn(crypto.subtle, 'encrypt').mockRejectedValueOnce(
      new Error('Synthetic encryption failure'),
    );
    await expect(enqueueAssignmentOperation(h.document.id, r, edit(h.document))).rejects.toThrow(
      'Synthetic encryption',
    );
    expect(await raw()).toEqual(before);
    vi.restoreAllMocks();
    const encrypt = crypto.subtle.encrypt.bind(crypto.subtle),
      controller = new AbortController();
    vi.spyOn(crypto.subtle, 'encrypt').mockImplementationOnce(async (...args) => {
      const result = await encrypt(...args);
      controller.abort();
      return result;
    });
    await expect(
      enqueueAssignmentOperation(h.document.id, r, edit(h.document), controller.signal),
    ).rejects.toThrow('cancelled');
    expect(await raw()).toEqual(before);
  });
  it('enforces count bounds without discarding existing saved drafts', async () => {
    const h = await fixture(),
      r = h.document.contentRevision!;
    await enqueueAssignmentOperation(h.document.id, r, edit(h.document));
    // Test the admission boundary with an encrypted full index; no broad expensive 1,000-write loop.
    await vaultTransaction(async (tx) => {
      const binding = await tx.get<any>('assignment-bindings', h.document.id);
      binding.queue = Array(MAX_OUTBOX_OPERATIONS).fill(id(10));
      tx.put('assignment-bindings', h.document.id, binding);
    });
    await expect(
      enqueueAssignmentOperation(h.document.id, r, edit(h.document, 11, 'next', id(19))),
    ).rejects.toMatchObject({ code: 'outbox_limit' });
    expect(await listVaultRecords('annotations')).toHaveLength(1);
  });
});
