import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { KeyManagementProvider, WrappedDataKey } from '../../encryption.js';
import type { SessionPrincipal } from '../../identity/types.js';
import { recheckReadyManifest } from '../../ingestion/postgres.js';
import { canonical } from '../../sync/validation.js';
import type { DocumentRow } from '../../sync/operations.js';
import { AssignmentError } from '../types.js';
import { WorkPool } from './pool.js';
import {
  decodeManifest,
  integrity,
  unavailable,
  type AssignmentRow,
  type WorkRow,
  type ReceiptRow,
  type Decoded,
} from './manifest.js';
import type { WorkRequestOptions } from './types.js';
interface Target extends DocumentRow {
  owner_id: string;
  deleted_at: Date | null;
  origin: string;
}
export interface WorkSnapshot {
  assignment: AssignmentRow;
  work: WorkRow | null;
  receipt: ReceiptRow | null;
  job: { state: string; claim_id: string; attempt: number } | null;
  document: Target | null;
  wrappedKey: WrappedDataKey | null;
  pages: Array<{ id: string; index: number; width: number; height: number }>;
}
const hash = (v: Buffer | string) => createHash('sha256').update(v).digest('hex');
// Date/Buffer serialization is explicit before canonicalization; mutable cursor is checked separately.
const fingerprint = (s: WorkSnapshot) =>
  hash(
    canonical(
      JSON.parse(
        JSON.stringify({
          ...s,
          document: s.document
            ? {
                id: s.document.id,
                current_version_id: s.document.current_version_id,
                owner_id: s.document.owner_id,
                deleted_at: s.document.deleted_at,
                origin: s.document.origin,
                audience: s.document.audience,
                permission: s.document.permission,
              }
            : null,
        }),
      ),
    ),
  );
