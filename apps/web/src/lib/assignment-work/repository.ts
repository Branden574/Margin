import type { AnnotationOperation, DocumentRecord } from '@margin/core';
import { createVaultGuard, vaultTransaction, type VaultTransaction } from '../vault';
import { notifyAssignmentChange } from '../storage';
import { readVerifiedSnapshot, type VerifiedAssignmentSnapshot } from './client';
import * as decode from './decode';
import {
  assignmentIdentity,
  canonical,
  fromAssignmentOperation,
  repositoryError,
  sameAssignmentIdentity,
  toAssignmentOperation,
} from './mapping';
import { inspectAssignmentSource } from './sourceInspection';
import {
  MAX_BASELINE_ANNOTATIONS,
  MAX_BASELINE_BYTES,
  MAX_OUTBOX_BYTES,
  MAX_OUTBOX_OPERATIONS,
  AssignmentRetryError,
  type AssignmentBaseline,
  type AssignmentBinding,
  type AssignmentIdentity,
  type AssignmentOutboxEntry,
  type AssignmentSnapshot,
} from './repositoryTypes';
import type { AppendOperation, AppendReceipt, CatchUpResult } from './types';

const size = (value: unknown) => new TextEncoder().encode(canonical(value)).byteLength;
const rowKey = (documentId: string, id: string) => `${documentId}:${id}`;
const indexKey = (identity: AssignmentIdentity) => `assignment-copy:${canonical(identity)}`;
interface AppliedReceipt {
  operationId: string;
  cursor: number;
  annotationRevision: number;
}
function assertVerified(binding: AssignmentBinding, verified: VerifiedAssignmentSnapshot) {
  const data = readVerifiedSnapshot(verified);
  if (
    !sameAssignmentIdentity(binding.identity, assignmentIdentity(data)) ||
    canonical(data.manifest.assignment) !== canonical(binding.manifest.assignment) ||
    data.manifest.work?.status !== 'provisioned' ||
    binding.manifest.work?.status !== 'provisioned' ||
    canonical(data.manifest.work.document.pages) !== canonical(binding.manifest.work.document.pages)
  )
    repositoryError(
      'binding_mismatch',
      'This verified launch does not match the locally saved assignment.',
    );
  return data;
}
async function load(tx: VaultTransaction, documentId: string, expectedRevision?: string) {
  const binding = await tx.get<AssignmentBinding>('assignment-bindings', documentId);
  const document = await tx.get<DocumentRecord>('documents', documentId);
  if (
    !binding ||
    binding.schema !== 1 ||
    !document ||
    binding.localDocumentId !== documentId ||
    binding.contentRevision !== document.contentRevision ||
    (expectedRevision !== undefined && expectedRevision !== binding.contentRevision) ||
    binding.manifest.work?.status !== 'provisioned' ||
    document.pageCount !== binding.manifest.work.document.pages.length ||
    !Array.isArray(binding.queue) ||
    binding.queue.length > MAX_OUTBOX_OPERATIONS ||
    !Array.isArray(binding.baselineIds) ||
    binding.baselineIds.length > MAX_BASELINE_ANNOTATIONS
  )
    return repositoryError(
      'stale_binding',
      'The saved assignment or PDF revision changed. Reopen its verified launch.',
    );
  return { binding, document };
}
async function queue(tx: VaultTransaction, binding: AssignmentBinding) {
  const rows: AssignmentOutboxEntry[] = [];
  for (const id of binding.queue) {
    const row = await tx.get<AssignmentOutboxEntry>(
      'assignment-outbox',
      rowKey(binding.localDocumentId, id),
    );
    if (
      !row ||
      row.schema !== 1 ||
      row.operation.operationId !== id ||
      row.localDocumentId !== binding.localDocumentId
    )
      return repositoryError('invalid_outbox', 'The encrypted assignment queue is incomplete.');
    rows.push(row);
  }
  return rows;
}
async function commit<T>(
  documentId: string,
  work: (tx: VaultTransaction) => Promise<T>,
  signal?: AbortSignal,
  lifecycleGuard?: () => void,
) {
  const guard = createVaultGuard();
  const result = await vaultTransaction(work, { signal, guard: lifecycleGuard });
  guard();
  notifyAssignmentChange(documentId);
  // Notifications may run synchronous listeners. Recheck immediately before
  // releasing a result, even when the encrypted transaction has already committed.
  lifecycleGuard?.();
  return result;
}

