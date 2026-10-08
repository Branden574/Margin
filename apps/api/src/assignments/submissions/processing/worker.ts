import { setImmediate as yieldToEventLoop } from 'node:timers/promises';
import type { PostgresIngestionRepository } from '../../../ingestion/postgres.js';
import type { ArtifactReader } from '../../../ingestion/types.js';
import { bounded } from '../../../cloud/limits.js';
import { SubmissionReplay } from './replay.js';
import { terminalProcessingFailure } from './failures.js';
import {
  SubmissionProcessingError,
  type MaterializationReceipt,
  type PreparedSubmission,
  type SubmissionProcessingClaim,
  type SubmissionProcessingRepository,
} from './types.js';

/** Internal composition only. Neither claims nor prepared tickets are HTTP inputs. */
export type { SubmissionProcessingRepository } from './types.js';

const fail = (code: string) => new SubmissionProcessingError(code);
function check(signal: AbortSignal) {
  if (signal.aborted) throw fail('processor_interrupted');
}
function receipt(
  value: MaterializationReceipt,
  claim: SubmissionProcessingClaim,
  expected?: { frozenCursor: number; chunkCount?: number },
): MaterializationReceipt {
  if (
    !value ||
    value.submissionId !== claim.submissionId ||
    value.workId !== claim.workId ||
    value.state !== 'materialized' ||
    !Number.isSafeInteger(value.frozenCursor) ||
    value.frozenCursor < 0 ||
    value.frozenCursor > 100000 ||
    !Number.isSafeInteger(value.chunkCount) ||
    value.chunkCount < 1 ||
    value.chunkCount > 2048 ||
    !/^[a-f0-9]{64}$/.test(value.manifestSha256) ||
    typeof value.duplicate !== 'boolean' ||
    (expected && value.frozenCursor !== expected.frozenCursor) ||
    (expected?.chunkCount !== undefined && value.chunkCount !== expected.chunkCount)
  )
    throw fail('materialization_receipt_invalid');
  return {
    submissionId: value.submissionId,
    workId: value.workId,
    frozenCursor: value.frozenCursor,
    state: 'materialized',
    manifestSha256: value.manifestSha256,
    chunkCount: value.chunkCount,
    duplicate: value.duplicate,
  };
}

/** Explicit one-job worker. It produces no PDF export, Canvas request or submission acknowledgement. */
export class SubmissionMaterializationWorker {
  private running = false;
  private readonly deadlineMs: number;
  constructor(
    private readonly repository: SubmissionProcessingRepository,
    private readonly reader: PostgresIngestionRepository,
    private readonly storage: ArtifactReader,
    options: { deadlineMs?: number } = {},
  ) {
    this.deadlineMs = options.deadlineMs ?? 540000;
    if (!Number.isSafeInteger(this.deadlineMs) || this.deadlineMs < 1 || this.deadlineMs > 540000)
      throw new Error('Submission processing requires a deadline of at most nine minutes.');
  }

  async runOne(external?: AbortSignal): Promise<MaterializationReceipt | null> {
    if (external?.aborted) throw fail('processor_interrupted');
    if (this.running) throw fail('processor_busy');
    this.running = true;
    let started = false;
    try {
      return await bounded(this.deadlineMs, external, async (signal) => {
        started = true;
        try {
          return await this.process(signal);
        } finally {
          // A provider ignoring AbortSignal still occupies this worker until it settles.
          this.running = false;
        }
      });
    } catch (error) {
      if (error instanceof SubmissionProcessingError) throw error;
      throw fail(
        external?.aborted || (error as { code?: string })?.code === 'operation_aborted'
          ? 'processor_interrupted'
          : 'materialization_unavailable',
      );
    } finally {
      if (!started) this.running = false;
    }
  }

  private async process(signal: AbortSignal): Promise<MaterializationReceipt | null> {
    let claim: SubmissionProcessingClaim | null = null;
    let ticket: PreparedSubmission | undefined;
    let replay: SubmissionReplay | undefined;
    let expected: { frozenCursor: number; chunkCount?: number } | undefined;
    try {
      check(signal);
      claim = await this.repository.claimNext(signal);
      check(signal);
      if (!claim) return null;
      const prepared = await this.repository.prepare(claim, this.reader, this.storage, signal);
      ticket = prepared.ticket;
      check(signal);
      replay = new SubmissionReplay(prepared.replay);
      expected = { frozenCursor: prepared.replay.frozenCursor };
      let cursor = 0;
      while (cursor < expected.frozenCursor) {
        const batch = await this.repository.readBatch(claim, ticket, cursor, signal);
        check(signal);
        if (
          !Array.isArray(batch.operations) ||
          batch.operations.length < 1 ||
          batch.operations.length > 100 ||
          batch.nextCursor !== cursor + batch.operations.length ||
          batch.nextCursor > expected.frozenCursor ||
          batch.hasMore !== batch.nextCursor < expected.frozenCursor
        )
          throw fail('materialization_batch_invalid');
        replay.appendBatch(batch.operations, signal);
        cursor = batch.nextCursor;
        await yieldToEventLoop(undefined, { signal });
        check(signal);
      }
      let chunkCount = 0;
      for (const chunk of replay.chunks(signal)) {
        try {
          check(signal);
          if (chunk.index !== chunkCount || chunk.plaintext.length > 262144)
            throw fail('materialization_chunk_invalid');
          const staged = await this.repository.stageChunk(
            claim,
            ticket,
            chunk.index,
            chunk.plaintext,
            signal,
          );
          check(signal);
          if (
            staged.index !== chunk.index ||
            staged.sha256 !== chunk.sha256 ||
            staged.bytes !== chunk.plaintext.length ||
            typeof staged.duplicate !== 'boolean'
          )
            throw fail('materialization_chunk_invalid');
          chunkCount++;
        } finally {
          chunk.plaintext.fill(0);
        }
        await yieldToEventLoop(undefined, { signal });
        check(signal);
      }
      const summary = replay.summary();
      if (summary.chunkCount !== chunkCount) throw fail('materialization_chunk_invalid');
      expected.chunkCount = chunkCount;
      const completed = await this.repository.complete(claim, ticket, summary, signal);
      check(signal);
      return receipt(completed, claim, expected);
    } catch (error) {
      // Recovery needs only claim identity; release decrypted replay data before any further I/O.
      replay?.dispose();
      replay = undefined;
      if (ticket) this.repository.dispose(ticket);
      ticket = undefined;
      // Only a current authenticated durable receipt can reconcile a lost COMMIT response.
      // After cancellation, leave the lease to expire instead of starting more provider work.
      if (claim && !signal.aborted) {
        const completed = await this.repository.receipt(claim, signal).catch(() => null);
        check(signal);
        if (completed) return receipt(completed, claim, expected);
        const terminal = terminalProcessingFailure(error);
        if (terminal) await this.repository.fail(claim, terminal, signal).catch(() => {});
        else
          await this.repository
            .retry(claim, Math.min(3600, 30 * 2 ** Math.min(claim.attempt - 1, 7)), signal)
            .catch(() => {});
      }
      throw error;
    } finally {
      replay?.dispose();
      if (ticket) this.repository.dispose(ticket);
    }
  }
}
