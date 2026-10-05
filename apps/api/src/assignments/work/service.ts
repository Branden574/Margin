import { createHash } from 'node:crypto';
import type { PoolClient, PoolConfig } from 'pg';
import type { KeyManagementProvider, WrappedDataKey } from '../../encryption.js';
import type { SessionPrincipal } from '../../identity/types.js';
import type { ArtifactReader } from '../../ingestion/types.js';
import { recheckReadyManifest } from '../../ingestion/postgres.js';
import { bounded } from '../../cloud/limits.js';
import { keyContext, unwrapKey } from '../../sync/encryption.js';
import { canonical, parseOperation, revision } from '../../sync/validation.js';
import {
  commitOperation,
  decodeOperation,
  type DocumentRow,
  type OperationRow,
} from '../../sync/operations.js';
import { SyncError, type CatchUpResult, type CommittedOperation } from '../../sync/types.js';
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
import type { AssignmentWorkService, WorkManifest, WorkRequestOptions } from './types.js';
interface Target extends DocumentRow {
  owner_id: string;
  deleted_at: Date | null;
  origin: string;
}
interface Snapshot {
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
const fingerprint = (s: Snapshot) =>
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
const cancelled = (signal?: AbortSignal) => {
  if (signal?.aborted)
    throw new AssignmentError(
      409,
      'work_request_cancelled',
      'The work request was cancelled. Retry an uncertain save with the same operation identifier.',
    );
};
/** Request-scoped student credentials. No provider calls occur inside its final transactions. */
export class PostgresAssignmentWorkService implements AssignmentWorkService {
  private readonly pool: WorkPool;
  private activeReads = 0;
  constructor(
    database: PoolConfig,
    private readonly kms: KeyManagementProvider,
    private readonly storage: ArtifactReader,
  ) {
    this.pool = new WorkPool(database);
  }
  close() {
    return this.pool.close();
  }
  private async capture(c: PoolClient): Promise<Snapshot> {
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
    const s: Snapshot = {
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
  private async prepare(p: SessionPrincipal, options: WorkRequestOptions) {
    cancelled(options.signal);
    const snapshot = await this.pool.transaction(p, (c) => this.capture(c), options.signal);
    const decoded = await decodeManifest(
      this.kms,
      snapshot.assignment,
      snapshot.work,
      snapshot.receipt,
    );
    cancelled(options.signal);
    if (
      snapshot.work?.status === 'provisioned' &&
      canonical(snapshot.pages) !== canonical(decoded.completion?.pages)
    )
      throw integrity();
    return { snapshot, decoded };
  }
  private async locks(
    c: PoolClient,
    p: SessionPrincipal,
    s: Snapshot,
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
  private async fresh(c: PoolClient, s: Snapshot, d: Decoded, signal?: AbortSignal) {
    cancelled(signal);
    const current = await this.capture(c);
    if (fingerprint(current) !== fingerprint(s)) throw unavailable();
    if (d.completion && !(await recheckReadyManifest(c, d.source, d.completion.approval)))
      throw unavailable();
    return current;
  }
  async describe(p: SessionPrincipal, options: WorkRequestOptions = {}): Promise<WorkManifest> {
    const { snapshot: s, decoded: d } = await this.prepare(p, options);
    return this.pool.transaction(
      p,
      async (c) => {
        await this.locks(c, p, s, d);
        const current = await this.fresh(c, s, d, options.signal),
          w = current.work;
        return {
          assignment: {
            id: s.assignment.id,
            title: d.title,
            instructions: d.instructions,
            policy: d.policy,
          },
          work: !w
            ? null
            : w.status === 'pending'
              ? { id: w.id, status: 'pending' }
              : {
                  id: w.id,
                  status: 'provisioned',
                  document: {
                    documentId: w.document_id,
                    versionId: w.version_id,
                    cursor: Number(current.document!.cursor),
                    permission: 'owner',
                    audience: 'members',
                    pages: current.pages,
                  },
                },
        };
      },
      options.signal,
    );
  }
  private requireReady(s: Snapshot, d: Decoded) {
    if (s.work?.status !== 'provisioned' || !d.completion || !s.wrappedKey || !s.document)
      throw new AssignmentError(
        409,
        'work_pending',
        'Your private assignment work has not finished provisioning.',
      );
    return { work: s.work, completion: d.completion, wrappedKey: s.wrappedKey };
  }
  async source(p: SessionPrincipal, options: WorkRequestOptions = {}): Promise<Buffer> {
    const { snapshot: s, decoded: d } = await this.prepare(p, options);
    const { completion } = this.requireReady(s, d),
      policy = d.policy;
    if (
      policy.assessment ||
      !policy.allowExport ||
      !policy.allowCopyPaste ||
      !policy.allowReadAloud
    )
      throw new AssignmentError(
        409,
        'restricted_delivery_unavailable',
        'Original PDF delivery is unavailable under this assignment policy. The policy has not been changed.',
      );
    // Check database authority before opening the object and again immediately before release.
    await this.pool.transaction(p, (c) => this.fresh(c, s, d, options.signal), options.signal);
    if (this.activeReads >= 2)
      throw new AssignmentError(
        503,
        'source_reader_busy',
        'Source delivery is busy. Retry shortly.',
      );
    this.activeReads++;
    let started = false;
    let bytes: Buffer | undefined;
    try {
      const result = await bounded(
        20000,
        options.signal,
        async (signal) => {
          started = true;
          try {
            return await this.storage.get(
              {
                organizationId: d.source.organizationId,
                documentId: d.source.documentId,
                versionId: d.source.versionId,
                artifactId: d.source.artifactId,
                kind: 'source-pdf',
              },
              completion.storage,
              signal,
            );
          } finally {
            this.activeReads--;
          }
        },
        (late) => late.bytes.fill(0),
      );
      bytes = result.bytes;
      if (
        bytes.length < 1 ||
        bytes.length > 100 * 1024 * 1024 ||
        result.metadata.mimeType !== 'application/pdf' ||
        hash(bytes) !== d.source.sha256
      )
        throw integrity();
      await this.pool.transaction(
        p,
        async (c) => {
          await this.locks(c, p, s, d);
          await this.fresh(c, s, d, options.signal);
        },
        options.signal,
      );
      const output = bytes;
      bytes = undefined;
      return output;
    } finally {
      if (!started) this.activeReads--;
      bytes?.fill(0);
    }
  }
  async append(p: SessionPrincipal, value: unknown, options: WorkRequestOptions = {}) {
    const input = parseOperation(value),
      { snapshot: s, decoded: d } = await this.prepare(p, options),
      { work, wrappedKey } = this.requireReady(s, d);
    if (input.documentId !== work.document_id || input.versionId !== work.version_id)
      throw unavailable();
    const tool = input.kind === 'delete' ? 'eraser' : input.annotation!.type;
    if (!d.policy.allowedTools.includes(tool))
      throw new AssignmentError(
        403,
        'assignment_tool_disabled',
        'This tool is disabled for the assignment. Keep the edit locally.',
      );
    const key = await unwrapKey(
      this.kms,
      wrappedKey,
      keyContext(p.organizationId, work.document_id),
    );
    try {
      return await this.pool.transaction(
        p,
        async (c) => {
          await this.locks(c, p, s, d, true);
          const current = await this.fresh(c, s, d, options.signal);
          const result = await commitOperation(c, p, input, current.document!, async () =>
            Buffer.from(key),
          );
          await this.fresh(c, s, d, options.signal);
          return result;
        },
        options.signal,
      );
    } finally {
      key.fill(0);
    }
  }
  async catchUp(
    p: SessionPrincipal,
    input: { afterCursor?: number; limit?: number },
    options: WorkRequestOptions = {},
  ): Promise<CatchUpResult> {
    const after = revision(input.afterCursor ?? 0),
      limit = input.limit ?? 50;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100)
      throw new SyncError(400, 'invalid_limit', 'Request between one and 100 operations.');
    const { snapshot: s, decoded: d } = await this.prepare(p, options),
      { work, wrappedKey } = this.requireReady(s, d);
    const captured = await this.pool.transaction(
      p,
      async (c) => {
        const current = await this.fresh(c, s, d, options.signal),
          cursor = Number(current.document!.cursor);
        if (after > cursor)
          throw new SyncError(
            409,
            'cursor_ahead',
            'The local cursor is ahead of the server. Keep local edits.',
            { currentCursor: cursor },
          );
        const rows = (
          await c.query<OperationRow>(
            'SELECT * FROM margin_sync.operations WHERE organization_id=$1 AND document_id=$2 AND cursor>$3 AND cursor<=$4 ORDER BY cursor LIMIT $5',
            [p.organizationId, work.document_id, after, cursor, limit],
          )
        ).rows;
        return { cursor, rows };
      },
      options.signal,
    );
    const operations: CommittedOperation[] = [];
    let bytes = 0;
    if (captured.rows.length) {
      const key = await unwrapKey(
        this.kms,
        wrappedKey,
        keyContext(p.organizationId, work.document_id),
      );
      try {
        for (const row of captured.rows) {
          if (row.actor_id !== p.userId) throw integrity();
          const operation: CommittedOperation = {
            ...decodeOperation(key, p.organizationId, row),
            actorId: row.actor_id,
            cursor: Number(row.cursor),
            annotationRevision: row.annotation_revision,
            committedAt: row.committed_at.toISOString(),
          };
          const size = Buffer.byteLength(JSON.stringify(operation));
          if (bytes + size > 1048000) break;
          bytes += size;
          operations.push(operation);
        }
      } finally {
        key.fill(0);
      }
    }
    await this.pool.transaction(
      p,
      async (c) => {
        await this.locks(c, p, s, d);
        await this.fresh(c, s, d, options.signal);
      },
      options.signal,
    );
    const nextCursor = operations.at(-1)?.cursor ?? after;
    return {
      documentId: work.document_id,
      versionId: work.version_id,
      operations,
      nextCursor,
      hasMore: nextCursor < captured.cursor,
      currentCursor: captured.cursor,
    };
  }
}
