import type { AnnotationOperation } from '@margin/core';
import { createVaultGuard, onBeforeVaultLock, onVaultLock } from '../vault';
import { subscribeToDataChanges } from '../storage';
import { canonical } from './mapping';
import {
  createAssignmentWorkClient,
  readVerifiedSnapshot,
  readVerifiedSubmissionRequest,
  type AssignmentWorkClient,
  type VerifiedAssignmentSnapshot,
} from './client';
import {
  acknowledgeAssignmentOperation,
  applyAssignmentCatchUp,
  createVerifiedWorkCopy,
  enqueueAssignmentOperation,
  findVerifiedWorkCopy,
  markAssignmentOutcome,
  prepareAssignmentSend,
  readAssignmentSnapshot,
  prepareSubmission,
  recordSubmissionOutcome,
  continueAssignmentDraft,
} from './repository';
import { AssignmentRetryError, type AssignmentSnapshot } from './repositoryTypes';
import { RequestScope } from './transport';
import { AssignmentWorkClientError, REQUEST_TIMEOUT_MS } from './types';
import {
  StudentWorkControllerError,
  type ReadonlyWorkValue,
  type StudentWorkController,
  type StudentWorkControllerDependencies,
  type StudentWorkState,
} from './controllerTypes';

const MAX_QUEUED_ACTIONS = 4;
const MAX_LOCAL_SAVES = 64;
const fail = (code: string, message: string, operationId?: string) =>
  new StudentWorkControllerError(code, message, operationId);
function immutable<T>(value: T): ReadonlyWorkValue<T> {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) immutable(child);
    Object.freeze(value);
  }
  return value as ReadonlyWorkValue<T>;
}
function issue(reason: unknown) {
  const value = reason as { code?: unknown; message?: unknown; operationId?: unknown };
  return {
    code: typeof value?.code === 'string' ? value.code : 'local_failure',
    message: typeof value?.message === 'string' ? value.message : 'The assignment action failed.',
    ...(typeof value?.operationId === 'string' ? { operationId: value.operationId } : {}),
  };
}
function invalidates(reason: unknown) {
  const e = reason as AssignmentWorkClientError;
  return (
    e?.status === 401 ||
    e?.status === 403 ||
    [
      'session_invalidated',
      'session_changed',
      'session_expired',
      'work_changed',
      'work_unavailable',
      'student_launch_required',
      'invalid_session',
    ].includes(e?.code)
  );
}
interface Action {
  scope: RequestScope;
  check(): void;
  batches: number;
}

class Controller implements StudentWorkController {
  private readonly client: AssignmentWorkClient;
  private readonly timeout: number;
  private readonly batchLimit: number;
  private readonly dispatchLimit: number;
  private state: ReadonlyWorkValue<StudentWorkState> = immutable({
    phase: 'idle',
    view: null,
    saveStatus: 'none',
    submission: 'not-submitted',
    submissionAvailability: 'unknown',
    submissionRecord: null,
    submissionHistory: [],
    submissionError: null,
    needsCatchUp: false,
    localSaving: false,
    localError: null,
    error: null,
    reconciledOperationId: null,
  });
  private readonly listeners = new Set<() => void>();
  private readonly scopes = new Set<RequestScope>();
  private networkTail: Promise<void> = Promise.resolve();
  private localTail: Promise<void> = Promise.resolve();
  private localPending = 0;
  private readonly localFailures = new Map<string, unknown>();
  private readonly localAttempts = new Map<
    string,
    { operation: AnnotationOperation; cursor: number }
  >();
  private snapshotSequence = 0;
  private hintActive = false;
  private generation = 0;
  private activeAction: object | null = null;
  private provenance?: VerifiedAssignmentSnapshot;
  private closed = false;
  private preparingLock = false;
  private readonly removeBeforeLock: () => void;
  private readonly removeLock: () => void;
  private readonly removeDataHint: () => void;
  private readonly lockingChanged = (event: Event) => {
    this.preparingLock = (event as CustomEvent<{ active: boolean }>).detail.active;
  };

