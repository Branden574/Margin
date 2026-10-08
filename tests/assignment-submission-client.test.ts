import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDB } from 'idb';
import {
  createAssignmentWorkClient,
  readVerifiedSnapshot,
  readVerifiedSubmissionRequest,
  readVerifiedSubmissionRetry,
  type VerifiedSubmissionRequest,
  type VerifiedSubmissionRetry,
} from '../apps/web/src/lib/assignment-work/client';
import type { WorkManifest } from '../apps/web/src/lib/assignment-work/types';
import type {
  SubmissionRequest,
  SubmissionStatus,
  SubmissionReprocess,
} from '../apps/web/src/lib/assignment-work/submissionTypes';
import {
  decodeSubmissionReprocess,
  decodeSubmissionStatus,
} from '../apps/web/src/lib/assignment-work/submissionDecode';
import {
  createVault,
  lockVault,
  unlockVault,
  vaultStatus,
  VAULT_DATABASE,
} from '../apps/web/src/lib/vault';

const origin = 'https://submission.synthetic.test';
const time = 1_800_000_000_000;
const passphrase = 'synthetic submission transport test vault only';
const id = (n: number) => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const input = () => ({ requestId: id(20), expectedCursor: 0 });
function status(patch: Partial<SubmissionStatus> = {}): SubmissionStatus {
  return {
    id: id(21),
    requestId: id(20),
    attempt: 1,
    frozenCursor: 0,
    frozenAt: new Date(time).toISOString(),
    revision: 1,
    phase: 'processing',
    confirmedAt: null,
    retryAllowed: false,
    errorCode: null,
    ...patch,
  };
}
const captured = (patch: Partial<SubmissionStatus> = {}): SubmissionRequest => ({
  ...input(),
  state: 'captured',
  submission: status(patch),
});
const rejected = (): SubmissionRequest => ({
  ...input(),
  state: 'rejected',
  code: 'cursor_changed',
});
function reprocess(patch: Partial<SubmissionReprocess> = {}): SubmissionReprocess {
  const request = captured({ revision: 3 });
  if (request.state !== 'captured') throw Error('Synthetic capture required');
  return {
    request,
    expectedRevision: 2,
    state: 'accepted',
    acceptedRevision: 3,
    code: null,
    ...patch,
  };
}
function retryRejected(
  code: 'revision_changed' | 'not_retryable' | 'retry_limit' = 'not_retryable',
): SubmissionReprocess {
  const request = captured({
    revision: code === 'revision_changed' ? 3 : 2,
    phase: 'failed',
    errorCode: 'retry_exhausted',
  });
  if (request.state !== 'captured') throw Error('Synthetic capture required');
  return reprocess({ request, state: 'rejected', acceptedRevision: null, code });
}
function json(url: string, body: unknown, code = 200, headers: Record<string, string> = {}) {
  const response = new Response(JSON.stringify(body), {
    status: code,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
  Object.defineProperty(response, 'url', { value: url, configurable: true });
  return response;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
type Hook = (url: string, init: RequestInit) => Response | Promise<Response> | undefined;
const clients: ReturnType<typeof createAssignmentWorkClient>[] = [];
function harness(timeoutMs = 45_000) {
  const state = {
    now: time,
    session: {
      authenticated: true,
      sessionId: id(1),
      userId: id(2),
      organizationId: id(3),
      role: 'student',
      authenticationMethod: 'lti',
      mfa: false,
      createdAt: time - 1000,
      lastSeenAt: time,
      expiresAt: time + 600_000,
      csrfToken: 'a'.repeat(43),
    },
    manifest: {
      assignment: {
        id: id(4),
        title: 'Synthetic assignment',
        instructions: 'Private instructions',
        policy: {
          allowedTools: ['text', 'eraser'],
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
          pages: [{ id: id(8), index: 0, width: 612, height: 792 }],
        },
      },
    } as WorkManifest,
    outcome: captured(),
    reprocess: reprocess(),
    history: [] as SubmissionStatus[],
    hook: undefined as Hook | undefined,
  };
  const fetcher = vi.fn(async (value: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(value),
      custom = state.hook?.(url, init);
    if (custom) return custom;
    const path = new URL(url).pathname;
    if (path === '/api/auth/session') return json(url, state.session);
    if (path === '/api/assignments/work') return json(url, state.manifest);
    if (path === '/api/assignments/work/submissions') {
      if (init.method !== 'POST')
        return json(url, { submissions: state.history, nextCursor: null });
      return json(
        url,
        { request: state.outcome, duplicate: false },
        state.outcome.state === 'rejected'
          ? 409
          : state.outcome.submission.phase === 'confirmed'
            ? 200
            : 202,
      );
    }
    if (path === `/api/assignments/work/submission-requests/${id(20)}`)
      return json(url, { request: state.outcome });
    if (path === `/api/assignments/work/submissions/${id(21)}/reprocess`)
      return json(url, state.reprocess, state.reprocess.state === 'accepted' ? 202 : 409);
    if (path.startsWith(`/api/assignments/work/submissions/${id(21)}/reprocess-requests/`))
      return json(url, state.reprocess);
    throw new Error('Unexpected synthetic request');
  });
  const client = createAssignmentWorkClient({
    fetch: fetcher,
    expectedOrigin: origin,
    now: () => state.now,
    timeoutMs,
  });
  clients.push(client);
  return { client, state, fetcher };
}
const posts = (h: ReturnType<typeof harness>) =>
  h.fetcher.mock.calls.filter(([, init]) => init?.method === 'POST');
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

describe('verified same-capture preparation retry transport', () => {
  it('rejects retryable status revisions that cannot advance to a safe accepted revision', () => {
    expect(() =>
      decodeSubmissionStatus(
        status({
          revision: Number.MAX_SAFE_INTEGER,
          phase: 'failed',
          errorCode: 'retry_exhausted',
          retryAllowed: true,
        }),
      ),
    ).toThrow();
    expect(
      decodeSubmissionStatus(
        status({
          revision: Number.MAX_SAFE_INTEGER - 1,
          phase: 'failed',
          errorCode: 'retry_exhausted',
          retryAllowed: true,
        }),
      ).revision,
    ).toBe(Number.MAX_SAFE_INTEGER - 1);
    expect(
      decodeSubmissionStatus(
        status({
          revision: Number.MAX_SAFE_INTEGER,
          phase: 'failed',
          errorCode: 'retry_exhausted',
          retryAllowed: false,
        }),
      ).revision,
    ).toBe(Number.MAX_SAFE_INTEGER);
  });
  it('sends only the immutable revision tuple and returns a cloned opaque proof with current capture provenance', async () => {
    const h = harness(),
      input = { expectedRevision: 2 };
    const pending = h.client.retrySubmission(id(21), input);
    input.expectedRevision = 99;
    const token = await pending;
    expect(Object.isFrozen(token)).toBe(true);
    expect(JSON.stringify(token)).toBe('{}');
    const proof = readVerifiedSubmissionRetry(token);
    expect(proof.outcome).toEqual(reprocess());
    expect(readVerifiedSnapshot(proof.verified).session).not.toHaveProperty('csrfToken');
    proof.outcome.request.submission.revision = 900;
    expect(readVerifiedSubmissionRetry(token).outcome).toEqual(reprocess());
    expect(posts(h)).toHaveLength(1);
    const [url, init] = posts(h)[0];
    expect(url).toBe(`${origin}/api/assignments/work/submissions/${id(21)}/reprocess`);
    expect(JSON.parse(String(init!.body))).toEqual({ expectedRevision: 2 });
    expect(init).toMatchObject({
      method: 'POST',
      credentials: 'same-origin',
      mode: 'same-origin',
      cache: 'no-store',
      redirect: 'error',
      referrerPolicy: 'no-referrer',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': 'a'.repeat(43) },
    });
    for (const [url, options] of h.fetcher.mock.calls) {
      expect(String(url)).not.toMatch(/csrf|token|student|organization|documentId|versionId/);
      expect(String(url)).not.toContain('a'.repeat(43));
      if (options?.method === 'GET') expect(options.headers).not.toHaveProperty('X-CSRF-Token');
    }
  });

  it.each(['revision_changed', 'not_retryable', 'retry_limit'] as const)(
    'accepts a durable %s rejection and lookup without creating another capture',
    async (code) => {
      const h = harness();
      h.state.reprocess = retryRejected(code);
      expect(
        readVerifiedSubmissionRetry(await h.client.retrySubmission(id(21), { expectedRevision: 2 }))
          .outcome,
      ).toEqual(h.state.reprocess);
      expect(
        readVerifiedSubmissionRetry(await h.client.submissionRetryRequest(id(21), 2)).outcome,
      ).toEqual(h.state.reprocess);
      expect(posts(h)).toHaveLength(1);
    },
  );

  it.each([
    [
      'extra field',
      (v: any) => {
        v.providerUrl = 'https://private.invalid';
      },
    ],
    [
      'rejected capture',
      (v: any) => {
        v.request = rejected();
      },
    ],
    [
      'wrong submission',
      (v: any) => {
        v.request.submission.id = id(99);
      },
    ],
    [
      'wrong expected revision',
      (v: any) => {
        v.expectedRevision = 1;
        v.acceptedRevision = 2;
      },
    ],
    [
      'future accepted revision',
      (v: any) => {
        v.acceptedRevision = 4;
      },
    ],
    [
      'missing accepted revision',
      (v: any) => {
        v.acceptedRevision = null;
      },
    ],
    [
      'accepted error code',
      (v: any) => {
        v.code = 'not_retryable';
      },
    ],
    [
      'unknown decision',
      (v: any) => {
        v.state = 'pending';
      },
    ],
    [
      'old current status',
      (v: any) => {
        v.request.submission.revision = 2;
      },
    ],
    [
      'retryable processing',
      (v: any) => {
        v.request.submission.retryAllowed = true;
      },
    ],
    [
      'unknown current error',
      (v: any) => {
        v.request.submission.errorCode = 'raw-provider-error';
      },
    ],
  ] as const)(
    'refuses %s without issuing proof or silently repeating POST',
    async (_name, mutate) => {
      const h = harness(),
        body = structuredClone(reprocess());
      mutate(body);
      h.state.hook = (url, init) => (init.method === 'POST' ? json(url, body, 202) : undefined);
      await expect(h.client.retrySubmission(id(21), { expectedRevision: 2 })).rejects.toMatchObject(
        { code: 'invalid_response', uncertainSave: true, operationId: `${id(21)}:2` },
      );
      expect(posts(h)).toHaveLength(1);
    },
  );

  it.each([
    [
      'missing rejection code',
      (v: any) => {
        v.code = null;
      },
    ],
    [
      'accepted revision on rejection',
      (v: any) => {
        v.acceptedRevision = 3;
      },
    ],
    [
      'unknown rejection code',
      (v: any) => {
        v.code = 'denied';
      },
    ],
    [
      'unadvanced revision_changed',
      (v: any) => {
        v.code = 'revision_changed';
      },
    ],
    [
      'future expected revision',
      (v: any) => {
        v.expectedRevision = 3;
      },
    ],
  ] as const)('decoder rejects %s in persisted outcome data', (_name, mutate) => {
    const value = structuredClone(retryRejected());
    mutate(value);
    expect(() => decodeSubmissionReprocess(value)).toThrow();
  });

  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER, Infinity, '2'])(
    'refuses expected revision %s before any network request',
    async (expectedRevision) => {
      const h = harness();
      await expect(
        h.client.retrySubmission(id(21), { expectedRevision: expectedRevision as number }),
      ).rejects.toThrow();
      await expect(
        h.client.submissionRetryRequest(id(21), expectedRevision as number),
      ).rejects.toThrow();
      expect(h.fetcher).not.toHaveBeenCalled();
    },
  );

  it('refuses changed identifiers and extra mutation fields before dispatch', async () => {
    const h = harness();
    await expect(h.client.retrySubmission('../private', { expectedRevision: 2 })).rejects.toThrow();
    await expect(
      h.client.retrySubmission(id(21), { expectedRevision: 2, requestId: id(98) } as {
        expectedRevision: number;
      }),
    ).rejects.toThrow();
    expect(h.fetcher).not.toHaveBeenCalled();
  });

  it.each(['accepted-409', 'rejected-202', 'accepted-200'] as const)(
    'refuses the mismatched %s POST mapping',
    async (kind) => {
      const h = harness();
      h.state.hook = (url, init) =>
        init.method === 'POST'
          ? json(
              url,
              kind === 'rejected-202' ? retryRejected() : reprocess(),
              kind === 'accepted-409' ? 409 : kind === 'accepted-200' ? 200 : 202,
            )
          : undefined;
      await expect(h.client.retrySubmission(id(21), { expectedRevision: 2 })).rejects.toMatchObject(
        { code: 'invalid_response', uncertainSave: true },
      );
    },
  );

  it('preserves uncertainty for an ordinary future-revision 409 and absence after reload', async () => {
    const h = harness();
    h.state.hook = (url, init) =>
      init.method === 'POST'
        ? json(url, { error: { code: 'revision_changed', message: 'Future revision.' } }, 409)
        : new URL(url).pathname.includes('/reprocess-requests/')
          ? json(url, { error: { code: 'reprocess_request_not_found', message: 'Missing.' } }, 404)
          : undefined;
    await expect(h.client.retrySubmission(id(21), { expectedRevision: 2 })).rejects.toMatchObject({
      uncertainSave: true,
    });
    await expect(h.client.submissionRetryRequest(id(21), 2)).rejects.toMatchObject({ status: 404 });
    expect(posts(h)).toHaveLength(1);
  });

  it('recovers a lost retry reply through a fresh client lookup, without automatic POST or new identity', async () => {
    const h = harness();
    h.state.hook = (_url, init) => {
      if (init.method === 'POST') throw Error('Lost synthetic reply');
      return undefined;
    };
    await expect(h.client.retrySubmission(id(21), { expectedRevision: 2 })).rejects.toMatchObject({
      uncertainSave: true,
      operationId: `${id(21)}:2`,
    });
    expect(posts(h)).toHaveLength(1);
    h.client.dispose();
    h.state.hook = undefined;
    const fresh = createAssignmentWorkClient({
      expectedOrigin: origin,
      fetch: h.fetcher,
      now: () => h.state.now,
    });
    clients.push(fresh);
    expect(
      readVerifiedSubmissionRetry(await fresh.submissionRetryRequest(id(21), 2)).outcome,
    ).toEqual(reprocess());
    expect(posts(h)).toHaveLength(1);
    expect(
      readVerifiedSubmissionRetry(await fresh.retrySubmission(id(21), { expectedRevision: 2 }))
        .outcome,
    ).toEqual(reprocess());
    expect(posts(h)).toHaveLength(2);
    expect(posts(h).map(([, init]) => init?.body)).toEqual([
      '{"expectedRevision":2}',
      '{"expectedRevision":2}',
    ]);
  });

  it('preserves the retry decision while its current status advances or arrives out of order', async () => {
    const h = harness();
    await h.client.retrySubmission(id(21), { expectedRevision: 2 });
    h.state.reprocess.request.submission = status({
      revision: 4,
      phase: 'failed',
      retryAllowed: true,
      errorCode: 'retry_exhausted',
    });
    const newer = structuredClone(h.state.reprocess);
    expect(
      readVerifiedSubmissionRetry(await h.client.submissionRetryRequest(id(21), 2)).outcome,
    ).toEqual(newer);
    h.state.reprocess = reprocess();
    expect(
      readVerifiedSubmissionRetry(await h.client.submissionRetryRequest(id(21), 2)).outcome,
    ).toEqual(newer);
    h.state.outcome = captured();
    const request = readVerifiedSubmissionRequest(await h.client.submissionRequest(id(20))).request;
    expect(request.state).toBe('captured');
    if (request.state !== 'captured') throw Error('Synthetic capture required');
    expect(request.submission).toEqual(newer.request.submission);
  });

  it.each(['decision', 'code', 'same-revision-status', 'capture-identity'] as const)(
    'rejects changed %s on the same durable retry key',
    async (kind) => {
      const h = harness();
      if (kind === 'code') h.state.reprocess = retryRejected();
      await h.client.submissionRetryRequest(id(21), 2);
      if (kind === 'decision') h.state.reprocess = retryRejected('revision_changed');
      if (kind === 'code') h.state.reprocess = retryRejected('retry_limit');
      if (kind === 'same-revision-status') h.state.reprocess.request.submission.phase = 'queued';
      if (kind === 'capture-identity') {
        h.state.reprocess.request.submission.frozenAt = new Date(time - 1).toISOString();
        h.state.reprocess.request.submission.revision++;
      }
      await expect(h.client.submissionRetryRequest(id(21), 2)).rejects.toMatchObject({
        code:
          kind === 'code' || kind === 'decision'
            ? 'submission_retry_changed'
            : 'submission_changed',
      });
    },
  );

  it.each([401, 403, 429, 500] as const)(
    'retains dispatched intent on HTTP %s, invalidating revoked sessions',
    async (code) => {
      const h = harness();
      h.state.hook = (url, init) =>
        init.method === 'POST'
          ? json(url, { error: { code: 'retry_unavailable', message: 'Unavailable.' } }, code)
          : undefined;
      await expect(h.client.retrySubmission(id(21), { expectedRevision: 2 })).rejects.toMatchObject(
        { status: code, uncertainSave: true },
      );
      expect(posts(h)).toHaveLength(1);
      if (code === 401 || code === 403)
        await expect(h.client.submissionRetryRequest(id(21), 2)).rejects.toMatchObject({
          code: 'session_invalidated',
        });
    },
  );

  it.each(['before', 'after'] as const)(
    'verifies session authority %s dispatch and withholds revoked proofs',
    async (when) => {
      const h = harness();
      let sent = false;
      h.state.hook = (url, init) => {
        if (init.method === 'POST') sent = true;
        if (new URL(url).pathname === '/api/auth/session' && (when === 'before' || sent))
          return json(url, { error: { code: 'session_expired', message: 'Launch again.' } }, 401);
      };
      await expect(h.client.retrySubmission(id(21), { expectedRevision: 2 })).rejects.toMatchObject(
        { uncertainSave: when === 'after' },
      );
      expect(posts(h)).toHaveLength(when === 'after' ? 1 : 0);
    },
  );

  it('refuses forged retry proofs and expires real proofs on time, disposal, or vault lock/reunlock', async () => {
    const h = harness(),
      token = await h.client.retrySubmission(id(21), { expectedRevision: 2 });
    for (const forged of [{}, { outcome: reprocess() }, structuredClone(token)])
      expect(() => readVerifiedSubmissionRetry(forged as VerifiedSubmissionRetry)).toThrow();
    h.state.now += 60000;
    expect(() => readVerifiedSubmissionRetry(token)).toThrow();
    h.state.now = time;
    const second = await h.client.submissionRetryRequest(id(21), 2);
    await lockVault();
    await unlockVault(passphrase);
    expect(() => readVerifiedSubmissionRetry(second)).toThrow();
    const third = await h.client.submissionRetryRequest(id(21), 2);
    h.client.dispose();
    expect(() => readVerifiedSubmissionRetry(third)).toThrow();
  });

  it('bounds retry responses and rejects redirects without releasing exact intent', async () => {
    for (const kind of ['oversized', 'redirected'] as const) {
      const h = harness();
      h.state.hook = (url, init) => {
        if (init.method !== 'POST') return;
        const response = json(
          url,
          reprocess(),
          202,
          kind === 'oversized' ? { 'Content-Length': '16385' } : {},
        );
        if (kind === 'redirected') Object.defineProperty(response, 'redirected', { value: true });
        return response;
      };
      await expect(h.client.retrySubmission(id(21), { expectedRevision: 2 })).rejects.toMatchObject(
        {
          uncertainSave: true,
          code: kind === 'oversized' ? 'response_too_large' : 'redirect_refused',
        },
      );
    }
  });

  it.each(['abort', 'timeout'] as const)(
    'preserves retry uncertainty and cancels a stalled body on %s',
    async (kind) => {
      const h = harness(50),
        started = deferred<void>(),
        aborted = new AbortController(),
        cancelled = vi.fn();
      h.state.hook = (url, init) => {
        if (init.method !== 'POST') return;
        const response = new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('{"request":'));
              started.resolve();
            },
            cancel: cancelled,
          }),
          { status: 202, headers: { 'content-type': 'application/json' } },
        );
        Object.defineProperty(response, 'url', { value: url });
        return response;
      };
      vi.useFakeTimers();
      const result = h.client.retrySubmission(
        id(21),
        { expectedRevision: 2 },
        { signal: aborted.signal },
      );
      const assertion = expect(result).rejects.toMatchObject({
        code: kind === 'abort' ? 'cancelled' : 'timeout',
        uncertainSave: true,
      });
      await started.promise;
      if (kind === 'abort') aborted.abort();
      else await vi.advanceTimersByTimeAsync(51);
      await assertion;
      expect(cancelled).toHaveBeenCalledOnce();
      expect(posts(h)).toHaveLength(1);
    },
  );
});
afterEach(async () => {
  for (const client of clients.splice(0)) client.dispose();
  vi.useRealTimers();
  vi.restoreAllMocks();
  await lockVault();
});

