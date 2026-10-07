import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDB } from 'idb';
import { PDFDocument } from 'pdf-lib';
import type { AnnotationOperation } from '@margin/core';
vi.mock('pdfjs-dist', async () => import('pdfjs-dist/legacy/build/pdf.mjs'));
import { createAssignmentWorkClient } from '../apps/web/src/lib/assignment-work/client';
import { createStudentWorkController } from '../apps/web/src/lib/assignment-work/controller';
import type { StudentWorkController } from '../apps/web/src/lib/assignment-work/controllerTypes';
import type {
  AppendOperation,
  CommittedOperation,
  WorkManifest,
} from '../apps/web/src/lib/assignment-work/types';
import { readAssignmentSnapshot } from '../apps/web/src/lib/assignment-work/repository';
import {
  createVault,
  lockVault,
  onBeforeVaultLock,
  unlockVault,
  VAULT_DATABASE,
  vaultStatus,
} from '../apps/web/src/lib/vault';

const origin = 'https://assignment.synthetic.test';
const time = 1_800_000_000_000;
const passphrase = 'synthetic controller vault testing only';
const id = (n: number) => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const controllers: StudentWorkController[] = [];
function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function harness(options: Parameters<typeof createStudentWorkController>[0] = {}) {
  const pdf = await PDFDocument.create();
  pdf.addPage([400, 600]);
  const blob = new Blob([(await pdf.save()) as BlobPart], { type: 'application/pdf' });
  const readyWork = {
    id: id(5),
    status: 'provisioned',
    document: {
      documentId: id(6),
      versionId: id(7),
      cursor: 0,
      permission: 'owner',
      audience: 'members',
      pages: [{ id: id(8), index: 0, width: 400, height: 600 }],
    },
  } as const;
  const state = {
    now: time,
    sessionId: id(1),
    userId: id(2),
    denied: false,
    malformedSession: false,
    offline: false,
    loseAppendReply: false,
    cancelAppendReply: false,
    failAppend: false,
    operations: [] as CommittedOperation[],
    requests: [] as { path: string; method: string; body?: AppendOperation }[],
    gate: undefined as
      | undefined
      | {
          entered: ReturnType<typeof deferred>;
          release: ReturnType<typeof deferred>;
          path: string;
        },
    manifest: {
      assignment: {
        id: id(4),
        title: 'Synthetic private work',
        instructions: 'Synthetic teacher instructions',
        policy: {
          allowedTools: ['text', 'pen', 'line', 'eraser'],
          assessment: false,
          allowExport: true,
          allowCopyPaste: true,
          allowReadAloud: true,
        },
      },
      work: structuredClone(readyWork),
    } as WorkManifest,
  };
  function commit(operation: AppendOperation) {
    const prior = state.operations.find((row) => row.operationId === operation.operationId);
    if (prior)
      return {
        operationId: prior.operationId,
        cursor: prior.cursor,
        annotationRevision: prior.annotationRevision,
        duplicate: true,
      };
    const row: CommittedOperation = {
      ...structuredClone(operation),
      actorId: state.userId,
      cursor: state.operations.length + 1,
      annotationRevision: operation.baseRevision + 1,
      committedAt: new Date(time).toISOString(),
    };
    state.operations.push(row);
    if (state.manifest.work?.status === 'provisioned')
      state.manifest.work.document.cursor = row.cursor;
    return {
      operationId: row.operationId,
      cursor: row.cursor,
      annotationRevision: row.annotationRevision,
      duplicate: false,
    };
  }
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input),
      parsed = new URL(url),
      path = parsed.pathname,
      method = init?.method ?? 'GET';
    state.requests.push({
      path,
      method,
      ...(path.endsWith('/operations') && method === 'POST'
        ? { body: JSON.parse(String(init?.body)) }
        : {}),
    });
    if (state.gate?.path === path) {
      const gate = state.gate;
      gate.entered.resolve();
      await gate.release.promise; // deliberately ignores AbortSignal to exercise late completions
    }
    if (state.offline) throw new TypeError('Synthetic offline');
    let status = 200,
      value: unknown;
    if (state.denied) {
      status = 403;
      value = { error: { code: 'launch_revoked', message: 'Synthetic launch revoked' } };
    } else if (path.endsWith('/session'))
      value = state.malformedSession
        ? { authenticated: false }
        : {
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
          };
    else if (path.endsWith('/source')) value = blob;
    else if (path.endsWith('/operations')) {
      if (method === 'POST') {
        if (state.failAppend) {
          status = 409;
          value = { error: { code: 'annotation_conflict', message: 'Synthetic concurrent edit' } };
        } else {
          value = { receipt: commit(JSON.parse(String(init?.body))) };
          if (state.loseAppendReply) throw new TypeError('Synthetic reply lost after commit');
          if (state.cancelAppendReply) {
            status = 409;
            value = {
              error: {
                code: 'work_request_cancelled',
                message: 'Synthetic cancellation after commit',
              },
            };
          }
        }
      } else {
        const after = Number(parsed.searchParams.get('afterCursor') ?? '0'),
          limit = Number(parsed.searchParams.get('limit') ?? '100');
        const operations = state.operations.filter((row) => row.cursor > after).slice(0, limit);
        const nextCursor = operations.at(-1)?.cursor ?? after;
        value = {
          documentId: id(6),
          versionId: id(7),
          operations,
          nextCursor,
          currentCursor: state.operations.length,
          hasMore: nextCursor < state.operations.length,
        };
      }
    } else if (method === 'POST') {
      status = 202;
      state.manifest.work ??= { id: id(5), status: 'pending' };
      value = {
        work: {
          id: id(5),
          assignmentId: id(4),
          userId: state.userId,
          documentId: id(6),
          versionId: id(7),
          status: state.manifest.work.status,
          duplicate: false,
        },
      };
    } else value = state.manifest;
    const response = new Response(value instanceof Blob ? value : JSON.stringify(value), {
      status,
      headers: { 'Content-Type': value instanceof Blob ? 'application/pdf' : 'application/json' },
    });
    Object.defineProperty(response, 'url', { value: url });
    return response;
  });
  function controller() {
    const client = createAssignmentWorkClient({
      expectedOrigin: origin,
      fetch: fetcher,
      now: () => state.now,
    });
    const result = createStudentWorkController({ ...options, client });
    controllers.push(result);
    return result;
  }
  function gate(path: string) {
    const value = { path, entered: deferred(), release: deferred() };
    state.gate = value;
    return value;
  }
  return {
    state,
    commit,
    fetcher,
    controller: controller(),
    anotherController: controller,
    readyWork: structuredClone(readyWork),
    gate,
  };
}
function edit(
  controller: StudentWorkController,
  n = 10,
  text = 'Private student draft',
  annotationId = id(9),
): AnnotationOperation {
  return {
    id: id(n),
    documentId: controller.getState().view!.document.id,
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
const posts = (h: Awaited<ReturnType<typeof harness>>) =>
  h.state.requests.filter((r) => r.path.endsWith('/operations') && r.method === 'POST');
function wire(n: number): AppendOperation {
  return {
    operationId: id(1000 + n),
    documentId: id(6),
    versionId: id(7),
    pageId: id(8),
    annotationId: id(2000 + n),
    kind: 'put',
    baseRevision: 0,
    annotation: {
      type: 'text',
      x: 20,
      y: 30,
      text: `Remote ${n}`,
      color: '#123456',
      strokeWidth: 1,
      opacity: 1,
    },
  };
}
beforeEach(async () => {
  await lockVault();
  await vaultStatus();
  const db = await openDB(VAULT_DATABASE, 1);
  const tx = db.transaction(['public', 'records'], 'readwrite');
  await Promise.all([tx.objectStore('public').clear(), tx.objectStore('records').clear()]);
  await tx.done;
  db.close();
  await createVault(passphrase);
});
afterEach(async () => {
  for (const controller of controllers.splice(0)) controller.dispose();
  vi.restoreAllMocks();
  await lockVault();
  vi.unstubAllGlobals();
});

describe('bounded student work controller with real encrypted repository and client', () => {
  it('reserves once, returns pending without polling, then explicitly opens the provisioned copy', async () => {
    const h = await harness();
    h.state.manifest.work = null;
    await h.controller.open();
    expect(h.controller.getState()).toMatchObject({
      phase: 'provisioning',
      view: null,
      submission: 'not-submitted',
    });
    expect(h.state.requests.filter((r) => r.method === 'POST')).toHaveLength(1);
    const count = h.state.requests.length;
    await Promise.resolve();
    expect(h.state.requests).toHaveLength(count);
    h.state.manifest.work = h.readyWork;
    await h.controller.refresh();
    expect(h.controller.getState()).toMatchObject({
      phase: 'ready',
      view: { hydrated: true, annotations: [] },
    });
    expect(h.state.requests.filter((r) => r.method === 'POST')).toHaveLength(1);
    expect(h.state.requests.filter((r) => r.path.endsWith('/source'))).toHaveLength(1);
  });
  it('resumes the same encrypted copy and drafts through a fresh launch without redownloading source', async () => {
    const h = await harness();
    await h.controller.open();
    const operation = edit(h.controller);
    await h.controller.enqueue(operation);
    const original = h.controller.getState().view!.document;
    h.controller.dispose();
    h.state.sessionId = id(30);
    const reopened = h.anotherController();
    await reopened.open();
    expect(reopened.getState()).toMatchObject({
      saveStatus: 'local-only',
      view: {
        document: { id: original.id, contentRevision: original.contentRevision },
        annotations: [{ text: operation.annotation!.text }],
      },
    });
    expect(h.state.requests.filter((r) => r.path.endsWith('/source'))).toHaveLength(1);
    expect(posts(h)).toHaveLength(0);
  });
  it('publishes stable immutable snapshots and acknowledges only exact server receipts/echoes', async () => {
    const h = await harness();
    const callback = vi.fn();
    const unsubscribe = h.controller.subscribe(callback);
    const { getState } = h.controller;
    expect(getState()).toBe(getState());
    await h.controller.open();
    await h.controller.enqueue(edit(h.controller));
    expect(getState()).toMatchObject({
      saveStatus: 'local-only',
      view: { pending: [{ status: 'queued' }] },
    });
    expect(Object.isFrozen(getState().view!.annotations[0])).toBe(true);
    await h.controller.sync();
    expect(getState()).toMatchObject({
      phase: 'ready',
      saveStatus: 'acknowledged',
      submission: 'not-submitted',
      view: { appliedCursor: 1, pending: [], annotations: [{ text: 'Private student draft' }] },
    });
    expect(posts(h)).toHaveLength(1);
    expect(callback).toHaveBeenCalled();
    unsubscribe();
  });
  it('stops at a whole-action batch bound and resumes catch-up only on explicit refresh', async () => {
    const h = await harness({ maxCatchUpBatches: 1 });
    for (let n = 0; n < 101; n++) h.commit(wire(n));
    await h.controller.open();
    expect(h.controller.getState()).toMatchObject({
      phase: 'ready',
      needsCatchUp: true,
      view: { appliedCursor: 100, hydrated: false },
    });
    await h.controller.refresh();
    expect(h.controller.getState()).toMatchObject({
      needsCatchUp: false,
      view: { appliedCursor: 101, hydrated: true },
    });
    expect(posts(h)).toHaveLength(0);
  });
  it('bounds dispatches and never drains remaining local edits in the background', async () => {
    const h = await harness({ maxDispatches: 1 });
    await h.controller.open();
    await h.controller.enqueue(edit(h.controller, 10));
    await h.controller.enqueue(edit(h.controller, 11, 'Second draft', id(12)));
    await h.controller.sync();
    expect(posts(h)).toHaveLength(1);
    expect(h.controller.getState()).toMatchObject({
      saveStatus: 'local-only',
      view: { pending: [{ operationId: id(11), status: 'queued' }] },
    });
    await h.controller.sync();
    expect(posts(h)).toHaveLength(2);
    expect(h.controller.getState().saveStatus).toBe('acknowledged');
  });
  it('reconciles a lost reply by exact ID without sending the next queued operation', async () => {
    const h = await harness();
    await h.controller.open();
    await h.controller.enqueue(edit(h.controller, 10));
    await h.controller.enqueue(edit(h.controller, 11, 'Later draft', id(12)));
    h.state.loseAppendReply = true;
    await expect(h.controller.sync()).rejects.toMatchObject({
      uncertainSave: true,
      operationId: id(10),
    });
    expect(h.controller.getState().saveStatus).toBe('uncertain');
    h.state.loseAppendReply = false;
    await h.controller.retry(id(10));
    expect(h.controller.getState()).toMatchObject({
      reconciledOperationId: id(10),
      saveStatus: 'local-only',
      view: { pending: [{ operationId: id(11), status: 'queued' }] },
    });
    expect(posts(h)).toHaveLength(1);
  });
  it('recovers a server commit when saving its acknowledgement fails without issuing a replacement append', async () => {
    const h = await harness();
    await h.controller.open();
    await h.controller.enqueue(edit(h.controller));
    const original = h.fetcher.getMockImplementation()!;
    h.fetcher.mockImplementation(async (input, init) => {
      const response = await original(input, init);
      if (String(input).endsWith('/operations') && init?.method === 'POST')
        vi.spyOn(crypto.subtle, 'encrypt').mockRejectedValueOnce(
          new Error('Synthetic acknowledgement write failed'),
        );
      return response;
    });
    await expect(h.controller.sync()).rejects.toThrow('Synthetic acknowledgement write failed');
    expect(h.controller.getState().saveStatus).toBe('uncertain');
    await h.controller.retry(id(10));
    expect(h.controller.getState()).toMatchObject({
      reconciledOperationId: id(10),
      saveStatus: 'acknowledged',
      view: { pending: [] },
    });
    expect(posts(h)).toHaveLength(1);
  });
  it('sends the identical uncertain operation only after explicit retry when the first request did not commit', async () => {
    const h = await harness();
    await h.controller.open();
    await h.controller.enqueue(edit(h.controller));
    const original = h.fetcher.getMockImplementation()!;
    h.fetcher.mockImplementationOnce(original); // first session check is still valid
    let failOnce = true;
    h.fetcher.mockImplementation(async (input, init) => {
      if (String(input).endsWith('/operations') && init?.method === 'POST' && failOnce) {
        failOnce = false;
        h.state.requests.push({
          path: '/api/assignments/work/operations',
          method: 'POST',
          body: JSON.parse(String(init.body)),
        });
        throw new TypeError('Synthetic offline before commit');
      }
      return original(input, init);
    });
    await expect(h.controller.sync()).rejects.toMatchObject({ uncertainSave: true });
    await expect(h.controller.sync()).rejects.toMatchObject({ code: 'uncertain_save' });
    expect(posts(h)).toHaveLength(1);
    await h.controller.retry(id(10));
    expect(posts(h)).toHaveLength(2);
    expect(posts(h)[1].body).toEqual(posts(h)[0].body);
    expect(h.controller.getState().saveStatus).toBe('acknowledged');
  });
  it('retains conflicting local edits and stops subsequent dispatches without rebasing', async () => {
    const h = await harness();
    await h.controller.open();
    await h.controller.enqueue(edit(h.controller));
    h.state.failAppend = true;
    await expect(h.controller.sync()).rejects.toMatchObject({ status: 409 });
    expect(h.controller.getState()).toMatchObject({
      saveStatus: 'conflict',
      view: { annotations: [{ text: 'Private student draft' }] },
    });
    h.state.failAppend = false;
    await expect(h.controller.retry(id(10))).rejects.toMatchObject({ code: 'outbox_conflict' });
    expect(posts(h)).toHaveLength(1);
  });
  it('keeps a 409 cancellation after dispatch uncertain instead of permanently classifying it as a conflict', async () => {
    const h = await harness();
    await h.controller.open();
    await h.controller.enqueue(edit(h.controller));
    h.state.cancelAppendReply = true;
    await expect(h.controller.sync()).rejects.toMatchObject({ status: 409, uncertainSave: true });
    expect(h.controller.getState().saveStatus).toBe('uncertain');
    h.state.cancelAppendReply = false;
    await h.controller.retry(id(10));
    expect(h.controller.getState()).toMatchObject({
      reconciledOperationId: id(10),
      saveStatus: 'acknowledged',
    });
    expect(posts(h)).toHaveLength(1);
  });
  it('pins a rejected rendered cursor and exact payload until explicit discard, preserving the unseen remote edit', async () => {
    const h = await harness();
    await h.controller.open();
    const local = edit(h.controller);
    const doc = h.controller.getState().view!.document;
    const other = h.anotherController();
    await other.open();
    h.commit({
      ...wire(0),
      annotationId: id(9),
      annotation: { ...wire(0).annotation!, text: 'Unseen remote edit' },
    });
    await other.refresh();
    await expect(h.controller.enqueue(local, 0)).rejects.toMatchObject({
      code: 'stale_editor_cursor',
    });
    await expect(h.controller.flushLocal()).rejects.toMatchObject({ code: 'local_save_failed' });
    await expect(h.controller.enqueue(local, 1)).rejects.toMatchObject({
      code: 'stale_editor_cursor',
    });
    await expect(
      h.controller.enqueue(
        { ...local, annotation: { ...local.annotation!, text: 'Changed retry payload' } },
        1,
      ),
    ).rejects.toMatchObject({ code: 'local_retry_changed' });
    expect((await readAssignmentSnapshot(doc.id, doc.contentRevision)).annotations[0].text).toBe(
      'Unseen remote edit',
    );
    expect((await readAssignmentSnapshot(doc.id, doc.contentRevision)).pending).toEqual([]);
    h.controller.discardStaleDraft(local.id);
    await h.controller.flushLocal();
    await h.controller.refresh();
    expect(h.controller.getState().view!.annotations[0].text).toBe('Unseen remote edit');
    await h.controller.enqueue(edit(h.controller, 11, 'Explicit new edit after review'), 1);
    expect(h.controller.getState().saveStatus).toBe('local-only');
  });
  it('treats a data-change event only as an encrypted local refresh hint; mounted editor cursor still gates new writes', async () => {
    const h = await harness();
    await h.controller.open();
    h.controller.dispose();
    vi.stubGlobal('window', new EventTarget());
    h.controller = h.anotherController();
    await h.controller.open();
    const local = edit(h.controller);
    const other = h.anotherController();
    await other.open();
    const reflected = deferred();
    const remove = h.controller.subscribe(() => {
      if (h.controller.getState().view?.appliedCursor === 1) reflected.resolve();
    });
    h.commit(wire(0));
    await other.refresh();
    await reflected.promise;
    remove();
    expect(h.controller.getState().view!.appliedCursor).toBe(1);
    // React has not yet remounted the editor; it must supply its original cursor.
    await expect(h.controller.enqueue(local, 0)).rejects.toMatchObject({
      code: 'stale_editor_cursor',
    });
    expect(posts(h)).toHaveLength(0);
    h.controller.discardStaleDraft(local.id);
  });
  it.each(['denied', 'malformedSession', 'changed'] as const)(
    'clears visible principal/work data after %s invalidation and preserves encrypted drafts',
    async (kind) => {
      const h = await harness();
      await h.controller.open();
      await h.controller.enqueue(edit(h.controller));
      const doc = h.controller.getState().view!.document;
      if (kind === 'changed') h.state.userId = id(40);
      else h.state[kind] = true;
      await expect(h.controller.refresh()).rejects.toBeDefined();
      expect(h.controller.getState()).toMatchObject({ phase: 'invalidated', view: null });
      expect((await readAssignmentSnapshot(doc.id, doc.contentRevision)).annotations[0].text).toBe(
        'Private student draft',
      );
      await expect(h.controller.sync()).rejects.toMatchObject({ code: 'controller_closed' });
    },
  );
  it('retains local drafts on offline failure and recovers after an explicit refresh', async () => {
    const h = await harness();
    await h.controller.open();
    await h.controller.enqueue(edit(h.controller));
    h.state.offline = true;
    await expect(h.controller.refresh()).rejects.toMatchObject({ code: 'network_error' });
    expect(h.controller.getState()).toMatchObject({
      phase: 'error',
      view: { annotations: [{ text: 'Private student draft' }] },
    });
    h.state.offline = false;
    await h.controller.refresh();
    expect(h.controller.getState().phase).toBe('ready');
  });
  it('serializes network actions but persists local edits independently, and aborts network before vault lock', async () => {
    const h = await harness();
    await h.controller.open();
    const doc = h.controller.getState().view!.document;
    const gate = h.gate('/api/auth/session');
    const refresh = h.controller.refresh();
    const rejectedRefresh = expect(refresh).rejects.toMatchObject({ code: 'cancelled' });
    await gate.entered.promise;
    const next = h.controller.sync();
    const rejectedNext = expect(next).rejects.toMatchObject({ code: 'cancelled' });
    await h.controller.enqueue(edit(h.controller));
    expect(h.controller.getState().saveStatus).toBe('local-only');
    await lockVault();
    await Promise.all([rejectedRefresh, rejectedNext]);
    expect(h.controller.getState()).toMatchObject({ phase: 'locked', view: null });
    gate.release.resolve();
    await unlockVault(passphrase);
    expect((await readAssignmentSnapshot(doc.id, doc.contentRevision)).annotations[0].text).toBe(
      'Private student draft',
    );
    expect(posts(h)).toHaveLength(0);
  });
  it('does not permanently invalidate the client when another before-lock handler refuses to lock', async () => {
    const h = await harness();
    await h.controller.open();
    const remove = onBeforeVaultLock(async () => {
      throw new Error('Synthetic other-editor unsaved draft');
    });
    try {
      await expect(lockVault()).rejects.toThrow('Retry saving');
    } finally {
      remove();
    }
    await h.controller.refresh();
    expect(h.controller.getState().phase).toBe('ready');
  });
  it('holds lock validation on a failed local write until the exact edit is successfully retried', async () => {
    const h = await harness();
    await h.controller.open();
    const operation = edit(h.controller);
    const original = crypto.subtle.encrypt.bind(crypto.subtle);
    vi.spyOn(crypto.subtle, 'encrypt').mockRejectedValueOnce(
      new Error('Synthetic disk encryption failure'),
    );
    await expect(h.controller.enqueue(operation)).rejects.toThrow(
      'Synthetic disk encryption failure',
    );
    await expect(h.controller.flushLocal()).rejects.toMatchObject({
      code: 'local_save_failed',
      operationId: id(10),
    });
    expect(() => h.controller.discardStaleDraft(operation.id)).toThrow('Only a confirmed');
    await expect(lockVault()).rejects.toThrow('Retry saving');
    expect(h.controller.getState().phase).not.toBe('locked');
    vi.mocked(crypto.subtle.encrypt).mockImplementation(original);
    await h.controller.enqueue(operation);
    await h.controller.flushLocal();
    expect(h.controller.getState().localError).toBeNull();
    await lockVault();
    expect(h.controller.getState().phase).toBe('locked');
  });
  it('awaits pending local encryption before lock and never publishes late private state after disposal', async () => {
    const h = await harness();
    await h.controller.open();
    const entered = deferred(),
      release = deferred();
    const original = crypto.subtle.encrypt.bind(crypto.subtle);
    vi.spyOn(crypto.subtle, 'encrypt').mockImplementationOnce(async (...args) => {
      entered.resolve();
      await release.promise;
      return original(...args);
    });
    const saving = h.controller.enqueue(edit(h.controller));
    await entered.promise;
    let locked = false;
    const locking = lockVault().then(() => {
      locked = true;
    });
    await Promise.resolve();
    expect(locked).toBe(false);
    release.resolve();
    await Promise.all([saving, locking]);
    expect(h.controller.getState()).toMatchObject({ phase: 'locked', view: null });
    await unlockVault(passphrase);
    const other = h.anotherController();
    await other.open();
    const gate = h.gate('/api/auth/session');
    const refresh = other.refresh();
    const rejected = expect(refresh).rejects.toMatchObject({ code: 'cancelled' });
    await gate.entered.promise;
    other.dispose();
    gate.release.resolve();
    await rejected;
    expect(other.getState()).toMatchObject({ phase: 'disposed', view: null });
  });
  it('includes serialized waiting in the whole-action deadline and bounds admission', async () => {
    const h = await harness({ actionTimeoutMs: 20 });
    const gate = h.gate('/api/auth/session');
    const first = h.controller.open();
    const results = [expect(first).rejects.toMatchObject({ code: 'timeout' })];
    await gate.entered.promise;
    for (let n = 0; n < 3; n++)
      results.push(expect(h.controller.open()).rejects.toMatchObject({ code: 'timeout' }));
    await expect(h.controller.open()).rejects.toMatchObject({ code: 'controller_busy' });
    await Promise.all(results);
    gate.release.resolve();
    expect(h.state.requests.length).toBeLessThanOrEqual(4);
    expect(h.state.requests.every((request) => request.path === '/api/auth/session')).toBe(true);
    expect(h.controller.getState().view).toBeNull();
  });
  it('keeps the serialization barrier after deadline while delayed local encryption is still settling', async () => {
    const h = await harness({ actionTimeoutMs: 500 });
    await h.controller.open();
    await h.controller.enqueue(edit(h.controller));
    const entered = deferred(),
      release = deferred();
    const original = crypto.subtle.encrypt.bind(crypto.subtle);
    vi.spyOn(crypto.subtle, 'encrypt').mockImplementationOnce(async (...args) => {
      entered.resolve();
      await release.promise;
      return original(...args);
    });
    const first = h.controller.sync();
    const firstRejected = expect(first).rejects.toMatchObject({ code: 'timeout' });
    await entered.promise;
    const count = h.state.requests.length;
    const next = h.controller.sync();
    const nextRejected = expect(next).rejects.toMatchObject({ code: 'timeout' });
    await Promise.all([firstRejected, nextRejected]);
    expect(h.state.requests).toHaveLength(count);
    release.resolve();
    await h.controller.refresh();
    expect(h.controller.getState()).toMatchObject({ phase: 'ready', saveStatus: 'local-only' });
    expect(posts(h)).toHaveLength(0);
  });
});
