import type { PoolClient, PoolConfig } from 'pg';
import type { KeyManagementProvider, WrappedDataKey } from '../encryption.js';
import type { SessionPrincipal } from '../identity/types.js';
import {
  decrypt,
  encrypt,
  keyContext,
  operationContext,
  unwrapKey,
  type Ciphertext,
} from './encryption.js';
import { SyncPool } from './pool.js';
import { canonical, identifier, parseOperation, revision } from './validation.js';
import {
  SyncError,
  type AppendOperation,
  type AppendReceipt,
  type CatchUpRequest,
  type CatchUpResult,
  type CommittedOperation,
  type DocumentDescription,
  type DocumentPermission,
} from './types.js';
interface DocumentRow {
  id: string;
  current_version_id: string;
  cursor: string;
  operation_bytes: string;
  audience: 'members' | 'teachers';
  permission: DocumentPermission;
}
interface OperationRow extends Ciphertext {
  document_id: string;
  version_id: string;
  page_id: string;
  annotation_id: string;
  operation_id: string;
  actor_id: string;
  base_revision: number;
  annotation_revision: number;
  cursor: string;
  kind: 'put' | 'delete';
  committed_at: Date;
}
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
  private decode(key: Buffer, organizationId: string, row: OperationRow): AppendOperation {
    const metadata: AppendOperation = {
      documentId: row.document_id,
      versionId: row.version_id,
      pageId: row.page_id,
      annotationId: row.annotation_id,
      operationId: row.operation_id,
      baseRevision: row.base_revision,
      kind: row.kind,
    };
    let plain: Buffer | undefined;
    try {
      plain = decrypt(
        key,
        row,
        operationContext(organizationId, row.actor_id, metadata, Number(row.cursor)),
      );
      const input = parseOperation(JSON.parse(plain.toString('utf8')));
      const { annotation: _, ...identity } = input;
      if (canonical(identity) !== canonical(metadata))
        throw new Error('Operation metadata mismatch.');
      return input;
    } catch {
      throw new SyncError(
        503,
        'encrypted_operation_unavailable',
        'A stored operation could not be authenticated. Keep your local edits and contact the workspace administrator.',
      );
    } finally {
      plain?.fill(0);
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
      const prior = (
        await client.query<OperationRow>(
          'SELECT * FROM margin_sync.operations WHERE organization_id=$1 AND document_id=$2 AND actor_id=$3 AND operation_id=$4',
          [principal.organizationId, input.documentId, principal.userId, input.operationId],
        )
      ).rows[0];
      if (prior) {
        const key = await this.key(client, principal.organizationId, input.documentId);
        try {
          if (canonical(this.decode(key, principal.organizationId, prior)) !== canonical(input))
            throw new SyncError(
              409,
              'idempotency_conflict',
              'This operation identifier already belongs to a different edit. Keep both edits locally.',
            );
          return {
            operationId: input.operationId,
            cursor: Number(prior.cursor),
            annotationRevision: prior.annotation_revision,
            duplicate: true,
          };
        } finally {
          key.fill(0);
        }
      }
      if (input.versionId !== d.current_version_id)
        throw new SyncError(
          409,
          'version_conflict',
          'The document version changed. Preserve this edit locally until it can be remapped.',
          { currentVersionId: d.current_version_id, currentCursor: Number(d.cursor) },
        );
      const page = await client.query(
        'SELECT id FROM margin_sync.pages WHERE organization_id=$1 AND document_id=$2 AND version_id=$3 AND id=$4',
        [principal.organizationId, input.documentId, input.versionId, input.pageId],
      );
      if (!page.rowCount)
        throw new SyncError(
          409,
          'page_unavailable',
          'This page does not belong to the current document version. Preserve this edit locally.',
        );
      const current = (
        await client.query<{ revision: number; version_id: string; page_id: string }>(
          'SELECT revision,version_id,page_id FROM margin_sync.annotations WHERE organization_id=$1 AND document_id=$2 AND annotation_id=$3',
          [principal.organizationId, input.documentId, input.annotationId],
        )
      ).rows[0];
      if ((current?.revision ?? 0) !== input.baseRevision || (!current && input.kind === 'delete'))
        throw new SyncError(
          409,
          'annotation_conflict',
          'This annotation has changed. Keep your edit locally and resolve it against the latest version.',
          { currentRevision: current?.revision ?? 0, currentCursor: Number(d.cursor) },
        );
      if (current && (current.version_id !== input.versionId || current.page_id !== input.pageId))
        throw new SyncError(
          409,
          'annotation_location_conflict',
          'This annotation belongs to a different page or version. Keep this edit locally.',
        );
      const bytes = Buffer.from(canonical(input));
      try {
        if (Number(d.cursor) >= 100000 || Number(d.operation_bytes) + bytes.length > 134217728)
          throw new SyncError(
            413,
            'document_sync_limit',
            'This document has reached its synchronization limit. Keep the edit locally and contact your workspace administrator.',
          );
        const cursor = Number(d.cursor) + 1,
          annotationRevision = input.baseRevision + 1;
        const key = await this.key(client, principal.organizationId, input.documentId);
        let sealed: Ciphertext;
        try {
          sealed = encrypt(
            key,
            bytes,
            operationContext(principal.organizationId, principal.userId, input, cursor),
          );
        } finally {
          key.fill(0);
        }
        await client.query(
          `INSERT INTO margin_sync.operations(organization_id,document_id,cursor,actor_id,operation_id,version_id,page_id,annotation_id,base_revision,annotation_revision,kind,ciphertext,nonce,tag) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
          [
            principal.organizationId,
            input.documentId,
            cursor,
            principal.userId,
            input.operationId,
            input.versionId,
            input.pageId,
            input.annotationId,
            input.baseRevision,
            annotationRevision,
            input.kind,
            sealed.ciphertext,
            sealed.nonce,
            sealed.tag,
          ],
        );
        await client.query(
          `INSERT INTO margin_sync.annotations(organization_id,document_id,annotation_id,version_id,page_id,revision,deleted,latest_cursor) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(organization_id,document_id,annotation_id) DO UPDATE SET revision=EXCLUDED.revision,deleted=EXCLUDED.deleted,latest_cursor=EXCLUDED.latest_cursor`,
          [
            principal.organizationId,
            input.documentId,
            input.annotationId,
            input.versionId,
            input.pageId,
            annotationRevision,
            input.kind === 'delete',
            cursor,
          ],
        );
        await client.query(
          'UPDATE margin_sync.documents SET cursor=$3,operation_bytes=operation_bytes+$4 WHERE organization_id=$1 AND id=$2',
          [principal.organizationId, input.documentId, cursor, bytes.length],
        );
        await client.query(
          'INSERT INTO margin_sync.outbox(organization_id,document_id,cursor) VALUES($1,$2,$3)',
          [principal.organizationId, input.documentId, cursor],
        );
        return { operationId: input.operationId, cursor, annotationRevision, duplicate: false };
      } finally {
        bytes.fill(0);
      }
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
              ...this.decode(key, principal.organizationId, row),
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
