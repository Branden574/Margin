import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDB } from 'idb';
import {
  createAssignmentWorkClient,
  readVerifiedSnapshot,
  readVerifiedSubmissionRequest,
  type VerifiedSubmissionRequest,
} from '../apps/web/src/lib/assignment-work/client';
import type { WorkManifest } from '../apps/web/src/lib/assignment-work/types';
import type {
  SubmissionRequest,
  SubmissionStatus,
} from '../apps/web/src/lib/assignment-work/submissionTypes';
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
