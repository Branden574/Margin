import 'fake-indexeddb/auto';
import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { openDB } from 'idb';
import { FeedbackClient } from '../apps/web/src/lib/assignment-feedback/client';
import { FeedbackController } from '../apps/web/src/lib/assignment-feedback/controller';
import { content } from '../apps/web/src/lib/assignment-feedback/decode';
import type {
  FeedbackCapture,
  FeedbackCommand,
  TeacherFeedback,
  SaveFeedbackInput,
  ReleaseFeedbackInput,
} from '../apps/api/src/assignments/feedback/types';
import {
  createVault,
  lockVault,
  unlockVault,
  VAULT_DATABASE,
  vaultStatus,
} from '../apps/web/src/lib/vault';

const id = (n: number) => `70000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const origin = 'https://feedback.synthetic.test',
  now = 1800000000000,
  password = 'synthetic feedback vault passphrase';
const capture: FeedbackCapture = {
  submissionId: id(1),
  snapshotPin: 'a'.repeat(64),
  documentId: id(2),
  versionId: id(3),
  frozenCursor: 3,
  frozenAt: new Date(now - 5000).toISOString(),
  pages: [{ id: id(4), index: 0, width: 612, height: 792 }],
  source: { sha256: 'b'.repeat(64), bytes: 2000, mimeType: 'application/pdf' },
};
const controllers: FeedbackController[] = [],
  clients: FeedbackClient[] = [];
function fixture() {
  const server: TeacherFeedback = {
    capture: structuredClone(capture),
    revision: 0,
    savedAt: null,
    content: { comment: '', annotations: [] },
    released: null,
  };
  const session = {
    authenticated: true,
    sessionId: id(5),
    userId: id(6),
    organizationId: id(7),
    role: 'teacher',
    authenticationMethod: 'lti',
    mfa: false,
    createdAt: now - 10000,
    lastSeenAt: now - 1000,
    expiresAt: now + 100000,
    csrfToken: 'c'.repeat(43),
  };
  const commands = new Map<string, FeedbackCommand>(),
    writes: Array<{ method: string; body: string }> = [],
    gets: string[] = [];
  let loseNext = false,
    rejectNext = false,
    lookupDenied = false,
    afterRead: (() => void) | null = null,
    tamperCommand = false;
  const response = (url: string, value: unknown, status = 200) => {
    const result = new Response(JSON.stringify(value), {
      status,
      headers: { 'content-type': 'application/json' },
    });
    Object.defineProperty(result, 'url', { value: url });
    return result;
  };
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input),
      path = new URL(url).pathname;
    expect(init?.credentials).toBe('same-origin');
    expect(init?.redirect).toBe('error');
    expect(init?.cache).toBe('no-store');
    if (path === '/api/auth/session') return response(url, session);
    const method = init?.method ?? 'GET';
    if (method === 'GET') {
      gets.push(path);
      if (path.includes('/commands/')) {
        if (lookupDenied)
          return response(
            url,
            { error: { code: 'feedback_unavailable', message: 'No longer authorized.' } },
            404,
          );
        const outcome = commands.get(path.split('/').at(-1)!);
        return outcome
          ? response(url, outcome)
          : response(
              url,
              { error: { code: 'feedback_command_not_found', message: 'Command not found.' } },
              404,
            );
      }
      const value = path.includes('/work/')
        ? { capture: server.capture, released: server.released }
        : structuredClone(server);
      afterRead?.();
      afterRead = null;
      return response(url, value);
    }
    expect(new Headers(init?.headers).get('X-CSRF-Token')).toBe(session.csrfToken);
    const body = String(init?.body);
    writes.push({ method, body });
    const command = JSON.parse(body) as SaveFeedbackInput | ReleaseFeedbackInput,
      action = method === 'PUT' ? 'save' : 'release';
    const found = commands.get(command.requestId);
    if (found) return response(url, found, found.state === 'rejected' ? 409 : 200);
    const rejected = rejectNext || command.expectedRevision !== server.revision;
    rejectNext = false;
    if (!rejected) {
      if (action === 'save') {
        server.revision++;
        server.savedAt = new Date(now).toISOString();
        server.content = content((command as SaveFeedbackInput).content, capture);
      } else
        server.released = {
          revision: server.revision,
          releasedAt: new Date(now + 100).toISOString(),
          content: structuredClone(server.content),
        };
    }
    const outcome: FeedbackCommand = {
      requestId: command.requestId,
      action,
      expectedRevision: command.expectedRevision,
      snapshotPin: command.snapshotPin,
      state: rejected ? 'rejected' : 'accepted',
      revision: server.revision,
      code: rejected ? 'revision_changed' : null,
      savedAt: server.savedAt,
      releasedAt: server.released?.releasedAt ?? null,
    };
    commands.set(command.requestId, outcome);
    if (loseNext) {
      loseNext = false;
      throw new TypeError('Synthetic lost acknowledgement');
    }
    return response(
      url,
      tamperCommand ? { ...outcome, requestId: id(999) } : outcome,
      rejected ? 409 : 200,
    );
  };
  const client = (role: 'teacher' | 'student' = 'teacher') => {
    const c = new FeedbackClient(role, capture.submissionId, {
      fetch: fetcher,
      expectedOrigin: origin,
      now: () => now,
    });
    clients.push(c);
    return c;
  };
  const controller = () => {
    const c = new FeedbackController(client(), capture);
    controllers.push(c);
    return c;
  };
  return {
    server,
    session,
    commands,
    writes,
    gets,
    client,
    controller,
    lose: () => {
      loseNext = true;
    },
    reject: () => {
      rejectNext = true;
    },
    denyLookup: () => {
      lookupDenied = true;
    },
    switchAfterRead: () => {
      afterRead = () => {
        session.userId = id(800);
      };
    },
    tamper: () => {
      tamperCommand = true;
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
  await createVault(password);
});
afterEach(async () => {
  controllers.splice(0).forEach((c) => c.dispose());
  clients.splice(0).forEach((c) => c.dispose());
  await lockVault();
});

describe('authenticated feedback and exact draft recovery', () => {
  it('encrypts local drafts, saves privately, explicitly returns, and keeps later drafts private', async () => {
    const f = fixture(),
      c = f.controller();
    await c.open();
    c.edit({ comment: 'Private teacher feedback', annotations: [] });
    await c.flush();
    const db = await openDB(VAULT_DATABASE, 1),
      raw = JSON.stringify(await db.getAll('records'));
    db.close();
    expect(raw).not.toContain('Private teacher feedback');
    expect(raw).not.toContain(f.session.userId);
    await c.save();
    expect(f.writes[0].method).toBe('PUT');
    expect(f.server.released).toBeNull();
    expect(c.getState().dirty).toBe(false);
    await c.release();
    expect(f.writes[1].method).toBe('POST');
    expect(f.server.released?.content.comment).toBe('Private teacher feedback');
    c.edit({ comment: 'Private later draft', annotations: [] });
    await c.flush();
    await c.save();
    f.session.role = 'student';
    const student = await f.client('student').student();
    expect(student.released?.content.comment).toBe('Private teacher feedback');
    expect(JSON.stringify(student)).not.toContain('Private later draft');
    expect(student).not.toHaveProperty('content');
  });
  it('recovers an accepted lost acknowledgement after lock/reload without a replacement write', async () => {
    const f = fixture(),
      c = f.controller();
    await c.open();
    c.edit({ comment: 'Keep this exact request', annotations: [] });
    await c.flush();
    f.lose();
    await c.save();
    expect(c.getState().pending).toBe(true);
    const exact = f.writes[0].body;
    c.dispose();
    await lockVault();
    await unlockVault(password);
    const reopened = f.controller();
    await reopened.open();
    expect(reopened.getState().pending).toBe(true);
    await reopened.recover();
    expect(reopened.getState().pending).toBe(false);
    expect(reopened.getState().content.comment).toBe('Keep this exact request');
    expect(f.writes).toHaveLength(1);
    expect(f.gets.some((p) => p.endsWith(JSON.parse(exact).requestId))).toBe(true);
  });
  it('recovers a rejected lost acknowledgement served with HTTP 200 and retains the local draft', async () => {
    const f = fixture(),
      c = f.controller();
    await c.open();
    c.edit({ comment: 'Keep rejected local content', annotations: [] });
    await c.flush();
    f.reject();
    f.lose();
    await c.save();
    expect(c.getState().pending).toBe(true);
    await c.recover();
    expect(c.getState().pending).toBe(false);
    expect(c.getState().conflict).toBe(true);
    expect(c.getState().content.comment).toBe('Keep rejected local content');
    expect(f.writes).toHaveLength(1);
  });
  it('replays only the persisted request after confirmed command-not-found', async () => {
    const f = fixture(),
      c = f.controller();
    await c.open();
    c.edit({ comment: 'Exact replay', annotations: [] });
    await c.flush();
    f.lose();
    await c.save();
    const request = JSON.parse(f.writes[0].body);
    f.commands.clear();
    f.server.revision = 0;
    f.server.savedAt = null;
    f.server.content = { comment: '', annotations: [] };
    await c.recover();
    expect(f.writes).toHaveLength(2);
    expect(JSON.parse(f.writes[1].body)).toEqual(request);
    expect(c.getState().pending).toBe(false);
  });
  it('does not resend when lookup 404 means feedback authorization is unavailable', async () => {
    const f = fixture(),
      c = f.controller();
    await c.open();
    c.edit({ comment: 'No access replay', annotations: [] });
    await c.flush();
    f.lose();
    await c.save();
    f.denyLookup();
    await c.recover();
    expect(f.writes).toHaveLength(1);
    expect(c.getState().pending).toBe(true);
    expect(c.getState().error).toContain('authorized');
  });
  it('clears sensitive display when identity changes during a read and never grants teacher writes to a student', async () => {
    const f = fixture(),
      c = f.controller();
    await c.open();
    c.edit({ comment: 'Private original author', annotations: [] });
    await c.flush();
    f.switchAfterRead();
    await c.save();
    expect(c.getState().invalidated).toBe(true);
    expect(c.getState().content.comment).toBe('');
    expect(c.getState().server).toBeNull();
    expect(f.writes).toHaveLength(0);
    f.session.role = 'student';
    const next = f.controller();
    await next.open();
    expect(next.getState().invalidated).toBe(true);
    expect(f.writes).toHaveLength(0);
  });
  it('isolates drafts by signed-in user and rejects concurrent-tab overwrites', async () => {
    const f = fixture(),
      first = f.controller();
    await first.open();
    const second = f.controller();
    await second.open();
    first.edit({ comment: 'First tab private draft', annotations: [] });
    await first.flush();
    second.edit({ comment: 'Stale tab edit', annotations: [] });
    await expect(second.flush()).rejects.toThrow('unsaved');
    expect(second.getState().conflict).toBe(true);
    f.session.userId = id(900);
    const other = f.controller();
    await other.open();
    expect(other.getState().content.comment).toBe('');
  });
  it('refuses tampered command acknowledgements and keeps the exact pending request recoverable', async () => {
    const f = fixture(),
      c = f.controller();
    await c.open();
    c.edit({ comment: 'Tampered acknowledgement', annotations: [] });
    await c.flush();
    f.tamper();
    await c.save();
    expect(c.getState().pending).toBe(true);
    await c.recover();
    expect(c.getState().pending).toBe(false);
    expect(f.writes).toHaveLength(1);
  });
  it('rejects marks on another page or outside the captured geometry', () => {
    const annotation = {
      id: id(20),
      pageIndex: 0,
      type: 'rectangle',
      x: 600,
      y: 20,
      width: 50,
      height: 20,
      color: '#123456',
      strokeWidth: 1,
      opacity: 1,
      createdAt: now,
      author: 'Teacher',
    };
    expect(() => content({ comment: '', annotations: [annotation] }, capture)).toThrow();
    expect(() =>
      content({ comment: '', annotations: [{ ...annotation, x: 20, pageIndex: 1 }] }, capture),
    ).toThrow();
    expect(() =>
      content(
        {
          comment: '',
          annotations: [
            { ...annotation, x: 20 },
            { ...annotation, x: 30 },
          ],
        },
        capture,
      ),
    ).toThrow();
  });
});
