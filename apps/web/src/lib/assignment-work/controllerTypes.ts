import type { Annotation, AnnotationOperation, DocumentRecord } from '@margin/core';
import type { AssignmentWorkClient } from './client';
import type { AssignmentSnapshot, AssignmentSubmissionRecord } from './repositoryTypes';
import type { SubmissionStatus } from './submissionTypes';
import type { WorkManifest } from './types';

export type ReadonlyWorkValue<T> = T extends object
  ? { readonly [K in keyof T]: ReadonlyWorkValue<T[K]> }
  : T;

export interface StudentWorkView {
  document: DocumentRecord;
  assignment: WorkManifest['assignment'];
  annotations: Annotation[];
  pending: AssignmentSnapshot['pending'];
  appliedCursor: number;
  observedCursor: number;
  hydrated: boolean;
}
export interface StudentWorkState {
  phase:
    | 'idle'
    | 'opening'
    | 'provisioning'
    | 'ready'
    | 'catching-up'
    | 'syncing'
    | 'error'
    | 'invalidated'
    | 'locked'
    | 'disposed';
  /** Immutable snapshots; no PDF bytes, bearer credentials, or server-only source identifiers. */
  view: ReadonlyWorkValue<StudentWorkView> | null;
  saveStatus: 'none' | 'local-only' | 'sending' | 'uncertain' | 'conflict' | 'acknowledged';
  /** Only an authenticated provider receipt can establish confirmation; saving never does. */
  submission: 'not-submitted' | 'confirmed';
  submissionAvailability: 'unknown' | 'available' | 'unavailable';
  submissionRecord: ReadonlyWorkValue<AssignmentSubmissionRecord> | null;
  submissionHistory: ReadonlyWorkValue<SubmissionStatus[]>;
  submissionError: { code: string; message: string } | null;
  needsCatchUp: boolean;
  localSaving: boolean;
  localError: { code: string; message: string; operationId: string } | null;
  error: { code: string; message: string; operationId?: string } | null;
  /** The explicit retry was reconciled without sending a replacement queue head. */
  reconciledOperationId: string | null;
}
export interface StudentWorkController {
  /** Stable object identity until state changes, suitable for useSyncExternalStore. */
  getState(): ReadonlyWorkValue<StudentWorkState>;
  subscribe(listener: () => void): () => void;
  /** Verify current launch; reserve once if absent; open or resume its encrypted local copy. */
  open(): Promise<void>;
  /** Explicitly recheck pending provisioning and fetch a bounded continuation of operations. */
  refresh(): Promise<void>;
  /** Local persistence is independent of the network queue. Caller owns the editor writer lock. */
  enqueue(operation: AnnotationOperation, expectedAppliedCursor?: number): Promise<void>;
  /** Explicitly discard a confirmed rejected stale-editor draft only. Never changes persisted rows. */
  discardStaleDraft(operationId: string): void;
  /** Rejects while any failed edit remains unsaved; retry that same edit to clear its failure. */
  flushLocal(): Promise<void>;
  /** Catch up, then send a bounded number of queued edits with fresh server verification. */
  sync(): Promise<void>;
  /** Only this exact uncertain/sending operation can be retried; never rebases conflicts. */
  retry(operationId: string): Promise<void>;
  /** Flush and fully synchronize before preparing one immutable request; retries reuse that request. */
  submit(): Promise<void>;
  checkSubmissionStatus(): Promise<void>;
  /** Freshly confirm a captured attempt or durable rejection before releasing the local barrier. */
  continueDraft(): Promise<void>;
  /** Abort network work and clear display state. Await flushLocal before normal editor teardown. */
  dispose(): void;
}
/** Trusted construction dependencies only. The controller exclusively owns and disposes its client.
 * No route, document ID, student ID, assignment ID, or persisted manifest grants authority here.
 */
export interface StudentWorkControllerDependencies {
  client?: AssignmentWorkClient;
  actionTimeoutMs?: number;
  maxCatchUpBatches?: number;
  maxDispatches?: number;
}

export class StudentWorkControllerError extends Error {
  readonly name = 'StudentWorkControllerError';
  constructor(
    readonly code: string,
    message: string,
    readonly operationId?: string,
  ) {
    super(message);
  }
}
