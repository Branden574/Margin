import {
  commitOperation,
  decodeOperation,
  type DocumentRow,
  type OperationRow,
} from './operations.js';
import type { PoolClient, PoolConfig } from 'pg';
import type { KeyManagementProvider, WrappedDataKey } from '../encryption.js';
import type { SessionPrincipal } from '../identity/types.js';
import { keyContext, unwrapKey } from './encryption.js';
import { SyncPool } from './pool.js';
import { identifier, parseOperation, revision } from './validation.js';
import {
  SyncError,
  type AppendReceipt,
  type CatchUpRequest,
  type CatchUpResult,
  type CommittedOperation,
  type DocumentDescription,
} from './types.js';
export interface SyncServiceOptions {
  database: PoolConfig;
  keyManagementProvider: KeyManagementProvider;
}
export class PostgresSyncService {
  private readonly pool: SyncPool;
  private readonly keys: KeyManagementProvider;
  constructor(options: SyncServiceOptions) {
    this.pool = new SyncPool(options.database, 'runtime');
    this.keys = options.keyManagementProvider;
  }
  close() {
    return this.pool.close();
  }
  private async document(
    client: PoolClient,
    documentId: string,
    writing = false,
  ): Promise<DocumentRow> {
    const role = (
      await client.query<{ role: string | null }>('SELECT margin_sync.active_role() AS role')
    ).rows[0]?.role;
    if (!role)
      throw new SyncError(
        401,
        'session_expired',
        'Sign in again before synchronizing. Your local edits are still available.',
      );
    const query = `SELECT d.id,d.current_version_id,d.cursor,d.operation_bytes,d.audience,g.permission FROM margin_sync.documents d JOIN margin_sync.grants g ON g.organization_id=d.organization_id AND g.document_id=d.id AND g.user_id=margin_sync.context_id('user_id') AND g.revoked_at IS NULL WHERE d.organization_id=margin_sync.context_id('organization_id') AND d.id=$1`;
    let row = (await client.query<DocumentRow>(query, [documentId])).rows[0];
    if (!row)
      throw new SyncError(
        404,
        'document_unavailable',
        'This document is not available to this account.',
      );
    if (writing) {
      if (row.permission === 'viewer' || role === 'viewer' || role === 'support')
        throw new SyncError(
          403,
          'read_only',
          'This account has read-only access. Keep your edits locally.',
        );
      // Every writer and grant update locks the same document before changing durable state.
      await client.query(`${query} FOR UPDATE OF d`, [documentId]);
      // Re-read after the lock wait: a preceding grant transaction may have revoked access.
      row = (await client.query<DocumentRow>(query, [documentId])).rows[0];
      if (!row)
        throw new SyncError(
          404,
          'document_unavailable',
          'This document is not available to this account.',
        );
      if (row.permission === 'viewer')
        throw new SyncError(
          403,
          'read_only',
          'This account has read-only access. Keep your edits locally.',
        );
    }
    return row;
  }
  private async key(client: PoolClient, organizationId: string, documentId: string) {
    const row = (
      await client.query<{ wrapped_key: WrappedDataKey }>(
        'SELECT wrapped_key FROM margin_sync.document_keys WHERE organization_id=$1 AND document_id=$2',
        [organizationId, documentId],
      )
    ).rows[0];
    if (!row)
      throw new SyncError(
        503,
        'key_unavailable',
        'The document encryption key is unavailable. Keep your edits locally and retry.',
      );
    try {
      return await unwrapKey(this.keys, row.wrapped_key, keyContext(organizationId, documentId));
    } catch {
      throw new SyncError(
        503,
        'key_unavailable',
        'The document encryption key is unavailable. Keep your edits locally and retry.',
      );
    }
  }
  async describeDocument(
    principal: SessionPrincipal,
    documentId: string,
  ): Promise<DocumentDescription> {
    documentId = identifier(documentId);
    return this.pool.transaction(principal, async (client) => {
      const d = await this.document(client, documentId);
      const pages = await client.query<{
        id: string;
        index: number;
        width: number;
        height: number;
      }>(
        'SELECT id,page_index AS index,width,height FROM margin_sync.pages WHERE organization_id=$1 AND document_id=$2 AND version_id=$3 ORDER BY page_index LIMIT 2000',
        [principal.organizationId, documentId, d.current_version_id],
      );
      return {
        documentId,
        versionId: d.current_version_id,
        cursor: Number(d.cursor),
        permission: d.permission,
        audience: d.audience,
        pages: pages.rows,
      };
    });
  }
  async append(principal: SessionPrincipal, value: unknown): Promise<AppendReceipt> {
    const input = parseOperation(value);
    return this.pool.transaction(principal, async (client) => {
      const d = await this.document(client, input.documentId, true);
      return commitOperation(client, principal, input, d, () =>
        this.key(client, principal.organizationId, input.documentId),
      );
    });
  }
  async catchUp(principal: SessionPrincipal, input: CatchUpRequest): Promise<CatchUpResult> {
    const documentId = identifier(input.documentId),
      after = revision(input.afterCursor ?? 0),
      limit = input.limit ?? 50;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100)
      throw new SyncError(400, 'invalid_limit', 'Request between one and 100 operations.');
    return this.pool.transaction(principal, async (client) => {
      const d = await this.document(client, documentId),
        currentCursor = Number(d.cursor);
      if (after > currentCursor)
        throw new SyncError(
          409,
          'cursor_ahead',
          'The local synchronization cursor is ahead of the server. Keep local work while reconnecting.',
          { currentCursor },
        );
      const rows = (
        await client.query<OperationRow>(
          'SELECT * FROM margin_sync.operations WHERE organization_id=$1 AND document_id=$2 AND cursor>$3 AND cursor<=$4 ORDER BY cursor LIMIT $5',
          [principal.organizationId, documentId, after, currentCursor, limit],
        )
      ).rows;
      const operations: CommittedOperation[] = [];
      let totalBytes = 0;
      if (rows.length) {
        const key = await this.key(client, principal.organizationId, documentId);
        try {
          for (const row of rows) {
            const operation: CommittedOperation = {
              ...decodeOperation(key, principal.organizationId, row),
              actorId: row.actor_id,
              cursor: Number(row.cursor),
              annotationRevision: row.annotation_revision,
              committedAt: row.committed_at.toISOString(),
            };
            const size = Buffer.byteLength(JSON.stringify(operation));
            if (totalBytes + size > 1048000) break;
            totalBytes += size;
            operations.push(operation);
          }
        } finally {
          key.fill(0);
        }
      }
      // A slow KMS response must not release plaintext after the caller lost access.
      await this.document(client, documentId);
      const nextCursor = operations.at(-1)?.cursor ?? after;
      return {
        documentId,
        versionId: d.current_version_id,
        operations,
        nextCursor,
        hasMore: nextCursor < currentCursor,
        currentCursor,
      };
    });
  }
}
