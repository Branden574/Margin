import type { SessionPrincipal } from '../../identity/types.js';
import type { SyncPage } from '../../sync/types.js';
import type { ProcessingFailureCode } from '../submissions/processing/types.js';
import type { SubmissionReplayEntry } from '../submissions/processing/replay.js';

export interface ReviewOptions {
  signal?: AbortSignal;
}
export interface ReviewContext {
  assignment: { id: string; title: string; instructions: string };
  mode: 'author-only';
}
/** A retained Margin capture; neither a verified student name nor a Canvas acknowledgement. */
export interface ReviewSubmission {
  id: string;
  frozenCursor: number;
  frozenAt: string;
  revision: number;
  preparation: 'preparing' | 'failed' | 'ready';
  errorCode: ProcessingFailureCode | null;
}
export interface ReviewPage {
  submissions: ReviewSubmission[];
  nextCursor: string | null;
}
export interface ReviewSnapshot {
  assignmentId: string;
  submission: ReviewSubmission;
  /** SHA-256 of the authenticated immutable completion manifest; not an access credential. */
  snapshotPin: string;
  organizationId: string;
  workId: string;
  documentId: string;
  versionId: string;
  pages: SyncPage[];
  source: { sha256: string; bytes: number; mimeType: 'application/pdf' };
  annotationCount: number;
  outputBytes: number;
  outputSha256: string;
  chunks: Array<{ index: number; sha256: string; bytes: number }>;
}
/** Exact canonical v1 plaintext materialization chunk. Includes tombstones for integrity checks. */
export interface ReviewChunk {
  schema: 1;
  organizationId: string;
  workId: string;
  documentId: string;
  versionId: string;
  frozenCursor: number;
  index: number;
  entries: SubmissionReplayEntry[];
}
export interface ReviewPin {
  snapshotPin: string;
}
export interface AssignmentReviewService {
  context(principal: SessionPrincipal, options?: ReviewOptions): Promise<ReviewContext>;
  list(
    principal: SessionPrincipal,
    input: { after?: string },
    options?: ReviewOptions,
  ): Promise<ReviewPage>;
  snapshot(
    principal: SessionPrincipal,
    submissionId: string,
    options?: ReviewOptions,
  ): Promise<ReviewSnapshot>;
  /** Caller owns the plaintext buffer and erases it after response finish/close. */
  chunk(
    principal: SessionPrincipal,
    submissionId: string,
    index: number,
    pin: ReviewPin,
    options?: ReviewOptions,
  ): Promise<Buffer>;
  /** Caller owns the plaintext buffer and erases it after response finish/close. */
  source(
    principal: SessionPrincipal,
    submissionId: string,
    pin: ReviewPin,
    options?: ReviewOptions,
  ): Promise<Buffer>;
}
