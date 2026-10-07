import { cursor, id, invalid, object } from './decode';
import type {
  SubmissionInput,
  SubmissionPage,
  SubmissionRequest,
  SubmissionStatus,
} from './submissionTypes';

export function decodeSubmissionInput(value: unknown): SubmissionInput {
  const row = object(value, ['requestId', 'expectedCursor']);
  return { requestId: id(row.requestId), expectedCursor: cursor(row.expectedCursor) };
}
function timestamp(value: unknown, now?: number): string {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value))
    invalid();
  const date = Date.parse(value as string);
  if (
    !Number.isFinite(date) ||
    new Date(date).toISOString() !== value ||
    (now !== undefined && date > now + 60_000)
  )
    invalid();
  return value as string;
}
export function decodeSubmissionStatus(value: unknown, now?: number): SubmissionStatus {
  const row = object(value, [
    'id',
    'requestId',
    'attempt',
    'frozenCursor',
    'frozenAt',
    'revision',
    'phase',
    'confirmedAt',
    'retryAllowed',
    'errorCode',
  ]);
  const phases = ['processing', 'queued', 'sending', 'uncertain', 'failed', 'confirmed'];
  const codes = [
    'snapshot_invalid',
    'source_unavailable',
    'delivery_unavailable',
    'authority_revoked',
    'provider_rejected',
    'confirmation_unavailable',
    'retry_exhausted',
  ];
  if (
    row.attempt !== 1 ||
    !Number.isSafeInteger(row.revision) ||
    (row.revision as number) < 1 ||
    !phases.includes(row.phase as string) ||
    typeof row.retryAllowed !== 'boolean' ||
    (row.errorCode !== null && !codes.includes(row.errorCode as string))
  )
    invalid();
  const frozenAt = timestamp(row.frozenAt, now);
  const confirmedAt = row.confirmedAt === null ? null : timestamp(row.confirmedAt, now);
  if (
    (row.phase === 'confirmed') !== (confirmedAt !== null) ||
    (confirmedAt !== null && Date.parse(confirmedAt) < Date.parse(frozenAt)) ||
    (row.phase === 'confirmed' && (row.retryAllowed || row.errorCode !== null)) ||
    (row.phase === 'failed' && row.errorCode === null)
  )
    invalid();
  return {
    id: id(row.id),
    requestId: id(row.requestId),
    attempt: 1,
    frozenCursor: cursor(row.frozenCursor),
    frozenAt,
    revision: row.revision as number,
    phase: row.phase as SubmissionStatus['phase'],
    confirmedAt,
    retryAllowed: row.retryAllowed as boolean,
    errorCode: row.errorCode as SubmissionStatus['errorCode'],
  };
}
export function decodeSubmissionRequest(value: unknown, now?: number): SubmissionRequest {
  const row = object(value, ['requestId', 'expectedCursor', 'state', 'submission', 'code']);
  const input = decodeSubmissionInput({
    requestId: row.requestId,
    expectedCursor: row.expectedCursor,
  });
  if (row.state === 'captured') {
    if ('code' in row) invalid();
    const submission = decodeSubmissionStatus(row.submission, now);
    if (
      submission.requestId !== input.requestId ||
      submission.frozenCursor !== input.expectedCursor
    )
      invalid();
    return { ...input, state: 'captured', submission };
  }
  if (
    row.state !== 'rejected' ||
    'submission' in row ||
    !['cursor_changed', 'attempt_exists'].includes(row.code as string)
  )
    invalid();
  return { ...input, state: 'rejected', code: row.code as 'cursor_changed' | 'attempt_exists' };
}
export function decodeSubmissionPage(value: unknown, now: number): SubmissionPage {
  const row = object(value, ['submissions', 'nextCursor']);
  if (
    !Array.isArray(row.submissions) ||
    row.submissions.length > 10 ||
    (row.nextCursor !== null &&
      (typeof row.nextCursor !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(row.nextCursor)))
  )
    invalid();
  const submissions = (row.submissions as unknown[]).map((v) => decodeSubmissionStatus(v, now));
  if (
    new Set(submissions.map((v) => v.id)).size !== submissions.length ||
    new Set(submissions.map((v) => v.requestId)).size !== submissions.length
  )
    invalid();
  return { submissions, nextCursor: row.nextCursor as string | null };
}
