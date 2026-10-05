import * as decode from './decode';
import { RequestScope, Transport } from './transport';
import {
  AssignmentWorkClientError,
  MAX_SOURCE_BYTES,
  REQUEST_TIMEOUT_MS,
  type AppendOperation,
  type AppendReceipt,
  type CatchUpResult,
  type RequestOptions,
  type StudentSession,
  type StudentWorkReservation,
  type WorkManifest,
} from './types';

/** Trusted construction dependencies, never populated from routes, documents, or server JSON.
 * In a browser expectedOrigin must equal location.origin. A non-browser test must supply both
 * expectedOrigin and fetch. No API method accepts a URL, student ID or assignment ID as authority.
 */
export interface ClientDependencies {
  fetch?: typeof fetch;
  expectedOrigin?: string;
  now?: () => number;
  timeoutMs?: number;
}
export interface AssignmentWorkClient {
  currentSession(options?: RequestOptions): Promise<StudentSession>;
  manifest(options?: RequestOptions): Promise<WorkManifest>;
  reserve(options?: RequestOptions): Promise<StudentWorkReservation>;
  source(options?: RequestOptions): Promise<Blob>;
  append(value: AppendOperation, options?: RequestOptions): Promise<AppendReceipt>;
  catchUp(
    input?: { afterCursor?: number; limit?: number },
    options?: RequestOptions,
  ): Promise<CatchUpResult>;
  /** Permanently clear this binding and abort active calls. Construct a new client after a new launch. */
  invalidate(): void;
  dispose(): void;
}
const error = (code: string, message: string) => new AssignmentWorkClientError(code, message);
const clone = <T>(value: T): T => structuredClone(value);
const identity = (s: StudentSession) =>
  JSON.stringify([
    s.sessionId,
    s.organizationId,
    s.userId,
    s.role,
    s.authenticationMethod,
    s.createdAt,
  ]);
const publicSession = (s: StudentSession & { csrfToken: string }): StudentSession => {
  const { csrfToken: _, ...visible } = s;
  return visible;
};

