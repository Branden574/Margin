import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { canonical } from '../apps/api/src/sync/validation';
import type {
  ReviewChunk,
  ReviewContext,
  ReviewSnapshot,
} from '../apps/api/src/assignments/review/types';
import {
  assertVerifiedReviewSnapshot,
  createAssignmentReviewClient,
  readVerifiedReviewSnapshot,
  type AssignmentReviewClient,
  type VerifiedReviewSnapshot,
} from '../apps/web/src/lib/assignment-review/client';
import * as decode from '../apps/web/src/lib/assignment-review/decode';

const vault = vi.hoisted(() => ({ epoch: 0, unlocked: true, listeners: new Set<() => void>() }));
vi.mock('../apps/web/src/lib/vault', () => ({
  createVaultGuard: () => {
    if (!vault.unlocked) throw Error('locked');
    const epoch = vault.epoch;
    return () => {
      if (!vault.unlocked || epoch !== vault.epoch) throw Error('locked');
    };
  },
  onVaultLock: (listener: () => void) => {
    vault.listeners.add(listener);
    return () => vault.listeners.delete(listener);
  },
}));
const origin = 'https://review.synthetic.test';
const now = 1_800_000_000_000;
const id = (n: number) => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
function fixture() {
  const context: ReviewContext = {
    assignment: { id: id(1), title: 'Synthetic assignment', instructions: '' },
    mode: 'author-only',
  };
  const source = Buffer.from('%PDF-1.7\nSynthetic bounded source bytes\n');
  const annotation = {
    type: 'text' as const,
    x: 5,
    y: 6,
    text: 'Retained content',
    color: '#123456',
    strokeWidth: 1,
    opacity: 1,
  };
  const chunks: ReviewChunk[] = [
    {
      schema: 1,
      organizationId: id(2),
      workId: id(3),
      documentId: id(4),
      versionId: id(5),
      frozenCursor: 5,
      index: 0,
      entries: [
        {
          annotationId: id(21),
          pageId: id(6),
          revision: 2,
          latestCursor: 5,
          deleted: false,
          layerOrder: 2,
          annotation,
        },
        {
          annotationId: id(22),
          pageId: id(6),
          revision: 2,
          latestCursor: 4,
          deleted: true,
          layerOrder: null,
        },
      ],
    },
    {
      schema: 1,
      organizationId: id(2),
      workId: id(3),
      documentId: id(4),
      versionId: id(5),
      frozenCursor: 5,
      index: 1,
      entries: [
        {
          annotationId: id(23),
          pageId: id(6),
          revision: 1,
          latestCursor: 3,
          deleted: false,
          layerOrder: 3,
          annotation: { ...annotation, text: 'Above retained update' },
        },
      ],
    },
  ];
  const detail: ReviewSnapshot = {
    assignmentId: id(1),
    submission: {
      id: id(7),
      frozenCursor: 5,
      frozenAt: new Date(now - 10000).toISOString(),
      revision: 2,
      preparation: 'ready',
      errorCode: null,
    },
    snapshotPin: 'a'.repeat(64),
    organizationId: id(2),
    workId: id(3),
    documentId: id(4),
    versionId: id(5),
    pages: [{ id: id(6), index: 0, width: 612, height: 792 }],
    source: { sha256: sha(source), bytes: source.length, mimeType: 'application/pdf' },
    annotationCount: 3,
    outputBytes: 0,
    outputSha256: '',
    chunks: [],
  };
  let encoded: Buffer[] = [];
  const seal = () => {
    encoded = chunks.map((c) => Buffer.from(canonical(c)));
    detail.chunks = encoded.map((b, index) => ({ index, sha256: sha(b), bytes: b.length }));
    detail.outputBytes = encoded.reduce((sum, b) => sum + b.length, 0);
    detail.outputSha256 = sha(Buffer.concat(encoded));
  };
  seal();
  return { context, source, chunks, detail, seal, bytes: (index: number) => encoded[index] };
}
function response(url: string, body: BodyInit, type = 'application/json', status = 200) {
  const result = new Response(body, { status, headers: { 'content-type': type } });
  Object.defineProperty(result, 'url', { value: url });
  return result;
}
function harness() {
  const f = fixture();
  let clock = now;
  let session = {
    authenticated: true,
    sessionId: id(40),
    userId: id(41),
    organizationId: id(2),
    role: 'teacher',
    authenticationMethod: 'lti',
    mfa: false,
    createdAt: now - 1000,
    lastSeenAt: now - 1000,
    expiresAt: now + 60000,
    csrfToken: 'x'.repeat(43),
  };
  const calls: { url: string; init?: RequestInit }[] = [];
  let intercept:
    | ((url: string, init?: RequestInit) => Promise<Response | void> | Response | void)
    | undefined;
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input),
      path = new URL(url).pathname;
    calls.push({ url, init });
    const intercepted = await intercept?.(url, init);
    if (intercepted) return intercepted;
    if (path === '/api/auth/session') return response(url, JSON.stringify(session));
    if (path === '/api/assignments/review') return response(url, JSON.stringify(f.context));
    if (path === '/api/assignments/review/submissions')
      return response(
        url,
        JSON.stringify({ submissions: [f.detail.submission], nextCursor: null }),
      );
    if (path.endsWith('/source')) return response(url, new Uint8Array(f.source), 'application/pdf');
    const chunk = /\/chunks\/(\d+)$/.exec(path);
    if (chunk) return response(url, new Uint8Array(f.bytes(Number(chunk[1]))));
    if (path.endsWith(`/submissions/${id(7)}`)) return response(url, JSON.stringify(f.detail));
    throw Error('unexpected synthetic route');
  };
  const client = createAssignmentReviewClient({
    expectedOrigin: origin,
    fetch: fetcher,
    now: () => clock,
  });
  clients.push(client);
  return {
    ...f,
    calls,
    client,
    setClock: (value: number) => {
      clock = value;
    },
    setSession: (patch: Partial<typeof session>) => {
      session = { ...session, ...patch };
    },
    intercept: (next: typeof intercept) => {
      intercept = next;
    },
  };
}
const clients: AssignmentReviewClient[] = [];
beforeEach(() => {
  vault.epoch++;
  vault.unlocked = true;
});
afterEach(() => {
  for (const client of clients.splice(0)) client.dispose();
  vault.listeners.clear();
  vi.useRealTimers();
});

