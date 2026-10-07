import type { Annotation, AnnotationOperation, DocumentRecord } from '@margin/core';
import type { AppendOperation, AppendReceipt, WorkManifest } from './types';
import type { SubmissionRequest } from './submissionTypes';

export const MAX_OUTBOX_OPERATIONS = 1_000;
export const MAX_OUTBOX_BYTES = 8 * 1024 * 1024;
export const MAX_BASELINE_ANNOTATIONS = 20_000;
export const MAX_BASELINE_BYTES = 32 * 1024 * 1024;
export const MAX_LOCAL_SUBMISSION_REQUESTS = 32;
export interface AssignmentSubmissionRecord {
  schema: 1;
  localDocumentId: string;
  request: { requestId: string; expectedCursor: number };
  outcome?: SubmissionRequest;
  /** Remains set after capture until the student explicitly continues the draft. */
  barrier: boolean;
}
export interface AssignmentSubmissionIndex {
  schema: 1;
  requestIds: string[];
  activeRequestId: string | null;
}
export interface AssignmentIdentity {
  origin: string;
  organizationId: string;
  userId: string;
  assignmentId: string;
  workId: string;
  documentId: string;
  versionId: string;
}
export interface AssignmentBinding {
  schema: 1;
  localDocumentId: string;
  contentRevision: string;
  sourceSha256: string;
  identity: AssignmentIdentity;
  manifest: WorkManifest;
  createdSessionId: string;
  appliedCursor: number;
  observedCursor: number;
  nextSequence: number;
  queue: string[];
  queueBytes: number;
  baselineIds: string[];
  baselineBytes: number;
  hydrated: boolean;
  /** Optional versioned extension; absence is the existing pre-submission vault format. */
  submissions?: AssignmentSubmissionIndex;
}
export interface AssignmentOutboxEntry {
  schema: 1;
  localDocumentId: string;
  sequence: number;
  local: AnnotationOperation;
  operation: AppendOperation;
  bytes: number;
  status: 'queued' | 'sending' | 'uncertain' | 'acknowledged' | 'conflict';
  receipt?: AppendReceipt;
  conflictCode?: string;
  dispatchedCursor?: number;
}
export interface AssignmentBaseline {
  annotationId: string;
  pageId: string;
  revision: number;
  cursor: number;
  annotation: Annotation | null;
}
export interface AssignmentSnapshot {
  document: DocumentRecord;
  binding: AssignmentBinding;
  annotations: Annotation[];
  pending: { operationId: string; annotationId: string; status: AssignmentOutboxEntry['status'] }[];
  submission: AssignmentSubmissionRecord | null;
}
export class AssignmentRepositoryError extends Error {
  readonly name = 'AssignmentRepositoryError';
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
/** An exact retry is never allowed to select a different queued operation. */
export class AssignmentRetryError extends AssignmentRepositoryError {
  constructor(
    readonly code:
      | 'invalid_retry_operation'
      | 'retry_reconciled'
      | 'retry_not_pending'
      | 'retry_not_head',
    readonly operationId: string,
    message: string,
  ) {
    super(code, message);
  }
}
