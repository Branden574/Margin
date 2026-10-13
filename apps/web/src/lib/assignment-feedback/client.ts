import { session as teacherSession } from '../assignment-author/decode';
import { session as studentSession } from '../assignment-work/decode';
import { RequestScope, Transport } from '../assignment-work/transport';
import { createVaultGuard, onVaultLock, vaultTransaction } from '../vault';
import type {
  SaveFeedbackInput,
  ReleaseFeedbackInput,
} from '../../../../api/src/assignments/feedback/types';
import * as decode from './decode';
import type { Annotation } from '@margin/core';
import type { AssignmentBinding } from '../assignment-work/repositoryTypes';
import * as reviewDecode from '../assignment-review/decode';
import {
  readMaterializedAnnotations,
  digestReviewBytes,
} from '../assignment-review/materialization';
import {
  MAX_REVIEW_BYTES,
  MAX_REVIEW_SOURCE_BYTES,
  type ReviewSnapshot,
  type ReviewLoadOptions,
} from '../assignment-review/types';

export interface ReturnedCaptureData {
  feedback: decode.StudentFeedback;
  detail: ReviewSnapshot;
  annotations: Annotation[];
  source: Blob;
}
export interface VerifiedReturnedCapture {
  readonly kind: 'verified-returned-capture';
}
interface ReturnedCaptureRecord {
  data: ReturnedCaptureData | null;
  check: () => void;
}
const returnedProofs = new WeakMap<object, ReturnedCaptureRecord>();
/** Live client provenance is required; a lookalike object cannot authorize a rendered capture. */
export function readVerifiedReturnedCapture(proof: VerifiedReturnedCapture): ReturnedCaptureData {
  const record = returnedProofs.get(proof);
  if (!record?.data) throw new Error('Reopen returned feedback to verify the captured work.');
  record.check();
  return structuredClone(record.data);
}
export interface ReturnedCaptureInput {
  expected: decode.StudentFeedback;
  source: Blob;
  /** Local values constrain the response. Current authenticated server identity grants access. */
  readBinding: () => Promise<Pick<AssignmentBinding, 'identity' | 'sourceSha256'>>;
}
const immutableCapture = (detail: ReviewSnapshot) => ({
  ...detail,
  submission: {
    id: detail.submission.id,
    frozenAt: detail.submission.frozenAt,
    frozenCursor: detail.submission.frozenCursor,
  },
});
const feedbackCapture = (detail: ReviewSnapshot): decode.FeedbackCapture => ({
  submissionId: detail.submission.id,
  snapshotPin: detail.snapshotPin,
  documentId: detail.documentId,
  versionId: detail.versionId,
  frozenCursor: detail.submission.frozenCursor,
  frozenAt: detail.submission.frozenAt,
  pages: detail.pages,
  source: detail.source,
});

export type PendingFeedback =
  | { action: 'save'; input: SaveFeedbackInput }
  | { action: 'release'; input: ReleaseFeedbackInput };
