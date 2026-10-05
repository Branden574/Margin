import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createAssignmentWorkClient,
  MAX_JSON_BYTES,
  MAX_SOURCE_BYTES,
  type AppendOperation,
  type WorkManifest,
} from '../apps/web/src/lib/assignment-work';

const origin = 'https://margin.synthetic.test';
const now = 1_800_000_000_000;
const id = (n: number) => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const session = () => ({
  authenticated: true,
  sessionId: id(1),
  userId: id(2),
  organizationId: id(3),
  role: 'student',
  authenticationMethod: 'lti',
  mfa: false,
  createdAt: now - 1000,
  lastSeenAt: now,
  expiresAt: now + 60_000,
  csrfToken: 'a'.repeat(43),
});
const manifest = (): WorkManifest => ({
  assignment: {
    id: id(4),
    title: 'Synthetic assignment',
    instructions: 'Private synthetic instructions',
    policy: {
      allowedTools: ['text', 'pen', 'eraser'],
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
});
const operation = (): AppendOperation => ({
  documentId: id(6),
  versionId: id(7),
  pageId: id(8),
  annotationId: id(9),
  operationId: id(10),
  baseRevision: 0,
  kind: 'put',
  annotation: {
    type: 'text',
    x: 12,
    y: 20,
    text: 'Synthetic note',
    color: '#aabbcc',
    opacity: 1,
    strokeWidth: 1,
  },
});
const receipt = () => ({
  receipt: { operationId: id(10), cursor: 1, annotationRevision: 1, duplicate: false },
});
const caught = () => ({
  documentId: id(6),
  versionId: id(7),
  operations: [
    {
      ...operation(),
      actorId: id(2),
      cursor: 1,
      annotationRevision: 1,
      committedAt: new Date(now).toISOString(),
    },
  ],
  nextCursor: 1,
  currentCursor: 1,
  hasMore: false,
});
function response(
  url: string,
  value: unknown,
  status = 200,
  headers: Record<string, string> = { 'Content-Type': 'application/json' },
) {
  const body =
    headers['Content-Type'] === 'application/json' ? JSON.stringify(value) : (value as BodyInit);
  const result = new Response(body, { status, headers });
  Object.defineProperty(result, 'url', { value: url, configurable: true });
  return result;
}
type Hook = (url: string, init: RequestInit) => Response | Promise<Response> | undefined;
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}
function harness(timeoutMs = 45_000) {
  const state = { session: session(), manifest: manifest(), hook: undefined as Hook | undefined };
  const fetcher = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input),
      custom = state.hook?.(url, init);
    if (custom) return custom;
    const path = new URL(url).pathname;
    if (path === '/api/auth/session') return response(url, state.session);
    if (path === '/api/assignments/work/source')
      return response(url, '%PDF-1.7\nSynthetic fixture\n%%EOF', 200, {
        'Content-Type': 'application/pdf',
      });
    if (path === '/api/assignments/work/operations')
      return response(url, init.method === 'POST' ? receipt() : caught());
    if (init.method === 'POST')
      return response(
        url,
        {
          work: {
            id: id(5),
            assignmentId: id(4),
            userId: id(2),
            documentId: id(6),
            versionId: id(7),
            status: 'pending',
            duplicate: false,
          },
        },
        202,
      );
    return response(url, state.manifest);
  });
  const client = createAssignmentWorkClient({
    fetch: fetcher,
    expectedOrigin: origin,
    now: () => now,
    timeoutMs,
  });
  return { client, state, fetcher };
}
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('current-launch assignment browser client', () => {
  it('uses same-origin HTTPS, private CSRF and immutable verified manifest IDs; no session round trips per stroke', async () => {
    const h = harness();
    const s = await h.client.currentSession();
    expect(s).not.toHaveProperty('csrfToken');
    const m = await h.client.manifest();
    expect(h.fetcher).toHaveBeenCalledTimes(4);
    m.assignment.policy.allowedTools.length = 0;
    if (m.work?.status === 'provisioned') m.work.document.pages[0].id = id(99);
    expect(await h.client.append(operation())).toEqual(receipt().receipt);
    expect(h.fetcher).toHaveBeenCalledTimes(5);
    const [url, init] = h.fetcher.mock.calls.at(-1)!;
    expect(url).toBe(`${origin}/api/assignments/work/operations`);
    expect(init).toMatchObject({
      method: 'POST',
      mode: 'same-origin',
      credentials: 'same-origin',
      cache: 'no-store',
      redirect: 'error',
      referrerPolicy: 'no-referrer',
      headers: { 'X-CSRF-Token': 'a'.repeat(43) },
    });
    expect(JSON.parse(init!.body as string)).toEqual(operation());
    expect(await h.client.catchUp()).toEqual(caught());
    expect(h.fetcher).toHaveBeenCalledTimes(6);
    expect(h.fetcher.mock.calls.at(-1)![1]!.headers).not.toHaveProperty('X-CSRF-Token');
    h.client.dispose();
  });
  it('reserves only {} and accepts null → pending → provisioned without treating reservation as source availability', async () => {
    const h = harness();
    h.state.manifest.work = null;
    await h.client.manifest();
    expect((await h.client.reserve()).status).toBe('pending');
    expect(h.fetcher.mock.calls.at(-1)![1]!.body).toBe('{}');
    await expect(h.client.source()).rejects.toMatchObject({ code: 'work_pending' });
    h.state.manifest.work = { id: id(5), status: 'pending' };
    expect((await h.client.manifest()).work?.status).toBe('pending');
    h.state.manifest = manifest();
    expect((await h.client.manifest()).work?.status).toBe('provisioned');
    const count = h.fetcher.mock.calls.length;
    expect(await (await h.client.source()).text()).toContain('%PDF-1.7');
    expect(h.fetcher).toHaveBeenCalledTimes(count + 3);
  });
  it.each([
    'http://margin.synthetic.test',
    'https://other.test/path',
    'https://user@other.test',
    'https://other.test?x=1',
  ])('rejects invalid origin %s', (expectedOrigin) => {
    expect(() => createAssignmentWorkClient({ fetch: vi.fn(), expectedOrigin })).toThrow();
  });
  it('cannot override a real page origin with injected dependencies', () => {
    vi.stubGlobal('location', { origin });
    expect(() =>
      createAssignmentWorkClient({ fetch: vi.fn(), expectedOrigin: 'https://other.test' }),
    ).toThrow();
  });
  it.each([
    { authenticationMethod: 'oidc' },
    { role: 'teacher' },
    { expiresAt: now },
    { csrfToken: 'invalid' },
    { userId: 'untrusted' },
  ])('refuses invalid or non-LTI student sessions %j', async (patch) => {
    const h = harness();
    Object.assign(h.state.session, patch);
    await expect(h.client.currentSession()).rejects.toThrow();
    await expect(h.client.manifest()).rejects.toMatchObject({ code: 'session_invalidated' });
    expect(h.fetcher).toHaveBeenCalledTimes(1);
  });
  it('requires verified manifest state and never accepts an externally supplied ID as authority', async () => {
    const h = harness();
    await expect(h.client.append(operation())).rejects.toMatchObject({ code: 'session_required' });
    await h.client.currentSession();
    await expect(h.client.reserve()).rejects.toMatchObject({ code: 'manifest_required' });
    await h.client.manifest();
    await expect(h.client.append({ ...operation(), documentId: id(90) })).rejects.toMatchObject({
      code: 'work_mismatch',
      uncertainSave: false,
    });
    expect(h.fetcher).toHaveBeenCalledTimes(4);
  });
  it.each([
    'duplicate-page',
    'noncontiguous-page',
    'wrong-permission',
    'extra-secret',
    'bad-policy',
  ] as const)('rejects malformed manifest %s', async (kind) => {
    const h = harness(),
      m = h.state.manifest;
    if (m.work?.status !== 'provisioned') throw new Error();
    if (kind === 'duplicate-page')
      m.work.document.pages.push({ ...m.work.document.pages[0], index: 1 });
    if (kind === 'noncontiguous-page') m.work.document.pages[0].index = 1;
    if (kind === 'wrong-permission') m.work.document.permission = 'viewer';
    if (kind === 'extra-secret') Object.assign(m.assignment, { teacherId: id(99) });
    if (kind === 'bad-policy') m.assignment.policy.allowedTools.push('text');
    await expect(h.client.manifest()).rejects.toMatchObject({ code: 'invalid_response' });
    await expect(h.client.source()).rejects.toMatchObject({ code: 'manifest_required' });
  });
  it('invalidates on replacement work identity while retaining valid provisioning transitions', async () => {
    const h = harness();
    await h.client.manifest();
    h.state.manifest = manifest();
    h.state.manifest.assignment.id = id(50);
    await expect(h.client.manifest()).rejects.toMatchObject({ code: 'work_changed' });
    await expect(h.client.catchUp()).rejects.toMatchObject({ code: 'session_invalidated' });
  });
  it.each([0.5, Number.MIN_VALUE, 100_000])(
    'accepts positive server page dimension %s',
    async (size) => {
      const h = harness();
      if (h.state.manifest.work?.status !== 'provisioned') throw new Error();
      h.state.manifest.work.document.pages[0].width = size;
      h.state.manifest.work.document.pages[0].height = size;
      const result = await h.client.manifest();
      expect(result.work?.status === 'provisioned' && result.work.document.pages[0]).toMatchObject({
        width: size,
        height: size,
      });
    },
  );
  it.each(['width', 'height'] as const)('rejects invalid %s page dimensions', async (axis) => {
    for (const size of [0, -0.5, 100_000.01, 1_000_000, Infinity, NaN]) {
      const h = harness();
      if (h.state.manifest.work?.status !== 'provisioned') throw new Error();
      h.state.manifest.work.document.pages[0][axis] = size;
      await expect(h.client.manifest()).rejects.toMatchObject({ code: 'invalid_response' });
      h.client.dispose();
    }
  });
  it('preserves an append cursor acknowledged during an older manifest snapshot', async () => {
    const h = harness();
    await h.client.manifest();
    const started = deferred<void>(),
      pending = deferred<Response>();
    h.state.hook = (url, init) => {
      if (url.endsWith('/work') && init.method === 'GET') {
        started.resolve();
        return pending.promise;
      }
    };
    const refresh = h.client.manifest();
    await started.promise;
    await h.client.append(operation());
    pending.resolve(response(`${origin}/api/assignments/work`, manifest()));
    const result = await refresh;
    expect(result.work?.status === 'provisioned' && result.work.document.cursor).toBe(1);
    h.state.hook = undefined;
    expect(await h.client.catchUp()).toEqual(caught());
    await expect(h.client.manifest()).rejects.toMatchObject({ code: 'work_changed' });
  });
  it('serializes pending and provisioned manifest refreshes without blocking append', async () => {
    const h = harness();
    h.state.manifest.work = { id: id(5), status: 'pending' };
    await h.client.manifest();
    const started = deferred<void>(),
      pending = deferred<Response>();
    let reads = 0;
    h.state.hook = (url, init) => {
      if (url.endsWith('/work') && init.method === 'GET' && ++reads === 1) {
        started.resolve();
        return pending.promise;
      }
    };
    const first = h.client.manifest();
    await started.promise;
    const second = h.client.manifest();
    await Promise.resolve();
    expect(reads).toBe(1);
    const oldSnapshot = structuredClone(h.state.manifest);
    h.state.manifest = manifest();
    pending.resolve(response(`${origin}/api/assignments/work`, oldSnapshot));
    expect((await first).work?.status).toBe('pending');
    expect((await second).work?.status).toBe('provisioned');
    expect(reads).toBe(2);
    expect(await h.client.append(operation())).toEqual(receipt().receipt);
  });
  it('does not let a cancelled queued manifest release the next reader ahead of an active snapshot', async () => {
    const h = harness();
    await h.client.manifest();
    const started = deferred<void>(),
      pending = deferred<Response>();
    let reads = 0;
    h.state.hook = (url, init) => {
      if (url.endsWith('/work') && init.method === 'GET' && ++reads === 1) {
        started.resolve();
        return pending.promise;
      }
    };
    const first = h.client.manifest();
    await started.promise;
    const controller = new AbortController();
    const second = h.client.manifest({ signal: controller.signal });
    const rejected = expect(second).rejects.toMatchObject({ code: 'cancelled' });
    controller.abort();
    await rejected;
    const third = h.client.manifest();
    await Promise.resolve();
    expect(reads).toBe(1);
    pending.resolve(response(`${origin}/api/assignments/work`, manifest()));
    await first;
    await third;
    expect(reads).toBe(2);
  });
  it('rejects a pre-reservation null snapshot as stale without erasing the new binding', async () => {
    const h = harness();
    h.state.manifest.work = null;
    await h.client.manifest();
    const started = deferred<void>(),
      pending = deferred<Response>();
    h.state.hook = (url, init) => {
      if (url.endsWith('/work') && init.method === 'GET') {
        started.resolve();
        return pending.promise;
      }
    };
    const refresh = h.client.manifest();
    await started.promise;
    await h.client.reserve();
    pending.resolve(response(`${origin}/api/assignments/work`, h.state.manifest));
    await expect(refresh).rejects.toMatchObject({ code: 'stale_response', uncertainSave: false });
    h.state.hook = undefined;
    h.state.manifest.work = { id: id(5), status: 'pending' };
    expect((await h.client.manifest()).work?.status).toBe('pending');
    h.state.manifest = manifest();
    expect((await h.client.manifest()).work?.status).toBe('provisioned');
  });
  it('refuses a fresh null manifest after an acknowledged reservation', async () => {
    const h = harness();
    h.state.manifest.work = null;
    await h.client.manifest();
    await h.client.reserve();
    await expect(h.client.manifest()).rejects.toMatchObject({ code: 'work_changed' });
    await expect(h.client.reserve()).rejects.toMatchObject({ code: 'session_invalidated' });
  });
  it('detects a different session before releasing a manifest or a binary source', async () => {
    const h = harness();
    await h.client.manifest();
    h.state.hook = (url) => {
      if (url.endsWith('/source')) {
        h.state.session.sessionId = id(40);
        return response(url, '%PDF-1.7\nprivate', 200, { 'Content-Type': 'application/pdf' });
      }
    };
    await expect(h.client.source()).rejects.toMatchObject({ code: 'session_changed' });
    await expect(h.client.currentSession()).rejects.toMatchObject({ code: 'session_invalidated' });
  });
  it.each(['cancelled', 'timeout'] as const)(
    'preserves the existing session after %s while reading auth and discards late replacement bytes',
    async (code) => {
      const h = harness(40);
      const original = await h.client.currentSession();
      vi.useFakeTimers();
      const controller = new AbortController();
      const reading = deferred<void>();
      const late = deferred<ReadableStreamReadResult<Uint8Array>>();
      const cancelled = vi.fn(async () => {});
      h.state.hook = (url) => {
        const r = response(url, {});
        Object.defineProperty(r, 'body', {
          value: {
            getReader: () => ({
              read: () => {
                reading.resolve();
                return late.promise;
              },
              cancel: cancelled,
              releaseLock: vi.fn(),
            }),
          },
        });
        return r;
      };
      const pending = h.client.currentSession({ signal: controller.signal });
      const observed = expect(pending).rejects.toMatchObject({ code, uncertainSave: false });
      await reading.promise;
      if (code === 'cancelled') controller.abort();
      else await vi.advanceTimersByTimeAsync(40);
      await observed;
      const stale = new TextEncoder().encode(
        JSON.stringify({ ...session(), sessionId: id(80), csrfToken: 'b'.repeat(43) }),
      );
      late.resolve({ done: false, value: stale });
      await vi.advanceTimersByTimeAsync(0);
      expect([...stale]).toEqual(Array(stale.length).fill(0));
      expect(cancelled).toHaveBeenCalled();
      h.state.hook = undefined;
      expect(await h.client.currentSession()).toEqual(original);
      expect((await h.client.manifest()).work?.status).toBe('provisioned');
    },
  );
  it.each(['broken-stream', 'declared-length'] as const)(
    'preserves the verified binding after truncated auth delivery: %s',
    async (kind) => {
      const h = harness();
      const original = await h.client.currentSession();
      h.state.hook = (url) => {
        if (kind === 'declared-length')
          return response(url, session(), 200, {
            'Content-Type': 'application/json',
            'Content-Length': '16000',
          });
        return response(
          url,
          new ReadableStream({
            start(controller) {
              controller.error(new Error('Synthetic network truncation'));
            },
          }),
          200,
          { 'Content-Type': 'application/json; charset=utf-8' },
        );
      };
      await expect(h.client.currentSession()).rejects.toMatchObject({
        code: kind === 'declared-length' ? 'invalid_response' : 'network_error',
      });
      h.state.hook = undefined;
      expect(await h.client.currentSession()).toEqual(original);
    },
  );
  it('still invalidates a complete malformed session after an existing binding', async () => {
    const h = harness();
    await h.client.currentSession();
    h.state.session.csrfToken = 'malformed';
    await expect(h.client.currentSession()).rejects.toMatchObject({ code: 'invalid_response' });
    h.state.session = session();
    await expect(h.client.currentSession()).rejects.toMatchObject({ code: 'session_invalidated' });
  });
  it('detects a known session swap during append and preserves the uncertain operation identifier', async () => {
    const h = harness();
    await h.client.manifest();
    h.state.hook = (url) => (url.endsWith('/operations') ? new Promise(() => {}) : undefined);
    const pending = h.client.append(operation());
    const observed = expect(pending).rejects.toMatchObject({
      code: 'session_invalidated',
      uncertainSave: true,
      operationId: id(10),
    });
    h.state.session.sessionId = id(41);
    await expect(h.client.currentSession()).rejects.toMatchObject({ code: 'session_changed' });
    await observed;
  });
  it.each([401, 403])('fails HTTP %s closed with no local fallback', async (status) => {
    const h = harness();
    await h.client.manifest();
    h.state.hook = (url) =>
      response(url, { error: { code: 'work_access_denied', message: 'Denied' } }, status);
    await expect(h.client.append(operation())).rejects.toMatchObject({
      status,
      code: 'work_access_denied',
      uncertainSave: false,
      operationId: id(10),
    });
    const count = h.fetcher.mock.calls.length;
    await expect(h.client.currentSession()).rejects.toMatchObject({ code: 'session_invalidated' });
    expect(h.fetcher).toHaveBeenCalledTimes(count);
  });
  it('snapshots the operation before asynchronous work and explicitly retries the exact identifier', async () => {
    const h = harness();
    await h.client.manifest();
    const input = operation();
    let finish!: (r: Response) => void;
    h.state.hook = (url) =>
      url.endsWith('/operations')
        ? new Promise((resolve) => {
            finish = resolve;
          })
        : undefined;
    const pending = h.client.append(input);
    input.operationId = id(90);
    input.annotation!.text = 'changed after send';
    const sent = JSON.parse(h.fetcher.mock.calls.at(-1)![1]!.body as string);
    expect(sent).toEqual(operation());
    finish(
      response(`${origin}/api/assignments/work/operations`, {
        receipt: { ...receipt().receipt, operationId: id(99) },
      }),
    );
    await expect(pending).rejects.toMatchObject({
      code: 'invalid_response',
      uncertainSave: true,
      operationId: id(10),
    });
    expect(h.fetcher).toHaveBeenCalledTimes(4);
    h.state.hook = (url) => response(url, { receipt: { ...receipt().receipt, duplicate: true } });
    expect(await h.client.append(sent)).toMatchObject({ operationId: id(10), duplicate: true });
    expect(JSON.parse(h.fetcher.mock.calls.at(-1)![1]!.body as string)).toEqual(sent);
  });
  it('keeps post-commit cancellation uncertain and allows caller-controlled exact-ID duplicate retry', async () => {
    const h = harness();
    await h.client.manifest();
    const committed: AppendOperation[] = [];
    h.state.hook = (url, init) => {
      const sent = JSON.parse(init.body as string) as AppendOperation;
      if (committed.length) {
        expect(sent).toEqual(committed[0]);
        return response(url, { receipt: { ...receipt().receipt, duplicate: true } });
      }
      committed.push(sent);
      return response(
        url,
        { error: { code: 'work_request_cancelled', message: 'Request cancelled' } },
        409,
      );
    };
    await expect(h.client.append(operation())).rejects.toMatchObject({
      status: 409,
      code: 'work_request_cancelled',
      uncertainSave: true,
      operationId: id(10),
    });
    expect(committed).toHaveLength(1);
    expect(h.fetcher).toHaveBeenCalledTimes(4);
    expect(await h.client.append(operation())).toMatchObject({
      operationId: id(10),
      duplicate: true,
    });
    expect(committed).toHaveLength(1);
    expect(h.fetcher).toHaveBeenCalledTimes(5);
  });
  it.each(['revision_conflict', 'idempotency_conflict'])(
    'keeps ordinary 409 %s distinct from uncertain cancellation',
    async (code) => {
      const h = harness();
      await h.client.manifest();
      h.state.hook = (url) => response(url, { error: { code, message: 'Conflict' } }, 409);
      await expect(h.client.append(operation())).rejects.toMatchObject({
        status: 409,
        code,
        uncertainSave: false,
        operationId: id(10),
      });
    },
  );
  it.each(['signature', 'arrow', 'stamp'])(
    'does not silently map local %s tools to supported operations',
    async (type) => {
      const h = harness();
      await h.client.manifest();
      const input = operation();
      Object.assign(input.annotation!, { type });
      await expect(h.client.append(input)).rejects.toMatchObject({ code: 'invalid_operation' });
      expect(h.fetcher).toHaveBeenCalledTimes(3);
    },
  );
  it('enforces immutable tool and original-content delivery policies', async () => {
    const h = harness();
    h.state.manifest.assignment.policy.allowedTools = ['pen'];
    h.state.manifest.assignment.policy.allowExport = false;
    await h.client.manifest();
    await expect(h.client.append(operation())).rejects.toMatchObject({
      code: 'assignment_tool_disabled',
    });
    await expect(h.client.source()).rejects.toMatchObject({
      code: 'restricted_delivery_unavailable',
    });
    expect(h.fetcher).toHaveBeenCalledTimes(3);
  });
  it.each([
    'actor',
    'document',
    'version',
    'page',
    'cursor-gap',
    'next-cursor',
    'has-more',
    'revision',
    'timestamp',
  ] as const)('rejects catch-up %s mismatch', async (kind) => {
    const h = harness();
    await h.client.manifest();
    const r = caught();
    if (kind === 'actor') r.operations[0].actorId = id(90);
    if (kind === 'document') r.documentId = id(90);
    if (kind === 'version') r.operations[0].versionId = id(90);
    if (kind === 'page') r.operations[0].pageId = id(90);
    if (kind === 'cursor-gap') {
      r.operations[0].cursor = 2;
      r.nextCursor = 2;
      r.currentCursor = 2;
    }
    if (kind === 'next-cursor') r.nextCursor = 0;
    if (kind === 'has-more') r.hasMore = true;
    if (kind === 'revision') r.operations[0].annotationRevision = 2;
    if (kind === 'timestamp') r.operations[0].committedAt = 'not a date';
    h.state.hook = (url) => response(url, r);
    await expect(h.client.catchUp()).rejects.toMatchObject({ code: 'invalid_response' });
  });
  it('rejects cursor rollback after an acknowledged save and respects catch-up page limits', async () => {
    const h = harness();
    await h.client.manifest();
    await h.client.append(operation());
    h.state.hook = (url) =>
      response(url, { ...caught(), currentCursor: 0, operations: [], nextCursor: 0 });
    await expect(h.client.catchUp()).rejects.toMatchObject({ code: 'invalid_response' });
    const count = h.fetcher.mock.calls.length;
    await expect(h.client.catchUp({ limit: 101 })).rejects.toThrow();
    expect(h.fetcher).toHaveBeenCalledTimes(count);
  });
  it('accepts a catch-up snapshot begun before a concurrent append without rolling back its cursor', async () => {
    const h = harness();
    await h.client.manifest();
    const pending = deferred<Response>();
    h.state.hook = (url, init) =>
      new URL(url).pathname.endsWith('/operations') && init.method === 'GET'
        ? pending.promise
        : undefined;
    const reading = h.client.catchUp();
    await h.client.append(operation());
    const earlier = { ...caught(), operations: [], nextCursor: 0, currentCursor: 0 };
    pending.resolve(
      response(`${origin}/api/assignments/work/operations?afterCursor=0&limit=50`, earlier),
    );
    expect(await reading).toEqual(earlier);
    h.state.hook = (url) => response(url, earlier);
    await expect(h.client.catchUp()).rejects.toMatchObject({ code: 'invalid_response' });
  });
  it.each(['redirected', 'foreign-url', '302'] as const)(
    'rejects %s responses even from an injected transport',
    async (kind) => {
      const h = harness();
      h.state.hook = (url) => {
        const r = response(
          kind === 'foreign-url' ? 'https://other.test/api/auth/session' : url,
          session(),
          kind === '302' ? 302 : 200,
        );
        if (kind === 'redirected') Object.defineProperty(r, 'redirected', { value: true });
        return r;
      };
      await expect(h.client.currentSession()).rejects.toMatchObject({ code: 'redirect_refused' });
    },
  );
  it.each(['html', 'bad-json', 'bad-utf8', 'declared-size', 'stream-size'] as const)(
    'bounds malformed JSON response %s',
    async (kind) => {
      const h = harness();
      h.state.hook = (url) => {
        if (kind === 'html')
          return response(url, '<html>Login</html>', 200, { 'Content-Type': 'text/html' });
        const content =
          kind === 'bad-json'
            ? '{'
            : kind === 'bad-utf8'
              ? new Uint8Array([0xff])
              : ' '.repeat(kind === 'stream-size' ? MAX_JSON_BYTES + 1 : 1);
        const r = new Response(content, {
          headers: {
            'Content-Type': 'application/json',
            ...(kind === 'declared-size' ? { 'Content-Length': String(MAX_JSON_BYTES + 1) } : {}),
          },
        });
        Object.defineProperty(r, 'url', { value: url });
        return r;
      };
      await expect(h.client.currentSession()).rejects.toThrow();
    },
  );
  it.each(['mime', 'signature', 'size'] as const)(
    'rejects invalid PDF %s before release',
    async (kind) => {
      const h = harness();
      await h.client.manifest();
      h.state.hook = (url) =>
        url.endsWith('/source')
          ? response(url, kind === 'signature' ? 'HTMLDATA' : '%PDF-1.7', 200, {
              'Content-Type': kind === 'mime' ? 'text/html' : 'application/pdf',
              ...(kind === 'size' ? { 'Content-Length': String(MAX_SOURCE_BYTES + 1) } : {}),
            })
          : undefined;
      await expect(h.client.source()).rejects.toThrow();
    },
  );
  it('keeps the deadline active through a stalled body and cancels its reader', async () => {
    const h = harness(40);
    await h.client.manifest();
    const cancelled = vi.fn();
    h.state.hook = (url) => {
      if (!url.endsWith('/source')) return;
      const stream = new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode('%PDF-1.7'));
        },
        cancel: cancelled,
      });
      return response(url, stream, 200, { 'Content-Type': 'application/pdf' });
    };
    await expect(h.client.source()).rejects.toMatchObject({ code: 'timeout' });
    expect(cancelled).toHaveBeenCalledTimes(1);
  });
  it('bounds abort-ignoring fetch and does not dispatch pre-cancelled edits', async () => {
    const h = harness(30);
    await h.client.manifest();
    h.state.hook = () => new Promise(() => {});
    await expect(h.client.append(operation())).rejects.toMatchObject({
      code: 'timeout',
      uncertainSave: true,
      operationId: id(10),
    });
    const count = h.fetcher.mock.calls.length,
      controller = new AbortController();
    controller.abort();
    await expect(h.client.append(operation(), { signal: controller.signal })).rejects.toMatchObject(
      { code: 'cancelled', uncertainSave: false, operationId: id(10) },
    );
    expect(h.fetcher).toHaveBeenCalledTimes(count);
  });
  it('explicit invalidation cancels in-flight work and permanently clears the binding', async () => {
    const h = harness();
    await h.client.manifest();
    h.state.hook = () => new Promise(() => {});
    const pending = h.client.append(operation());
    h.client.invalidate();
    await expect(pending).rejects.toMatchObject({
      code: 'session_invalidated',
      uncertainSave: true,
      operationId: id(10),
    });
    await expect(h.client.currentSession()).rejects.toMatchObject({ code: 'session_invalidated' });
  });
  it.each(['resolve', 'reject'] as const)(
    'settles a late fetch %s after synchronous cancellation inside fetch',
    async (outcome) => {
      const h = harness();
      await h.client.manifest();
      const controller = new AbortController(),
        late = deferred<Response>(),
        cancelled = vi.fn();
      h.state.hook = () => {
        controller.abort();
        return late.promise;
      };
      await expect(
        h.client.append(operation(), { signal: controller.signal }),
      ).rejects.toMatchObject({
        code: 'cancelled',
        uncertainSave: true,
        operationId: id(10),
      });
      if (outcome === 'reject') late.reject(new Error('Synthetic late rejection'));
      else {
        const stream = new ReadableStream({ cancel: cancelled });
        late.resolve(
          response(`${origin}/api/assignments/work/operations`, stream, 200, {
            'Content-Type': 'application/octet-stream',
          }),
        );
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      expect(cancelled).toHaveBeenCalledTimes(outcome === 'resolve' ? 1 : 0);
    },
  );
  it('disposes a late body chunk when its reader synchronously cancels the request', async () => {
    const h = harness();
    await h.client.manifest();
    const controller = new AbortController(),
      late = deferred<ReadableStreamReadResult<Uint8Array>>();
    const cancelled = vi.fn(async () => {}),
      released = vi.fn();
    h.state.hook = (url) => {
      if (!url.endsWith('/source')) return;
      const r = response(url, '', 200, { 'Content-Type': 'application/pdf' });
      Object.defineProperty(r, 'body', {
        value: {
          getReader: () => ({
            read: () => {
              controller.abort();
              return late.promise;
            },
            cancel: cancelled,
            releaseLock: released,
          }),
        },
      });
      return r;
    };
    await expect(h.client.source({ signal: controller.signal })).rejects.toMatchObject({
      code: 'cancelled',
    });
    const chunk = new TextEncoder().encode('%PDF-1.7 private synthetic bytes');
    late.resolve({ done: false, value: chunk });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect([...chunk]).toEqual(Array(chunk.length).fill(0));
    expect(cancelled).toHaveBeenCalled();
    expect(released).toHaveBeenCalledTimes(1);
  });
});