/** New IDs only. Input provenance comes from a live client; the repository never calls the network. */
export async function createVerifiedWorkCopy(
  verified: VerifiedAssignmentSnapshot,
  signal?: AbortSignal,
): Promise<DocumentRecord> {
  const guard = createVaultGuard();
  const data = readVerifiedSnapshot(verified);
  const identity = assignmentIdentity(data);
  if (!data.source)
    return repositoryError(
      'source_required',
      'Retrieve the verified assignment source before creating a local copy.',
    );
  const inspection = await inspectAssignmentSource(data.source, signal);
  guard();
  readVerifiedSnapshot(verified);
  const work = data.manifest.work;
  if (
    work?.status !== 'provisioned' ||
    inspection.pages.length !== work.document.pages.length ||
    inspection.pages.some((page, i) =>
      ['width', 'height'].some((axis) => {
        const key = axis as 'width' | 'height';
        return Math.abs(page[key] - work.document.pages[i][key]) > 1e-7 * Math.max(1, page[key]);
      }),
    )
  )
    return repositoryError(
      'source_geometry_mismatch',
      'The PDF pages do not match the verified assignment manifest.',
    );
  const id = crypto.randomUUID(),
    contentRevision = crypto.randomUUID(),
    now = Date.now();
  const document: DocumentRecord = {
    id,
    contentRevision,
    name: data.manifest.assignment.title,
    mimeType: 'application/pdf',
    size: data.source.size,
    pageCount: inspection.pages.length,
    createdAt: now,
    updatedAt: now,
    folderId: null,
    starred: false,
    trashed: false,
    cover: 'import',
    source: 'created',
  };
  const binding: AssignmentBinding = {
    schema: 1,
    localDocumentId: id,
    contentRevision,
    sourceSha256: inspection.sha256,
    identity,
    manifest: data.manifest,
    createdSessionId: data.session.sessionId,
    appliedCursor: 0,
    observedCursor: work.document.cursor,
    nextSequence: 1,
    queue: [],
    queueBytes: 0,
    baselineIds: [],
    baselineBytes: 0,
    hydrated: work.document.cursor === 0,
  };
  return commit(
    id,
    async (tx) => {
      readVerifiedSnapshot(verified);
      if (await tx.has('settings', indexKey(binding.identity)))
        return repositoryError(
          'already_bound',
          'A local copy of this assignment already exists. Open that copy instead.',
        );
      if (await tx.has('documents', id))
        return repositoryError(
          'identifier_collision',
          'The local document identifier is already in use.',
        );
      tx.put('documents', id, document);
      tx.put('blobs', id, data.source);
      tx.put('assignment-bindings', id, binding);
      tx.put('settings', indexKey(binding.identity), { localDocumentId: id });
      return document;
    },
    signal,
    () => {
      readVerifiedSnapshot(verified);
    },
  );
}

