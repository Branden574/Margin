import type { Annotation } from '@margin/core';
import { session as decodeSession } from '../assignment-author/decode';
import type { AuthorSession } from '../assignment-author/types';
import { RequestScope, Transport } from '../assignment-work/transport';
import { createVaultGuard, onVaultLock } from '../vault';
import * as decode from './decode';
import {
  MAX_REVIEW_BYTES,
  MAX_REVIEW_CHUNK_BYTES,
  MAX_REVIEW_SOURCE_BYTES,
  REVIEW_TIMEOUT_MS,
  ReviewClientError,
  type ReviewContext,
  type ReviewData,
  type ReviewLoadOptions,
  type ReviewOptions,
  type ReviewPage,
  type ReviewSnapshot,
} from './types';

export interface ReviewClientDependencies {
  fetch?: typeof fetch;
  expectedOrigin?: string;
  now?: () => number;
  timeoutMs?: number;
}
export interface VerifiedReviewSnapshot {
  readonly kind: 'verified-teacher-review';
}
interface ProofRecord {
  data: ReviewData | null;
  check: () => void;
}
const proofs = new WeakMap<object, ProofRecord>();
const failure = (code: string, message: string) => new ReviewClientError(code, message);
/** A structural object is never provenance. Checking does not clone the retained annotation array. */
export function assertVerifiedReviewSnapshot(proof: VerifiedReviewSnapshot): void {
  const record = proofs.get(proof);
  if (!record?.data) throw failure('verification_required', 'Open the retained submission again.');
  record.check();
}
/** Read once for the view. Consumers must clear their own view/object URLs on invalidation. */
export function readVerifiedReviewSnapshot(proof: VerifiedReviewSnapshot): ReviewData {
  assertVerifiedReviewSnapshot(proof);
  return structuredClone(proofs.get(proof)!.data!);
}
export interface AssignmentReviewClient {
  loadContext(options?: ReviewOptions): Promise<ReviewContext>;
  revalidateSelection(options?: ReviewOptions): Promise<ReviewContext>;
  list(input?: { after?: string }, options?: ReviewOptions): Promise<ReviewPage>;
  loadSubmission(
    submissionId: string,
    options?: ReviewLoadOptions,
  ): Promise<VerifiedReviewSnapshot>;
  clearSelection(): void;
  subscribeInvalidation(listener: (reason: string, message?: string) => void): () => void;
  dispose(): void;
}
const identity = (s: AuthorSession & { csrfToken: string }) =>
  JSON.stringify([
    s.sessionId,
    s.organizationId,
    s.userId,
    s.role,
    s.authenticationMethod,
    s.createdAt,
    s.csrfToken,
  ]);
const digest = async (bytes: Uint8Array<ArrayBuffer>, scope: RequestScope) =>
  [...new Uint8Array(await scope.wait(crypto.subtle.digest('SHA-256', bytes)))]
    .map((n) => n.toString(16).padStart(2, '0'))
    .join('');