class Client implements AssignmentWorkClient {
  private readonly transport: Transport;
  private readonly now: () => number;
  private readonly timeout: number;
  private readonly active = new Set<RequestScope>();
  private session: (StudentSession & { csrfToken: string }) | null = null;
  private view: WorkManifest | null = null;
  private reserved: StudentWorkReservation | null = null;
  private closed = false;
  private sourceActive = false;
  private manifestTail: Promise<void> = Promise.resolve();
  constructor(dependencies: ClientDependencies) {
    const pageOrigin = globalThis.location?.origin;
    const expected = dependencies.expectedOrigin ?? pageOrigin;
    if (
      !expected ||
      (!pageOrigin && !dependencies.fetch) ||
      (pageOrigin && expected !== pageOrigin)
    )
      throw error(
        'invalid_origin',
        'Assignment requests require the current HTTPS application origin.',
      );
    const origin = new URL(expected);
    if (
      origin.protocol !== 'https:' ||
      origin.username ||
      origin.password ||
      origin.search ||
      origin.hash ||
      origin.pathname !== '/' ||
      origin.origin !== expected
    )
      throw error(
        'invalid_origin',
        'Assignment requests require the current HTTPS application origin.',
      );
    this.transport = new Transport(
      origin.origin,
      dependencies.fetch ?? globalThis.fetch.bind(globalThis),
    );
    this.now = dependencies.now ?? Date.now;
    this.timeout = dependencies.timeoutMs ?? REQUEST_TIMEOUT_MS;
    if (
      !Number.isSafeInteger(this.timeout) ||
      this.timeout < 1 ||
      this.timeout > REQUEST_TIMEOUT_MS
    )
      throw error('invalid_timeout', 'The assignment request deadline is invalid.');
  }
  invalidate() {
    this.closed = true;
    this.session = null;
    this.view = null;
    this.reserved = null;
    for (const scope of this.active)
      scope.controller.abort(
        error(
          'session_invalidated',
          'This assignment session was invalidated. Reopen it from Canvas.',
        ),
      );
  }
  dispose() {
    this.invalidate();
  }
  private bound() {
    if (this.closed)
      throw error(
        'session_invalidated',
        'This assignment session was invalidated. Reopen it from Canvas.',
      );
    if (!this.session)
      throw error('session_required', 'Verify the current Canvas student session first.');
    if (this.session.expiresAt <= this.now()) {
      this.invalidate();
      throw error('session_expired', 'This Canvas session has expired. Reopen it from Canvas.');
    }
    return this.session;
  }
  private manifestRequired(ready = false): WorkManifest {
    this.bound();
    if (!this.view) throw error('manifest_required', 'Read the current assignment manifest first.');
    if (ready && this.view.work?.status !== 'provisioned')
      throw error('work_pending', 'The private assignment document is not provisioned yet.');
    return clone(this.view);
  }
  private async run<T>(
    options: RequestOptions,
    action: (scope: RequestScope, dispatched: () => void) => Promise<T>,
    operationId?: string,
  ): Promise<T> {
    if (this.closed)
      throw error(
        'session_invalidated',
        'This assignment session was invalidated. Reopen it from Canvas.',
      );
    if (this.active.size >= 8)
      throw error('client_busy', 'Too many assignment requests are already active.');
    const scope = new RequestScope(this.timeout, options.signal);
    this.active.add(scope);
    let sent = false;
    try {
      scope.check();
      const result = await action(scope, () => {
        scope.check();
        sent = true;
      });
      scope.check();
      return result;
    } catch (reason) {
      const e =
        reason instanceof AssignmentWorkClientError
          ? reason
          : error('network_error', 'The assignment request could not be completed.');
      if (e.status === 401 || e.status === 403) this.invalidate();
      throw new AssignmentWorkClientError(
        e.code,
        e.message,
        e.status,
        sent &&
          (e.status === undefined ||
            e.status >= 500 ||
            e.status === 408 ||
            e.code === 'work_request_cancelled'),
        operationId,
      );
    } finally {
      scope.close();
      this.active.delete(scope);
    }
  }
  private async verify(scope: RequestScope) {
    const response = await this.transport.request(scope, '/api/auth/session', 200);
    // Interrupted or truncated transport data does not establish a replacement
    // session. Leave the existing binding unchanged until a complete body decodes.
    const value = await this.transport.json(scope, response, 16_384);
    let next: StudentSession & { csrfToken: string };
    try {
      next = decode.session(value, this.now());
    } catch (e) {
      this.invalidate();
      throw e;
    }
    scope.check();
    if (
      this.session &&
      (identity(this.session) !== identity(next) || this.session.csrfToken !== next.csrfToken)
    ) {
      this.invalidate();
      throw error(
        'session_changed',
        'The signed-in Canvas student changed. Reopen the assignment before continuing.',
      );
    }
    this.session = next;
    return publicSession(next);
  }
  currentSession(options: RequestOptions = {}) {
    return this.run(options, (scope) => this.verify(scope));
  }
  private accept(
    next: WorkManifest,
    minimumCursor: number,
    reservationAtStart: StudentWorkReservation | null,
  ) {
    const previous = this.view;
    const fail = () => {
      this.invalidate();
      throw error(
        'work_changed',
        'The assignment or private document changed. Reopen it from Canvas.',
      );
    };
    if (
      previous &&
      (previous.assignment.id !== next.assignment.id ||
        JSON.stringify(previous.assignment) !== JSON.stringify(next.assignment))
    )
      fail();
    if (previous?.work && (!next.work || previous.work.id !== next.work.id)) fail();
    if (previous?.work?.status === 'provisioned') {
      if (next.work?.status !== 'provisioned') fail();
      const old = previous.work.document,
        fresh = next.work?.status === 'provisioned' ? next.work.document : undefined;
      if (
        !fresh ||
        old.documentId !== fresh.documentId ||
        old.versionId !== fresh.versionId ||
        JSON.stringify(old.pages) !== JSON.stringify(fresh.pages) ||
        fresh.cursor < minimumCursor
      )
        fail();
      if (fresh) fresh.cursor = Math.max(fresh.cursor, old.cursor);
    }
    if (this.reserved && !next.work) {
      // Reservation may have committed while this GET was reading an earlier snapshot.
      // Never erase the new binding or invalidate the account for that valid race.
      if (!reservationAtStart)
        throw error('stale_response', 'Assignment work changed while loading. Refresh it again.');
      fail();
    }
    if (this.reserved && next.work) {
      if (this.reserved.id !== next.work.id) fail();
      if (
        next.work.status === 'provisioned' &&
        (this.reserved.documentId !== next.work.document.documentId ||
          this.reserved.versionId !== next.work.document.versionId)
      )
        fail();
    }
    this.view = clone(next);
  }
  manifest(options: RequestOptions = {}) {
    const preceding = this.manifestTail;
    const result = this.run(options, async (scope) => {
      // Serialize only manifest snapshots. Queue waiting shares the request deadline,
      // and annotation appends/catch-up remain independent of this queue.
      await scope.wait(preceding);
      scope.check();
      const minimumCursor =
        this.view?.work?.status === 'provisioned' ? this.view.work.document.cursor : 0;
      const reservationAtStart = this.reserved;
      await this.verify(scope);
      const response = await this.transport.request(scope, '/api/assignments/work', 200);
      const next = decode.manifest(await this.transport.json(scope, response));
      await this.verify(scope);
      this.accept(next, minimumCursor, reservationAtStart);
      return clone(next);
    });
    // A cancelled waiter cannot release subsequent calls before the earlier reader.
    this.manifestTail = Promise.all([
      preceding,
      result.then(
        () => {},
        () => {},
      ),
    ]).then(() => {});
    return result;
  }
  async reserve(options: RequestOptions = {}) {
    const m = this.manifestRequired(),
      s = this.bound();
    return this.run(options, async (scope, dispatched) => {
      dispatched();
      const response = await this.transport.request(
        scope,
        '/api/assignments/work',
        202,
        '{}',
        s.csrfToken,
      );
      const r = decode.reservation(await this.transport.json(scope, response, 16_384), m, s.userId);
      scope.check();
      if (
        this.reserved &&
        (this.reserved.id !== r.id ||
          this.reserved.documentId !== r.documentId ||
          this.reserved.versionId !== r.versionId)
      ) {
        this.invalidate();
        throw error(
          'work_changed',
          'The private assignment document changed. Reopen it from Canvas.',
        );
      }
      this.reserved = clone(r);
      return r;
    });
  }
  async source(options: RequestOptions = {}) {
    const m = this.manifestRequired(true),
      p = m.assignment.policy;
    if (p.assessment || !p.allowExport || !p.allowCopyPaste || !p.allowReadAloud)
      throw error(
        'restricted_delivery_unavailable',
        'Original PDF delivery is unavailable under this assignment policy.',
      );
    if (this.sourceActive)
      throw error('client_busy', 'The assignment source is already being retrieved.');
    this.sourceActive = true;
    try {
      return await this.run(options, async (scope) => {
        await this.verify(scope);
        const response = await this.transport.request(scope, '/api/assignments/work/source', 200);
        if (!/^application\/pdf\s*$/i.test(response.headers.get('content-type') ?? '')) {
          void response.body?.cancel().catch(() => {});
          throw error('invalid_response', 'The assignment source is not a PDF.');
        }
        const bytes = await this.transport.bytes(scope, response, MAX_SOURCE_BYTES);
        try {
          if (
            !/^%PDF-(?:1\.[0-7]|2\.0)$/.test(new TextDecoder('ascii').decode(bytes.subarray(0, 8)))
          )
            throw error('invalid_response', 'The assignment source has an invalid PDF signature.');
          await this.verify(scope);
          return new Blob([bytes], { type: 'application/pdf' });
        } finally {
          bytes.fill(0);
        }
      });
    } finally {
      this.sourceActive = false;
    }
  }
  async append(value: AppendOperation, options: RequestOptions = {}) {
    let input: AppendOperation;
    try {
      input = decode.operation(value);
    } catch {
      throw error(
        'invalid_operation',
        'This edit is not supported by the assignment protocol. Keep it locally.',
      );
    }
    const m = this.manifestRequired(true),
      s = this.bound();
    try {
      decode.boundOperation(input, m);
    } catch {
      throw new AssignmentWorkClientError(
        'work_mismatch',
        'This edit does not belong to the current assignment document.',
        undefined,
        false,
        input.operationId,
      );
    }
    const tool = input.kind === 'delete' ? 'eraser' : input.annotation!.type;
    if (!m.assignment.policy.allowedTools.includes(tool))
      throw new AssignmentWorkClientError(
        'assignment_tool_disabled',
        'This tool is disabled for the assignment. Keep the edit locally.',
        undefined,
        false,
        input.operationId,
      );
    const body = JSON.stringify(input),
      known = m.work?.status === 'provisioned' ? m.work.document.cursor : 0;
    return this.run(
      options,
      async (scope, dispatched) => {
        dispatched();
        const response = await this.transport.request(
          scope,
          '/api/assignments/work/operations',
          200,
          body,
          s.csrfToken,
        );
        const result = decode.receipt(
          await this.transport.json(scope, response, 16_384),
          input,
          known,
        );
        this.advance(result.cursor);
        return result;
      },
      input.operationId,
    );
  }
  private advance(position: number) {
    if (this.view?.work?.status === 'provisioned')
      this.view.work.document.cursor = Math.max(position, this.view.work.document.cursor);
  }
  async catchUp(
    input: { afterCursor?: number; limit?: number } = {},
    options: RequestOptions = {},
  ) {
    const m = this.manifestRequired(true),
      s = this.bound();
    const values = decode.object(input, ['afterCursor', 'limit']);
    const after = decode.cursor(values.afterCursor ?? 0),
      limit = values.limit ?? 50;
    if (!Number.isInteger(limit) || (limit as number) < 1 || (limit as number) > 100)
      throw error('invalid_request', 'Request between one and 100 assignment operations.');
    const known = m.work?.status === 'provisioned' ? m.work.document.cursor : 0;
    return this.run(options, async (scope) => {
      const response = await this.transport.request(
        scope,
        `/api/assignments/work/operations?afterCursor=${after}&limit=${limit}`,
        200,
      );
      const result = decode.catchUp(
        await this.transport.json(scope, response),
        m,
        s.userId,
        after,
        limit as number,
        known,
      );
      this.advance(result.currentCursor);
      return result;
    });
  }
}
/** No persistence, queue, retry, logging, local-vault adoption, or Canvas submission occurs here. */
export function createAssignmentWorkClient(
  testDependencies: ClientDependencies = {},
): AssignmentWorkClient {
  return new Client(testDependencies);
}