describe('verified submission transport and opaque outcomes', () => {
  it('sends only immutable capture intent with private CSRF and issues an opaque, cloned outcome after both identity checks', async () => {
    const h = harness(),
      value = input();
    const pending = h.client.captureSubmission(value);
    value.expectedCursor = 99;
    const token = await pending;
    expect(Object.isFrozen(token)).toBe(true);
    expect(JSON.stringify(token)).toBe('{}');
    const decoded = readVerifiedSubmissionRequest(token);
    expect(decoded.request).toEqual(captured());
    expect(readVerifiedSnapshot(decoded.verified).session).not.toHaveProperty('csrfToken');
    decoded.request.expectedCursor = 99;
    expect(readVerifiedSubmissionRequest(token).request).toEqual(captured());
    expect(h.fetcher.mock.calls.map(([url]) => new URL(String(url)).pathname)).toEqual([
      '/api/auth/session',
      '/api/assignments/work',
      '/api/auth/session',
      '/api/assignments/work/submissions',
      '/api/auth/session',
      '/api/assignments/work',
      '/api/auth/session',
    ]);
    expect(posts(h)).toHaveLength(1);
    const [url, init] = posts(h)[0];
    expect(url).toBe(`${origin}/api/assignments/work/submissions`);
    expect(init).toMatchObject({
      method: 'POST',
      mode: 'same-origin',
      credentials: 'same-origin',
      cache: 'no-store',
      redirect: 'error',
      referrerPolicy: 'no-referrer',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': 'a'.repeat(43) },
    });
    expect(JSON.parse(String(init!.body))).toEqual(input());
    for (const [requestUrl, options] of h.fetcher.mock.calls) {
      expect(String(requestUrl)).not.toMatch(
        /csrf|token|student|organization|documentId|versionId/,
      );
      expect(String(requestUrl)).not.toContain('a'.repeat(43));
      if (options?.method === 'GET') expect(options.headers).not.toHaveProperty('X-CSRF-Token');
    }
  });
  it.each(['confirmed', 'rejected'] as const)(
    'accepts the exact %s POST status mapping and a 200 request lookup',
    async (kind) => {
      const h = harness();
      h.state.outcome =
        kind === 'rejected'
          ? rejected()
          : captured({ phase: 'confirmed', confirmedAt: new Date(time).toISOString() });
      expect(
        readVerifiedSubmissionRequest(await h.client.captureSubmission(input())).request,
      ).toEqual(h.state.outcome);
      expect(
        readVerifiedSubmissionRequest(await h.client.submissionRequest(id(20))).request,
      ).toEqual(h.state.outcome);
    },
  );
  it.each([
    [
      'extra top-level field',
      (v: any) => {
        v.downloadUrl = 'https://private.invalid';
      },
    ],
    [
      'missing duplicate marker',
      (v: any) => {
        delete v.duplicate;
      },
    ],
    [
      'wrong request ID',
      (v: any) => {
        v.request.requestId = id(99);
      },
    ],
    [
      'wrong requested cursor',
      (v: any) => {
        v.request.expectedCursor = 1;
        v.request.submission.frozenCursor = 1;
      },
    ],
    [
      'wrong nested request ID',
      (v: any) => {
        v.request.submission.requestId = id(99);
      },
    ],
    [
      'wrong frozen cursor',
      (v: any) => {
        v.request.submission.frozenCursor = 1;
      },
    ],
    [
      'unknown phase',
      (v: any) => {
        v.request.submission.phase = 'submitted';
      },
    ],
    [
      'private field',
      (v: any) => {
        v.request.submission.accessToken = 'synthetic';
      },
    ],
    [
      'invalid revision',
      (v: any) => {
        v.request.submission.revision = 0;
      },
    ],
    [
      'unbounded cursor',
      (v: any) => {
        v.request.expectedCursor = 100001;
      },
    ],
    [
      'future timestamp',
      (v: any) => {
        v.request.submission.frozenAt = new Date(time + 60001).toISOString();
      },
    ],
    [
      'invalid date',
      (v: any) => {
        v.request.submission.frozenAt = '2026-02-30T00:00:00.000Z';
      },
    ],
    [
      'unconfirmed phase with confirmation time',
      (v: any) => {
        v.request.submission.confirmedAt = new Date(time).toISOString();
      },
    ],
    [
      'failed phase without error',
      (v: any) => {
        v.request.submission.phase = 'failed';
      },
    ],
  ] as const)('does not issue proof for %s', async (_label, mutate) => {
    const h = harness(),
      body = { request: captured(), duplicate: false };
    mutate(body);
    h.state.hook = (url, init) => (init.method === 'POST' ? json(url, body, 202) : undefined);
    await expect(h.client.captureSubmission(input())).rejects.toMatchObject({
      code: 'invalid_response',
      uncertainSave: true,
      operationId: id(20),
    });
    expect(posts(h)).toHaveLength(1);
  });
  it.each([
    [200, captured()],
    [409, captured()],
    [202, rejected()],
    [202, captured({ phase: 'confirmed', confirmedAt: new Date(time).toISOString() })],
  ] as const)('rejects inconsistent HTTP %s outcome mapping', async (code, request) => {
    const h = harness();
    h.state.hook = (url, init) =>
      init.method === 'POST' ? json(url, { request, duplicate: false }, code) : undefined;
    await expect(h.client.captureSubmission(input())).rejects.toMatchObject({
      code: 'invalid_response',
    });
  });
  it('never treats a bare 409 as a durable rejection fence or automatically repeats its POST', async () => {
    const h = harness();
    h.state.hook = (url, init) =>
      init.method === 'POST'
        ? json(url, { error: { code: 'cursor_changed', message: 'Synthetic conflict' } }, 409)
        : undefined;
    await expect(h.client.captureSubmission(input())).rejects.toMatchObject({
      code: 'invalid_response',
      uncertainSave: true,
      operationId: id(20),
    });
    expect(posts(h)).toHaveLength(1);
    await expect(
      h.client.captureSubmission({ ...input(), expectedCursor: 1 }),
    ).rejects.toMatchObject({ code: 'submission_request_changed' });
    expect(posts(h)).toHaveLength(1);
  });
  it('preserves the original request across a lost reply and only retries on a second explicit call', async () => {
    const h = harness();
    h.state.hook = (_url, init) => {
      if (init.method === 'POST') throw new Error('Synthetic lost reply');
      return undefined;
    };
    await expect(h.client.captureSubmission(input())).rejects.toMatchObject({
      code: 'network_error',
      uncertainSave: true,
      operationId: id(20),
    });
    expect(posts(h)).toHaveLength(1);
    h.state.hook = undefined;
    expect(
      readVerifiedSubmissionRequest(await h.client.captureSubmission(input())).request,
    ).toEqual(captured());
    expect(posts(h).map(([, init]) => init!.body)).toEqual([
      JSON.stringify(input()),
      JSON.stringify(input()),
    ]);
  });
  it.each([400, 401, 403, 422, 429, 503])(
    'classifies a dispatched HTTP %s failure as uncertain without releasing immutable intent',
    async (code) => {
      const h = harness();
      h.state.hook = (url, init) =>
        init.method === 'POST'
          ? json(url, { error: { code: 'synthetic_refusal', message: 'Synthetic response' } }, code)
          : undefined;
      await expect(h.client.captureSubmission(input())).rejects.toMatchObject({
        status: code,
        uncertainSave: true,
        operationId: id(20),
      });
      expect(posts(h)).toHaveLength(1);
    },
  );
  it.each([401, 403])(
    'withholds the token but preserves uncertainty when post-capture verification returns HTTP %s',
    async (code) => {
      const h = harness();
      let capturedResponse = false;
      h.state.hook = (url, init) => {
        if (init.method === 'POST') capturedResponse = true;
        if (capturedResponse && new URL(url).pathname === '/api/auth/session')
          return json(url, { error: { code: 'student_launch_required' } }, code);
        return undefined;
      };
      await expect(h.client.captureSubmission(input())).rejects.toMatchObject({
        uncertainSave: true,
        operationId: id(20),
      });
      expect(posts(h)).toHaveLength(1);
      await expect(h.client.submissions()).rejects.toMatchObject({ code: 'session_invalidated' });
    },
  );
  it('does not claim capture uncertainty when authorization fails before dispatch', async () => {
    const h = harness();
    h.state.hook = (url) =>
      new URL(url).pathname === '/api/auth/session'
        ? json(url, { error: { code: 'student_launch_required' } }, 403)
        : undefined;
    await expect(h.client.captureSubmission(input())).rejects.toMatchObject({
      uncertainSave: false,
      operationId: id(20),
    });
    expect(posts(h)).toHaveLength(0);
  });
  it.each(['pre', 'post'] as const)(
    'withholds proof after %s-capture session replacement',
    async (stage) => {
      const h = harness();
      await h.client.currentSession();
      if (stage === 'pre') h.state.session.userId = id(90);
      else
        h.state.hook = (_url, init) => {
          if (init.method === 'POST') h.state.session.userId = id(90);
          return undefined;
        };
      await expect(h.client.captureSubmission(input())).rejects.toMatchObject({
        code: 'session_invalidated',
      });
      expect(posts(h)).toHaveLength(stage === 'pre' ? 0 : 1);
      await expect(h.client.submissions()).rejects.toMatchObject({ code: 'session_invalidated' });
    },
  );
  it.each([401, 403])(
    'invalidates on HTTP %s and never issues a terminal rejection token',
    async (code) => {
      const h = harness();
      const old = await h.client.captureSubmission(input());
      h.state.hook = (url) =>
        url.includes('/submission-requests/')
          ? json(url, { error: { code: 'student_launch_required' } }, code)
          : undefined;
      await expect(h.client.submissionRequest(id(20))).rejects.toMatchObject({ status: code });
      expect(() => readVerifiedSubmissionRequest(old)).toThrow();
    },
  );
  it.each(['expired', 'disposed', 'lock-unlock'] as const)(
    'revokes an opaque outcome after %s',
    async (kind) => {
      const h = harness(),
        token = await h.client.captureSubmission(input());
      if (kind === 'expired') h.state.now += 60_001;
      if (kind === 'disposed') h.client.dispose();
      if (kind === 'lock-unlock') {
        await lockVault();
        await unlockVault(passphrase);
      }
      expect(() => readVerifiedSubmissionRequest(token)).toThrow();
      if (kind === 'expired')
        expect(
          readVerifiedSubmissionRequest(await h.client.submissionRequest(id(20))).request,
        ).toEqual(captured());
    },
  );
  it('rejects forged and serialized proof objects', async () => {
    const h = harness(),
      token = await h.client.captureSubmission(input());
    for (const value of [{}, { request: captured() }, structuredClone(token)])
      expect(() => readVerifiedSubmissionRequest(value as VerifiedSubmissionRequest)).toThrow();
  });
  it('keeps newer status when request reads arrive out of order', async () => {
    const h = harness();
    h.state.outcome = captured({ revision: 3, phase: 'sending' });
    await h.client.submissionRequest(id(20));
    h.state.outcome = captured();
    expect(readVerifiedSubmissionRequest(await h.client.submissionRequest(id(20))).request).toEqual(
      captured({ revision: 3, phase: 'sending' }),
    );
    h.state.history = [status()];
    expect((await h.client.submissions()).submissions[0]).toEqual(
      status({ revision: 3, phase: 'sending' }),
    );
  });
  it.each(['same-revision', 'frozen-identity', 'confirmed-regression', 'rejected-code'] as const)(
    'refuses %s status mutation',
    async (kind) => {
      const h = harness();
      if (kind === 'confirmed-regression')
        h.state.outcome = captured({
          phase: 'confirmed',
          confirmedAt: new Date(time).toISOString(),
        });
      if (kind === 'rejected-code') h.state.outcome = rejected();
      await h.client.submissionRequest(id(20));
      if (kind === 'same-revision') h.state.outcome = captured({ phase: 'queued' });
      if (kind === 'frozen-identity')
        h.state.outcome = captured({ frozenAt: new Date(time - 1).toISOString(), revision: 2 });
      if (kind === 'confirmed-regression') h.state.outcome = captured({ revision: 2 });
      if (kind === 'rejected-code')
        h.state.outcome = { ...input(), state: 'rejected', code: 'attempt_exists' };
      await expect(h.client.submissionRequest(id(20))).rejects.toMatchObject({
        code: 'submission_changed',
      });
    },
  );
  it('refuses a lookup whose known immutable capture cursor changed after an unknown POST outcome', async () => {
    const h = harness();
    h.state.hook = (_url, init) => {
      if (init.method === 'POST') throw new Error('Synthetic lost reply');
      return undefined;
    };
    await expect(h.client.captureSubmission(input())).rejects.toThrow();
    h.state.hook = undefined;
    h.state.outcome = { ...captured({ frozenCursor: 1 }), expectedCursor: 1 };
    await expect(h.client.submissionRequest(id(20))).rejects.toMatchObject({
      code: 'submission_request_changed',
    });
  });
  it.each(['capture', 'lookup', 'history'] as const)(
    'refuses a %s with a frozen cursor beyond the post-verified document',
    async (kind) => {
      const h = harness();
      h.state.outcome = { ...captured({ frozenCursor: 1 }), expectedCursor: 1 };
      h.state.history = [status({ frozenCursor: 1 })];
      await expect(
        kind === 'capture'
          ? h.client.captureSubmission({ ...input(), expectedCursor: 1 })
          : kind === 'lookup'
            ? h.client.submissionRequest(id(20))
            : h.client.submissions(),
      ).rejects.toMatchObject({ code: 'invalid_response' });
    },
  );
  it.each(['too-many', 'duplicate', 'bad-cursor', 'extra'] as const)(
    'bounds and validates %s history responses',
    async (kind) => {
      const h = harness();
      const page: any = { submissions: [status()], nextCursor: null };
      if (kind === 'too-many')
        page.submissions = Array.from({ length: 11 }, (_, i) =>
          status({ id: id(100 + i), requestId: id(200 + i) }),
        );
      if (kind === 'duplicate') page.submissions.push(status());
      if (kind === 'bad-cursor') page.nextCursor = '../private?token=synthetic';
      if (kind === 'extra') page.receiptUrl = 'https://private.invalid';
      h.state.hook = (url) =>
        new URL(url).pathname.endsWith('/submissions') ? json(url, page) : undefined;
      await expect(h.client.submissions()).rejects.toMatchObject({ code: 'invalid_response' });
    },
  );
  it.each(['capture', 'history'] as const)(
    'cancels oversized %s JSON before decoding or issuing proof',
    async (kind) => {
      const h = harness();
      h.state.hook = (url) =>
        new URL(url).pathname.endsWith('/submissions')
          ? json(url, {}, kind === 'capture' ? 202 : 200, {
              'Content-Length': String(kind === 'capture' ? 16385 : 32769),
            })
          : undefined;
      await expect(
        kind === 'capture' ? h.client.captureSubmission(input()) : h.client.submissions(),
      ).rejects.toMatchObject({ code: 'response_too_large' });
    },
  );
  it('refuses redirected submission replies despite a correctly shaped body', async () => {
    const h = harness();
    h.state.hook = (url, init) => {
      if (init.method !== 'POST') return undefined;
      const value = json(url, { request: captured(), duplicate: false }, 202);
      Object.defineProperty(value, 'redirected', { value: true });
      return value;
    };
    await expect(h.client.captureSubmission(input())).rejects.toMatchObject({
      code: 'redirect_refused',
      uncertainSave: true,
    });
    expect(posts(h)).toHaveLength(1);
  });
  it.each(['timeout', 'abort'] as const)(
    'covers the pending response body with the %s boundary',
    async (kind) => {
      const h = harness(50),
        started = deferred<void>(),
        aborted = new AbortController(),
        cancelled = vi.fn();
      h.state.hook = (url, init) => {
        if (init.method !== 'POST') return undefined;
        const response = new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('{"request":'));
              started.resolve();
            },
            cancel: cancelled,
          }),
          { status: 202, headers: { 'content-type': 'application/json' } },
        );
        Object.defineProperty(response, 'url', { value: url });
        return response;
      };
      vi.useFakeTimers();
      const pending = h.client.captureSubmission(input(), { signal: aborted.signal });
      const assertion = expect(pending).rejects.toMatchObject({
        code: kind === 'timeout' ? 'timeout' : 'cancelled',
        uncertainSave: true,
        operationId: id(20),
      });
      await started.promise;
      if (kind === 'timeout') await vi.advanceTimersByTimeAsync(51);
      else aborted.abort();
      await assertion;
      expect(cancelled).toHaveBeenCalledOnce();
      expect(posts(h)).toHaveLength(1);
    },
  );
});