/** Resolve only a verified identity; the eventual blob read must authenticate PDF ciphertext before display. */
export async function findVerifiedWorkCopy(
  verified: VerifiedAssignmentSnapshot,
  signal?: AbortSignal,
): Promise<DocumentRecord | undefined> {
  const guard = createVaultGuard();
  const identity = assignmentIdentity(readVerifiedSnapshot(verified));
  const assertLive = () => {
    guard();
    if (signal?.aborted)
      throw new DOMException('This assignment lookup was cancelled.', 'AbortError');
    readVerifiedSnapshot(verified);
  };
  const document = await vaultTransaction(
    async (tx) => {
      const index = await tx.get<unknown>('settings', indexKey(identity));
      if (index === undefined) return undefined;
      let documentId: string;
      try {
        if (!index || typeof index !== 'object' || Array.isArray(index)) throw new Error();
        const value = index as Record<string, unknown>;
        documentId = decode.id(value.localDocumentId);
        if (documentId !== value.localDocumentId || Object.keys(value).length !== 1)
          throw new Error();
      } catch {
        return repositoryError('invalid_copy_index', 'The saved assignment copy index is damaged.');
      }
      const { binding, document } = await load(tx, documentId);
      assertVerified(binding, verified);
      if (
        document.id !== documentId ||
        typeof document.contentRevision !== 'string' ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
          document.contentRevision,
        )
      )
        return repositoryError('stale_binding', 'The saved assignment PDF revision is damaged.');
      if (!(await tx.has('blobs', documentId)))
        return repositoryError('source_missing', 'The saved assignment PDF is missing.');
      return structuredClone(document);
    },
    { signal, guard: assertLive },
  );
  guard();
  assertLive();
  return document;
}

/** Local data only. Wire payloads are deliberately absent; this does not authorize dispatch. */
export async function readAssignmentSnapshot(
  documentId: string,
  expectedRevision?: string,
  signal?: AbortSignal,
): Promise<AssignmentSnapshot> {
  return vaultTransaction(
    async (tx) => {
      const { binding, document } = await load(tx, documentId, expectedRevision);
      const annotations = new Map<string, NonNullable<AssignmentBaseline['annotation']>>();
      for (const id of binding.baselineIds) {
        const baseline = await tx.get<AssignmentBaseline>(
          'assignment-baseline',
          rowKey(documentId, id),
        );
        if (!baseline)
          return repositoryError(
            'invalid_baseline',
            'The encrypted assignment baseline is incomplete.',
          );
        if (baseline.annotation) annotations.set(id, baseline.annotation);
      }
      const pending = await queue(tx, binding);
      for (const row of pending) {
        if (row.local.kind === 'delete') annotations.delete(row.local.annotationId);
        else annotations.set(row.local.annotationId, row.local.annotation!);
      }
      return structuredClone({
        document,
        binding,
        annotations: [...annotations.values()].sort(
          (a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id),
        ),
        pending: pending.map((row) => ({
          operationId: row.operation.operationId,
          annotationId: row.operation.annotationId,
          status: row.status,
        })),
      });
    },
    { signal },
  );
}

