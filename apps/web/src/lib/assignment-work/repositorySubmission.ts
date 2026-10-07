import type { VaultTransaction } from '../vault';
import { canonical, repositoryError } from './mapping';
import { decodeSubmissionRequest } from './submissionDecode';
import type { SubmissionRequest } from './submissionTypes';
import {
  MAX_LOCAL_SUBMISSION_REQUESTS,
  type AssignmentBinding,
  type AssignmentSubmissionIndex,
  type AssignmentSubmissionRecord,
} from './repositoryTypes';

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const invalid = (): never =>
  repositoryError(
    'invalid_submission_record',
    'The encrypted submission checkpoint is incomplete or inconsistent. Saved work has not been changed.',
  );
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid();
  return value as Record<string, unknown>;
};
const keys = (value: Record<string, unknown>, allowed: string[]) => {
  if (Object.keys(value).some((key) => !allowed.includes(key))) invalid();
};
export const submissionRecordKey = (documentId: string, requestId: string) =>
  `submission:${documentId}:${requestId}`;
export function submissionInput(value: unknown): { requestId: string; expectedCursor: number } {
  const row = object(value);
  keys(row, ['requestId', 'expectedCursor']);
  if (
    typeof row.requestId !== 'string' ||
    !uuid.test(row.requestId) ||
    !Number.isSafeInteger(row.expectedCursor) ||
    Number(row.expectedCursor) < 0 ||
    Number(row.expectedCursor) > 100_000
  )
    return invalid();
  return { requestId: row.requestId, expectedCursor: Number(row.expectedCursor) };
}
export function submissionIndex(binding: AssignmentBinding): AssignmentSubmissionIndex {
  if (binding.submissions === undefined)
    return { schema: 1, requestIds: [], activeRequestId: null };
  const row = object(binding.submissions);
  keys(row, ['schema', 'requestIds', 'activeRequestId']);
  if (
    row.schema !== 1 ||
    !Array.isArray(row.requestIds) ||
    row.requestIds.length > MAX_LOCAL_SUBMISSION_REQUESTS ||
    new Set(row.requestIds).size !== row.requestIds.length ||
    row.requestIds.some((id) => typeof id !== 'string' || !uuid.test(id)) ||
    (row.activeRequestId !== null && !row.requestIds.includes(row.activeRequestId))
  )
    return invalid();
  return {
    schema: 1,
    requestIds: [...row.requestIds] as string[],
    activeRequestId: row.activeRequestId as string | null,
  };
}
function record(
  value: unknown,
  binding: AssignmentBinding,
  requestId: string,
): AssignmentSubmissionRecord {
  const row = object(value);
  keys(row, ['schema', 'localDocumentId', 'request', 'outcome', 'barrier']);
  if (
    row.schema !== 1 ||
    row.localDocumentId !== binding.localDocumentId ||
    typeof row.barrier !== 'boolean'
  )
    return invalid();
  const request = submissionInput(row.request);
  if (request.requestId !== requestId) return invalid();
  let outcome: SubmissionRequest | undefined;
  if (row.outcome !== undefined) {
    try {
      outcome = decodeSubmissionRequest(row.outcome);
    } catch {
      return invalid();
    }
    if (
      outcome.requestId !== request.requestId ||
      outcome.expectedCursor !== request.expectedCursor ||
      (outcome.state === 'captured' && outcome.submission.frozenCursor !== request.expectedCursor)
    )
      return invalid();
  }
  if (!row.barrier && !outcome) return invalid();
  return {
    schema: 1,
    localDocumentId: binding.localDocumentId,
    request,
    ...(outcome ? { outcome } : {}),
    barrier: row.barrier,
  };
}
/** The small bounded index and every indexed row are authenticated together. */
export async function readSubmissionRecords(tx: VaultTransaction, binding: AssignmentBinding) {
  const index = submissionIndex(binding);
  const records: AssignmentSubmissionRecord[] = [];
  for (const id of index.requestIds) {
    const next = record(
      await tx.get('assignment-receipts', submissionRecordKey(binding.localDocumentId, id)),
      binding,
      id,
    );
    if (next.barrier !== (index.activeRequestId === id)) return invalid();
    records.push(next);
  }
  if (records.filter((row) => row.outcome?.state === 'captured').length > 1) return invalid();
  return {
    index,
    records,
    latest:
      records.find((row) => row.request.requestId === index.activeRequestId) ??
      records.at(-1) ??
      null,
  };
}
/** Revisions may arrive out of order; immutable capture identity and terminal fences never change. */
export function mergeSubmissionOutcome(
  previous: SubmissionRequest | undefined,
  value: SubmissionRequest,
): SubmissionRequest {
  let next: SubmissionRequest;
  try {
    next = decodeSubmissionRequest(value);
  } catch {
    return invalid();
  }
  if (!previous) return next;
  if (
    previous.requestId !== next.requestId ||
    previous.expectedCursor !== next.expectedCursor ||
    previous.state !== next.state
  )
    return invalid();
  if (previous.state === 'rejected') {
    if (canonical(previous) !== canonical(next)) return invalid();
    return structuredClone(previous);
  }
  if (next.state !== 'captured') return invalid();
  const before = previous.submission,
    after = next.submission;
  if (
    before.id !== after.id ||
    before.requestId !== after.requestId ||
    before.attempt !== after.attempt ||
    before.frozenCursor !== after.frozenCursor ||
    before.frozenAt !== after.frozenAt
  )
    return invalid();
  if (after.revision < before.revision) return structuredClone(previous);
  if (after.revision === before.revision) {
    if (canonical(before) !== canonical(after)) return invalid();
    return structuredClone(previous);
  }
  if (before.phase === 'confirmed' && canonical(before) !== canonical(after)) return invalid();
  return next;
}
