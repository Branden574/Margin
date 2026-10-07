import { RequestScope, Transport } from '../assignment-work/transport';
import { AssignmentWorkClientError, REQUEST_TIMEOUT_MS } from '../assignment-work/types';
import { object } from '../assignment-work/decode';
import * as decode from './decode';
import {
  AuthorClientError,
  type AssignmentAuthorClient,
  type AuthorContext,
  type AuthorDraft,
  type AuthorAssignment,
  type AuthorSession,
  type RequestOptions,
} from './types';
export { AuthorClientError } from './types';
export type * from './types';

interface Dependencies {
  fetch?: typeof fetch;
  expectedOrigin?: string;
  now?: () => number;
  timeoutMs?: number;
}
const contexts = new WeakMap<AuthorContext, { data: AuthorContext; check: () => void }>();
/** Ephemeral provenance for encrypted drafts; never an authorization substitute on the server. */
export function readAuthorContext(context: AuthorContext): AuthorContext {
  const entry = contexts.get(context);
  if (!entry)
    throw new AuthorClientError(
      'verification_required',
      'Verify the current Canvas teacher launch first.',
    );
  entry.check();
  return structuredClone(entry.data);
}
const identity = (s: AuthorSession) =>
  JSON.stringify([
    s.sessionId,
    s.userId,
    s.organizationId,
    s.role,
    s.authenticationMethod,
    s.createdAt,
  ]);
