import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDB } from 'idb';
import { canvasAuthorFixture } from './fixtures/canvas-author-service';
import { createAssignmentAuthorClient } from '../apps/web/src/lib/assignment-author/client';
import {
  AuthorUploadController,
  type AuthorUploadState,
} from '../apps/web/src/lib/assignment-author/upload-controller';
import {
  prepareAuthorUpload,
  readAuthorUpload,
  readAuthorUploadFile,
  saveAuthorUploadStatus,
  AuthorUploadConflict,
} from '../apps/web/src/lib/assignment-author/upload-vault';
import {
  createVault,
  lockVault,
  onBeforeVaultLock,
  unlockVault,
  vaultStatus,
  VAULT_DATABASE,
  listVaultRecords,
  vaultTransaction,
} from '../apps/web/src/lib/vault';

const passphrase = 'synthetic upload passphrase only',
  origin = 'https://author.synthetic.test';
const pdf = () =>
  new File(['%PDF-1.7\nPrivate synthetic PDF bytes\n%%EOF'], 'Private worksheet.pdf', {
    type: 'application/pdf',
  });
async function harness(
  fixture = canvasAuthorFixture(),
  hook?: (url: URL, init?: RequestInit) => Promise<Response | undefined>,
) {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const fetcher: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), init });
    const override = await hook?.(new URL(String(input)), init);
    if (override) return override;
    const body =
      init?.body instanceof Blob ? await init.body.text() : (init?.body as string | undefined);
    const result = await fixture.handle(new URL(String(input)), init?.method ?? 'GET', body);
    const response = new Response(result.body, {
      status: result.status,
      headers: { 'content-type': result.contentType },
    });
    Object.defineProperty(response, 'url', { value: String(input) });
    return response;
  };
  const client = createAssignmentAuthorClient({ expectedOrigin: origin, fetch: fetcher });
  const context = await client.open(),
    states: AuthorUploadState[] = [],
    ready = vi.fn(async () => {});
  const controller = new AuthorUploadController(
    context,
    client,
    (state) => states.push(state),
    ready,
  );
  return { fixture, client, context, controller, calls, states, ready, last: () => states.at(-1)! };
}
beforeEach(async () => {
  await lockVault();
  await vaultStatus();
  const db = await openDB(VAULT_DATABASE, 1),
    tx = db.transaction(['public', 'records'], 'readwrite');
  await tx.objectStore('public').clear();
  await tx.objectStore('records').clear();
  await tx.done;
  db.close();
  await createVault(passphrase);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await lockVault();
});

