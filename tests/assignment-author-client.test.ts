import { describe, expect, it, vi } from 'vitest';
import {
  createAssignmentAuthorClient,
  readAuthorContext,
  AuthorClientError,
} from '../apps/web/src/lib/assignment-author/client';
import {
  authorTools,
  type AuthorContext,
  type AuthorDraft,
} from '../apps/web/src/lib/assignment-author/types';
const origin = 'https://margin.synthetic.test',
  now = 1800000000000;
const id = (n: number) => `30000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const draft = (): AuthorDraft => ({
  documentId: id(5),
  versionId: id(6),
  title: 'Synthetic coursework',
  instructions: 'Synthetic teacher instructions',
  policy: {
    allowedTools: [...authorTools],
    allowExport: true,
    allowCopyPaste: true,
    allowReadAloud: true,
    assessment: false,
  },
});
function response(url: string, value: unknown, status = 200) {
  const result = new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
  Object.defineProperty(result, 'url', { value: url, configurable: true });
  return result;
}
function harness(timeoutMs = 45000) {
  const state = {
    session: {
      authenticated: true,
      sessionId: id(1),
      organizationId: id(2),
      userId: id(3),
      role: 'teacher',
      authenticationMethod: 'lti',
      mfa: false,
      createdAt: now - 1000,
      lastSeenAt: now,
      expiresAt: now + 600000,
      csrfToken: 'a'.repeat(43),
    },
    selection: { id: id(4), courseId: id(8), expiresAt: now + 600000 },
    sources: {
      sources: [
        {
          documentId: id(5),
          versionId: id(6),
          name: 'Synthetic.pdf',
          pageCount: 1,
          bytes: 100,
          inspection: 'approved',
          availability: 'not-checked',
        },
      ],
      nextCursor: null as string | null,
    },
    hook: undefined as
      | undefined
      | ((url: string, init: RequestInit) => Response | Promise<Response> | undefined),
  };
  const fetcher = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input),
      custom = state.hook?.(url, init);
    if (custom) return custom;
    const path = new URL(url).pathname;
    if (path === '/api/auth/session') return response(url, state.session);
    if (path === '/api/assignments/selection') return response(url, { selection: state.selection });
    if (path === '/api/assignments/sources') return response(url, state.sources);
    if (path === '/api/assignments' && init.method === 'POST') {
      const input = JSON.parse(String(init.body));
      return response(
        url,
        {
          assignment: {
            id: id(9),
            title: input.title,
            instructions: input.instructions,
            policy: input.policy,
            createdAt: new Date(now).toISOString(),
          },
        },
        201,
      );
    }
    throw new Error('Unexpected fixture path');
  });
  const client = createAssignmentAuthorClient({
    expectedOrigin: origin,
    fetch: fetcher,
    now: () => now,
    timeoutMs,
  });
  return { state, client, fetcher };
}
describe('verified teacher assignment browser client', () => {
  it('opens a current context without returning CSRF and rejects structural provenance', async () => {
    const h = harness(),
      context = await h.client.open();
    expect(context.session).not.toHaveProperty('csrfToken');
    expect(readAuthorContext(context)).toEqual(context);
    expect(() => readAuthorContext(structuredClone(context))).toThrow(/Verify/);
    h.client.dispose();
    expect(() => readAuthorContext(context)).toThrow(/Reopen/);
  });
  it('creates with session CSRF and prepares a native same-origin form without claiming publication', async () => {
    const h = harness();
    await h.client.open();
    expect(await h.client.sources()).toEqual(h.state.sources);
    const result = await h.client.create(draft(), id(10));
    const post = h.fetcher.mock.calls.find(([, init]) => init?.method === 'POST')!;
    expect(post[1]).toMatchObject({
      mode: 'same-origin',
      credentials: 'same-origin',
      cache: 'no-store',
      redirect: 'error',
      referrerPolicy: 'no-referrer',
      headers: { 'X-CSRF-Token': 'a'.repeat(43) },
    });
    expect(JSON.parse(String(post[1]!.body))).toEqual({ requestId: id(10), ...draft() });
    expect(await h.client.prepareReturn(result.id)).toEqual({
      action: `${origin}/api/assignments/selections/${id(4)}/return`,
      fields: { csrfToken: 'a'.repeat(43), assignmentId: id(9) },
    });
    expect(h.fetcher.mock.calls.some(([url]) => String(url).endsWith('/return'))).toBe(false);
  });
  it('allows explicit cancellation without creating an assignment', async () => {
    const h = harness();
    await h.client.open();
    expect((await h.client.prepareReturn(null)).fields.assignmentId).toBe('');
    expect(h.fetcher.mock.calls.every(([, init]) => init?.method === 'GET')).toBe(true);
  });
  it('requires a confirmed creation before selecting an assignment ID', async () => {
    const h = harness();
    await h.client.open();
    await expect(h.client.prepareReturn(id(9))).rejects.toMatchObject({
      code: 'assignment_unconfirmed',
    });
  });
  it.each(['userId', 'organizationId', 'sessionId'] as const)(
    'invalidates changed %s and prevents source release',
    async (field) => {
      const h = harness(),
        context = await h.client.open();
      h.state.session[field] = id(90);
      await expect(h.client.sources()).rejects.toMatchObject({ code: 'session_changed' });
      expect(() => readAuthorContext(context)).toThrow();
      expect(h.fetcher.mock.calls.some(([url]) => String(url).includes('/sources'))).toBe(false);
    },
  );
  it.each(['student', 'admin', 'viewer'])('rejects nonteacher role %s', async (role) => {
    const h = harness();
    h.state.session.role = role;
    await expect(h.client.open()).rejects.toMatchObject({ code: 'teacher_launch_required' });
  });
  it('rejects ordinary OIDC sign-in and a changed selection', async () => {
    const h = harness();
    h.state.session.authenticationMethod = 'oidc';
    await expect(h.client.open()).rejects.toMatchObject({ code: 'teacher_launch_required' });
    const next = harness(),
      context = await next.client.open();
    next.state.selection.id = id(90);
    await expect(next.client.sources()).rejects.toMatchObject({ code: 'selection_changed' });
    expect(() => readAuthorContext(context)).toThrow();
  });
  it('withholds completed catalog data after a session changes during delivery', async () => {
    const h = harness();
    await h.client.open();
    h.state.hook = (url) => {
      if (url.endsWith('/sources')) {
        h.state.session.userId = id(90);
        return response(url, h.state.sources);
      }
    };
    await expect(h.client.sources()).rejects.toMatchObject({ code: 'session_changed' });
  });
  it.each([401, 403, 408, 409, 500, 503])(
    'retains exact create request after ambiguous %i',
    async (status) => {
      const h = harness();
      await h.client.open();
      h.state.hook = (url, init) =>
        init.method === 'POST'
          ? response(
              url,
              { error: { code: 'synthetic_interruption', message: 'Synthetic interruption' } },
              status,
            )
          : undefined;
      await expect(h.client.create(draft(), id(10))).rejects.toMatchObject({
        uncertainCreate: true,
        status,
      });
      if (status !== 401 && status !== 403) {
        await expect(
          h.client.create({ ...draft(), title: 'Changed' }, id(11)),
        ).rejects.toMatchObject({ code: 'exact_retry_required' });
        await expect(h.client.prepareReturn(null)).rejects.toMatchObject({
          code: 'uncertain_create',
        });
        h.state.hook = undefined;
        expect((await h.client.create(draft(), id(10))).id).toBe(id(9));
        const posts = h.fetcher.mock.calls.filter(([, init]) => init?.method === 'POST');
        expect(posts[0][1]!.body).toBe(posts[1][1]!.body);
      }
    },
  );
  it('allows corrected input after a known precommit validation rejection', async () => {
    const h = harness();
    await h.client.open();
    h.state.hook = (url, init) =>
      init.method === 'POST'
        ? response(url, { error: { code: 'invalid_text', message: 'Invalid title' } }, 400)
        : undefined;
    await expect(h.client.create(draft(), id(10))).rejects.toMatchObject({
      uncertainCreate: false,
    });
    h.state.hook = undefined;
    await expect(
      h.client.create({ ...draft(), title: 'Corrected' }, id(11)),
    ).resolves.toMatchObject({ title: 'Corrected' });
  });
  it('keeps a committed create uncertain when its follow-up authority check is rate limited', async () => {
    const h = harness();
    await h.client.open();
    let posted = false;
    h.state.hook = (url, init) => {
      if (init.method === 'POST') posted = true;
      else if (posted) {
        h.state.hook = undefined;
        return response(url, { error: { code: 'rate_limited', message: 'Retry shortly.' } }, 429);
      }
    };
    await expect(h.client.create(draft(), id(10))).rejects.toMatchObject({
      status: 429,
      uncertainCreate: true,
    });
    await expect(h.client.prepareReturn(id(9))).rejects.toMatchObject({
      code: 'assignment_unconfirmed',
    });
    await expect(h.client.create({ ...draft(), title: 'Changed' }, id(11))).rejects.toMatchObject({
      code: 'exact_retry_required',
    });
    await expect(h.client.prepareReturn(null)).rejects.toMatchObject({ code: 'uncertain_create' });
    await expect(h.client.create(draft(), id(10))).resolves.toMatchObject({ id: id(9) });
    const posts = h.fetcher.mock.calls.filter(([, init]) => init?.method === 'POST');
    expect(posts).toHaveLength(2);
    expect(posts[0][1]!.body).toBe(posts[1][1]!.body);
    expect((await h.client.prepareReturn(id(9))).fields.assignmentId).toBe(id(9));
  });
  it.each(['before POST', 'during POST'])(
    'keeps earlier uncertainty when an exact retry is rate limited %s',
    async (stage) => {
      const h = harness();
      await h.client.open();
      h.state.hook = (_url, init) => {
        if (init.method === 'POST') throw new Error('Synthetic lost response after commit.');
        return undefined;
      };
      await expect(h.client.create(draft(), id(10))).rejects.toMatchObject({
        uncertainCreate: true,
      });
      h.state.hook = (url, init) =>
        stage === 'before POST' || init.method === 'POST'
          ? response(url, { error: { code: 'rate_limited', message: 'Retry shortly.' } }, 429)
          : undefined;
      await expect(h.client.create(draft(), id(10))).rejects.toMatchObject({
        status: 429,
        uncertainCreate: true,
      });
      h.state.hook = undefined;
      await expect(h.client.create({ ...draft(), title: 'Changed' }, id(11))).rejects.toMatchObject(
        { code: 'exact_retry_required' },
      );
      await expect(h.client.prepareReturn(null)).rejects.toMatchObject({
        code: 'uncertain_create',
      });
      await expect(h.client.create(draft(), id(10))).resolves.toMatchObject({ id: id(9) });
      const posts = h.fetcher.mock.calls.filter(([, init]) => init?.method === 'POST');
      expect(posts).toHaveLength(stage === 'before POST' ? 2 : 3);
      expect(new Set(posts.map(([, init]) => init?.body)).size).toBe(1);
    },
  );
  it('pins a valid assignment response ID even when its final authority verification fails', async () => {
    const h = harness();
    await h.client.open();
    let posted = false;
    h.state.hook = (url, init) => {
      if (init.method === 'POST') posted = true;
      else if (posted) {
        h.state.hook = undefined;
        return response(url, { error: { code: 'service_busy', message: 'Retry shortly.' } }, 503);
      }
    };
    await expect(h.client.create(draft(), id(10))).rejects.toMatchObject({
      status: 503,
      uncertainCreate: true,
    });
    h.state.hook = (url, init) =>
      init.method === 'POST'
        ? response(
            url,
            {
              assignment: {
                id: id(90),
                title: draft().title,
                instructions: draft().instructions,
                policy: draft().policy,
                createdAt: new Date(now).toISOString(),
              },
            },
            201,
          )
        : undefined;
    await expect(h.client.create(draft(), id(10))).rejects.toMatchObject({
      code: 'invalid_response',
      uncertainCreate: true,
    });
    for (const assignmentId of [id(9), id(90)])
      await expect(h.client.prepareReturn(assignmentId)).rejects.toMatchObject({
        code: 'assignment_unconfirmed',
      });
    h.state.hook = undefined;
    await expect(h.client.create(draft(), id(10))).resolves.toMatchObject({ id: id(9) });
    expect((await h.client.prepareReturn(id(9))).fields.assignmentId).toBe(id(9));
  });
  it('marks postcommit session replacement uncertain and withholds returned assignment', async () => {
    const h = harness();
    await h.client.open();
    h.state.hook = (url, init) => {
      if (init.method === 'POST') {
        h.state.session.userId = id(90);
        return response(
          url,
          {
            assignment: {
              id: id(9),
              title: draft().title,
              instructions: draft().instructions,
              policy: draft().policy,
              createdAt: new Date(now).toISOString(),
            },
          },
          201,
        );
      }
    };
    await expect(h.client.create(draft(), id(10))).rejects.toMatchObject({
      code: 'session_changed',
      uncertainCreate: true,
    });
    await expect(h.client.open()).rejects.toMatchObject({ code: 'session_invalidated' });
  });
  it('refuses mismatched successful payloads and changed duplicate IDs', async () => {
    const h = harness();
    await h.client.open();
    await h.client.create(draft(), id(10));
    h.state.hook = (url, init) =>
      init.method === 'POST'
        ? response(
            url,
            {
              assignment: {
                id: id(90),
                title: draft().title,
                instructions: draft().instructions,
                policy: draft().policy,
                createdAt: new Date(now).toISOString(),
              },
            },
            201,
          )
        : undefined;
    await expect(h.client.create(draft(), id(10))).rejects.toMatchObject({
      code: 'invalid_response',
      uncertainCreate: true,
    });
  });
  it.each([
    { bytes: 104857601 },
    { pageCount: 0 },
    { name: 'Bad\nfilename' },
    { inspection: 'pending' },
    { availability: 'ready' },
  ])('rejects malformed catalog metadata %j', async (patch) => {
    const h = harness();
    await h.client.open();
    Object.assign(h.state.sources.sources[0], patch);
    await expect(h.client.sources()).rejects.toMatchObject({ code: 'invalid_response' });
  });
  it('rejects duplicate source rows, overlong/repeated cursors and query injection', async () => {
    const h = harness();
    await h.client.open();
    h.state.sources.sources.push(h.state.sources.sources[0]);
    await expect(h.client.sources()).rejects.toMatchObject({ code: 'invalid_response' });
    h.state.sources.sources.pop();
    h.state.sources.nextCursor = 'abc';
    await expect(h.client.sources('abc')).rejects.toMatchObject({ code: 'invalid_response' });
    expect(() => h.client.sources('a&owner=other')).toThrow();
  });
  it('bounds stalled requests and explicit disposal', async () => {
    const h = harness(10);
    h.state.hook = () => new Promise<Response>(() => {});
    await expect(h.client.open()).rejects.toMatchObject({ code: 'timeout' });
    const second = harness();
    second.state.hook = () => new Promise<Response>(() => {});
    const pending = second.client.open();
    second.client.dispose();
    await expect(pending).rejects.toMatchObject({ code: 'session_invalidated' });
  });
  it('rejects insecure or credential-bearing origins', () => {
    for (const expectedOrigin of [
      'http://localhost',
      'https://u:p@margin.synthetic.test',
      'https://margin.synthetic.test/path',
    ])
      expect(() => createAssignmentAuthorClient({ expectedOrigin, fetch: fetch })).toThrow(
        AuthorClientError,
      );
    expect(() => readAuthorContext({} as AuthorContext)).toThrow(AuthorClientError);
  });
});
