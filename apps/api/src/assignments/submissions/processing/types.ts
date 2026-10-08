import type { CommittedOperation, SyncPage } from '../../../sync/types.js';
import type { PostgresIngestionRepository } from '../../../ingestion/postgres.js';
import type { ArtifactReader } from '../../../ingestion/types.js';
/** Internal worker credentials only; never accept these capabilities from HTTP. */
export interface SubmissionProcessingClaim {
  submissionId: string;
  workId: string;
  claimId: string;
  token: string;
  attempt: number;
  expiresAt: number;
}
export interface PreparedSubmission {
  readonly kind: 'prepared-submission';
}
export interface SubmissionReplayContext {
  organizationId: string;
  workId: string;
  documentId: string;
  versionId: string;
  actorId: string;
  frozenCursor: number;
  expectedCanonicalBytes: number;
  pages: SyncPage[];
}
export interface PreparedSubmissionResult {
  ticket: PreparedSubmission;
  replay: SubmissionReplayContext;
}
export interface SubmissionOperationBatch {
  operations: CommittedOperation[];
  nextCursor: number;
  hasMore: boolean;
}
export interface StagedSubmissionChunk {
  index: number;
  sha256: string;
  bytes: number;
  duplicate: boolean;
}
export interface MaterializationReceipt {
  submissionId: string;
  workId: string;
  frozenCursor: number;
  state: 'materialized';
  manifestSha256: string;
  chunkCount: number;
  duplicate: boolean;
}
export interface MaterializationSummary {
  schema: 1;
  frozenCursor: number;
  operationCount: number;
  canonicalOperationBytes: number;
  annotationCount: number;
  outputBytes: number;
  chunkCount: number;
  outputSha256: string;
}
export interface SubmissionProcessingRepository {
  claimNext(signal?: AbortSignal): Promise<SubmissionProcessingClaim | null>;
  prepare(
    claim: SubmissionProcessingClaim,
    reader: PostgresIngestionRepository,
    storage: ArtifactReader,
    signal?: AbortSignal,
  ): Promise<PreparedSubmissionResult>;
  readBatch(
    claim: SubmissionProcessingClaim,
    ticket: PreparedSubmission,
    afterCursor: number,
    signal?: AbortSignal,
  ): Promise<SubmissionOperationBatch>;
  stageChunk(
    claim: SubmissionProcessingClaim,
    ticket: PreparedSubmission,
    index: number,
    chunk: Buffer,
    signal?: AbortSignal,
  ): Promise<StagedSubmissionChunk>;
  complete(
    claim: SubmissionProcessingClaim,
    ticket: PreparedSubmission,
    summary: MaterializationSummary,
    signal?: AbortSignal,
  ): Promise<MaterializationReceipt>;
  receipt(
    claim: SubmissionProcessingClaim,
    signal?: AbortSignal,
  ): Promise<MaterializationReceipt | null>;
  retry(
    claim: SubmissionProcessingClaim,
    delaySeconds?: number,
    signal?: AbortSignal,
  ): Promise<void>;
  dispose(ticket: PreparedSubmission): void;
}
export class SubmissionProcessingError extends Error {
  constructor(
    public readonly code: string,
    message = 'Submission materialization is unavailable.',
  ) {
    super(message);
    this.name = 'SubmissionProcessingError';
  }
}
