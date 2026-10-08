import { createHash } from 'node:crypto';
import type { CommittedOperation, SyncAnnotation } from '../../../sync/types.js';
import { canonical, identifier, parseOperation } from '../../../sync/validation.js';
import {
  SubmissionProcessingError,
  type MaterializationSummary,
  type SubmissionReplayContext,
} from './types.js';

const MAX_OPERATIONS = 100000;
const MAX_OPERATION_BYTES = 134217728;
export const MAX_SUBMISSION_CHUNK_BYTES = 262144;

export interface SubmissionReplayEntry {
  annotationId: string;
  pageId: string;
  revision: number;
  latestCursor: number;
  deleted: boolean;
  /** First accepted put cursor, matching the synced editor's persistent baselineIds. */
  layerOrder: number | null;
  annotation?: SyncAnnotation;
}
export interface SubmissionReplayChunk {
  index: number;
  /** The caller must erase this buffer after durable encrypted staging. */
  plaintext: Buffer;
  sha256: string;
  entries: number;
}

function invalid(): never {
  throw new SubmissionProcessingError('snapshot_invalid');
}
function integer(value: unknown, max: number): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= max;
}
function uuid(value: unknown): value is string {
  return identifier(value) === value;
}
function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
function checkSignal(signal?: AbortSignal) {
  if (signal?.aborted) throw new SubmissionProcessingError('processing_cancelled');
}

/**
 * Replay only the authenticated, immutable operation prefix supplied by the repository.
 * No mutable annotation table, provider call, key, or browser state enters this module.
 * Append is capped at 100 operations so a worker can yield/check its lease between calls.
 */
export class SubmissionReplay {
  private context: SubmissionReplayContext | null;
  private readonly pages = new Set<string>();
  private readonly operationIds = new Set<string>();
  private readonly entries = new Map<string, SubmissionReplayEntry>();
  private readonly firstCursors = new Map<string, number>();
  private cursor = 0;
  private canonicalBytes = 0;
  private state: 'appending' | 'chunking' | 'finished' | 'disposed' = 'appending';
  private result: MaterializationSummary | null = null;
  private activeChunk: Buffer | undefined;

  constructor(context: SubmissionReplayContext) {
    this.context = null;
    try {
      if (
        !record(context) ||
        Object.keys(context).length !== 8 ||
        ![
          context.organizationId,
          context.workId,
          context.documentId,
          context.versionId,
          context.actorId,
        ].every(uuid) ||
        !integer(context.frozenCursor, MAX_OPERATIONS) ||
        !integer(context.expectedCanonicalBytes, MAX_OPERATION_BYTES) ||
        (context.frozenCursor === 0) !== (context.expectedCanonicalBytes === 0) ||
        !Array.isArray(context.pages) ||
        context.pages.length < 1 ||
        context.pages.length > 2000
      )
        invalid();
      for (const [index, page] of context.pages.entries()) {
        if (
          !record(page) ||
          Object.keys(page).length !== 4 ||
          !uuid(page.id) ||
          page.index !== index ||
          this.pages.has(page.id) ||
          ![page.width, page.height].every(
            (value) =>
              typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= 100000,
          )
        )
          invalid();
        this.pages.add(page.id);
      }
      this.context = structuredClone(context);
    } catch {
      this.dispose();
      invalid();
    }
  }

  appendBatch(operations: readonly CommittedOperation[], signal?: AbortSignal): void {
    try {
      checkSignal(signal);
      if (
        this.state !== 'appending' ||
        !this.context ||
        !Array.isArray(operations) ||
        operations.length > 100
      )
        invalid();
      for (const value of operations) {
        checkSignal(signal);
        if (!record(value)) invalid();
        const { actorId, cursor, annotationRevision, committedAt, ...wire } = value;
        const operation = parseOperation(wire);
        const encoded = canonical(operation);
        if (
          canonical(wire) !== encoded ||
          actorId !== this.context.actorId ||
          cursor !== this.cursor + 1 ||
          cursor > this.context.frozenCursor ||
          !integer(annotationRevision, MAX_OPERATIONS) ||
          annotationRevision !== operation.baseRevision + 1 ||
          operation.documentId !== this.context.documentId ||
          operation.versionId !== this.context.versionId ||
          !this.pages.has(operation.pageId) ||
          this.operationIds.has(operation.operationId) ||
          typeof committedAt !== 'string' ||
          !Number.isFinite(Date.parse(committedAt)) ||
          new Date(committedAt).toISOString() !== committedAt
        )
          invalid();
        const prior = this.entries.get(operation.annotationId);
        if (
          (prior?.revision ?? 0) !== operation.baseRevision ||
          (!prior && operation.kind === 'delete') ||
          (prior && prior.pageId !== operation.pageId)
        )
          invalid();
        const bytes = Buffer.byteLength(encoded);
        if (
          this.canonicalBytes + bytes > this.context.expectedCanonicalBytes ||
          this.canonicalBytes + bytes > MAX_OPERATION_BYTES
        )
          invalid();
        const firstCursor = this.firstCursors.get(operation.annotationId) ?? cursor;
        this.firstCursors.set(operation.annotationId, firstCursor);
        this.entries.set(operation.annotationId, {
          annotationId: operation.annotationId,
          pageId: operation.pageId,
          revision: annotationRevision,
          latestCursor: cursor,
          deleted: operation.kind === 'delete',
          layerOrder: operation.kind === 'delete' ? null : firstCursor,
          ...(operation.annotation ? { annotation: operation.annotation } : {}),
        });
        this.operationIds.add(operation.operationId);
        this.cursor = cursor;
        this.canonicalBytes += bytes;
      }
    } catch (error) {
      this.dispose();
      if (error instanceof SubmissionProcessingError) throw error;
      invalid();
    }
  }