class Client implements AssignmentReviewClient {
  private readonly transport: Transport;
  private readonly now: () => number;
  private readonly timeout: number;
  private readonly vaultGuard: () => void;
  private readonly removeLock: () => void;
  private readonly active = new Set<RequestScope>();
  private readonly listeners = new Set<(reason: string, message?: string) => void>();
  private session: (AuthorSession & { csrfToken: string }) | null = null;
  private context: ReviewContext | null = null;
  private selection = 0;
  private readonly selectionScopes = new Set<RequestScope>();
  private proof: ProofRecord | null = null;
  private closed = false;
  private expiryTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly knownSubmissions = new Map<string, ReviewSnapshot['submission']>();
  private readonly knownSnapshots = new Map<string, string>();
  constructor(dependencies: ReviewClientDependencies) {
    const pageOrigin = globalThis.location?.origin,
      expected = dependencies.expectedOrigin ?? pageOrigin;
    if (
      !expected ||
      (!pageOrigin && !dependencies.fetch) ||
      (pageOrigin && expected !== pageOrigin)
    )
      throw failure('invalid_origin', 'Review requires the current HTTPS application origin.');
    let url: URL;
    try {
      url = new URL(expected);
    } catch {
      throw failure('invalid_origin', 'Review requires the current HTTPS application origin.');
    }
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== '/' ||
      url.origin !== expected
    )
      throw failure('invalid_origin', 'Review requires the current HTTPS application origin.');
    const fetcher = dependencies.fetch ?? globalThis.fetch.bind(globalThis);
    this.transport = new Transport(expected, (input, init) => {
      const headers = new Headers(init?.headers);
      headers.set(
        'Accept',
        new URL(String(input)).pathname.endsWith('/source')
          ? 'application/pdf'
          : 'application/json',
      );
      return fetcher(input, { ...init, headers });
    });
    this.now = dependencies.now ?? Date.now;
    this.timeout = dependencies.timeoutMs ?? REVIEW_TIMEOUT_MS;
    if (!Number.isSafeInteger(this.timeout) || this.timeout < 1 || this.timeout > REVIEW_TIMEOUT_MS)
      throw failure('invalid_timeout', 'The review deadline is invalid.');
    this.vaultGuard = createVaultGuard();
    this.removeLock = onVaultLock(() => this.invalidate('vault_locked'));
  }
  subscribeInvalidation(listener: (reason: string, message?: string) => void) {
    if (this.closed) listener('session_invalidated');
    else this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  private clearProof() {
    if (this.proof) {
      if (this.proof.data) this.proof.data.annotations.length = 0;
      this.proof.data = null;
      this.proof = null;
    }
  }
  clearSelection() {
    this.selection++;
    for (const scope of this.selectionScopes)
      scope.controller.abort(failure('selection_changed', 'A different submission was selected.'));
    this.selectionScopes.clear();
    this.clearProof();
  }
  private invalidate(reason: string, message?: string) {
    if (this.closed) return;
    this.closed = true;
    this.clearSelection();
    this.session = null;
    this.context = null;
    this.knownSubmissions.clear();
    this.knownSnapshots.clear();
    clearTimeout(this.expiryTimer);
    this.removeLock();
    for (const scope of this.active)
      scope.controller.abort(failure(reason, 'Review ended. Reopen this assignment from Canvas.'));
    for (const listener of this.listeners) {
      try {
        if (message) listener(reason, message);
        else listener(reason);
      } catch {
        /* UI observers cannot prevent teardown. */
      }
    }
    this.listeners.clear();
  }
  dispose() {
    this.invalidate('session_invalidated');
  }
  private check() {
    if (this.closed)
      throw failure('session_invalidated', 'Review ended. Reopen this assignment from Canvas.');
    try {
      this.vaultGuard();
    } catch {
      this.invalidate('vault_locked');
      throw failure('vault_locked', 'Unlock the workspace and reopen this assignment from Canvas.');
    }
    if (this.session && this.session.expiresAt <= this.now()) {
      this.invalidate('session_expired');
      throw failure(
        'session_expired',
        'This Canvas session expired. Reopen the assignment from Canvas.',
      );
    }
  }
  private async run<T>(
    options: ReviewOptions,
    action: (scope: RequestScope) => Promise<T>,
  ): Promise<T> {
    this.check();
    if (this.active.size >= 4)
      throw failure('client_busy', 'Wait for the current review request to finish.');
    const scope = new RequestScope(this.timeout, options.signal);
    this.active.add(scope);
    try {
      scope.check();
      const result = await action(scope);
      scope.check();
      this.check();
      return result;
    } catch (error) {
      const e = error as { code?: unknown; status?: unknown; message?: unknown } | null;
      const code = typeof e?.code === 'string' ? e.code : 'network_error';
      const status = typeof e?.status === 'number' ? e.status : undefined;
      if (
        status === 401 ||
        status === 403 ||
        ['session_changed', 'teacher_launch_required', 'session_expired'].includes(code)
      )
        this.invalidate(code);
      throw new ReviewClientError(
        code,
        typeof e?.message === 'string' && e.message.length <= 500
          ? e.message
          : 'The retained submission could not be loaded.',
        status,
      );
    } finally {
      scope.close();
      this.active.delete(scope);
      this.selectionScopes.delete(scope);
    }
  }
  private async verify(scope: RequestScope) {
    this.check();
    let next: AuthorSession & { csrfToken: string };
    try {
      const response = await this.transport.request(scope, '/api/auth/session', 200);
      next = decodeSession(await this.transport.json(scope, response, 16384), this.now());
    } catch (error) {
      // A superseded selection must not invalidate its replacement's session.
      if (!scope.controller.signal.aborted) this.invalidate('session_unverified');
      throw error;
    }
    scope.check();
    this.check();
    if (this.session && identity(this.session) !== identity(next)) {
      this.invalidate('session_changed');
      throw failure(
        'session_changed',
        'The signed-in Canvas teacher changed. Reopen the assignment.',
      );
    }
    this.session = next;
    clearTimeout(this.expiryTimer);
    const expire = () => {
      if (!this.session || this.closed) return;
      if (this.session.expiresAt <= this.now()) this.invalidate('session_expired');
      else
        this.expiryTimer = setTimeout(
          expire,
          Math.min(this.session.expiresAt - this.now(), 2147483647),
        );
    };
    this.expiryTimer = setTimeout(expire, Math.min(next.expiresAt - this.now(), 2147483647));
  }
  private async contextWithin(scope: RequestScope) {
    await this.verify(scope);
    const response = await this.transport.request(scope, '/api/assignments/review', 200);
    const next = decode.context(await this.transport.json(scope, response, 100000));
    await this.verify(scope);
    if (this.context && decode.canonical(next) !== decode.canonical(this.context)) {
      this.invalidate('assignment_changed');
      throw failure('assignment_changed', 'The Canvas assignment changed. Reopen its review.');
    }
    this.context = next;
    return structuredClone(next);
  }
  loadContext(options: ReviewOptions = {}) {
    return this.run(options, (scope) => this.contextWithin(scope)).catch((error) => {
      // A failed authority refresh cannot leave an old teacher view visible indefinitely.
      if (!['cancelled', 'selection_changed', 'client_busy'].includes(error?.code))
        this.invalidate(
          'authority_unverified',
          error instanceof ReviewClientError ? error.message : undefined,
        );
      throw error;
    });
  }
  private acceptSubmission(next: ReviewSnapshot['submission']) {
    const old = this.knownSubmissions.get(next.id);
    if (
      old &&
      (old.frozenCursor !== next.frozenCursor ||
        old.frozenAt !== next.frozenAt ||
        next.revision < old.revision ||
        (next.revision === old.revision && decode.canonical(old) !== decode.canonical(next)) ||
        (old.preparation === 'ready' && next.preparation !== 'ready'))
    )
      decode.invalid();
    if (!old && this.knownSubmissions.size >= 10000)
      throw failure('review_limit', 'Reopen review before loading more submission history.');
    this.knownSubmissions.set(next.id, structuredClone(next));
  }
  list(input: { after?: string } = {}, options: ReviewOptions = {}) {
    if (Object.keys(input).some((key) => key !== 'after'))
      return Promise.reject(failure('invalid_request', 'The review history cursor is invalid.'));
    const after = input.after === undefined ? undefined : decode.id(input.after);
    return this.run(options, async (scope) => {
      await this.contextWithin(scope);
      const response = await this.transport.request(
        scope,
        `/api/assignments/review/submissions${after ? `?after=${after}` : ''}`,
        200,
      );
      const page = decode.page(
        await this.transport.json(scope, response, 100000),
        this.now(),
        after,
      );
      await this.contextWithin(scope);
      for (const item of page.submissions) this.acceptSubmission(item);
      return page;
    });
  }
  private async snapshotWithin(scope: RequestScope, context: ReviewContext, id: string) {
    const response = await this.transport.request(
      scope,
      `/api/assignments/review/submissions/${id}`,
      200,
    );
    const detail = decode.snapshot(
      await this.transport.json(scope, response, 1100000),
      context,
      this.session!.organizationId,
      id,
      this.now(),
    );
    this.acceptSubmission(detail.submission);
    const metadata = new TextEncoder().encode(
      decode.canonical({
        ...detail,
        submission: {
          id: detail.submission.id,
          frozenAt: detail.submission.frozenAt,
          frozenCursor: detail.submission.frozenCursor,
        },
      }),
    );
    try {
      const fingerprint = await digest(metadata, scope);
      const old = this.knownSnapshots.get(id);
      if (old && old !== fingerprint) decode.invalid();
      this.knownSnapshots.set(id, fingerprint);
    } finally {
      metadata.fill(0);
    }
    return detail;
  }
  revalidateSelection(options: ReviewOptions = {}) {
    const record = this.proof,
      data = record?.data,
      generation = this.selection;
    if (!record || !data) return this.loadContext(options);
    return this.run(options, async (scope) => {
      this.selectionScopes.add(scope);
      const context = await this.contextWithin(scope);
      const detail = await this.snapshotWithin(scope, context, data.detail.submission.id);
      await this.contextWithin(scope);
      scope.check();
      this.check();
      if (generation !== this.selection || this.proof !== record || !record.data)
        throw failure('selection_changed', 'A different submission was selected.');
      record.data.detail = detail;
      return context;
    }).catch((error) => {
      if (
        generation === this.selection &&
        !['cancelled', 'selection_changed', 'client_busy'].includes(error?.code)
      )
        this.invalidate(
          'selection_unverified',
          error instanceof ReviewClientError ? error.message : undefined,
        );
      throw error;
    });
  }
  loadSubmission(submissionId: string, options: ReviewLoadOptions = {}) {
    const id = decode.id(submissionId);
    this.clearSelection();
    const generation = this.selection;
    return this.run(options, async (scope) => {
      this.selectionScopes.add(scope);
      const selected = () => {
        scope.check();
        this.check();
        if (generation !== this.selection)
          throw failure('selection_changed', 'A different submission was selected.');
      };
      const progress = (
        stage: 'snapshot' | 'annotations' | 'source' | 'verifying',
        completed: number,
        total: number,
      ) => {
        selected();
        options.onProgress?.({ stage, completed, total });
        selected();
      };
      const context = await this.contextWithin(scope);
      progress('snapshot', 0, 1);
      const detail = await this.snapshotWithin(scope, context, id);
      if (detail.outputBytes > MAX_REVIEW_BYTES || detail.source.bytes > MAX_REVIEW_SOURCE_BYTES)
        throw failure(
          'review_too_large',
          'This retained submission exceeds the browser review limit (32 MiB annotations or 50 MiB PDF). Its saved capture remains available.',
        );
      progress('snapshot', 1, 1);
      let joined: Uint8Array<ArrayBuffer> | null = new Uint8Array(detail.outputBytes);
      let sourceBytes: Uint8Array<ArrayBuffer> | null = null;
      const ordered: Array<{ layerOrder: number; annotation: Annotation }> = [];
      const pageIndexes = new Map(detail.pages.map((page) => [page.id, page.index]));
      const cursorOwners = new Map<number, string>();
      let lastId = '',
        entryCount = 0,
        revisions = 0,
        latestCursor = 0,
        offset = 0;
      let completed = false;
      try {
        for (const descriptor of detail.chunks) {
          selected();
          const response = await this.transport.request(
            scope,
            `/api/assignments/review/submissions/${id}/chunks/${descriptor.index}?pin=${detail.snapshotPin}`,
            200,
          );
          if (
            !/^application\/json(?:\s*;\s*charset=utf-8)?\s*$/i.test(
              response.headers.get('content-type') ?? '',
            )
          ) {
            void response.body?.cancel().catch(() => {});
            decode.invalid();
          }
          const bytes = await this.transport.bytes(scope, response, MAX_REVIEW_CHUNK_BYTES);
          try {
            selected();
            if (
              bytes.length !== descriptor.bytes ||
              (await digest(bytes, scope)) !== descriptor.sha256
            )
              decode.invalid();
            let text: string, value: unknown;
            try {
              text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
              value = JSON.parse(text);
            } catch {
              decode.invalid();
            }
            const chunk = decode.chunk(value, detail, descriptor.index);
            if (decode.canonical(chunk) !== text) decode.invalid();
            joined.set(bytes, offset);
            offset += bytes.length;
            for (const entry of chunk.entries) {
              if (entry.annotationId <= lastId || ++entryCount > detail.annotationCount)
                decode.invalid();
              lastId = entry.annotationId;
              revisions += entry.revision;
              latestCursor = Math.max(latestCursor, entry.latestCursor);
              for (const cursor of [
                entry.latestCursor,
                ...(entry.layerOrder === null ? [] : [entry.layerOrder]),
              ]) {
                const owner = cursorOwners.get(cursor);
                if (owner && owner !== entry.annotationId) decode.invalid();
                cursorOwners.set(cursor, entry.annotationId);
              }
              if (entry.annotation && entry.layerOrder !== null)
                ordered.push({
                  layerOrder: entry.layerOrder,
                  annotation: {
                    ...entry.annotation,
                    id: entry.annotationId,
                    pageIndex: pageIndexes.get(entry.pageId)!,
                    createdAt: 0,
                    author: '',
                  },
                });
            }
          } finally {
            bytes.fill(0);
          }
          progress('annotations', descriptor.index + 1, detail.chunks.length);
          await scope.wait(new Promise<void>((resolve) => setTimeout(resolve, 0)));
        }
        if (
          entryCount !== detail.annotationCount ||
          revisions !== detail.submission.frozenCursor ||
          latestCursor !== detail.submission.frozenCursor ||
          offset !== detail.outputBytes ||
          (await digest(joined, scope)) !== detail.outputSha256
        )
          decode.invalid();
        joined.fill(0);
        joined = null;
        selected();
        progress('source', 0, detail.source.bytes);
        const sourceResponse = await this.transport.request(
          scope,
          `/api/assignments/review/submissions/${id}/source?pin=${detail.snapshotPin}`,
          200,
        );
        if (!/^application\/pdf\s*$/i.test(sourceResponse.headers.get('content-type') ?? '')) {
          void sourceResponse.body?.cancel().catch(() => {});
          decode.invalid();
        }
        sourceBytes = await this.transport.bytes(scope, sourceResponse, MAX_REVIEW_SOURCE_BYTES);
        if (
          sourceBytes.length !== detail.source.bytes ||
          new TextDecoder().decode(sourceBytes.subarray(0, 5)) !== '%PDF-' ||
          (await digest(sourceBytes, scope)) !== detail.source.sha256
        )
          decode.invalid();
        progress('source', sourceBytes.length, detail.source.bytes);
        progress('verifying', 0, 1);
        await this.contextWithin(scope);
        // Recheck selected work/source authority after content transfer, not just
        // the teacher's assignment enrollment. The immutable fingerprint must agree.
        const finalDetail = await this.snapshotWithin(scope, context, id);
        await this.contextWithin(scope);
        selected();
        ordered.sort((a, b) => a.layerOrder - b.layerOrder);
        const data: ReviewData = {
          context,
          detail: finalDetail,
          annotations: ordered.map((entry) => entry.annotation),
          source: new Blob([sourceBytes], { type: 'application/pdf' }),
        };
        const record: ProofRecord = {
          data,
          check: () => {
            this.check();
            if (generation !== this.selection)
              throw failure('selection_changed', 'A different submission was selected.');
          },
        };
        const proof = Object.freeze({ kind: 'verified-teacher-review' }) as VerifiedReviewSnapshot;
        this.proof = record;
        proofs.set(proof, record);
        progress('verifying', 1, 1);
        completed = true;
        return proof;
      } finally {
        joined?.fill(0);
        sourceBytes?.fill(0);
        ordered.length = 0;
        cursorOwners.clear();
        pageIndexes.clear();
        if (!completed && generation === this.selection) this.clearProof();
      }
    });
  }
}
export function createAssignmentReviewClient(
  dependencies: ReviewClientDependencies = {},
): AssignmentReviewClient {
  return new Client(dependencies);
}