describe('teacher retained review client', () => {
  it('verifies exact pinned bytes, filters tombstones, preserves first-put layer order, and uses no local editor persistence', async () => {
    const h = harness(),
      progress: string[] = [];
    expect(await h.client.loadContext()).toEqual(h.context);
    expect((await h.client.list()).submissions).toEqual([h.detail.submission]);
    const proof = await h.client.loadSubmission(id(7), {
      onProgress: (p) => progress.push(p.stage),
    });
    const view = readVerifiedReviewSnapshot(proof);
    expect(view.annotations.map((a) => a.id)).toEqual([id(21), id(23)]);
    expect(view.annotations.map((a) => [a.author, a.createdAt])).toEqual([
      ['', 0],
      ['', 0],
    ]);
    expect(Buffer.from(await view.source.arrayBuffer())).toEqual(h.source);
    expect(progress).toContain('verifying');
    for (const { url, init } of h.calls) {
      expect(init).toMatchObject({
        method: 'GET',
        mode: 'same-origin',
        credentials: 'same-origin',
        cache: 'no-store',
        redirect: 'error',
        referrerPolicy: 'no-referrer',
      });
      if (/\/(source|chunks\/\d+)\?/.test(url))
        expect(new URL(url).searchParams.get('pin')).toBe(h.detail.snapshotPin);
      expect(new Headers(init?.headers).get('Accept')).toBe(
        new URL(url).pathname.endsWith('/source') ? 'application/pdf' : 'application/json',
      );
    }
    view.annotations[0].text = 'local mutation';
    expect(readVerifiedReviewSnapshot(proof).annotations[0].text).toBe('Retained content');
  });
  it('rejects a fabricated proof and invalidates retained proof when selection clears', async () => {
    expect(() => assertVerifiedReviewSnapshot({ kind: 'verified-teacher-review' })).toThrow();
    const h = harness(),
      proof = await h.client.loadSubmission(id(7));
    h.client.clearSelection();
    expect(() => readVerifiedReviewSnapshot(proof)).toThrow();
  });
  it('supports the exact empty captured prefix', async () => {
    const h = harness();
    h.chunks.splice(1);
    h.chunks[0].entries = [];
    h.chunks[0].frozenCursor = 0;
    h.detail.submission.frozenCursor = 0;
    h.detail.annotationCount = 0;
    h.seal();
    expect(readVerifiedReviewSnapshot(await h.client.loadSubmission(id(7))).annotations).toEqual(
      [],
    );
  });
  it.each(['student', 'admin'])('rejects %s account sessions', async (role) => {
    const h = harness();
    h.setSession({ role });
    await expect(h.client.loadContext()).rejects.toMatchObject({ code: 'teacher_launch_required' });
    expect(h.calls).toHaveLength(1);
  });
  it('rejects a non-LTI teacher session', async () => {
    const h = harness();
    h.setSession({ authenticationMethod: 'oidc' });
    await expect(h.client.loadContext()).rejects.toMatchObject({ code: 'teacher_launch_required' });
  });
  it('detects teacher identity replacement after the final source fetch', async () => {
    const h = harness();
    h.intercept((url) => {
      if (url.includes('/source?')) h.setSession({ userId: id(99) });
    });
    await expect(h.client.loadSubmission(id(7))).rejects.toMatchObject({ code: 'session_changed' });
  });
  it('invalidates a visible proof on failed authority refresh', async () => {
    const h = harness(),
      proof = await h.client.loadSubmission(id(7)),
      invalidated = vi.fn();
    h.client.subscribeInvalidation(invalidated);
    h.intercept((url) => {
      if (url.endsWith('/api/auth/session')) throw Error('offline');
    });
    await expect(h.client.loadContext()).rejects.toThrow();
    expect(invalidated).toHaveBeenCalledOnce();
    expect(() => assertVerifiedReviewSnapshot(proof)).toThrow();
  });
  it('invalidates a visible proof immediately on vault lock', async () => {
    const h = harness(),
      proof = await h.client.loadSubmission(id(7)),
      invalidated = vi.fn();
    h.client.subscribeInvalidation(invalidated);
    vault.unlocked = false;
    vault.epoch++;
    for (const listener of [...vault.listeners]) listener();
    expect(invalidated).toHaveBeenCalledWith('vault_locked');
    expect(() => assertVerifiedReviewSnapshot(proof)).toThrow();
  });
  it('expires proofs with a timer even without another request', async () => {
    const h = harness(),
      proof = await h.client.loadSubmission(id(7)),
      invalidated = vi.fn();
    h.client.subscribeInvalidation(invalidated);
    vi.useFakeTimers();
    // Refresh installs the expiry timeout on the fake clock.
    await h.client.loadContext();
    h.setClock(now + 60000);
    await vi.advanceTimersByTimeAsync(60000);
    expect(invalidated).toHaveBeenCalledWith('session_expired');
    expect(() => assertVerifiedReviewSnapshot(proof)).toThrow();
  });
  it('rejects same-session assignment replacement', async () => {
    const h = harness();
    await h.client.loadContext();
    h.context.assignment.id = id(98);
    await expect(h.client.loadContext()).rejects.toMatchObject({ code: 'assignment_changed' });
  });
  it.each([
    ['assignmentId', id(98)],
    ['organizationId', id(98)],
    ['snapshotPin', 'BAD'],
    ['annotationCount', 6],
    ['outputBytes', 1],
  ])('rejects invalid snapshot field %s', async (key, value) => {
    const h = harness();
    (h.detail as unknown as Record<string, unknown>)[key] = value;
    await expect(h.client.loadSubmission(id(7))).rejects.toMatchObject({
      code: 'invalid_response',
    });
    expect(h.calls.some((c) => c.url.includes('/chunks/'))).toBe(false);
  });
  it('refuses the browser source budget before fetching content', async () => {
    const h = harness();
    h.detail.source.bytes = 50 * 1024 * 1024 + 1;
    await expect(h.client.loadSubmission(id(7))).rejects.toMatchObject({
      code: 'review_too_large',
    });
    expect(h.calls.some((c) => c.url.includes('/chunks/'))).toBe(false);
  });
  it('refuses the browser materialization budget before fetching content', async () => {
    const h = harness();
    h.detail.chunks = Array.from({ length: 129 }, (_, index) => ({
      index,
      bytes: 262144,
      sha256: 'b'.repeat(64),
    }));
    h.detail.outputBytes = 129 * 262144;
    await expect(h.client.loadSubmission(id(7))).rejects.toMatchObject({
      code: 'review_too_large',
    });
    expect(h.calls.some((c) => c.url.includes('/chunks/'))).toBe(false);
  });
  it.each(['workId', 'documentId', 'versionId', 'organizationId'])(
    'rejects authenticated-looking chunks with wrong %s',
    async (key) => {
      const h = harness();
      (h.chunks[0] as unknown as Record<string, unknown>)[key] = id(98);
      h.seal();
      await expect(h.client.loadSubmission(id(7))).rejects.toMatchObject({
        code: 'invalid_response',
      });
    },
  );
  it.each([
    [
      'out of order IDs',
      (h: ReturnType<typeof harness>) => {
        h.chunks[1].entries[0].annotationId = id(20);
      },
    ],
    [
      'duplicate IDs across chunks',
      (h: ReturnType<typeof harness>) => {
        h.chunks[1].entries[0].annotationId = id(21);
      },
    ],
    [
      'wrong page',
      (h: ReturnType<typeof harness>) => {
        h.chunks[0].entries[0].pageId = id(98);
      },
    ],
    [
      'duplicate layer cursor',
      (h: ReturnType<typeof harness>) => {
        h.chunks[0].entries[0].layerOrder = 3;
      },
    ],
    [
      'tombstone appearance',
      (h: ReturnType<typeof harness>) => {
        h.chunks[0].entries[1].annotation = h.chunks[0].entries[0].annotation;
      },
    ],
    [
      'unsafe annotation extension',
      (h: ReturnType<typeof harness>) => {
        Object.assign(h.chunks[0].entries[0].annotation!, { html: '<script>bad</script>' });
      },
    ],
    [
      'revision count mismatch',
      (h: ReturnType<typeof harness>) => {
        h.chunks[0].entries[0].revision = 3;
      },
    ],
    [
      'cursor collision',
      (h: ReturnType<typeof harness>) => {
        h.chunks[0].entries[1].latestCursor = 3;
      },
    ],
  ])('rejects %s even with matching chunk hashes', async (_, mutate) => {
    const h = harness();
    mutate(h);
    h.seal();
    await expect(h.client.loadSubmission(id(7))).rejects.toMatchObject({
      code: 'invalid_response',
    });
  });
  it('rejects source corruption', async () => {
    const h = harness();
    h.source[h.source.length - 1] ^= 1;
    await expect(h.client.loadSubmission(id(7))).rejects.toMatchObject({
      code: 'invalid_response',
    });
  });
  it('rejects aggregate hash mismatch even when individual hashes match', async () => {
    const h = harness();
    h.detail.outputSha256 = 'b'.repeat(64);
    await expect(h.client.loadSubmission(id(7))).rejects.toMatchObject({
      code: 'invalid_response',
    });
    expect(h.calls.some((c) => c.url.includes('/source?'))).toBe(false);
  });
  it('rejects noncanonical JSON despite correct wire digest', async () => {
    const h = harness();
    const wire = Buffer.from(JSON.stringify(h.chunks[0]));
    h.detail.chunks[0] = { index: 0, bytes: wire.length, sha256: sha(wire) };
    h.detail.outputBytes = wire.length + h.bytes(1).length;
    h.detail.outputSha256 = sha(Buffer.concat([wire, h.bytes(1)]));
    h.intercept((url) =>
      url.includes('/chunks/0?') ? response(url, new Uint8Array(wire)) : undefined,
    );
    await expect(h.client.loadSubmission(id(7))).rejects.toMatchObject({
      code: 'invalid_response',
    });
  });
  it('aborts a stale selection while its auth fetch ignores abort, without killing the replacement', async () => {
    const h = harness();
    let release!: () => void, started!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const seen = new Promise<void>((resolve) => {
      started = resolve;
    });
    let first = true;
    h.intercept(async (url) => {
      if (url.endsWith('/api/auth/session') && first) {
        first = false;
        started();
        await pending;
      }
    });
    const old = h.client.loadSubmission(id(7));
    const rejected = expect(old).rejects.toMatchObject({ code: 'selection_changed' });
    await seen;
    const fresh = h.client.loadSubmission(id(7));
    await rejected;
    release();
    expect(readVerifiedReviewSnapshot(await fresh).detail.submission.id).toBe(id(7));
  });
  it('checks vault identity after an ignored cancellation and never publishes content', async () => {
    const h = harness();
    h.intercept((url) => {
      if (url.includes('/source?')) vault.epoch++;
    });
    await expect(h.client.loadSubmission(id(7))).rejects.toMatchObject({ code: 'vault_locked' });
  });
  it('rejects redirects and truncated body lengths', async () => {
    const h = harness();
    h.intercept((url) => {
      if (!url.includes('/chunks/0?')) return;
      const r = response(url, new Uint8Array(h.bytes(0)));
      r.headers.set('content-length', String(h.bytes(0).length + 1));
      return r;
    });
    await expect(h.client.loadSubmission(id(7))).rejects.toMatchObject({
      code: 'invalid_response',
    });
    const other = harness();
    other.intercept((url) => {
      const r = response('https://elsewhere.synthetic.test', '{}');
      return r;
    });
    await expect(other.client.loadContext()).rejects.toMatchObject({ code: 'redirect_refused' });
  });
  it('does not accept a stale revision after history has advanced', async () => {
    const h = harness();
    h.detail.submission.revision = 4;
    await h.client.list();
    h.detail.submission.revision = 2;
    await expect(h.client.loadSubmission(id(7))).rejects.toMatchObject({
      code: 'invalid_response',
    });
  });
  it('validates ascending history pagination and exact metadata fields', () => {
    const h = fixture();
    expect(() =>
      decode.page({ submissions: [h.detail.submission], nextCursor: h.detail.submission.id }, now),
    ).toThrow();
    expect(() =>
      decode.page(
        { submissions: [h.detail.submission, h.detail.submission], nextCursor: null },
        now,
      ),
    ).toThrow();
    expect(() => decode.context({ ...h.context, studentName: 'fabricated' })).toThrow();
    expect(() =>
      decode.snapshot(
        { ...h.detail, pages: [h.detail.pages[0], h.detail.pages[0]] },
        h.context,
        id(2),
        id(7),
        now,
      ),
    ).toThrow();
  });
  it('cancelling one context request does not invalidate a valid replacement', async () => {
    const h = harness();
    let release!: () => void, started!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const seen = new Promise<void>((resolve) => {
      started = resolve;
    });
    let first = true;
    h.intercept(async (url) => {
      if (url.endsWith('/api/auth/session') && first) {
        first = false;
        started();
        await pending;
      }
    });
    const cancellation = new AbortController();
    const old = h.client.loadContext({ signal: cancellation.signal });
    const rejected = expect(old).rejects.toMatchObject({ code: 'cancelled' });
    await seen;
    const fresh = h.client.loadContext();
    cancellation.abort();
    await rejected;
    release();
    expect(await fresh).toEqual(h.context);
    expect(
      readVerifiedReviewSnapshot(await h.client.loadSubmission(id(7))).annotations,
    ).toHaveLength(2);
  });
  it('preserves the safe service message on failed context invalidation', async () => {
    const h = harness(),
      invalidated = vi.fn();
    h.client.subscribeInvalidation(invalidated);
    h.intercept((url) =>
      url.endsWith('/api/assignments/review')
        ? response(
            url,
            JSON.stringify({
              error: {
                code: 'review_unconfigured',
                message: 'Teacher review is not configured for this environment.',
              },
            }),
            'application/json',
            503,
          )
        : undefined,
    );
    await expect(h.client.loadContext()).rejects.toMatchObject({ code: 'review_unconfigured' });
    expect(invalidated).toHaveBeenCalledWith(
      'authority_unverified',
      'Teacher review is not configured for this environment.',
    );
  });
  it.each(['pin', 'source', 'page'])(
    'rejects changed immutable %s metadata for an already verified submission',
    async (field) => {
      const h = harness();
      await h.client.loadSubmission(id(7));
      if (field === 'pin') h.detail.snapshotPin = 'b'.repeat(64);
      if (field === 'source') h.detail.source.sha256 = 'b'.repeat(64);
      if (field === 'page') h.detail.pages[0].width = 900;
      h.calls.length = 0;
      await expect(h.client.loadSubmission(id(7))).rejects.toMatchObject({
        code: 'invalid_response',
      });
      expect(h.calls.some((c) => c.url.includes('/chunks/'))).toBe(false);
    },
  );
  it('enforces streaming size bounds without trusting Content-Length', async () => {
    const h = harness();
    h.intercept((url) =>
      url.includes('/chunks/0?') ? response(url, new Uint8Array(262145)) : undefined,
    );
    await expect(h.client.loadSubmission(id(7))).rejects.toMatchObject({
      code: 'response_too_large',
    });
    expect(h.calls.some((c) => c.url.includes('/source?'))).toBe(false);
  });
  it('rejects malformed UTF-8 and wrong content types before publication', async () => {
    const h = harness(),
      malformed = new Uint8Array([0xff]);
    h.detail.chunks[0] = { index: 0, bytes: 1, sha256: sha(malformed) };
    h.detail.outputBytes = 1 + h.bytes(1).length;
    h.intercept((url) => (url.includes('/chunks/0?') ? response(url, malformed) : undefined));
    await expect(h.client.loadSubmission(id(7))).rejects.toMatchObject({
      code: 'invalid_response',
    });
    const other = harness();
    other.intercept((url) =>
      url.includes('/source?')
        ? response(url, new Uint8Array(other.source), 'text/html')
        : undefined,
    );
    await expect(other.client.loadSubmission(id(7))).rejects.toMatchObject({
      code: 'invalid_response',
    });
  });
  it('rechecks selected source authority after downloading and refuses a revoked capture', async () => {
    const h = harness();
    let sourceRead = false;
    h.intercept((url) => {
      if (url.includes('/source?')) sourceRead = true;
      if (sourceRead && url.endsWith(`/submissions/${id(7)}`))
        return response(
          url,
          JSON.stringify({
            error: {
              code: 'review_unavailable',
              message: 'This retained submission is unavailable.',
            },
          }),
          'application/json',
          404,
        );
    });
    await expect(h.client.loadSubmission(id(7))).rejects.toMatchObject({
      code: 'review_unavailable',
    });
    expect(h.calls.filter((c) => c.url.endsWith(`/submissions/${id(7)}`))).toHaveLength(2);
  });
  it('revalidates the visible selected capture and destroys proof on work/source revocation', async () => {
    const h = harness(),
      proof = await h.client.loadSubmission(id(7)),
      invalidated = vi.fn();
    h.client.subscribeInvalidation(invalidated);
    h.intercept((url) =>
      url.endsWith(`/submissions/${id(7)}`)
        ? response(
            url,
            JSON.stringify({
              error: {
                code: 'review_unavailable',
                message: 'This retained submission is unavailable.',
              },
            }),
            'application/json',
            404,
          )
        : undefined,
    );
    await expect(h.client.revalidateSelection()).rejects.toMatchObject({
      code: 'review_unavailable',
    });
    expect(invalidated).toHaveBeenCalledWith(
      'selection_unverified',
      'This retained submission is unavailable.',
    );
    expect(() => assertVerifiedReviewSnapshot(proof)).toThrow();
  });
  it('revalidates metadata without downloading plaintext again', async () => {
    const h = harness(),
      proof = await h.client.loadSubmission(id(7));
    h.calls.length = 0;
    expect(await h.client.revalidateSelection()).toEqual(h.context);
    expect(h.calls.some((c) => c.url.endsWith(`/submissions/${id(7)}`))).toBe(true);
    expect(h.calls.some((c) => c.url.includes('/chunks/') || c.url.includes('/source?'))).toBe(
      false,
    );
    expect(() => assertVerifiedReviewSnapshot(proof)).not.toThrow();
  });
  it('a superseded revalidation denial cannot invalidate a newly selected capture', async () => {
    const h = harness();
    await h.client.loadSubmission(id(7));
    let release!: () => void, started!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const seen = new Promise<void>((resolve) => {
      started = resolve;
    });
    let first = true;
    h.intercept(async (url) => {
      if (url.endsWith(`/submissions/${id(7)}`) && first) {
        first = false;
        started();
        await pending;
        return response(
          url,
          JSON.stringify({
            error: {
              code: 'review_unavailable',
              message: 'This retained submission is unavailable.',
            },
          }),
          'application/json',
          404,
        );
      }
    });
    const old = h.client.revalidateSelection();
    const rejected = expect(old).rejects.toMatchObject({ code: 'selection_changed' });
    await seen;
    const fresh = h.client.loadSubmission(id(7));
    await rejected;
    release();
    expect(readVerifiedReviewSnapshot(await fresh).annotations).toHaveLength(2);
  });
});
