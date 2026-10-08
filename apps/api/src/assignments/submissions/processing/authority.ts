import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { WrappedDataKey } from '../../../encryption.js';
import { recheckReadyManifest } from '../../../ingestion/postgres.js';
import { canonical } from '../../../sync/validation.js';
import type { Ciphertext } from '../../../sync/encryption.js';
import type { AssignmentRow, WorkRow, ReceiptRow, Decoded } from '../../work/manifest.js';
import { SubmissionProcessingError } from './types.js';
export const fail = (code: string) => new SubmissionProcessingError(code);
export const cancelled = (signal?: AbortSignal) => {
  if (signal?.aborted) throw fail('processing_cancelled');
};
export const hash = (v: string | Buffer) => createHash('sha256').update(v).digest('hex');
export const fingerprint = (v: unknown) => hash(canonical(JSON.parse(JSON.stringify(v))));
export interface CapturedRow extends Ciphertext {
  organization_id: string;
  work_id: string;
  request_id: string;
  expected_cursor: string;
  outcome: string;
  wrapped_key: WrappedDataKey;
}
export interface AttemptRow {
  id: string;
  organization_id: string;
  work_id: string;
  request_id: string;
  document_id: string;
  version_id: string;
  frozen_cursor: string;
  source_artifact_id: string;
  scan_receipt_id: string;
}
export interface Snapshot {
  attempt: AttemptRow;
  request: CapturedRow;
  work: WorkRow;
  assignment: AssignmentRow;
  receipt: ReceiptRow;
  job: { state: string; claim_id: string; attempt: number };
  wrappedKey: WrappedDataKey;
  pages: Array<{ id: string; index: number; width: number; height: number }>;
}
export async function capture(c: PoolClient, submissionId: string): Promise<Snapshot> {
  const attempt = (
    await c.query<AttemptRow>('SELECT * FROM margin_submissions.attempts WHERE id=$1', [
      submissionId,
    ])
  ).rows[0];
  if (!attempt) throw fail('submission_unavailable');
  const work = (
    await c.query<WorkRow>('SELECT * FROM margin_assignments.student_work WHERE id=$1', [
      attempt.work_id,
    ])
  ).rows[0];
  if (
    !work ||
    work.status !== 'provisioned' ||
    work.organization_id !== attempt.organization_id ||
    work.document_id !== attempt.document_id ||
    work.version_id !== attempt.version_id
  )
    throw fail('submission_integrity');
  const assignment = (
    await c.query<AssignmentRow>('SELECT * FROM margin_assignments.assignments WHERE id=$1', [
      work.assignment_id,
    ])
  ).rows[0];
  const request = (
    await c.query<CapturedRow>(
      'SELECT * FROM margin_submissions.requests WHERE work_id=$1 AND request_id=$2',
      [work.id, attempt.request_id],
    )
  ).rows[0];
  const receipt = (
    await c.query<ReceiptRow>('SELECT * FROM margin_work.receipts WHERE work_id=$1', [work.id])
  ).rows[0];
  const job = (
    await c.query<Snapshot['job']>(
      'SELECT state,claim_id,attempt FROM margin_assignments.provisioning_outbox WHERE work_id=$1',
      [work.id],
    )
  ).rows[0];
  const wrappedKey = (
    await c.query<{ wrapped_key: WrappedDataKey }>(
      'SELECT wrapped_key FROM margin_sync.document_keys WHERE organization_id=$1 AND document_id=$2',
      [work.organization_id, work.document_id],
    )
  ).rows[0]?.wrapped_key;
  const pages = (
    await c.query<Snapshot['pages'][number]>(
      'SELECT id,page_index AS index,width,height FROM margin_sync.pages WHERE organization_id=$1 AND document_id=$2 AND version_id=$3 ORDER BY page_index LIMIT 2000',
      [work.organization_id, work.document_id, work.version_id],
    )
  ).rows;
  if (
    !assignment ||
    !request ||
    !receipt ||
    !job ||
    !wrappedKey ||
    job.state !== 'completed' ||
    job.claim_id !== receipt.claim_id ||
    job.attempt !== receipt.attempt ||
    request.organization_id !== work.organization_id ||
    request.outcome !== 'captured' ||
    request.expected_cursor !== attempt.frozen_cursor ||
    receipt.source_artifact_id !== attempt.source_artifact_id ||
    receipt.scan_receipt_id !== attempt.scan_receipt_id
  )
    throw fail('submission_integrity');
  return { attempt, request, work, assignment, receipt, job, wrappedKey, pages };
}
/** Establish a serial order against current enrollment, installation and source/target revocation. */
export async function lockAuthority(c: PoolClient, s: Snapshot, d: Decoded) {
  const w = s.work,
    src = d.source,
    actors = [w.user_id, s.assignment.created_by].sort();
  const locks: Array<[string, unknown[]]> = [
    ['SELECT id FROM margin_identity.organizations WHERE id=$1 FOR SHARE', [w.organization_id]],
    [
      'SELECT id FROM margin_identity.users WHERE id=ANY($1::uuid[]) ORDER BY id FOR SHARE',
      [actors],
    ],
    [
      'SELECT user_id FROM margin_identity.memberships WHERE organization_id=$1 AND user_id=ANY($2::uuid[]) ORDER BY user_id FOR SHARE',
      [w.organization_id, actors],
    ],
    ['SELECT id FROM margin_lms.installations WHERE id=$1 FOR SHARE', [w.installation_id]],
    [
      'SELECT course_id FROM margin_lms.courses WHERE installation_id=$1 AND course_id=$2 FOR SHARE',
      [w.installation_id, w.course_id],
    ],
    [
      'SELECT user_id FROM margin_lms.user_links WHERE installation_id=$1 AND user_id=ANY($2::uuid[]) ORDER BY user_id FOR SHARE',
      [w.installation_id, actors],
    ],
    [
      'SELECT user_id FROM margin_lms.enrollments WHERE installation_id=$1 AND course_id=$2 AND user_id=ANY($3::uuid[]) ORDER BY user_id FOR SHARE',
      [w.installation_id, w.course_id, actors],
    ],
    ['SELECT id FROM margin_assignments.assignments WHERE id=$1 FOR SHARE', [w.assignment_id]],
    [
      'SELECT resource_digest FROM margin_assignments.resource_links WHERE installation_id=$1 AND resource_digest=$2 AND assignment_id=$3 FOR SHARE',
      [w.installation_id, w.resource_digest, w.assignment_id],
    ],
    ['SELECT id FROM margin_assignments.student_work WHERE id=$1 FOR SHARE', [w.id]],
    [
      'SELECT work_id FROM margin_assignments.provisioning_outbox WHERE work_id=$1 FOR SHARE',
      [w.id],
    ],
    ['SELECT work_id FROM margin_work.receipts WHERE work_id=$1 FOR SHARE', [w.id]],
  ];
  for (const [doc, ver, owner] of [
    [src.documentId, src.versionId, src.ownerId],
    [w.document_id, w.version_id, w.user_id],
  ])
    locks.push(
      [
        'SELECT id FROM margin_sync.documents WHERE organization_id=$1 AND id=$2 FOR SHARE',
        [w.organization_id, doc],
      ],
      [
        'SELECT id FROM margin_sync.versions WHERE organization_id=$1 AND document_id=$2 AND id=$3 FOR SHARE',
        [w.organization_id, doc, ver],
      ],
      [
        'SELECT user_id FROM margin_sync.grants WHERE organization_id=$1 AND document_id=$2 AND user_id=$3 FOR SHARE',
        [w.organization_id, doc, owner],
      ],
    );
  locks.push(
    [
      'SELECT artifact_id FROM margin_ingestion.artifacts WHERE artifact_id=$1 FOR SHARE',
      [src.artifactId],
    ],
    [
      'SELECT artifact_id FROM margin_ingestion.storage_receipts WHERE artifact_id=$1 FOR SHARE',
      [src.artifactId],
    ],
    [
      'SELECT artifact_id FROM margin_ingestion.inspection_jobs WHERE artifact_id=$1 FOR SHARE',
      [src.artifactId],
    ],
    [
      'SELECT id FROM margin_ingestion.inspection_receipts WHERE id=$1 FOR SHARE',
      [src.scanReceiptId],
    ],
    [
      'SELECT scan_receipt_id FROM margin_ingestion.page_geometry WHERE scan_receipt_id=$1 FOR SHARE',
      [src.scanReceiptId],
    ],
    [
      'SELECT document_id FROM margin_sync.document_keys WHERE organization_id=$1 AND document_id=$2 FOR SHARE',
      [w.organization_id, w.document_id],
    ],
    [
      'SELECT id FROM margin_sync.pages WHERE organization_id=$1 AND document_id=$2 AND version_id=$3 ORDER BY page_index FOR SHARE',
      [w.organization_id, w.document_id, w.version_id],
    ],
    [
      'SELECT request_id FROM margin_submissions.requests WHERE work_id=$1 AND request_id=$2 FOR SHARE',
      [w.id, s.request.request_id],
    ],
    ['SELECT id FROM margin_submissions.attempts WHERE id=$1 FOR SHARE', [s.attempt.id]],
  );
  for (const [query, params] of locks)
    if (!(await c.query(query, params)).rowCount) throw fail('authority_revoked');
}
export async function fresh(c: PoolClient, s: Snapshot, d: Decoded, signal?: AbortSignal) {
  cancelled(signal);
  if (
    !(
      await c.query<{ active: boolean }>('SELECT margin_submissions.active($1) AS active', [
        s.work.id,
      ])
    ).rows[0]?.active ||
    !d.completion ||
    !(await recheckReadyManifest(c, d.source, d.completion.approval)) ||
    fingerprint(await capture(c, s.attempt.id)) !== fingerprint(s)
  )
    throw fail('authority_revoked');
  cancelled(signal);
}