describe('teacher source upload recovery', () => {
  it.each([
    'unknown status',
    'extra receipt',
    'wrong request',
    'unexpected HTTP status',
    'redirect',
  ])('retains the exact intent and refuses content dispatch for %s responses', async (kind) => {
    const h = await harness(undefined, async (url, init) => {
      if (url.pathname !== '/api/assignments/source-uploads') return undefined;
      const intent = JSON.parse(init?.body as string);
      const result = {
        upload: {
          id: crypto.randomUUID(),
          requestId: kind === 'wrong request' ? crypto.randomUUID() : intent.requestId,
          status: kind === 'unknown status' ? 'approved' : 'pending',
          ...(kind === 'extra receipt' ? { storageReceipt: 'not public' } : {}),
        },
        duplicate: false,
      };
      const response = new Response(JSON.stringify(result), {
        status: kind === 'unexpected HTTP status' ? 201 : 202,
        headers: { 'content-type': 'application/json' },
      });
      Object.defineProperty(response, 'url', {
        value: kind === 'redirect' ? 'https://other.synthetic.test/' : url.href,
      });
      return response;
    });
    await h.controller.start(pdf());
    expect(h.last().error).not.toBe('');
    expect(h.last().task?.upload).toBeNull();
    expect(h.calls.some((call) => call.init?.method === 'PUT')).toBe(false);
    expect(h.ready).not.toHaveBeenCalled();
  });
  it('commits encrypted intent and exact bytes before reservation, then keeps quarantined documents unapproved', async () => {
    let h: Awaited<ReturnType<typeof harness>>;
    h = await harness(undefined, async (url) => {
      if (url.pathname === '/api/assignments/source-uploads') {
        const task = await readAuthorUpload(h.context);
        expect(task?.intent.metadata.name).toBe('Private worksheet.pdf');
        expect(await (await readAuthorUploadFile(h.context, task!)).text()).toBe(
          await pdf().text(),
        );
      }
      return undefined;
    });
    await h.controller.start(pdf());
    expect(h.last()).toMatchObject({ busy: false, task: { upload: { status: 'quarantined' } } });
    expect(h.ready).not.toHaveBeenCalled();
    expect(h.fixture.sources.some((s) => s.name === 'Private worksheet.pdf')).toBe(false);
    const db = await openDB(VAULT_DATABASE, 1),
      raw = JSON.stringify(await db.getAll('records'));
    db.close();
    expect(raw).not.toContain('Private worksheet');
    expect(raw).not.toContain(h.context.session.userId);
    const stored = JSON.stringify(await listVaultRecords('author-uploads'));
    expect(stored).not.toContain('csrfToken');
    expect(stored).not.toContain('a'.repeat(43));
    const put = h.calls.find((c) => c.init?.method === 'PUT')!;
    expect(put.init).toMatchObject({
      credentials: 'same-origin',
      redirect: 'error',
      referrerPolicy: 'no-referrer',
      headers: { 'Content-Type': 'application/pdf', 'X-CSRF-Token': 'a'.repeat(43) },
    });
  });
  it('retries a lost reservation using the identical persisted request after reload and unlock', async () => {
    const h = await harness();
    h.fixture.state.loseNextReserveResponse = true;
    await h.controller.start(pdf());
    expect(h.fixture.uploads.size).toBe(1);
    expect(h.fixture.transfers).toHaveLength(0);
    h.controller.dispose();
    h.client.dispose();
    await lockVault();
    await unlockVault(passphrase);
    const reopened = await harness(h.fixture);
    await reopened.controller.restore();
    expect(reopened.fixture.uploadRequests).toHaveLength(1); // Restore never sends automatically.
    await reopened.controller.resume();
    expect(reopened.fixture.uploadRequests).toHaveLength(2);
    expect(reopened.fixture.uploadRequests[1]).toEqual(reopened.fixture.uploadRequests[0]);
    expect(reopened.fixture.uploads.size).toBe(1);
    expect(reopened.fixture.transfers).toHaveLength(1);
  });
  it('queries status after an unknown content response and never resends quarantined content', async () => {
    const h = await harness();
    h.fixture.state.loseNextContentResponse = true;
    await h.controller.start(pdf());
    expect(h.last().error).not.toBe('');
    await h.controller.resume();
    expect(h.fixture.statusReads).toHaveLength(1);
    expect(h.fixture.transfers).toHaveLength(1);
    expect(h.last().task?.upload?.status).toBe('quarantined');
    expect(h.ready).not.toHaveBeenCalled();
    h.fixture.approveUpload();
    await h.controller.resume();
    expect(h.last().task?.upload?.status).toBe('ready');
    expect(h.ready).toHaveBeenCalledTimes(1);
  });
  it('resends the same encrypted bytes only when reconciled status is pending', async () => {
    const h = await harness();
    h.fixture.state.failNextContentBeforeStore = true;
    await h.controller.start(pdf());
    await h.controller.resume();
    expect(h.fixture.statusReads).toHaveLength(1);
    expect(h.fixture.transfers).toHaveLength(2);
    expect(h.fixture.transfers[1]).toBe(h.fixture.transfers[0]);
  });
  it('cancels an unknown transfer, preserves recovery, and ignores its late response', async () => {
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>((r) => {
        entered = r;
      }),
      gate = new Promise<void>((r) => {
        release = r;
      });
    const h = await harness(undefined, async (_url, init) => {
      if (init?.method === 'PUT') {
        entered();
        await gate;
      }
      return undefined;
    });
    const work = h.controller.start(pdf());
    await started;
    h.controller.cancel();
    await work;
    expect(h.last()).toMatchObject({
      busy: false,
      paused: true,
      task: { upload: { status: 'pending' } },
    });
    release();
    await new Promise((r) => setTimeout(r, 5));
    expect(h.last().task?.upload?.status).toBe('pending');
    expect(h.ready).not.toHaveBeenCalled();
    await h.controller.resume();
    expect(h.last().task?.upload?.status).toBe('quarantined');
    expect(h.fixture.transfers).toHaveLength(1);
  });
  it('does not dispatch if atomic encrypted persistence fails', async () => {
    const h = await harness();
    vi.spyOn(crypto.subtle, 'encrypt').mockRejectedValueOnce(new Error('Synthetic disk failure'));
    await h.controller.start(pdf());
    expect(h.fixture.uploadRequests).toHaveLength(0);
    expect(h.fixture.transfers).toHaveLength(0);
    expect(await readAuthorUpload(h.context)).toBeUndefined();
    expect(h.last().error).toContain('Synthetic disk failure');
  });
  it('keeps unconfigured uploads recoverable without suggesting document checks succeeded', async () => {
    const h = await harness();
    h.fixture.state.uploadsConfigured = false;
    await h.controller.start(pdf());
    expect(h.last().error).toContain('not configured');
    expect(h.last().task?.upload).toBeNull();
    expect(h.ready).not.toHaveBeenCalled();
  });
  it('does not replace a pending task or assignment draft when another PDF is selected', async () => {
    const h = await harness();
    const task = await prepareAuthorUpload(h.context, pdf());
    await expect(
      prepareAuthorUpload(h.context, new File(['%PDF-1.7 second'], 'Other.pdf')),
    ).rejects.toThrow('Resume the saved upload');
    expect(await readAuthorUpload(h.context)).toEqual(task);
    expect(await listVaultRecords('author-drafts')).toEqual([]);
  });
  it('uses CAS and refuses changed upload identity, status regression, and tampered file bytes', async () => {
    const h = await harness(),
      task = await prepareAuthorUpload(h.context, pdf());
    const receipt = {
      id: crypto.randomUUID(),
      requestId: task.intent.requestId,
      status: 'quarantined' as const,
    };
    const saved = await saveAuthorUploadStatus(h.context, task, receipt);
    await expect(saveAuthorUploadStatus(h.context, task, receipt)).rejects.toBeInstanceOf(
      AuthorUploadConflict,
    );
    await expect(
      saveAuthorUploadStatus(h.context, saved, { ...receipt, id: crypto.randomUUID() }),
    ).rejects.toThrow('damaged');
    await expect(
      saveAuthorUploadStatus(h.context, saved, { ...receipt, status: 'pending' }),
    ).rejects.toThrow('damaged');
    const records = await listVaultRecords('author-uploads'),
      blob = records.find((r) => r.value instanceof Blob)!;
    await vaultTransaction(async (tx) =>
      tx.put(
        'author-uploads',
        blob.key,
        new Blob(['x'.repeat(pdf().size)], { type: 'application/pdf' }),
      ),
    );
    await expect(readAuthorUploadFile(h.context, saved)).rejects.toThrow('damaged');
  });
  it.each(['sessionId', 'userId', 'organizationId', 'courseId', 'selectionId'] as const)(
    'never adopts cached bytes into another %s',
    async (key) => {
      const h = await harness();
      await prepareAuthorUpload(h.context, pdf());
      const otherFixture = canvasAuthorFixture();
      otherFixture.state[key] = crypto.randomUUID();
      const other = await harness(otherFixture);
      expect(await readAuthorUpload(other.context)).toBeUndefined();
      await expect(readAuthorUpload(structuredClone(h.context))).rejects.toThrow('Verify');
    },
  );
  it('refuses old async results after session changes during content transfer', async () => {
    const fixture = canvasAuthorFixture();
    const h = await harness(fixture, async (_url, init) => {
      if (init?.method === 'PUT') fixture.state.userId = crypto.randomUUID();
      return undefined;
    });
    await h.controller.start(pdf());
    expect(h.ready).not.toHaveBeenCalled();
    expect(h.states.some((state) => state.task?.upload?.status === 'quarantined')).toBe(false);
    const other = await harness(fixture);
    expect(await readAuthorUpload(other.context)).toBeUndefined();
  });
  it('rolls back preparation and dispatches nothing when vault locks during encryption', async () => {
    const h = await harness();
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>((r) => {
        release = r;
      }),
      started = new Promise<void>((r) => {
        entered = r;
      });
    const encrypt = crypto.subtle.encrypt.bind(crypto.subtle);
    vi.spyOn(crypto.subtle, 'encrypt').mockImplementationOnce(async (...args) => {
      entered();
      await gate;
      return encrypt(...args);
    });
    const off = onBeforeVaultLock(async () => h.controller.cancel());
    const work = h.controller.start(pdf());
    await started;
    const locking = lockVault();
    release();
    try {
      await locking;
      await work;
    } finally {
      off();
    }
    expect(h.fixture.uploadRequests).toHaveLength(0);
    await unlockVault(passphrase);
    expect(await readAuthorUpload(h.context)).toBeUndefined();
  });
  it('rejects invalid, oversized and non-PDF inputs before persistence or dispatch', async () => {
    const h = await harness();
    for (const file of [
      new File(['not a PDF'], 'no.pdf'),
      new File(['%PDF-1.7'], 'bad\nname.pdf'),
    ]) {
      await h.controller.start(file);
      expect(h.last().error).not.toBe('');
    }
    const huge = pdf();
    Object.defineProperty(huge, 'size', { value: 104857601 });
    await h.controller.start(huge);
    expect(h.last().error).toContain('100 MB');
    expect(h.fixture.uploadRequests).toHaveLength(0);
  });
});