  constructor(dependencies: StudentWorkControllerDependencies) {
    this.timeout = dependencies.actionTimeoutMs ?? REQUEST_TIMEOUT_MS;
    this.batchLimit = dependencies.maxCatchUpBatches ?? 4;
    this.dispatchLimit = dependencies.maxDispatches ?? 8;
    if (
      !Number.isSafeInteger(this.timeout) ||
      this.timeout < 1 ||
      this.timeout > REQUEST_TIMEOUT_MS ||
      !Number.isSafeInteger(this.batchLimit) ||
      this.batchLimit < 1 ||
      this.batchLimit > 8 ||
      !Number.isSafeInteger(this.dispatchLimit) ||
      this.dispatchLimit < 1 ||
      this.dispatchLimit > 16
    )
      throw fail('invalid_limits', 'Assignment controller limits are invalid.');
    this.client = dependencies.client ?? createAssignmentWorkClient();
    this.removeBeforeLock = onBeforeVaultLock(async () => {
      // Preparing a lock may fail in another editor/tab. Keep the client usable
      // until actual key removal; never wait for a cloud response here.
      this.abortNetwork();
      await this.flushLocal();
    });
    this.removeLock = onVaultLock(() => this.close('locked'));
    this.removeDataHint =
      typeof window === 'undefined'
        ? () => {}
        : subscribeToDataChanges((change) => {
            if (change.entity === 'document' && change.id === this.state.view?.document.id)
              this.refreshHint();
          });
    if (typeof window !== 'undefined')
      window.addEventListener('margin-vault-locking', this.lockingChanged);
  }
  getState = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  private publish(patch: Partial<StudentWorkState>) {
    this.state = immutable({ ...this.state, ...patch } as StudentWorkState);
    // A render/subscriber exception must not change a committed operation's outcome.
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {
        /* State is still available to the other subscribers. */
      }
    }
  }
  private live(localSave = false) {
    if (this.closed)
      throw fail('controller_closed', 'Reopen this assignment from a verified Canvas launch.');
    // An editor's before-lock hook must still be able to persist its current draft.
    if (this.preparingLock && !localSave)
      throw fail('workspace_locking', 'The workspace is preparing to lock.');
  }
  private abortNetwork() {
    this.generation++;
    this.activeAction = null;
    for (const scope of this.scopes)
      scope.controller.abort(fail('cancelled', 'The assignment action was cancelled.'));
    if (!this.closed) this.publish({ phase: this.state.view ? 'ready' : 'idle' });
  }
  private close(phase: 'disposed' | 'locked' | 'invalidated', reason?: unknown) {
    if (this.closed) return;
    this.closed = true;
    this.abortNetwork();
    this.client.dispose();
    this.provenance = undefined;
    this.removeBeforeLock();
    this.removeLock();
    this.removeDataHint();
    if (typeof window !== 'undefined')
      window.removeEventListener('margin-vault-locking', this.lockingChanged);
    this.publish({
      phase,
      view: null,
      saveStatus: 'none',
      needsCatchUp: false,
      localSaving: false,
      localError: null,
      reconciledOperationId: null,
      error: reason ? issue(reason) : null,
      submission: 'not-submitted',
      submissionAvailability: 'unknown',
      submissionRecord: null,
      submissionHistory: [],
      submissionError: null,
    });
  }
  dispose = () => this.close('disposed');

  private run(phase: 'opening' | 'syncing', body: (action: Action) => Promise<void>) {
    try {
      this.live();
      if (this.scopes.size >= MAX_QUEUED_ACTIONS)
        throw fail('controller_busy', 'Too many assignment actions are already waiting.');
      const guard = createVaultGuard(),
        generation = this.generation,
        scope = new RequestScope(this.timeout),
        key = {},
        preceding = this.networkTail;
      this.scopes.add(scope);
      const check = () => {
        scope.check();
        guard();
        if (this.closed || this.generation !== generation)
          throw fail('cancelled', 'The assignment action is no longer current.');
      };
      const execution = (async () => {
        await scope.wait(preceding);
        check();
        this.activeAction = key;
        this.publish({ phase, error: null, reconciledOperationId: null });
        check();
        await body({ scope, check, batches: 0 });
        check();
      })();
      // Keep the serialization barrier until underlying work actually settles,
      // even when the caller's whole-action deadline has already elapsed.
      this.networkTail = Promise.all([preceding, execution.catch(() => {})]).then(() => {});
      return scope
        .wait(execution)
        .catch((reason: unknown) => {
          if (!this.closed && this.generation === generation && this.activeAction === key) {
            let invalidated = invalidates(reason);
            if (this.provenance) {
              try {
                readVerifiedSnapshot(this.provenance);
              } catch (verificationError) {
                invalidated ||= invalidates(verificationError);
              }
            }
            if (invalidated) this.close('invalidated', reason);
            else this.publish({ phase: 'error', error: issue(reason) });
          }
          throw reason;
        })
        .finally(() => {
          scope.close();
          this.scopes.delete(scope);
          if (this.activeAction === key) this.activeAction = null;
        });
    } catch (reason) {
      return Promise.reject(reason);
    }
  }
  private target(): { id: string; revision: string } {
    const document = this.state.view?.document;
    if (!document?.contentRevision)
      throw fail('open_required', 'Open the verified assignment before saving or synchronizing.');
    return { id: document.id, revision: document.contentRevision };
  }
  private display(snapshot: AssignmentSnapshot, action?: Action) {
    action?.check();
    if (this.closed) return;
    const statuses = snapshot.pending.map((row) => row.status);
    this.publish({
      view: {
        document: snapshot.document,
        assignment: snapshot.binding.manifest.assignment,
        annotations: snapshot.annotations,
        pending: snapshot.pending,
        appliedCursor: snapshot.binding.appliedCursor,
        observedCursor: snapshot.binding.observedCursor,
        hydrated: snapshot.binding.hydrated,
      },
      needsCatchUp:
        !snapshot.binding.hydrated ||
        snapshot.binding.appliedCursor < snapshot.binding.observedCursor,
      saveStatus: statuses.includes('conflict')
        ? 'conflict'
        : statuses.some((status) => status === 'uncertain' || status === 'sending')
          ? 'uncertain'
          : statuses.includes('queued')
            ? 'local-only'
            : statuses.length || snapshot.binding.appliedCursor > 0
              ? 'acknowledged'
              : 'none',
      submissionRecord: snapshot.submission,
      submission:
        (snapshot.submission?.outcome?.state === 'captured' &&
          snapshot.submission.outcome.submission.phase === 'confirmed') ||
        this.state.submissionHistory.some((s) => s.phase === 'confirmed')
          ? 'confirmed'
          : 'not-submitted',
    });
  }
  private async read(action: Action) {
    const target = this.target();
    const sequence = ++this.snapshotSequence;
    const snapshot = await readAssignmentSnapshot(
      target.id,
      target.revision,
      action.scope.controller.signal,
    );
    action.check();
    if (sequence === this.snapshotSequence) this.display(snapshot, action);
    return snapshot;
  }
  private refreshHint() {
    if (this.closed || this.hintActive || !this.state.view) return;
    this.hintActive = true;
    const generation = this.generation,
      target = this.target(),
      guard = createVaultGuard();
    const sequence = ++this.snapshotSequence;
    // Cross-tab messages carry no authority or annotation payload. Read one local
    // encrypted snapshot as an advisory hint; the enqueue CAS remains decisive.
    void readAssignmentSnapshot(target.id, target.revision)
      .then((snapshot) => {
        guard();
        if (!this.closed && generation === this.generation && sequence === this.snapshotSequence)
          this.display(snapshot);
      })
      .catch(() => {
        // Explicit refresh reports storage errors. A broadcast cannot trigger a
        // network request or discard a current editor's draft.
      })
      .finally(() => {
        this.hintActive = false;
      });
  }
  private async verify(action: Action) {
    const verified = await this.client.verifiedSnapshot({ signal: action.scope.controller.signal });
    action.check();
    this.provenance = verified;
    return verified;
  }
  private async recover(action: Action, verified: VerifiedAssignmentSnapshot) {
    const target = this.target();
    let snapshot = await this.read(action);
    // Even a locally hydrated cursor needs one fresh bounded server read.
    while (action.batches < this.batchLimit) {
      action.check();
      this.publish({ phase: 'catching-up' });
      const afterCursor = snapshot.binding.appliedCursor;
      action.batches++;
      const result = await this.client.catchUp(
        { afterCursor, limit: 100 },
        { signal: action.scope.controller.signal },
      );
      action.check();
      await applyAssignmentCatchUp(
        target.id,
        target.revision,
        verified,
        afterCursor,
        result,
        action.scope.controller.signal,
      );
      action.check();
      snapshot = await this.read(action);
      if (!result.hasMore) return true;
    }
    this.publish({ needsCatchUp: true, phase: 'ready' });
    return false;
  }
  private async openWork(action: Action) {
    await action.scope.wait(this.flushLocal());
    action.check();
    let verified = await this.verify(action);
    let manifest = readVerifiedSnapshot(verified).manifest;
    if (!manifest.work) {
      await this.client.reserve({ signal: action.scope.controller.signal });
      action.check();
      verified = await this.verify(action);
      manifest = readVerifiedSnapshot(verified).manifest;
    }
    if (manifest.work?.status !== 'provisioned') {
      this.publish({ phase: 'provisioning', view: null, saveStatus: 'none', needsCatchUp: false });
      return;
    }
    let document = await findVerifiedWorkCopy(verified, action.scope.controller.signal);
    action.check();
    if (!document) {
      verified = await this.client.verifiedSnapshot({
        includeSource: true,
        signal: action.scope.controller.signal,
      });
      action.check();
      this.provenance = verified;
      try {
        document = await createVerifiedWorkCopy(verified, action.scope.controller.signal);
      } catch (reason) {
        action.check();
        if (issue(reason).code !== 'already_bound') throw reason;
        document = await findVerifiedWorkCopy(verified, action.scope.controller.signal);
      }
      action.check();
    }
    if (!document?.contentRevision)
      throw fail('source_missing', 'The verified local assignment copy is unavailable.');
    const sequence = ++this.snapshotSequence;
    const snapshot = await readAssignmentSnapshot(
      document.id,
      document.contentRevision,
      action.scope.controller.signal,
    );
    action.check();
    readVerifiedSnapshot(verified);
    if (sequence === this.snapshotSequence) this.display(snapshot, action);
    await this.recover(action, verified);
    action.check();
    await this.loadSubmissions(action);
    action.check();
    this.publish({ phase: 'ready' });
  }
  open = () => this.run('opening', (action) => this.openWork(action));
  refresh = () => this.open();

  enqueue = (value: AnnotationOperation, expectedAppliedCursor?: number): Promise<void> => {
    try {
      this.live(true);
      const target = this.target(),
        guard = createVaultGuard(),
        operation = structuredClone(value);
      const previous = this.localAttempts.get(operation.id);
      if (previous && canonical(previous.operation) !== canonical(operation))
        throw fail(
          'local_retry_changed',
          'Retry the exact failed local edit; its identifier cannot be reused for a different draft.',
          operation.id,
        );
      const cursor = previous?.cursor ?? expectedAppliedCursor ?? this.state.view!.appliedCursor;
      if (!Number.isSafeInteger(cursor) || cursor < 0 || cursor > 100_000)
        throw fail(
          'invalid_editor_cursor',
          'The rendered assignment cursor is invalid.',
          operation.id,
        );
      this.localAttempts.set(operation.id, { operation, cursor });
      if (this.localPending >= MAX_LOCAL_SAVES)
        throw fail('local_busy', 'Too many local edits are waiting to save.', operation.id);
      if (operation.documentId !== target.id)
        throw fail(
          'document_mismatch',
          'This edit belongs to a different local document.',
          operation.id,
        );
      this.localPending++;
      this.publish({ localSaving: true });
      const save = this.localTail.then(async () => {
        guard();
        await enqueueAssignmentOperation(target.id, target.revision, operation, undefined, cursor);
        // Local persistence may finish after disposal. Its successful commit still
        // satisfies flushLocal, but must never republish private display state.
        if (!this.closed) {
          guard();
          const sequence = ++this.snapshotSequence;
          const snapshot = await readAssignmentSnapshot(target.id, target.revision);
          guard();
          if (!this.closed && sequence === this.snapshotSequence) this.display(snapshot);
        }
        this.localFailures.delete(operation.id);
        this.localAttempts.delete(operation.id);
      });
      const tracked = save
        .catch((reason: unknown) => {
          this.localFailures.set(operation.id, reason);
          throw reason;
        })
        .finally(() => {
          this.localPending--;
          if (!this.closed) {
            const first = this.localFailures.entries().next().value as
              | [string, unknown]
              | undefined;
            this.publish({
              localSaving: this.localPending > 0,
              localError: first ? { ...issue(first[1]), operationId: first[0] } : null,
            });
          }
        });
      this.localTail = tracked.then(
        () => {},
        () => {},
      );
      return tracked;
    } catch (reason) {
      if (!this.closed && this.state.view && typeof value?.id === 'string') {
        if (!this.localFailures.has(value.id)) this.localFailures.set(value.id, reason);
        this.publish({
          localError: { ...issue(this.localFailures.get(value.id)), operationId: value.id },
        });
      }
      return Promise.reject(reason);
    }
  };
  flushLocal = async () => {
    // Include edits accepted while an earlier local transaction was still running.
    let observed: Promise<void>;
    do {
      observed = this.localTail;
      await observed;
    } while (observed !== this.localTail);
    const first = this.localFailures.entries().next().value as [string, unknown] | undefined;
    if (first)
      throw fail(
        'local_save_failed',
        'An edit has not been saved. Retry that same edit before leaving or locking.',
        first[0],
      );
  };
  discardStaleDraft = (operationId: string) => {
    this.live();
    if (
      this.localPending ||
      !this.localAttempts.has(operationId) ||
      issue(this.localFailures.get(operationId)).code !== 'stale_editor_cursor'
    )
      throw fail(
        'discard_unavailable',
        'Only a confirmed rejected stale-editor draft can be discarded.',
        operationId,
      );
    this.localFailures.delete(operationId);
    this.localAttempts.delete(operationId);
    const first = this.localFailures.entries().next().value as [string, unknown] | undefined;
    this.publish({ localError: first ? { ...issue(first[1]), operationId: first[0] } : null });
  };
  private async send(action: Action, retryOperationId?: string) {
    await action.scope.wait(this.flushLocal());
    action.check();
    const target = this.target();
    for (let sent = 0; sent < (retryOperationId === undefined ? this.dispatchLimit : 1); sent++) {
      const verified = await this.verify(action);
      if (!(await this.recover(action, verified))) return;
      action.check();
      let operation;
      try {
        operation = await prepareAssignmentSend(
          target.id,
          target.revision,
          verified,
          retryOperationId,
          action.scope.controller.signal,
        );
      } catch (reason) {
        action.check();
        await this.read(action);
        if (reason instanceof AssignmentRetryError && reason.code === 'retry_reconciled') {
          this.publish({ reconciledOperationId: reason.operationId, phase: 'ready' });
          return;
        }
        throw reason;
      }
      action.check();
      if (!operation) break;
      this.publish({ phase: 'syncing', saveStatus: 'sending' });
      try {
        const receipt = await this.client.append(operation, {
          signal: action.scope.controller.signal,
        });
        action.check();
        await acknowledgeAssignmentOperation(
          target.id,
          target.revision,
          receipt,
          action.scope.controller.signal,
        );
        action.check();
      } catch (reason) {
        // The persisted sending row survives timeout/lock/ack-save uncertainty.
        // Never reset it to queued and never generate a replacement operation.
        if (!action.scope.controller.signal.aborted && !invalidates(reason)) {
          try {
            await markAssignmentOutcome(
              target.id,
              target.revision,
              operation.operationId,
              reason instanceof AssignmentWorkClientError &&
                reason.status === 409 &&
                !reason.uncertainSave
                ? 'conflict'
                : 'uncertain',
              issue(reason).code,
              action.scope.controller.signal,
            );
          } catch {
            // An acknowledgement may already have committed. Recovery reads the
            // durable row/receipt rather than claiming this failed mark rolled it back.
          }
          action.check();
          await this.read(action);
        }
        throw reason;
      }
      await this.read(action);
      // Recover the contiguous echo before releasing dependent edits. Each read
      // consumes the same action-wide batch budget; no background drain follows.
      if (!(await this.recover(action, verified))) return;
    }
    action.check();
    this.publish({ phase: 'ready' });
  }
  sync = () => this.run('syncing', (action) => this.send(action));
  retry = (operationId: string) => this.run('syncing', (action) => this.send(action, operationId));

  private async loadSubmissions(action: Action) {
    try {
      const history = await this.client.submissions({}, { signal: action.scope.controller.signal });
      action.check();
      this.publish({
        submissionAvailability: 'available',
        submissionHistory: history.submissions,
        submissionError: null,
        submission: history.submissions.some((s) => s.phase === 'confirmed')
          ? 'confirmed'
          : 'not-submitted',
      });
      const snapshot = await this.read(action);
      if (snapshot.submission) {
        try {
          const verified = await this.client.submissionRequest(
            snapshot.submission.request.requestId,
            { signal: action.scope.controller.signal },
          );
          action.check();
          const target = this.target();
          await recordSubmissionOutcome(
            target.id,
            target.revision,
            verified,
            action.scope.controller.signal,
          );
          await this.read(action);
        } catch (reason) {
          action.check();
          if ((reason as AssignmentWorkClientError).status !== 404) throw reason;
          // Prepared locally does not imply dispatched. Preserve the exact request for explicit retry.
        }
      }
    } catch (reason) {
      action.check();
      if (invalidates(reason)) throw reason;
      if (this.provenance) {
        try {
          readVerifiedSnapshot(this.provenance);
        } catch (verificationError) {
          if (invalidates(verificationError)) throw verificationError;
        }
      }
      this.publish({
        submissionAvailability:
          issue(reason).code === 'submission_unconfigured' ? 'unavailable' : 'unknown',
        submissionError: issue(reason),
      });
    }
  }
  checkSubmissionStatus = () =>
    this.run('syncing', async (action) => {
      await action.scope.wait(this.flushLocal());
      action.check();
      await this.loadSubmissions(action);
      this.publish({ phase: 'ready' });
    });
  submit = () =>
    this.run('syncing', async (action) => {
      await action.scope.wait(this.flushLocal());
      action.check();
      let snapshot = await this.read(action);
      if (snapshot.submission?.outcome?.state === 'captured')
        throw fail(
          'submission_already_captured',
          'This submission version is already saved. Check its delivery status.',
        );
      if (!snapshot.submission?.barrier) {
        await this.loadSubmissions(action);
        action.check();
        if (this.state.submissionAvailability !== 'available')
          throw fail(
            'submission_unavailable',
            'Submission is not available right now. Your saved work is kept.',
          );
        if (this.state.submissionHistory.length)
          throw fail(
            'submission_already_captured',
            'A submission version already exists. Further attempts are not available yet.',
          );
        await this.send(action);
        action.check();
        snapshot = await this.read(action);
        if (
          snapshot.pending.length ||
          !snapshot.binding.hydrated ||
          snapshot.binding.appliedCursor !== snapshot.binding.observedCursor ||
          this.state.needsCatchUp ||
          this.localPending ||
          this.localFailures.size
        )
          throw fail(
            'submission_sync_required',
            'Continue syncing all saved edits before submitting. No submission request was created.',
          );
        const verified = await this.verify(action);
        const target = this.target();
        await prepareSubmission(
          target.id,
          target.revision,
          verified,
          { requestId: crypto.randomUUID(), expectedCursor: snapshot.binding.appliedCursor },
          action.scope.controller.signal,
        );
        snapshot = await this.read(action);
      }
      const record = snapshot.submission;
      if (!record?.barrier)
        throw fail('submission_request_missing', 'Prepare a saved submission request first.');
      const outcome = await this.client.captureSubmission(record.request, {
        signal: action.scope.controller.signal,
      });
      action.check();
      const target = this.target();
      await recordSubmissionOutcome(
        target.id,
        target.revision,
        outcome,
        action.scope.controller.signal,
      );
      await this.read(action);
      const request = readVerifiedSubmissionRequest(outcome).request;
      if (request.state === 'captured') this.publish({ submissionHistory: [request.submission] });
      this.publish({ phase: 'ready', submissionError: null });
    });
  continueDraft = () =>
    this.run('syncing', async (action) => {
      await action.scope.wait(this.flushLocal());
      action.check();
      const snapshot = await this.read(action),
        target = this.target();
      if (!snapshot.submission?.barrier)
        throw fail(
          'submission_barrier_missing',
          'There is no paused submission request to continue.',
        );
      const verified = await this.client.submissionRequest(snapshot.submission.request.requestId, {
        signal: action.scope.controller.signal,
      });
      action.check();
      await recordSubmissionOutcome(
        target.id,
        target.revision,
        verified,
        action.scope.controller.signal,
      );
      await continueAssignmentDraft(
        target.id,
        target.revision,
        verified,
        action.scope.controller.signal,
      );
      await this.read(action);
      await this.recover(action, readVerifiedSubmissionRequest(verified).verified);
      this.publish({ phase: 'ready', submissionError: null });
    });
}

export function createStudentWorkController(
  dependencies: StudentWorkControllerDependencies = {},
): StudentWorkController {
  return new Controller(dependencies);
}
