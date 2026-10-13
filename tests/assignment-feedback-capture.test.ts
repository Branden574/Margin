import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FeedbackClient,
  readVerifiedReturnedCapture,
  type VerifiedReturnedCapture,
} from '../apps/web/src/lib/assignment-feedback/client';
import { canonical } from '../apps/web/src/lib/assignment-review/decode';
import type { ReviewSnapshot, ReviewChunk } from '../apps/web/src/lib/assignment-review/types';
import type { StudentFeedback } from '../apps/web/src/lib/assignment-feedback/decode';

const vault = vi.hoisted(() => ({ epoch: 0, unlocked: true, listeners: new Set<() => void>() }));
vi.mock('../apps/web/src/lib/vault', () => ({
  createVaultGuard: () => {
    const epoch = vault.epoch;
    if (!vault.unlocked) throw Error('locked');
    return () => {
      if (!vault.unlocked || epoch !== vault.epoch) throw Error('locked');
    };
  },
  onVaultLock: (listener: () => void) => {
    vault.listeners.add(listener);
    return () => vault.listeners.delete(listener);
  },
}));
const origin = 'https://feedback-capture.synthetic.test',
  initialNow = 1800000000000;
const id = (n: number) => `90000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const digest = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const clients: FeedbackClient[] = [];
function fixture() {
  let now = initialNow;
  const bytes = Buffer.from('%PDF-1.7\nImmutable synthetic returned source\n'),
    source = new Blob([bytes]);
  const identity = {
    origin,
    userId: id(1),
    organizationId: id(2),
    assignmentId: id(3),
    workId: id(4),
    documentId: id(5),
    versionId: id(6),
  };
  const binding = { identity, sourceSha256: digest(bytes) };
  const session = {
    authenticated: true,
    sessionId: id(7),
    userId: identity.userId,
    organizationId: identity.organizationId,
    role: 'student',
    authenticationMethod: 'lti',
    mfa: false,
    createdAt: now - 10000,
    lastSeenAt: now - 1000,
    expiresAt: now + 60000,
    csrfToken: 'a'.repeat(43),
  };
  const annotation = {
    type: 'text' as const,
    x: 10,
    y: 50,
    text: 'Frozen student response',
    color: '#123456',
    strokeWidth: 1,
    opacity: 1,
  };
  const chunkBase = {
    schema: 1 as const,
    organizationId: identity.organizationId,
    workId: identity.workId,
    documentId: identity.documentId,
    versionId: identity.versionId,
    frozenCursor: 5,
  };
  const chunks: ReviewChunk[] = [
    {
      ...chunkBase,
      index: 0,
      entries: [
        {
          annotationId: id(21),
          pageId: id(8),
          revision: 2,
          latestCursor: 5,
          deleted: false,
          layerOrder: 2,
          annotation,
        },
        {
          annotationId: id(22),
          pageId: id(8),
          revision: 2,
          latestCursor: 4,
          deleted: true,
          layerOrder: null,
        },
      ],
    },
    {
      ...chunkBase,
      index: 1,
      entries: [
        {
          annotationId: id(23),
          pageId: id(8),
          revision: 1,
          latestCursor: 3,
          deleted: false,
          layerOrder: 3,
          annotation: { ...annotation, text: 'Top captured layer' },
        },
      ],
    },
  ];
  const detail: ReviewSnapshot = {
    assignmentId: identity.assignmentId,
    organizationId: identity.organizationId,
    workId: identity.workId,
    documentId: identity.documentId,
    versionId: identity.versionId,
    submission: {
      id: id(9),
      frozenCursor: 5,
      frozenAt: new Date(now - 5000).toISOString(),
      revision: 2,
      preparation: 'ready',
      errorCode: null,
    },
    snapshotPin: 'c'.repeat(64),
    pages: [{ id: id(8), index: 0, width: 612, height: 792 }],
    source: { sha256: digest(bytes), bytes: bytes.length, mimeType: 'application/pdf' },
    annotationCount: 3,
    outputBytes: 1,
    outputSha256: 'd'.repeat(64),
    chunks: [],
  };
  let payloads: Buffer[] = [];
  const seal = () => {
    payloads = chunks.map((c) => Buffer.from(canonical(c)));
    detail.chunks = payloads.map((p, index) => ({ index, bytes: p.length, sha256: digest(p) }));
    const all = Buffer.concat(payloads);
    detail.outputBytes = all.length;
    detail.outputSha256 = digest(all);
  };
  seal();
  const feedback: StudentFeedback = {
    capture: {
      submissionId: detail.submission.id,
      snapshotPin: detail.snapshotPin,
      documentId: detail.documentId,
      versionId: detail.versionId,
      frozenCursor: detail.submission.frozenCursor,
      frozenAt: detail.submission.frozenAt,
      pages: structuredClone(detail.pages),
      source: structuredClone(detail.source),
    },
    released: {
      revision: 1,
      releasedAt: new Date(now - 100).toISOString(),
      content: { comment: 'Returned teacher feedback', annotations: [] },
    },
  };
  const expected = structuredClone(feedback),
    requests: string[] = [];
  let afterChunk: (() => void) | null = null,
    afterFinalCapture: (() => void) | null = null,
    captureReads = 0;
  const fetcher: typeof fetch = async (input, init) => {
    expect(init?.credentials).toBe('same-origin');
    expect(init?.redirect).toBe('error');
    expect(init?.cache).toBe('no-store');
    expect(init?.method).toBe('GET');
    const url = String(input),
      parsed = new URL(url),
      path = parsed.pathname;
    requests.push(path);
    let body: string | Buffer,
      status = 200;
    if (path === '/api/auth/session') body = JSON.stringify(session);
    else if (path.endsWith('/feedback')) body = JSON.stringify(feedback);
    else if (path.endsWith('/capture')) {
      captureReads++;
      if (captureReads > 1) afterFinalCapture?.();
      body = JSON.stringify(detail);
    } else if (path.includes('/chunks/')) {
      expect(parsed.searchParams.get('pin')).toBe(detail.snapshotPin);
      const index = Number(path.split('/').at(-1));
      body = payloads[index];
      afterChunk?.();
      afterChunk = null;
    } else {
      body = JSON.stringify({ error: { code: 'not_found', message: 'Missing synthetic route.' } });
      status = 404;
    }
    const response = new Response(typeof body === 'string' ? body : new Uint8Array(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
    Object.defineProperty(response, 'url', { value: url });
    return response;
  };
  const client = new FeedbackClient('student', detail.submission.id, {
    fetch: fetcher,
    expectedOrigin: origin,
    now: () => now,
  });
  clients.push(client);
  const input = { expected, source, readBinding: async () => structuredClone(binding) };
  return {
    client,
    input,
    identity,
    binding,
    session,
    detail,
    chunks,
    feedback,
    requests,
    seal,
    load: (signal?: AbortSignal) => client.loadReturnedCapture(input, { signal }),
    afterChunk: (fn: () => void) => {
      afterChunk = fn;
    },
    afterFinalCapture: (fn: () => void) => {
      afterFinalCapture = fn;
    },
    expire: () => {
      now = session.expiresAt + 1;
    },
    corruptBytes: () => {
      payloads[0] = Buffer.from(payloads[0]);
      payloads[0][20] ^= 1;
    },
    noncanonical: () => {
      payloads[0] = Buffer.from(JSON.stringify(chunks[0], null, 2));
      detail.chunks[0] = { index: 0, bytes: payloads[0].length, sha256: digest(payloads[0]) };
      const all = Buffer.concat(payloads);
      detail.outputBytes = all.length;
      detail.outputSha256 = digest(all);
    },
  };
}
beforeEach(() => {
  vault.epoch++;
  vault.unlocked = true;
});
afterEach(() => {
  clients.splice(0).forEach((c) => c.dispose());
  vault.listeners.clear();
});

describe('owning student returned captured layer', () => {
  it('loads ordered frozen marks, drops tombstones, verifies source, and requires live opaque provenance', async () => {
    const f = fixture(),
      proof = await f.load(),
      view = readVerifiedReturnedCapture(proof);
    expect(view.annotations.map((a) => a.text)).toEqual([
      'Frozen student response',
      'Top captured layer',
    ]);
    expect(view.annotations.map((a) => a.id)).toEqual([id(21), id(23)]);
    expect(view.annotations.every((a) => a.pageIndex === 0)).toBe(true);
    expect(view.feedback.released?.content.comment).toBe('Returned teacher feedback');
    expect(() => readVerifiedReturnedCapture({ kind: 'verified-returned-capture' })).toThrow(
      'verify',
    );
    f.client.clearReturnedCapture();
    expect(() => readVerifiedReturnedCapture(proof)).toThrow('verify');
  });
  it.each(['assignmentId', 'organizationId', 'workId', 'documentId', 'versionId'] as const)(
    'refuses another %s even when response hashes are internally consistent',
    async (field) => {
      const f = fixture();
      f.detail[field] = id(900);
      await expect(f.load()).rejects.toThrow();
      expect(f.requests.filter((p) => p.includes('/chunks/'))).toHaveLength(0);
    },
  );
  it('requires signed-in local-copy owner identity and a released feedback revision', async () => {
    const owner = fixture();
    owner.binding.identity.userId = id(901);
    await expect(owner.load()).rejects.toThrow('different Canvas identity');
    const unreturned = fixture();
    unreturned.feedback.released = null;
    await expect(unreturned.load()).rejects.toThrow('no longer available');
    expect(unreturned.requests.filter((p) => p.includes('/chunks/'))).toHaveLength(0);
  });
  it.each(['pin', 'pages', 'frozenCursor', 'frozenAt', 'source'] as const)(
    'binds capture %s to previously verified feedback',
    async (field) => {
      const f = fixture();
      if (field === 'pin') f.detail.snapshotPin = 'e'.repeat(64);
      if (field === 'pages') f.detail.pages[0].width = 600;
      if (field === 'frozenCursor') f.detail.submission.frozenCursor = 6;
      if (field === 'frozenAt')
        f.detail.submission.frozenAt = new Date(initialNow - 4000).toISOString();
      if (field === 'source') f.detail.source.sha256 = 'e'.repeat(64);
      await expect(f.load()).rejects.toThrow();
      expect(f.requests.filter((p) => p.includes('/chunks/'))).toHaveLength(0);
    },
  );
  it.each([
    'bytes',
    'noncanonical',
    'entry_order',
    'duplicate_cursor',
    'revision_total',
    'output_hash',
  ] as const)('rejects corrupted %s instead of displaying partial marks', async (kind) => {
    const f = fixture();
    if (kind === 'bytes') f.corruptBytes();
    if (kind === 'noncanonical') f.noncanonical();
    if (kind === 'entry_order') {
      f.chunks[0].entries.reverse();
      f.seal();
    }
    if (kind === 'duplicate_cursor') {
      f.chunks[0].entries[0].layerOrder = 3;
      f.seal();
    }
    if (kind === 'revision_total') {
      f.chunks[0].entries[0].revision = 3;
      f.seal();
    }
    if (kind === 'output_hash') f.detail.outputSha256 = 'f'.repeat(64);
    await expect(f.load()).rejects.toThrow();
  });
  it('rejects a changed manifest after transfer and actual mismatched PDF bytes', async () => {
    const changed = fixture();
    changed.afterFinalCapture(() => {
      changed.detail.outputSha256 = 'f'.repeat(64);
    });
    await expect(changed.load()).rejects.toThrow('changed while opening');
    const source = fixture();
    const altered = new Uint8Array(await source.input.source.arrayBuffer());
    altered[altered.length - 1] ^= 1;
    source.input.source = new Blob([altered]);
    await expect(source.load()).rejects.toThrow();
  });
  it('rejects session switches at final verification and clears proof on expiry or vault lock', async () => {
    const switched = fixture();
    switched.afterChunk(() => {
      switched.session.userId = id(999);
    });
    await expect(switched.load()).rejects.toThrow();
    const expired = fixture(),
      expiredProof = await expired.load();
    expired.expire();
    expect(() => readVerifiedReturnedCapture(expiredProof)).toThrow('expired');
    const locked = fixture(),
      lockedProof = await locked.load();
    vault.unlocked = false;
    for (const listener of [...vault.listeners]) listener();
    expect(() => readVerifiedReturnedCapture(lockedProof)).toThrow();
  });
  it('aborts dismissed transfers without retaining a usable proof and allows a fresh explicit retry', async () => {
    const f = fixture(),
      abort = new AbortController();
    f.afterChunk(() => abort.abort());
    await expect(f.load(abort.signal)).rejects.toThrow();
    const proof = await f.load();
    expect(readVerifiedReturnedCapture(proof).annotations).toHaveLength(2);
  });
  it('refuses over-budget captures before fetching any chunk', async () => {
    const f = fixture();
    f.detail.chunks = Array.from({ length: 129 }, (_, index) => ({
      index,
      sha256: 'e'.repeat(64),
      bytes: 262144,
    }));
    f.detail.outputBytes = 129 * 262144;
    await expect(f.load()).rejects.toThrow('32 MiB');
    expect(f.requests.filter((p) => p.includes('/chunks/'))).toHaveLength(0);
  });
});
