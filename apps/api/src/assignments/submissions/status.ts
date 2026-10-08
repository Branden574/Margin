import { AssignmentError } from '../types.js';
import type { SubmissionStatus } from './types.js';

export interface SubmissionProcessingStatusRow {
  status_revision: string;
  materialization_state: 'pending' | 'completed' | 'failed';
  published_error_code:
    | 'source_unavailable'
    | 'snapshot_invalid'
    | 'authority_revoked'
    | 'retry_exhausted'
    | null;
  processing_generation: number;
  failed_at: Date | null;
  materialized_at: Date | null;
}
export const recoverableProcessingError = (
  code: SubmissionProcessingStatusRow['published_error_code'],
) => code === 'source_unavailable' || code === 'authority_revoked' || code === 'retry_exhausted';

/** Project operational metadata over the authenticated immutable v1 capture; never rewrite it. */
export function projectSubmissionStatus(
  base: SubmissionStatus,
  row: SubmissionProcessingStatusRow,
): SubmissionStatus {
  const revision = Number(row.status_revision);
  const failed = row.materialization_state === 'failed';
  const completed = row.materialization_state === 'completed';
  const validDate = (value: unknown) => value instanceof Date && Number.isFinite(value.getTime());
  if (
    !Number.isSafeInteger(revision) ||
    revision < 1 ||
    !Number.isInteger(row.processing_generation) ||
    row.processing_generation < 1 ||
    row.processing_generation > 3 ||
    revision !==
      row.processing_generation * 2 - (row.materialization_state === 'pending' ? 1 : 0) ||
    !['pending', 'completed', 'failed'].includes(row.materialization_state) ||
    (row.published_error_code !== null &&
      !['source_unavailable', 'snapshot_invalid', 'authority_revoked', 'retry_exhausted'].includes(
        row.published_error_code,
      )) ||
    (failed
      ? row.published_error_code === null || !validDate(row.failed_at) || revision < 2
      : row.published_error_code !== null || row.failed_at !== null) ||
    (completed ? !validDate(row.materialized_at) || revision < 2 : row.materialized_at !== null)
  )
    throw new AssignmentError(
      503,
      'submission_integrity',
      'The saved submission status could not be authenticated. Preserve the exact request.',
    );
  return {
    ...base,
    revision,
    phase: failed ? 'failed' : 'processing',
    confirmedAt: null,
    retryAllowed:
      failed &&
      recoverableProcessingError(row.published_error_code) &&
      row.processing_generation < 3,
    errorCode: failed ? row.published_error_code : null,
  };
}