/** Local annotation journal + immutable wire row + queue index commit together. */
export async function enqueueAssignmentOperation(
  documentId: string,
  expectedRevision: string,
  value: AnnotationOperation,
  signal?: AbortSignal,
  expectedAppliedCursor?: number,
): Promise<void> {
  const local = structuredClone(value);
  if (
    expectedAppliedCursor !== undefined &&
    (!Number.isSafeInteger(expectedAppliedCursor) ||
      expectedAppliedCursor < 0 ||
      expectedAppliedCursor > 100_000)
  )
    return repositoryError('invalid_editor_cursor', 'The rendered assignment cursor is invalid.');
  try {
    if (decode.id(local.id) !== local.id || decode.id(local.annotationId) !== local.annotationId)
      throw new Error();
  } catch {
    return repositoryError(
      'invalid_local_operation',
      'Assignment operation and annotation IDs must be canonical lowercase UUIDs.',
    );
  }
  if (size(local) > 131_072)
    return repositoryError(
      'operation_limit',
      'This local edit exceeds the assignment operation limit.',
    );
  await commit(
    documentId,
    async (tx) => {
      const { binding, document } = await load(tx, documentId, expectedRevision);
      if (!binding.hydrated)
        return repositoryError(
          'catch_up_required',
          'Recover existing assignment annotations before editing.',
        );
      const existing = await tx.get<AnnotationOperation>('annotations', local.id);
      if (existing) {
        if (canonical(existing) !== canonical(local))
          return repositoryError(
            'local_operation_conflict',
            'This operation identifier already belongs to a different local edit.',
          );
        return;
      }
      // An identical persisted operation above is an idempotent confirmation,
      // not a new edit. Never derive a new revision from an unseen baseline.
      if (expectedAppliedCursor !== undefined && binding.appliedCursor !== expectedAppliedCursor)
        return repositoryError(
          'stale_editor_cursor',
          'Assignment updates arrived from another tab. Your draft has been kept; refresh the saved work before editing again.',
        );
      const rows = await queue(tx, binding);
      const previous = [...rows]
        .reverse()
        .find((row) => row.operation.annotationId === local.annotationId);
      const baseline = await tx.get<AssignmentBaseline>(
        'assignment-baseline',
        rowKey(documentId, local.annotationId),
      );
      const baseRevision = previous
        ? previous.operation.baseRevision + 1
        : (baseline?.revision ?? 0);
      const operation = toAssignmentOperation(
        local,
        binding,
        baseRevision,
        previous?.operation.pageId ?? baseline?.pageId,
      );
      if ((previous?.operation.pageId ?? baseline?.pageId ?? operation.pageId) !== operation.pageId)
        return repositoryError(
          'annotation_location_conflict',
          'An existing annotation cannot move to a different assignment page.',
        );
      if (operation.kind === 'delete' && !previous && !baseline)
        return repositoryError(
          'annotation_missing',
          'The annotation cannot be deleted before it exists.',
        );
      const bytes = size({ local, operation });
      if (
        binding.queue.length >= MAX_OUTBOX_OPERATIONS ||
        binding.queueBytes + bytes > MAX_OUTBOX_BYTES
      )
        return repositoryError(
          'outbox_limit',
          'The encrypted assignment queue is full. Existing drafts remain saved.',
        );
      const row: AssignmentOutboxEntry = {
        schema: 1,
        localDocumentId: documentId,
        sequence: binding.nextSequence++,
        local,
        operation,
        bytes,
        status: previous?.status === 'conflict' ? 'conflict' : 'queued',
        ...(previous?.status === 'conflict' ? { conflictCode: previous.conflictCode } : {}),
      };
      binding.queue.push(operation.operationId);
      binding.queueBytes += bytes;
      tx.put('annotations', local.id, local);
      tx.put('documents', documentId, {
        ...document,
        updatedAt: Math.max(document.updatedAt, local.timestamp),
      });
      tx.put('assignment-outbox', rowKey(documentId, local.id), row);
      tx.put('assignment-bindings', documentId, binding);
    },
    signal,
  );
}

/** Fresh provenance is required before releasing any wire row. Caller still owns server authorization and dispatch. */
export async function prepareAssignmentSend(
  documentId: string,
  expectedRevision: string,
  verified: VerifiedAssignmentSnapshot,
  retryOperationId?: string,
  signal?: AbortSignal,
): Promise<AppendOperation | null> {
  if (retryOperationId !== undefined) {
    try {
      if (decode.id(retryOperationId) !== retryOperationId) throw new Error();
    } catch {
      throw new AssignmentRetryError(
        'invalid_retry_operation',
        retryOperationId,
        'Choose the exact canonical operation ID to retry.',
      );
    }
  }
  return commit(
    documentId,
    async (tx) => {
      const { binding } = await load(tx, documentId, expectedRevision);
      const data = assertVerified(binding, verified);
      const rows = await queue(tx, binding),
        row = rows.find((candidate) => candidate.status !== 'acknowledged');
      if (retryOperationId !== undefined) {
        const intended = rows.find(
          (candidate) => candidate.operation.operationId === retryOperationId,
        );
        const applied = await tx.get<AppliedReceipt>(
          'assignment-receipts',
          rowKey(documentId, retryOperationId),
        );
        if (intended?.status === 'acknowledged' || applied)
          throw new AssignmentRetryError(
            'retry_reconciled',
            retryOperationId,
            'This operation was already confirmed. Reload its saved state before continuing.',
          );
        if (!intended || !['sending', 'uncertain', 'conflict'].includes(intended.status))
          throw new AssignmentRetryError(
            'retry_not_pending',
            retryOperationId,
            'This operation has no unresolved send to retry.',
          );
        if (intended !== row)
          throw new AssignmentRetryError(
            'retry_not_head',
            retryOperationId,
            'Resolve the earlier queued operation before retrying this operation.',
          );
      }
      const serverCursor =
        data.manifest.work?.status === 'provisioned'
          ? data.manifest.work.document.cursor
          : Infinity;
      if (!binding.hydrated || binding.appliedCursor < serverCursor)
        return repositoryError(
          'catch_up_required',
          'Recover the current assignment operations before sending drafts.',
        );
      if (!row) return null;
      if (row.status === 'conflict')
        return repositoryError(
          'outbox_conflict',
          'Resolve the saved assignment conflict before sending later edits.',
        );
      if (
        (row.status === 'sending' || row.status === 'uncertain') &&
        retryOperationId === undefined
      )
        return repositoryError(
          'uncertain_save',
          'Retry the exact saved operation to resolve its uncertain outcome.',
        );
      row.status = 'sending';
      row.dispatchedCursor ??= binding.observedCursor;
      assertVerified(binding, verified);
      tx.put('assignment-outbox', rowKey(documentId, row.operation.operationId), row);
      return structuredClone(row.operation);
    },
    signal,
    () => {
      readVerifiedSnapshot(verified);
    },
  );
}

