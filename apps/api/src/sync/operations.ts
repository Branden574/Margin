import type { PoolClient } from 'pg';
import type { SessionPrincipal } from '../identity/types.js';
import { decrypt, encrypt, operationContext, type Ciphertext } from './encryption.js';
import { canonical, parseOperation } from './validation.js';
import {
  SyncError,
  type AppendOperation,
  type AppendReceipt,
  type DocumentPermission,
} from './types.js';
export interface DocumentRow {
  id: string;
  current_version_id: string;
  cursor: string;
  operation_bytes: string;
  audience: 'members' | 'teachers';
  permission: DocumentPermission;
}
export interface OperationRow extends Ciphertext {
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
export function decodeOperation(
  key: Buffer,
  organizationId: string,
  row: OperationRow,
): AppendOperation {
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

/** Caller owns authorization, document lock, transaction and key lifecycle. No remote I/O except the supplied key callback. */
export async function commitOperation(
  client: PoolClient,
  principal: SessionPrincipal,
  input: AppendOperation,
  d: DocumentRow,
  getKey: () => Promise<Buffer>,
): Promise<AppendReceipt> {
  const prior = (
    await client.query<OperationRow>(
      'SELECT * FROM margin_sync.operations WHERE organization_id=$1 AND document_id=$2 AND actor_id=$3 AND operation_id=$4',
      [principal.organizationId, input.documentId, principal.userId, input.operationId],
    )
  ).rows[0];
  if (prior) {
    const key = await getKey();
    try {
      if (canonical(decodeOperation(key, principal.organizationId, prior)) !== canonical(input))
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
    const key = await getKey();
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
}
