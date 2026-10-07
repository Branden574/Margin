import { createHash } from 'node:crypto';
import type { PoolConfig } from 'pg';
import type { KeyManagementProvider } from '../../encryption.js';
import type { SessionPrincipal } from '../../identity/types.js';
import type { ArtifactReader } from '../../ingestion/types.js';
import { bounded } from '../../cloud/limits.js';
import { keyContext, unwrapKey } from '../../sync/encryption.js';
import { parseOperation, revision } from '../../sync/validation.js';
import { commitOperation, decodeOperation, type OperationRow } from '../../sync/operations.js';
import { SyncError, type CatchUpResult, type CommittedOperation } from '../../sync/types.js';
import { AssignmentError } from '../types.js';
import { WorkPool } from './pool.js';
import { WorkAuthority } from './authority.js';
import { integrity, unavailable } from './manifest.js';
import type { AssignmentWorkService, WorkManifest, WorkRequestOptions } from './types.js';
const hash = (v: Buffer) => createHash('sha256').update(v).digest('hex');
/** Request-scoped student credentials. No provider calls occur inside its final transactions. */
export class PostgresAssignmentWorkService implements AssignmentWorkService {
  private readonly pool: WorkPool;
  private readonly authority: WorkAuthority;
  private activeReads = 0;
  constructor(
    database: PoolConfig,
    private readonly kms: KeyManagementProvider,
    private readonly storage: ArtifactReader,
  ) {
    this.pool = new WorkPool(database);
    this.authority = new WorkAuthority(this.pool, kms);
  }
  close() {
    return this.pool.close();
  }
  async describe(p: SessionPrincipal, options: WorkRequestOptions = {}): Promise<WorkManifest> {
    const { snapshot: s, decoded: d } = await this.authority.prepare(p, options);
    return this.pool.transaction(
      p,
      async (c) => {
        await this.authority.locks(c, p, s, d);
        const current = await this.authority.fresh(c, s, d, options.signal),
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
  async source(p: SessionPrincipal, options: WorkRequestOptions = {}): Promise<Buffer> {
    const { snapshot: s, decoded: d } = await this.authority.prepare(p, options);
    const { completion } = this.authority.requireReady(s, d),
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
    await this.pool.transaction(
      p,
      (c) => this.authority.fresh(c, s, d, options.signal),
      options.signal,
    );
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
          await this.authority.locks(c, p, s, d);
          await this.authority.fresh(c, s, d, options.signal);
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
      { snapshot: s, decoded: d } = await this.authority.prepare(p, options),
      { work, wrappedKey } = this.authority.requireReady(s, d);
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
          await this.authority.locks(c, p, s, d, true);
          const current = await this.authority.fresh(c, s, d, options.signal);
          const result = await commitOperation(c, p, input, current.document!, async () =>
            Buffer.from(key),
          );
          await this.authority.fresh(c, s, d, options.signal);
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
    const { snapshot: s, decoded: d } = await this.authority.prepare(p, options),
      { work, wrappedKey } = this.authority.requireReady(s, d);
    const captured = await this.pool.transaction(
      p,
      async (c) => {
        const current = await this.authority.fresh(c, s, d, options.signal),
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
        await this.authority.locks(c, p, s, d);
        await this.authority.fresh(c, s, d, options.signal);
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