export async function acknowledgeAssignmentOperation(
  documentId: string,
  expectedRevision: string,
  receipt: AppendReceipt,
  signal?: AbortSignal,
): Promise<void> {
  const input = structuredClone(receipt);
  await commit(
    documentId,
    async (tx) => {
      const { binding } = await load(tx, documentId, expectedRevision);
      const key = rowKey(documentId, input.operationId);
      const row = await tx.get<AssignmentOutboxEntry>('assignment-outbox', key);
      if (!row) {
        const applied = await tx.get<AppliedReceipt>('assignment-receipts', key);
        if (
          !applied ||
          input.operationId !== applied.operationId ||
          input.cursor !== applied.cursor ||
          input.annotationRevision !== applied.annotationRevision
        )
          return repositoryError(
            'receipt_mismatch',
            'The acknowledgement does not match a saved operation.',
          );
        return;
      }
      if (!['sending', 'uncertain', 'acknowledged'].includes(row.status))
        return repositoryError('receipt_mismatch', 'This operation was not sent.');
      const checked = decode.receipt({ receipt: input }, row.operation, row.dispatchedCursor ?? 0);
      if (
        row.receipt &&
        (row.receipt.cursor !== checked.cursor ||
          row.receipt.annotationRevision !== checked.annotationRevision)
      )
        return repositoryError('receipt_mismatch', 'The acknowledgement changed identity.');
      row.status = 'acknowledged';
      row.receipt = checked;
      binding.observedCursor = Math.max(binding.observedCursor, checked.cursor);
      tx.put('assignment-outbox', key, row);
      tx.put('assignment-bindings', documentId, binding);
    },
    signal,
  );
}
export async function markAssignmentOutcome(
  documentId: string,
  expectedRevision: string,
  operationId: string,
  outcome: 'uncertain' | 'conflict',
  code?: string,
  signal?: AbortSignal,
): Promise<void> {
  if (code !== undefined && !/^[a-z][a-z0-9_]{0,79}$/.test(code))
    return repositoryError('invalid_outcome', 'The assignment outcome code is invalid.');
  await commit(
    documentId,
    async (tx) => {
      const { binding } = await load(tx, documentId, expectedRevision);
      const rows = await queue(tx, binding),
        row = rows.find((candidate) => candidate.operation.operationId === operationId);
      if (!row || !['sending', 'uncertain'].includes(row.status))
        return repositoryError('invalid_outcome', 'This operation has no pending send.');
      row.status = outcome;
      if (outcome === 'conflict') row.conflictCode = code ?? 'annotation_conflict';
      tx.put('assignment-outbox', rowKey(documentId, operationId), row);
    },
    signal,
  );
}