class Client implements AssignmentAuthorClient {
  private readonly transport: Transport;
  private readonly origin: string;
  private readonly now: () => number;
  private readonly timeout: number;
  private readonly active = new Set<RequestScope>();
  private session: (AuthorSession & { csrfToken: string }) | null = null;
  private selection: AuthorContext['selection'] | null = null;
  private closed = false;
  private mutationActive = false;
  private attempt: {
    requestId: string;
    body: string;
    assignment?: AuthorAssignment;
    confirmed: boolean;
    uncertain: boolean;
  } | null = null;
  constructor(d: Dependencies) {
    const page = globalThis.location?.origin,
      expected = d.expectedOrigin ?? page;
    let parsed: URL;
    try {
      parsed = new URL(expected ?? '');
    } catch {
      throw new AuthorClientError(
        'invalid_origin',
        'Assignment setup requires the current HTTPS origin.',
      );
    }
    if (
      (!page && !d.fetch) ||
      (page && expected !== page) ||
      parsed.protocol !== 'https:' ||
      parsed.origin !== expected ||
      parsed.username ||
      parsed.password ||
      parsed.pathname !== '/' ||
      parsed.search ||
      parsed.hash
    )
      throw new AuthorClientError(
        'invalid_origin',
        'Assignment setup requires the current HTTPS origin.',
      );
    this.origin = parsed.origin;
    this.transport = new Transport(this.origin, d.fetch ?? globalThis.fetch.bind(globalThis));
    this.now = d.now ?? Date.now;
    this.timeout = d.timeoutMs ?? REQUEST_TIMEOUT_MS;
    if (
      !Number.isSafeInteger(this.timeout) ||
      this.timeout < 1 ||
      this.timeout > REQUEST_TIMEOUT_MS
    )
      throw new AuthorClientError('invalid_timeout', 'Invalid assignment setup deadline.');
  }
  dispose() {
    this.closed = true;
    this.session = null;
    this.selection = null;
    this.attempt = null;
    for (const scope of this.active)
      scope.controller.abort(
        new AuthorClientError('session_invalidated', 'Reopen assignment setup from Canvas.'),
      );
  }
  private bound() {
    if (this.closed)
      throw new AuthorClientError('session_invalidated', 'Reopen assignment setup from Canvas.');
    if (!this.session || !this.selection)
      throw new AuthorClientError(
        'selection_required',
        'Verify assignment setup before continuing.',
      );
    if (this.session.expiresAt <= this.now() || this.selection.expiresAt <= this.now()) {
      this.dispose();
      throw new AuthorClientError(
        'selection_expired',
        'This Canvas selection expired. Reopen assignment setup from Canvas.',
      );
    }
    return { session: this.session, selection: this.selection };
  }
  private async run<T>(
    options: RequestOptions,
    action: (scope: RequestScope, dispatched: () => void) => Promise<T>,
    uncertainty?: (sent: boolean) => boolean,
  ): Promise<T> {
    if (this.closed)
      throw new AuthorClientError('session_invalidated', 'Reopen assignment setup from Canvas.');
    if (this.active.size >= 4)
      throw new AuthorClientError(
        'client_busy',
        'Wait for the current assignment request to finish.',
      );
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
        reason instanceof AuthorClientError || reason instanceof AssignmentWorkClientError
          ? reason
          : new AuthorClientError(
              'network_error',
              'The assignment request could not be completed. Your saved draft is kept.',
            );
      if (
        e.status === 401 ||
        e.status === 403 ||
        [
          'teacher_launch_required',
          'session_changed',
          'selection_changed',
          'selection_expired',
          'session_expired',
        ].includes(e.code)
      )
        this.dispose();
      throw new AuthorClientError(e.code, e.message, e.status, uncertainty?.(sent) ?? false);
    } finally {
      scope.close();
      this.active.delete(scope);
    }
  }
  private async verifySession(scope: RequestScope) {
    const response = await this.transport.request(scope, '/api/auth/session', 200);
    const body = await this.transport.json(scope, response, 16384);
    let next: NonNullable<Client['session']>;
    try {
      next = decode.session(body, this.now());
    } catch (error) {
      this.dispose();
      throw error;
    }
    scope.check();
    if (
      this.session &&
      (identity(this.session) !== identity(next) || this.session.csrfToken !== next.csrfToken)
    ) {
      this.dispose();
      throw new AuthorClientError(
        'session_changed',
        'The signed-in teacher changed. Reopen assignment setup from Canvas.',
      );
    }
    if (this.closed)
      throw new AuthorClientError('session_invalidated', 'Reopen assignment setup from Canvas.');
    this.session = next;
  }
  private async verify(scope: RequestScope) {
    await this.verifySession(scope);
    const response = await this.transport.request(scope, '/api/assignments/selection', 200);
    const body = await this.transport.json(scope, response, 16384);
    let next: AuthorContext['selection'];
    try {
      next = decode.selection(body, this.now());
    } catch (error) {
      this.dispose();
      throw error;
    }
    scope.check();
    if (this.selection && JSON.stringify(this.selection) !== JSON.stringify(next)) {
      this.dispose();
      throw new AuthorClientError(
        'selection_changed',
        'The Canvas course selection changed. Reopen assignment setup.',
      );
    }
    this.selection = next;
    await this.verifySession(scope);
    return this.bound();
  }
  open(options: RequestOptions = {}) {
    return this.run(options, async (scope) => {
      const { session, selection } = await this.verify(scope);
      const { csrfToken: _, ...visible } = session;
      const data: AuthorContext = {
        origin: this.origin,
        session: structuredClone(visible),
        selection: structuredClone(selection),
      };
      const result = structuredClone(data),
        key = identity(session),
        selected = JSON.stringify(selection);
      Object.freeze(result.session);
      Object.freeze(result.selection);
      Object.freeze(result);
      contexts.set(result, {
        data,
        check: () => {
          const current = this.bound();
          if (identity(current.session) !== key || JSON.stringify(current.selection) !== selected)
            throw new AuthorClientError(
              'selection_changed',
              'Reopen assignment setup from Canvas.',
            );
        },
      });
      return result;
    });
  }
  sources(after?: string, options: RequestOptions = {}) {
    const path =
      '/api/assignments/sources' +
      (after === undefined ? '' : `?after=${encodeURIComponent(decode.cursor(after))}`);
    return this.run(options, async (scope) => {
      this.bound();
      await this.verify(scope);
      const response = await this.transport.request(scope, path, 200);
      const result = decode.sources(await this.transport.json(scope, response, 16384));
      if (after !== undefined && result.nextCursor === after) decode.invalid();
      await this.verify(scope);
      return result;
    });
  }
  async create(value: AuthorDraft, requestId: string, options: RequestOptions = {}) {
    const draft = decode.decodeAuthorDraft(value),
      id = decode.id(requestId),
      body = JSON.stringify({ requestId: id, ...draft });
    if (this.mutationActive)
      throw new AuthorClientError(
        'client_busy',
        'Wait for the current assignment request to finish.',
      );
    if (this.attempt && (this.attempt.requestId !== id || this.attempt.body !== body))
      throw new AuthorClientError(
        'exact_retry_required',
        'Retry the original saved assignment request before starting another.',
      );
    this.mutationActive = true;
    const priorUncertain = this.attempt?.uncertain ?? false;
    let definitivePostRejection = false;
    return this.run(
      options,
      async (scope, dispatched) => {
        this.bound();
        await this.verify(scope);
        this.attempt ??= { requestId: id, body, confirmed: false, uncertain: false };
        this.attempt.confirmed = false;
        dispatched();
        let response: Response;
        try {
          response = await this.transport.request(
            scope,
            '/api/assignments',
            201,
            body,
            this.bound().session.csrfToken,
          );
        } catch (error) {
          // Only a rejection of the POST itself can prove this attempt did not write.
          // A later failed verification, or an earlier uncertain attempt, cannot.
          if (error instanceof AssignmentWorkClientError || error instanceof AuthorClientError) {
            definitivePostRejection =
              (error.status === 400 &&
                [
                  'invalid_identifier',
                  'invalid_text',
                  'invalid_assignment',
                  'unknown_field',
                  'invalid_tools',
                  'invalid_policy',
                  'invalid_json',
                ].includes(error.code)) ||
              [413, 415, 422, 429].includes(error.status ?? 0);
          }
          throw error;
        }
        const envelope = object(await this.transport.json(scope, response, 65536), ['assignment']);
        const assignment = decode.decodeAuthorAssignment(envelope.assignment);
        if (
          assignment.title !== draft.title ||
          assignment.instructions !== draft.instructions ||
          JSON.stringify(assignment.policy) !== JSON.stringify(draft.policy) ||
          (this.attempt.assignment && this.attempt.assignment.id !== assignment.id)
        )
          decode.invalid();
        // Pin a valid response identity even when final authority verification fails.
        // It is not released to the UI or eligible for return until confirmed below.
        this.attempt.assignment = assignment;
        await this.verify(scope);
        if (!this.attempt || this.attempt.body !== body)
          throw new AuthorClientError(
            'session_invalidated',
            'Reopen assignment setup from Canvas.',
          );
        this.attempt.assignment = assignment;
        this.attempt.confirmed = true;
        this.attempt.uncertain = false;
        return structuredClone(assignment);
      },
      (sent) => priorUncertain || (sent && !definitivePostRejection),
    )
      .catch((error) => {
        if (
          error instanceof AuthorClientError &&
          error.uncertainCreate &&
          this.attempt?.body === body
        )
          this.attempt.uncertain = true;
        // Known validation/refusal before a successful response permits corrected input.
        // Unknown outcomes keep the exact payload/ID; changing it could create duplicates.
        if (
          error instanceof AuthorClientError &&
          !error.uncertainCreate &&
          error.status !== undefined &&
          error.status >= 400 &&
          error.status < 500 &&
          [400, 413, 415, 422, 429].includes(error.status) &&
          !this.attempt?.assignment
        )
          this.attempt = null;
        throw error;
      })
      .finally(() => {
        this.mutationActive = false;
      });
  }
  prepareReturn(assignmentId: string | null, options: RequestOptions = {}) {
    const id = assignmentId === null ? null : decode.id(assignmentId);
    return this.run(options, async (scope) => {
      this.bound();
      await this.verify(scope);
      if (id !== null && (!this.attempt?.confirmed || this.attempt.assignment?.id !== id))
        throw new AuthorClientError(
          'assignment_unconfirmed',
          'Confirm the saved assignment request before returning it to Canvas.',
        );
      if (this.mutationActive)
        throw new AuthorClientError('client_busy', 'Wait for assignment creation to finish.');
      if (id === null && this.attempt && !this.attempt.confirmed)
        throw new AuthorClientError(
          'uncertain_create',
          'Retry the saved assignment request before cancelling.',
        );
      const current = this.bound();
      return {
        action: `${this.origin}/api/assignments/selections/${current.selection.id}/return`,
        fields: { csrfToken: current.session.csrfToken, assignmentId: id ?? '' },
      };
    });
  }
}
export const createAssignmentAuthorClient = (
  dependencies: Dependencies = {},
): AssignmentAuthorClient => new Client(dependencies);