export interface FeedbackDraft {
  content: decode.FeedbackContent;
  baseRevision: number;
  pending: PendingFeedback | null;
  revision: string;
}
export interface FeedbackDependencies {
  fetch?: typeof fetch;
  expectedOrigin?: string;
  now?: () => number;
  timeoutMs?: number;
}
export class FeedbackClient {
  private readonly transport: Transport;
  private readonly origin: string;
  private readonly now: () => number;
  private readonly timeout: number;
  private readonly guard = createVaultGuard();
  private readonly removeLock: () => void;
  private session: ReturnType<typeof teacherSession> | ReturnType<typeof studentSession> | null =
    null;
  private closed = false;
  private readonly scopes = new Set<RequestScope>();
  private readonly listeners = new Set<() => void>();
  private returnedGeneration = 0;
  private returnedProof: ReturnedCaptureRecord | null = null;
  private readonly returnedScopes = new Set<RequestScope>();
  constructor(
    private readonly role: 'teacher' | 'student',
    readonly submissionId: string,
    dependencies: FeedbackDependencies = {},
  ) {
    const origin = dependencies.expectedOrigin ?? globalThis.location?.origin;
    if (
      !origin ||
      (!globalThis.location && !dependencies.fetch) ||
      (globalThis.location && globalThis.location.origin !== origin)
    )
      throw decode.fail();
    const url = new URL(origin);
    if (
      url.protocol !== 'https:' ||
      url.origin !== origin ||
      url.pathname !== '/' ||
      url.search ||
      url.hash ||
      url.username ||
      url.password
    )
      throw decode.fail();
    if (
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(
        submissionId,
      )
    )
      throw decode.fail();
    this.origin = origin;
    this.transport = new Transport(origin, dependencies.fetch ?? fetch.bind(globalThis));
    this.now = dependencies.now ?? Date.now;
    this.timeout = dependencies.timeoutMs ?? 45000;
    if (!Number.isSafeInteger(this.timeout) || this.timeout < 1 || this.timeout > 120000)
      throw decode.fail();
    this.removeLock = onVaultLock(() => this.dispose());
  }
  subscribeInvalidation(listener: () => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  dispose() {
    if (this.closed) return;
    this.closed = true;
    this.clearReturnedCapture();
    this.session = null;
    this.removeLock();
    for (const scope of this.scopes)
      scope.controller.abort(
        new Error('Feedback session ended. Reopen this assignment from Canvas.'),
      );
    for (const listener of this.listeners) listener();
    this.listeners.clear();
  }
  check = () => {
    if (this.closed) throw new Error('Feedback session ended. Reopen this assignment from Canvas.');
    this.guard();
    if (this.session && this.session.expiresAt <= this.now()) {
      this.dispose();
      throw new Error('Your Canvas session expired. Reopen this assignment.');
    }
  };
  private async verify(scope: RequestScope) {
    this.check();
    let next: ReturnType<typeof teacherSession> | ReturnType<typeof studentSession>;
    try {
      const response = await this.transport.request(scope, '/api/auth/session', 200);
      next = (this.role === 'teacher' ? teacherSession : studentSession)(
        await this.transport.json(scope, response, 16384),
        this.now(),
      );
    } catch (reason) {
      if (!scope.controller.signal.aborted) this.dispose();
      throw reason;
    }
    const identity = (s: typeof next) => [
      s.sessionId,
      s.userId,
      s.organizationId,
      s.role,
      s.authenticationMethod,
      s.createdAt,
      s.csrfToken,
    ];
    if (this.session && !decode.same(identity(this.session), identity(next))) {
      this.dispose();
      throw new Error('The Canvas identity changed. Reopen this assignment.');
    }
    this.session = next;
    this.check();
  }
  private path() {
    return `/api/assignments/${this.role === 'teacher' ? 'review' : 'work'}/submissions/${this.submissionId}/feedback`;
  }
  private async run<T>(
    action: (scope: RequestScope) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    this.check();
    if (this.scopes.size >= 4) throw new Error('Wait for the current feedback request to finish.');
    const scope = new RequestScope(this.timeout, signal);
    this.scopes.add(scope);
    try {
      await this.verify(scope);
      const result = await action(scope);
      await this.verify(scope);
      this.check();
      scope.check();
      return result;
    } catch (reason) {
      const error = reason as { status?: number };
      if ([401, 403].includes(error?.status ?? 0)) this.dispose();
      throw reason;
    } finally {
      this.scopes.delete(scope);
      this.returnedScopes.delete(scope);
      scope.close();
    }
  }
  teacher(signal?: AbortSignal) {
    if (this.role !== 'teacher') throw decode.fail();
    return this.run(async (scope) => {
      const result = decode.teacher(
        await this.transport.json(
          scope,
          await this.transport.request(scope, this.path(), 200),
          1_048_576,
        ),
      );
      if (result.capture.submissionId !== this.submissionId) throw decode.fail();
      return result;
    }, signal);
  }
  student(signal?: AbortSignal) {
    if (this.role !== 'student') throw decode.fail();
    return this.run(async (scope) => {
      const result = decode.student(
        await this.transport.json(
          scope,
          await this.transport.request(scope, this.path(), 200),
          1_048_576,
        ),
      );
      if (result.capture.submissionId !== this.submissionId) throw decode.fail();
      return result;
    }, signal);
  }
  clearReturnedCapture() {
    this.returnedGeneration++;
    for (const scope of this.returnedScopes)
      scope.controller.abort(new Error('The returned feedback view was closed.'));
    this.returnedScopes.clear();
    if (this.returnedProof) {
      if (this.returnedProof.data) this.returnedProof.data.annotations.length = 0;
      this.returnedProof.data = null;
      this.returnedProof = null;
    }
  }
  async loadReturnedCapture(
    input: ReturnedCaptureInput,
    options: ReviewLoadOptions = {},
  ): Promise<VerifiedReturnedCapture> {
    if (this.role !== 'student') throw decode.fail();
    const expected = decode.student(structuredClone(input.expected));
    if (!expected.released || expected.capture.submissionId !== this.submissionId)
      throw new Error('Your teacher has not returned feedback for this captured version yet.');
    const source = input.source;
    if (
      !(source instanceof Blob) ||
      source.size !== expected.capture.source.bytes ||
      source.size > MAX_REVIEW_SOURCE_BYTES
    )
      throw new Error(
        'This returned document exceeds the browser PDF limit (50 MiB), or its source changed.',
      );
    this.clearReturnedCapture();
    const generation = this.returnedGeneration;
    const check = () => {
      this.check();
      if (generation !== this.returnedGeneration || options.signal?.aborted)
        throw new Error('The returned feedback view was closed.');
    };
    let complete = false;
    let annotations: Annotation[] = [];
    try {
      const data = await this.run(async (scope) => {
        this.returnedScopes.add(scope);
        const current = () => {
          scope.check();
          check();
        };
        const progress = (
          stage: 'snapshot' | 'annotations' | 'source' | 'verifying',
          completed: number,
          total: number,
        ) => {
          current();
          options.onProgress?.({ stage, completed, total });
          current();
        };
        const binding = await scope.wait(input.readBinding());
        current();
        const identity = structuredClone(binding.identity);
        if (
          identity.origin !== this.origin ||
          identity.organizationId !== this.session!.organizationId ||
          identity.userId !== this.session!.userId
        )
          throw new Error(
            'This saved assignment belongs to a different Canvas identity. Reopen the assignment.',
          );
        for (const name of [
          'organizationId',
          'userId',
          'assignmentId',
          'workId',
          'documentId',
          'versionId',
        ] as const)
          reviewDecode.id(identity[name]);
        reviewDecode.hash(binding.sourceSha256);
        const readFeedback = async (previous: decode.StudentFeedback) => {
          const value = decode.student(
            await this.transport.json(
              scope,
              await this.transport.request(scope, this.path(), 200),
              1_048_576,
            ),
          );
          if (
            !value.released ||
            !previous.released ||
            !decode.same(value.capture, expected.capture) ||
            value.released.revision < previous.released.revision ||
            (value.released.revision === previous.released.revision &&
              !decode.same(value.released, previous.released))
          )
            throw new Error(
              'Returned feedback changed or is no longer available. Check feedback again.',
            );
          return value;
        };
        const readCapture = async () => {
          const value = await this.transport.json(
            scope,
            await this.transport.request(scope, `${this.path()}/capture`, 200),
            1_048_576,
          );
          // Expected assignment comes from the bound local copy, never the untrusted response.
          const detail = reviewDecode.snapshot(
            value,
            {
              assignment: { id: identity.assignmentId, title: '', instructions: '' },
              mode: 'author-only',
            },
            this.session!.organizationId,
            this.submissionId,
            this.now(),
          );
          if (
            detail.workId !== identity.workId ||
            detail.documentId !== identity.documentId ||
            detail.versionId !== identity.versionId ||
            detail.source.sha256 !== binding.sourceSha256 ||
            !decode.same(feedbackCapture(detail), expected.capture)
          )
            throw new Error(
              'The returned capture does not match this assignment and feedback. Reopen it from Canvas.',
            );
          if (detail.outputBytes > MAX_REVIEW_BYTES)
            throw new Error(
              'This retained submission exceeds the browser annotation limit (32 MiB). Its saved capture remains available.',
            );
          return detail;
        };
        progress('snapshot', 0, 1);
        const feedback = await readFeedback(expected);
        const detail = await readCapture();
        progress('snapshot', 1, 1);
        annotations = await readMaterializedAnnotations({
          detail,
          scope,
          transport: this.transport,
          path: (index) => `${this.path()}/chunks/${index}?pin=${detail.snapshotPin}`,
          check: current,
          progress: (completed, total) => progress('annotations', completed, total),
        });
        progress('source', 0, source.size);
        const bytes = new Uint8Array(
          await scope.wait(source.arrayBuffer(), (late) => new Uint8Array(late).fill(0)),
        );
        try {
          if (
            new TextDecoder().decode(bytes.subarray(0, 5)) !== '%PDF-' ||
            bytes.length !== detail.source.bytes ||
            (await digestReviewBytes(bytes, scope)) !== detail.source.sha256
          )
            throw new Error(
              'The preserved PDF source could not be verified. Reopen the assignment.',
            );
        } finally {
          bytes.fill(0);
        }
        progress('source', source.size, source.size);
        progress('verifying', 0, 1);
        const finalDetail = await readCapture();
        if (
          finalDetail.submission.revision < detail.submission.revision ||
          !decode.same(immutableCapture(detail), immutableCapture(finalDetail))
        )
          throw new Error(
            'The captured submission changed while opening it. Check feedback again.',
          );
        const finalFeedback = await readFeedback(feedback);
        const finalBinding = await scope.wait(input.readBinding());
        if (
          !decode.same(identity, finalBinding.identity) ||
          finalBinding.sourceSha256 !== binding.sourceSha256
        )
          throw new Error(
            'The saved assignment changed while opening feedback. Reopen it from Canvas.',
          );
        current();
        progress('verifying', 1, 1);
        return { feedback: finalFeedback, detail: finalDetail, annotations, source };
      }, options.signal);
      check();
      const record: ReturnedCaptureRecord = { data, check };
      const proof = Object.freeze({ kind: 'verified-returned-capture' }) as VerifiedReturnedCapture;
      this.returnedProof = record;
      returnedProofs.set(proof, record);
      complete = true;
      return proof;
    } finally {
      if (!complete) {
        annotations.length = 0;
        if (generation === this.returnedGeneration) this.clearReturnedCapture();
      }
    }
  }
  command(pending: PendingFeedback, lookup: boolean, signal?: AbortSignal) {
    if (this.role !== 'teacher') throw decode.fail();
    return this.run(async (scope) => {
      const response = lookup
        ? await this.transport.request(
            scope,
            `${this.path()}/commands/${pending.input.requestId}`,
            200,
          )
        : await this.transport.request(
            scope,
            this.path() + (pending.action === 'release' ? '/release' : ''),
            [200, 409],
            JSON.stringify(pending.input),
            this.session!.csrfToken,
            pending.action === 'save' ? 'PUT' : 'POST',
          );
      const result = decode.command(await this.transport.json(scope, response, 16384));
      if (
        result.requestId !== pending.input.requestId ||
        result.snapshotPin !== pending.input.snapshotPin ||
        result.action !== pending.action ||
        result.expectedRevision !== pending.input.expectedRevision ||
        (!lookup && (response.status === 409) !== (result.state === 'rejected'))
      )
        throw decode.fail();
      return result;
    }, signal);
  }
  private binding(snapshot: decode.FeedbackCapture) {
    this.check();
    if (!this.session || this.role !== 'teacher' || snapshot.submissionId !== this.submissionId)
      throw decode.fail();
    return [
      this.origin,
      this.session.organizationId,
      this.session.userId,
      this.role,
      this.submissionId,
      snapshot.snapshotPin,
    ];
  }
  private parseDraft(
    value: unknown,
    snapshot: decode.FeedbackCapture,
    binding: unknown,
  ): FeedbackDraft {
    const row = value as Record<string, unknown>;
    if (
      !row ||
      row.schema !== 1 ||
      !decode.same(row.binding, binding) ||
      typeof row.revision !== 'string' ||
      !/^[a-f0-9-]{36}$/.test(row.revision) ||
      !Number.isSafeInteger(row.baseRevision) ||
      (row.baseRevision as number) < 0 ||
      (row.baseRevision as number) > 100000
    )
      throw decode.fail();
    const content = decode.content(row.content, snapshot),
      pending = row.pending as PendingFeedback | null;
    if (pending !== null) {
      if (
        !pending ||
        !['save', 'release'].includes(pending.action) ||
        typeof pending.input?.requestId !== 'string' ||
        !/^[a-f0-9-]{36}$/.test(pending.input.requestId) ||
        pending.input.snapshotPin !== snapshot.snapshotPin ||
        pending.input.expectedRevision !== row.baseRevision
      )
        throw decode.fail();
      if (
        pending.action === 'save' &&
        !decode.same(decode.content(pending.input.content, snapshot), content)
      )
        throw decode.fail();
    }
    return { content, baseRevision: row.baseRevision as number, pending, revision: row.revision };
  }
  async readDraft(snapshot: decode.FeedbackCapture) {
    const binding = this.binding(snapshot),
      key = JSON.stringify(binding);
    const result = await vaultTransaction(
      async (tx) => {
        this.check();
        const value = await tx.get('feedback-drafts', key);
        return value === undefined ? null : this.parseDraft(value, snapshot, binding);
      },
      { guard: this.check },
    );
    this.check();
    return result;
  }
  async writeDraft(
    snapshot: decode.FeedbackCapture,
    value: Omit<FeedbackDraft, 'revision'>,
    previous: FeedbackDraft | null,
    outcome?: decode.FeedbackCommand,
  ) {
    const binding = this.binding(snapshot),
      key = JSON.stringify(binding),
      revision = crypto.randomUUID();
    const next = this.parseDraft({ schema: 1, binding, revision, ...value }, snapshot, binding);
    await vaultTransaction(
      async (tx) => {
        this.check();
        const raw = await tx.get('feedback-drafts', key),
          found = raw === undefined ? null : this.parseDraft(raw, snapshot, binding);
        if ((found?.revision ?? null) !== (previous?.revision ?? null))
          throw new Error(
            'Feedback changed in another tab. Reopen this submission before editing.',
          );
        if (found?.pending && !decode.same(found.pending, next.pending)) {
          const request = found.pending;
          if (
            !outcome ||
            next.pending !== null ||
            outcome.requestId !== request.input.requestId ||
            outcome.snapshotPin !== request.input.snapshotPin ||
            outcome.expectedRevision !== request.input.expectedRevision ||
            outcome.action !== request.action
          )
            throw new Error(
              'Keep the exact pending feedback request until its outcome is confirmed.',
            );
        }
        tx.put('feedback-drafts', key, { schema: 1, binding, ...next });
      },
      { guard: this.check },
    );
    this.check();
    return next;
  }
}