/** Contiguous server baseline + pending overlay acknowledgement move in one encrypted transaction. */
export async function applyAssignmentCatchUp(
  documentId: string,
  expectedRevision: string,
  verified: VerifiedAssignmentSnapshot,
  afterCursor: number,
  value: CatchUpResult,
  signal?: AbortSignal,
): Promise<void> {
  const input = structuredClone(value);
  await commit(
    documentId,
    async (tx) => {
      const { binding } = await load(tx, documentId, expectedRevision);
      assertVerified(binding, verified);
      if (binding.appliedCursor !== afterCursor)
        return repositoryError(
          'stale_cursor',
          'The assignment catch-up cursor changed. Reload it before continuing.',
        );
      const result = decode.catchUp(
        input,
        binding.manifest,
        binding.identity.userId,
        afterCursor,
        100,
        afterCursor,
      );
      const rows = await queue(tx, binding);
      for (const operation of result.operations) {
        const key = rowKey(documentId, operation.annotationId);
        const prior = await tx.get<AssignmentBaseline>('assignment-baseline', key);
        if (
          (prior?.revision ?? 0) !== operation.baseRevision ||
          (prior && prior.pageId !== operation.pageId) ||
          (!prior && operation.kind === 'delete')
        )
          return repositoryError(
            'revision_mismatch',
            'The server operation does not follow the saved annotation baseline.',
          );
        const echo = rows.find((row) => row.operation.operationId === operation.operationId);
        const { actorId: _, cursor, annotationRevision, committedAt: _time, ...wire } = operation;
        if (echo) {
          if (
            canonical(echo.operation) !== canonical(wire) ||
            (echo.receipt &&
              (echo.receipt.cursor !== cursor ||
                echo.receipt.annotationRevision !== annotationRevision))
          )
            return repositoryError(
              'echo_mismatch',
              'The server echo differs from the exact saved operation.',
            );
          binding.queue = binding.queue.filter((id) => id !== operation.operationId);
          binding.queueBytes -= echo.bytes;
          tx.delete('assignment-outbox', rowKey(documentId, operation.operationId));
          tx.put('assignment-receipts', rowKey(documentId, operation.operationId), {
            operationId: operation.operationId,
            cursor,
            annotationRevision,
          } satisfies AppliedReceipt);
        } else {
          for (const row of rows)
            if (
              binding.queue.includes(row.operation.operationId) &&
              row.operation.annotationId === operation.annotationId
            ) {
              row.status = 'conflict';
              row.conflictCode = 'annotation_conflict';
              tx.put('assignment-outbox', rowKey(documentId, row.operation.operationId), row);
            }
        }
        const baseline: AssignmentBaseline = {
          annotationId: operation.annotationId,
          pageId: operation.pageId,
          revision: annotationRevision,
          cursor,
          annotation: fromAssignmentOperation(
            operation,
            binding,
            echo?.local.annotation ?? prior?.annotation,
          ),
        };
        binding.baselineBytes += size(baseline) - (prior ? size(prior) : 0);
        if (!prior) binding.baselineIds.push(operation.annotationId);
        if (
          binding.baselineIds.length > MAX_BASELINE_ANNOTATIONS ||
          binding.baselineBytes > MAX_BASELINE_BYTES
        )
          return repositoryError(
            'baseline_limit',
            'The assignment baseline exceeds this browser workspace limit. Drafts remain saved.',
          );
        tx.put('assignment-baseline', key, baseline);
      }
      binding.appliedCursor = result.nextCursor;
      binding.observedCursor = Math.max(binding.observedCursor, result.currentCursor);
      const initialCursor =
        binding.manifest.work?.status === 'provisioned'
          ? binding.manifest.work.document.cursor
          : Infinity;
      binding.hydrated ||= binding.appliedCursor >= initialCursor;
      assertVerified(binding, verified);
      tx.put('assignment-bindings', documentId, binding);
    },
    signal,
    () => {
      readVerifiedSnapshot(verified);
    },
  );
}