export const workCancelled = (signal?: AbortSignal) => {
  if (signal?.aborted)
    throw new AssignmentError(
      409,
      'work_request_cancelled',
      'The work request was cancelled. Retry an uncertain save with the same operation identifier.',
    );
};
/** Internal current-launch authority shared by independently credentialed work/capture services. */
export class WorkAuthority {
  constructor(
    private readonly pool: WorkPool,
    private readonly kms: KeyManagementProvider,
  ) {}
  async capture(c: PoolClient): Promise<WorkSnapshot> {
    const assignment = (
      await c.query<AssignmentRow>(
        "SELECT a.* FROM margin_assignments.assignments a JOIN margin_assignments.launch_bindings l ON l.assignment_id=a.id WHERE l.session_id=margin_work.ctx('session_id')",
      )
    ).rows[0];
    if (!assignment) throw unavailable();
    await c.query("SELECT set_config('margin_work.source_owner_id',$1,true)", [
      assignment.created_by,
    ]);
    const work =
      (
        await c.query<WorkRow>(
          "SELECT * FROM margin_assignments.student_work WHERE assignment_id=$1 AND user_id=margin_work.ctx('user_id')",
          [assignment.id],
        )
      ).rows[0] ?? null;
    const s: WorkSnapshot = {
      assignment,
      work,
      receipt: null,
      job: null,
      document: null,
      wrappedKey: null,
      pages: [],
    };
    if (!work || work.status === 'pending') return s;
    s.receipt =
      (await c.query<ReceiptRow>('SELECT * FROM margin_work.receipts WHERE work_id=$1', [work.id]))
        .rows[0] ?? null;
    s.job =
      (
        await c.query<{ state: string; claim_id: string; attempt: number }>(
          'SELECT state,claim_id,attempt FROM margin_assignments.provisioning_outbox WHERE work_id=$1',
          [work.id],
        )
      ).rows[0] ?? null;
    s.document =
      (
        await c.query<Target>(
          'SELECT d.id,d.current_version_id,d.owner_id,d.deleted_at,d.origin,d.audience,d.cursor,d.operation_bytes,g.permission FROM margin_sync.documents d JOIN margin_sync.grants g ON g.organization_id=d.organization_id AND g.document_id=d.id AND g.user_id=$3 AND g.revoked_at IS NULL WHERE d.organization_id=$1 AND d.id=$2',
          [work.organization_id, work.document_id, work.user_id],
        )
      ).rows[0] ?? null;
    s.wrappedKey =
      (
        await c.query<{ wrapped_key: WrappedDataKey }>(
          'SELECT wrapped_key FROM margin_sync.document_keys WHERE organization_id=$1 AND document_id=$2',
          [work.organization_id, work.document_id],
        )
      ).rows[0]?.wrapped_key ?? null;
    s.pages = (
      await c.query<{ id: string; index: number; width: number; height: number }>(
        'SELECT id,page_index AS index,width,height FROM margin_sync.pages WHERE organization_id=$1 AND document_id=$2 AND version_id=$3 ORDER BY page_index LIMIT 2000',
        [work.organization_id, work.document_id, work.version_id],
      )
    ).rows;
    if (
      !s.receipt ||
      !s.job ||
      s.job.state !== 'completed' ||
      s.job.claim_id !== s.receipt.claim_id ||
      s.job.attempt !== s.receipt.attempt ||
      !s.document ||
      s.document.owner_id !== work.user_id ||
      s.document.current_version_id !== work.version_id ||
      s.document.origin !== 'assignment' ||
      s.document.audience !== 'members' ||
      s.document.deleted_at ||
      s.document.permission !== 'owner' ||
      !s.wrappedKey
    )
      throw unavailable();
    return s;
  }
  async prepare(p: SessionPrincipal, options: WorkRequestOptions) {
    workCancelled(options.signal);
    const snapshot = await this.pool.transaction(p, (c) => this.capture(c), options.signal);
    const decoded = await decodeManifest(
      this.kms,
      snapshot.assignment,
      snapshot.work,
      snapshot.receipt,
    );
    workCancelled(options.signal);
    if (
      snapshot.work?.status === 'provisioned' &&
      canonical(snapshot.pages) !== canonical(decoded.completion?.pages)
    )
      throw integrity();
    return { snapshot, decoded };
  }
  async locks(
    c: PoolClient,
    p: SessionPrincipal,
    s: WorkSnapshot,
    decoded: Decoded,
    writing = false,
  ) {
    const a = s.assignment,
      w = s.work,
      src = decoded.source,
      actors = [p.userId, a.created_by].sort();
    await c.query("SELECT set_config('margin_work.source_owner_id',$1,true)", [a.created_by]);
    const locks: Array<[string, unknown[]]> = [
      ['SELECT id FROM margin_identity.organizations WHERE id=$1 FOR SHARE', [p.organizationId]],
      [
        'SELECT id FROM margin_identity.users WHERE id=ANY($1::uuid[]) ORDER BY id FOR SHARE',
        [actors],
      ],
      [
        'SELECT user_id FROM margin_identity.memberships WHERE organization_id=$1 AND user_id=ANY($2::uuid[]) ORDER BY user_id FOR SHARE',
        [p.organizationId, actors],
      ],
      ['SELECT id FROM margin_lms.installations WHERE id=$1 FOR SHARE', [a.installation_id]],
      [
        'SELECT course_id FROM margin_lms.courses WHERE installation_id=$1 AND course_id=$2 FOR SHARE',
        [a.installation_id, a.course_id],
      ],
      [
        'SELECT user_id FROM margin_lms.user_links WHERE installation_id=$1 AND user_id=ANY($2::uuid[]) ORDER BY user_id FOR SHARE',
        [a.installation_id, actors],
      ],
      [
        'SELECT user_id FROM margin_lms.enrollments WHERE installation_id=$1 AND course_id=$2 AND user_id=ANY($3::uuid[]) ORDER BY user_id FOR SHARE',
        [a.installation_id, a.course_id, actors],
      ],
      ['SELECT id FROM margin_identity.sessions WHERE id=$1 FOR SHARE', [p.sessionId]],
      [
        'SELECT session_id FROM margin_lms.session_bindings WHERE session_id=$1 FOR SHARE',
        [p.sessionId],
      ],
      ['SELECT id FROM margin_assignments.assignments WHERE id=$1 FOR SHARE', [a.id]],
      [
        'SELECT resource_digest FROM margin_assignments.resource_links WHERE assignment_id=$1 FOR SHARE',
        [a.id],
      ],
      [
        'SELECT session_id FROM margin_assignments.launch_bindings WHERE session_id=$1 FOR SHARE',
        [p.sessionId],
      ],
    ];
    if (w)
      locks.push(['SELECT id FROM margin_assignments.student_work WHERE id=$1 FOR SHARE', [w.id]]);
    if (w?.status === 'provisioned')
      locks.push(
        [
          'SELECT id FROM margin_sync.documents WHERE organization_id=$1 AND id=$2 FOR SHARE',
          [p.organizationId, src.documentId],
        ],
        [
          'SELECT id FROM margin_sync.versions WHERE organization_id=$1 AND document_id=$2 AND id=$3 FOR SHARE',
          [p.organizationId, src.documentId, src.versionId],
        ],
        [
          'SELECT user_id FROM margin_sync.grants WHERE organization_id=$1 AND document_id=$2 AND user_id=$3 FOR SHARE',
          [p.organizationId, src.documentId, src.ownerId],
        ],
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
          'SELECT work_id FROM margin_assignments.provisioning_outbox WHERE work_id=$1 FOR SHARE',
          [w.id],
        ],
        ['SELECT work_id FROM margin_work.receipts WHERE work_id=$1 FOR SHARE', [w.id]],
        [
          `SELECT id FROM margin_sync.documents WHERE organization_id=$1 AND id=$2 FOR ${writing ? 'UPDATE' : 'SHARE'}`,
          [p.organizationId, w.document_id],
        ],
        [
          'SELECT id FROM margin_sync.versions WHERE organization_id=$1 AND document_id=$2 AND id=$3 FOR SHARE',
          [p.organizationId, w.document_id, w.version_id],
        ],
        [
          'SELECT user_id FROM margin_sync.grants WHERE organization_id=$1 AND document_id=$2 AND user_id=$3 FOR SHARE',
          [p.organizationId, w.document_id, p.userId],
        ],
        [
          'SELECT document_id FROM margin_sync.document_keys WHERE organization_id=$1 AND document_id=$2 FOR SHARE',
          [p.organizationId, w.document_id],
        ],
        [
          'SELECT id FROM margin_sync.pages WHERE organization_id=$1 AND document_id=$2 AND version_id=$3 ORDER BY page_index FOR SHARE',
          [p.organizationId, w.document_id, w.version_id],
        ],
      );
    for (const [query, params] of locks)
      if (!(await c.query(query, params)).rowCount) throw unavailable();
  }
  async fresh(c: PoolClient, s: WorkSnapshot, d: Decoded, signal?: AbortSignal) {
    workCancelled(signal);
    const current = await this.capture(c);
    if (fingerprint(current) !== fingerprint(s)) throw unavailable();
    if (d.completion && !(await recheckReadyManifest(c, d.source, d.completion.approval)))
      throw unavailable();
    return current;
  }
  requireReady(s: WorkSnapshot, d: Decoded) {
    if (s.work?.status !== 'provisioned' || !d.completion || !s.wrappedKey || !s.document)
      throw new AssignmentError(
        409,
        'work_pending',
        'Your private assignment work has not finished provisioning.',
      );
    return { work: s.work, completion: d.completion, wrappedKey: s.wrappedKey };
  }
}
