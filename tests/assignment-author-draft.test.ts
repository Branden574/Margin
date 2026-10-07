import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDB } from 'idb';
import { createAssignmentAuthorClient } from '../apps/web/src/lib/assignment-author/client';
import {
  authorFormPayload,
  AuthorDraftConflict,
  readAuthorDraft,
  saveAuthorDraft,
  type AuthorDraftValue,
} from '../apps/web/src/lib/assignment-author/draft';
import {
  createVault,
  listVaultRecords,
  lockVault,
  unlockVault,
  VAULT_DATABASE,
  vaultStatus,
  vaultTransaction,
} from '../apps/web/src/lib/vault';
import { canvasAuthorFixture } from './fixtures/canvas-author-service';

const passphrase = 'synthetic author vault passphrase only';
const origin = 'https://author.synthetic.test';
async function harness() {
  const fixture = canvasAuthorFixture();
  let now = Date.now();
  const fetcher: typeof fetch = async (input, init) => {
    const result = await fixture.handle(
      new URL(String(input)),
      init?.method ?? 'GET',
      init?.body as string | undefined,
    );
    const response = new Response(result.body, {
      status: result.status,
      headers: { 'content-type': result.contentType },
    });
    Object.defineProperty(response, 'url', { value: String(input) });
    return response;
  };
  const client = createAssignmentAuthorClient({
    expectedOrigin: origin,
    fetch: fetcher,
    now: () => now,
  });
  const context = await client.open();
  const value: AuthorDraftValue = {
    phase: 'editing',
    form: {
      source: fixture.sources[0],
      title: 'Private synthetic title',
      instructions: 'Private instructions',
      allowedTools: ['text', 'eraser'],
    },
  };
  const prepared = (): AuthorDraftValue => ({
    phase: 'prepared',
    form: structuredClone(value.form),
    request: { requestId: crypto.randomUUID(), draft: authorFormPayload(value.form) },
  });
  return {
    fixture,
    fetcher,
    client,
    context,
    value,
    prepared,
    expire: () => {
      now = fixture.state.expiresAt + 1;
    },
  };
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

describe('encrypted Canvas author drafts', () => {
  it('stores only encrypted form/provenance data and resumes the exact request after unlock', async () => {
    const h = await harness(),
      pending = h.prepared();
    const saved = await saveAuthorDraft(h.context, pending, null);
    const db = await openDB(VAULT_DATABASE, 1),
      records = await db.getAll('records');
    db.close();
    expect(JSON.stringify(records)).not.toContain('Private synthetic title');
    expect(JSON.stringify(records)).not.toContain(h.context.session.userId);
    const plaintext = JSON.stringify(await listVaultRecords('author-drafts'));
    expect(plaintext).not.toContain('csrfToken');
    expect(plaintext).not.toContain('a'.repeat(43));
    await lockVault();
    await unlockVault(passphrase);
    const renewed = await h.client.open();
    expect(await readAuthorDraft(renewed)).toEqual(saved);
  });
  it('rejects copied/forged context without releasing any saved draft', async () => {
    const h = await harness();
    await saveAuthorDraft(h.context, h.value, null);
    await expect(readAuthorDraft(structuredClone(h.context))).rejects.toThrow(
      'Verify the current Canvas',
    );
  });
  it('does not adopt a draft into another selection, session, teacher or course', async () => {
    const h = await harness();
    await saveAuthorDraft(h.context, h.value, null);
    for (const key of ['selectionId', 'sessionId', 'userId', 'courseId'] as const) {
      const other = canvasAuthorFixture();
      other.state[key] = crypto.randomUUID();
      const client = createAssignmentAuthorClient({
        expectedOrigin: origin,
        fetch: async (input, init) => {
          const r = await other.handle(
            new URL(String(input)),
            init?.method ?? 'GET',
            init?.body as string,
          );
          const response = new Response(r.body, {
            status: r.status,
            headers: { 'content-type': r.contentType },
          });
          Object.defineProperty(response, 'url', { value: String(input) });
          return response;
        },
      });
      expect(await readAuthorDraft(await client.open())).toBeUndefined();
      client.dispose();
    }
  });
  it('allows incomplete editing drafts and legitimate 240-character document names', async () => {
    const h = await harness();
    h.value.form.source!.name = 'x'.repeat(236) + '.pdf';
    h.value.form.title = '';
    h.value.form.allowedTools = [];
    const saved = await saveAuthorDraft(h.context, h.value, null);
    expect(saved.form.source!.name).toHaveLength(240);
    expect(() => authorFormPayload(saved.form)).toThrow();
  });
  it('snapshots caller input before encryption', async () => {
    const h = await harness();
    const saving = saveAuthorDraft(h.context, h.value, null);
    h.value.form.title = 'Later mutation';
    h.value.form.allowedTools.push('pen');
    const saved = await saving;
    expect(saved.form.title).toBe('Private synthetic title');
    expect(saved.form.allowedTools).toEqual(['text', 'eraser']);
  });
  it('enforces CAS across two tabs creating or replacing the same draft', async () => {
    const h = await harness();
    const results = await Promise.allSettled([
      saveAuthorDraft(h.context, h.value, null),
      saveAuthorDraft(
        h.context,
        { ...h.value, form: { ...h.value.form, title: 'Other tab' } },
        null,
      ),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.find((r) => r.status === 'rejected')).toMatchObject({
      reason: expect.any(AuthorDraftConflict),
    });
    const first = await readAuthorDraft(h.context);
    await saveAuthorDraft(h.context, h.value, first!.revision);
    await expect(saveAuthorDraft(h.context, h.value, first!.revision)).rejects.toBeInstanceOf(
      AuthorDraftConflict,
    );
  });
  it('keeps prepared payload immutable even when one tab is rejected and another commits', async () => {
    const h = await harness(),
      pending = h.prepared();
    if (pending.phase === 'editing') throw new Error('fixture');
    const saved = await saveAuthorDraft(h.context, pending, null);
    const other = createAssignmentAuthorClient({ expectedOrigin: origin, fetch: h.fetcher });
    const otherContext = await other.open();
    const restored = await readAuthorDraft(otherContext);
    expect(restored).toEqual(saved);
    h.fixture.state.failNextCreate = 429;
    await expect(
      h.client.create(pending.request.draft, pending.request.requestId),
    ).rejects.toMatchObject({ status: 429, uncertainCreate: false });
    await other.create(pending.request.draft, pending.request.requestId);
    expect(h.fixture.assignments.size).toBe(1);
    // The second tab has committed but has not yet saved a local created receipt.
    await expect(saveAuthorDraft(h.context, h.value, saved.revision)).rejects.toThrow(
      'exact saved assignment request',
    );
    await expect(saveAuthorDraft(h.context, h.prepared(), saved.revision)).rejects.toThrow(
      'exact saved assignment request',
    );
    expect(await readAuthorDraft(h.context)).toEqual(saved);
    other.dispose();
  });
  it('retains created state and rejects a different assignment identity', async () => {
    const h = await harness(),
      pending = h.prepared();
    if (pending.phase === 'editing') throw new Error('fixture');
    const saved = await saveAuthorDraft(h.context, pending, null);
    const assignment = await h.client.create(pending.request.draft, pending.request.requestId);
    const created = await saveAuthorDraft(
      h.context,
      { ...pending, phase: 'created', assignment },
      saved.revision,
    );
    await expect(
      saveAuthorDraft(
        h.context,
        { ...pending, phase: 'created', assignment: { ...assignment, id: crypto.randomUUID() } },
        created.revision,
      ),
    ).rejects.toThrow('exact saved assignment');
  });
  it('rejects mismatched form/request payloads and unsupported policy without writing', async () => {
    const h = await harness(),
      pending = h.prepared();
    pending.form.title = 'Different title';
    await expect(saveAuthorDraft(h.context, pending, null)).rejects.toThrow();
    const unsupported = h.prepared();
    if (unsupported.phase === 'editing') throw new Error('fixture');
    (unsupported.request.draft.policy as { assessment: boolean }).assessment = true;
    await expect(saveAuthorDraft(h.context, unsupported, null)).rejects.toThrow();
    expect(await readAuthorDraft(h.context)).toBeUndefined();
  });
  it('detects authenticated but malformed stored records instead of overwriting them', async () => {
    const h = await harness();
    await saveAuthorDraft(h.context, h.value, null);
    const [record] = await listVaultRecords<Record<string, unknown>>('author-drafts');
    await vaultTransaction(async (tx) =>
      tx.put('author-drafts', record.key, { ...record.value, binding: [] }),
    );
    await expect(readAuthorDraft(h.context)).rejects.toThrow('damaged or unsupported');
    await expect(saveAuthorDraft(h.context, h.value, null)).rejects.toThrow(
      'damaged or unsupported',
    );
  });
  it.each(['dispose', 'expiry'] as const)(
    'refuses release and rolls back when %s occurs during encryption',
    async (kind) => {
      const h = await harness();
      let release!: () => void, entered!: () => void;
      const gate = new Promise<void>((resolve) => {
          release = resolve;
        }),
        started = new Promise<void>((resolve) => {
          entered = resolve;
        });
      const encrypt = crypto.subtle.encrypt.bind(crypto.subtle);
      vi.spyOn(crypto.subtle, 'encrypt').mockImplementationOnce(async (...args) => {
        entered();
        await gate;
        return encrypt(...args);
      });
      const saving = saveAuthorDraft(h.context, h.value, null);
      const result = saving.catch((e: unknown) => e);
      await started;
      if (kind === 'dispose') h.client.dispose();
      else h.expire();
      release();
      expect(await result).toBeInstanceOf(Error);
      expect(await listVaultRecords('author-drafts')).toEqual([]);
    },
  );
});