  /** One-shot bounded output. The worker controls scheduling between generator.next calls. */
  *chunks(signal?: AbortSignal): Generator<SubmissionReplayChunk, undefined, unknown> {
    let active: Buffer | undefined;
    let finished = false;
    try {
      checkSignal(signal);
      const context = this.context;
      if (
        this.state !== 'appending' ||
        !context ||
        this.cursor !== context.frozenCursor ||
        this.canonicalBytes !== context.expectedCanonicalBytes
      )
        invalid();
      this.state = 'chunking';
      const ids = [...this.entries.keys()].sort();
      const hash = createHash('sha256');
      let outputBytes = 0;
      let index = 0;
      let offset = 0;
      // A canonical chunk contains its exact immutable identity, even when empty.
      do {
        checkSignal(signal);
        const envelope = {
          schema: 1,
          organizationId: context.organizationId,
          workId: context.workId,
          documentId: context.documentId,
          versionId: context.versionId,
          frozenCursor: context.frozenCursor,
          index,
          entries: [] as SubmissionReplayEntry[],
        };
        // Add entry bytes and commas to the envelope's existing empty-array brackets.
        let bytes = Buffer.byteLength(canonical(envelope));
        const encodedEntries: string[] = [];
        while (offset < ids.length) {
          checkSignal(signal);
          const encoded = canonical(this.entries.get(ids[offset])!);
          const added = Buffer.byteLength(encoded) + (encodedEntries.length ? 1 : 0);
          if (bytes + added > MAX_SUBMISSION_CHUNK_BYTES) {
            if (!encodedEntries.length) invalid();
            break;
          }
          encodedEntries.push(encoded);
          bytes += added;
          offset++;
        }
        const emptyEnvelope = canonical(envelope);
        const payload = emptyEnvelope.replace(
          '"entries":[]',
          `"entries":[${encodedEntries.join(',')}]`,
        );
        active = Buffer.from(payload);
        this.activeChunk = active;
        if (active.length !== bytes || active.length > MAX_SUBMISSION_CHUNK_BYTES) invalid();
        hash.update(active);
        outputBytes += active.length;
        const chunk = {
          index,
          plaintext: active,
          sha256: createHash('sha256').update(active).digest('hex'),
          entries: encodedEntries.length,
        };
        index++;
        yield chunk;
        if (this.state !== 'chunking') invalid();
        active.fill(0);
        this.activeChunk = undefined;
        active = undefined;
      } while (offset < ids.length);
      checkSignal(signal);
      this.result = {
        schema: 1,
        frozenCursor: context.frozenCursor,
        operationCount: this.cursor,
        canonicalOperationBytes: this.canonicalBytes,
        annotationCount: this.entries.size,
        outputBytes,
        chunkCount: index,
        outputSha256: hash.digest('hex'),
      };
      this.state = 'finished';
      finished = true;
      this.clearRetained();
    } catch (error) {
      if (error instanceof SubmissionProcessingError) throw error;
      invalid();
    } finally {
      active?.fill(0);
      if (!finished) this.dispose();
      else this.activeChunk = undefined;
    }
  }

  summary(): MaterializationSummary {
    if (this.state !== 'finished' || !this.result) {
      this.dispose();
      invalid();
    }
    return { ...this.result };
  }

  private clearRetained() {
    this.context = null;
    this.entries.clear();
    this.operationIds.clear();
    this.pages.clear();
    this.firstCursors.clear();
  }

  dispose(): void {
    this.activeChunk?.fill(0);
    this.activeChunk = undefined;
    this.clearRetained();
    this.result = null;
    this.cursor = 0;
    this.canonicalBytes = 0;
    this.state = 'disposed';
  }
}
