import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  SubmissionMaterializationWorker,
  type SubmissionProcessingRepository,
} from '../apps/api/src/assignments/submissions/processing/worker';
import {
  SubmissionProcessingError,
  type MaterializationReceipt,
  type MaterializationSummary,
  type PreparedSubmission,
  type SubmissionOperationBatch,
} from '../apps/api/src/assignments/submissions/processing/types';
import type { PostgresIngestionRepository } from '../apps/api/src/ingestion/postgres';
import type { ArtifactReader } from '../apps/api/src/ingestion/types';
import type { CommittedOperation } from '../apps/api/src/sync/types';
import { canonical } from '../apps/api/src/sync/validation';

const id = (n: number) => `a3000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const hash = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
function operation(n: number): CommittedOperation {
  return {
    documentId: id(3),
    versionId: id(4),
    pageId: id(6),
    actorId: id(5),
    annotationId: id(n + 100),
    operationId: id(n + 200000),
    baseRevision: 0,
    annotationRevision: 1,
    cursor: n,
    kind: 'put',
    committedAt: '2026-10-08T12:00:00.000Z',
    annotation: {
      type: 'text',
      x: 10,
      y: 10,
      color: '#112233',
      strokeWidth: 1,
      opacity: 1,
      text: `Synthetic answer ${n}`,
    },
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function fixture(count = 3, deadlineMs?: number) {
  const operations = Array.from({ length: count }, (_, n) => operation(n + 1));
  const expectedCanonicalBytes = operations.reduce((total, value) => {
    const { actorId: _, cursor: __, annotationRevision: ___, committedAt: ____, ...input } = value;
    return total + Buffer.byteLength(canonical(input));
  }, 0);
  const claim = {
    submissionId: id(8),
    workId: id(2),
    claimId: id(9),
    token: 'x'.repeat(43),
    attempt: 1,
    expiresAt: Date.now() + 600000,
  };
  const ticket: PreparedSubmission = Object.freeze({ kind: 'prepared-submission' });
  const prepared = {
    ticket,
    replay: {
      organizationId: id(1),
      workId: id(2),
      documentId: id(3),
      versionId: id(4),
      actorId: id(5),
      frozenCursor: count,
      expectedCanonicalBytes,
      pages: [{ id: id(6), index: 0, width: 612, height: 792 }],
    },
  };
  let completed: MaterializationReceipt | null = null;
  const buffers: Buffer[] = [],
    contents: Array<{ entries: Array<{ annotation?: { text?: string } }> }> = [];
  const repository = {
    claimNext: vi.fn(async () => claim),
    prepare: vi.fn(async () => prepared),
    readBatch: vi.fn(async (_claim, _ticket, after: number): Promise<SubmissionOperationBatch> => {
      const batch = operations.slice(after, after + 100);
      return {
        operations: batch,
        nextCursor: after + batch.length,
        hasMore: after + batch.length < count,
      };
    }),
    stageChunk: vi.fn(async (_claim, _ticket, index: number, plaintext: Buffer) => {
      buffers.push(plaintext);
      contents.push(JSON.parse(plaintext.toString('utf8')));
      return { index, bytes: plaintext.length, sha256: hash(plaintext), duplicate: false };
    }),
    complete: vi.fn(async (_claim, _ticket, summary: MaterializationSummary) => {
      completed = {
        submissionId: claim.submissionId,
        workId: claim.workId,
        frozenCursor: count,
        state: 'materialized',
        manifestSha256: hash(canonical(summary)),
        chunkCount: summary.chunkCount,
        duplicate: false,
      };
      return completed;
    }),
    receipt: vi.fn(async () => completed),
    retry: vi.fn(async () => undefined),
    dispose: vi.fn(),
  } satisfies SubmissionProcessingRepository;
  const worker = new SubmissionMaterializationWorker(
    repository,
    {} as PostgresIngestionRepository,
    {} as ArtifactReader,
    { deadlineMs },
  );
  return { worker, repository, claim, ticket, prepared, operations, buffers, contents };
}
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('bounded submission materialization worker', () => {
  it('replays a complete frozen prefix in bounded batches, stages encrypted inputs, and releases all plaintext buffers', async () => {
    const f = fixture(250);
    const result = await f.worker.runOne();
    expect(result).toMatchObject({
      state: 'materialized',
      frozenCursor: 250,
      workId: f.claim.workId,
    });
    expect(f.repository.readBatch.mock.calls.map((call) => call[2])).toEqual([0, 100, 200]);
    expect(f.contents.flatMap((chunk) => chunk.entries)).toHaveLength(250);
    expect(JSON.stringify(f.contents)).toContain('Synthetic answer 250');
    expect(f.buffers.every((buffer) => buffer.every((byte) => byte === 0))).toBe(true);
    expect(f.repository.dispose).toHaveBeenCalledExactlyOnceWith(f.ticket);
    expect(f.repository.receipt).not.toHaveBeenCalled();
    expect(f.repository.retry).not.toHaveBeenCalled();
  });
  it('materializes an empty capture with an explicit empty chunk without reading mutable history', async () => {
    const f = fixture(0);
    expect(await f.worker.runOne()).toMatchObject({ frozenCursor: 0, chunkCount: 1 });
    expect(f.repository.readBatch).not.toHaveBeenCalled();
    expect(f.contents[0].entries).toEqual([]);
  });
  it('returns null when the authenticated queue has no work', async () => {
    const f = fixture();
    f.repository.claimNext.mockResolvedValueOnce(null as never);
    expect(await f.worker.runOne()).toBeNull();
    expect(f.repository.prepare).not.toHaveBeenCalled();
    expect(f.repository.dispose).not.toHaveBeenCalled();
  });
  it('reconciles a lost completion response only from the durable current receipt', async () => {
    const f = fixture();
    const complete = f.repository.complete.getMockImplementation()!;
    f.repository.complete.mockImplementationOnce(async (...args) => {
      await complete(...args);
      throw Error('Synthetic lost commit response');
    });
    expect(await f.worker.runOne()).toMatchObject({ state: 'materialized', frozenCursor: 3 });
    expect(f.repository.receipt).toHaveBeenCalledOnce();
    expect(f.repository.retry).not.toHaveBeenCalled();
    expect(f.repository.dispose).toHaveBeenCalledOnce();
    expect(f.repository.dispose.mock.invocationCallOrder[0]).toBeLessThan(
      f.repository.receipt.mock.invocationCallOrder[0],
    );
  });
  it('preserves the original request when a completion acknowledgement and receipt lookup are both unavailable', async () => {
    const f = fixture();
    f.repository.complete.mockRejectedValueOnce(Error('Synthetic unavailable commit result'));
    f.repository.receipt.mockRejectedValueOnce(Error('Synthetic receipt unavailable'));
    await expect(f.worker.runOne()).rejects.toMatchObject({ code: 'materialization_unavailable' });
    expect(f.repository.retry).toHaveBeenCalledWith(f.claim, 30, expect.any(AbortSignal));
    expect(f.repository.claimNext).toHaveBeenCalledOnce();
    expect(f.repository.complete).toHaveBeenCalledOnce();
    expect(f.buffers.every((buffer) => buffer.every((byte) => byte === 0))).toBe(true);
  });
  it.each([
    { operations: [], nextCursor: 0, hasMore: true },
    { operations: [operation(1)], nextCursor: 0, hasMore: true },
    { operations: [operation(1)], nextCursor: 1, hasMore: false },
    {
      operations: Array.from({ length: 101 }, (_, n) => operation(n + 1)),
      nextCursor: 101,
      hasMore: false,
    },
  ])(
    'rejects incomplete or unbounded batch progress without staging a partial version: %#',
    async (batch) => {
      const f = fixture();
      f.repository.readBatch.mockResolvedValueOnce(batch);
      await expect(f.worker.runOne()).rejects.toMatchObject({
        code: 'materialization_batch_invalid',
      });
      expect(f.repository.stageChunk).not.toHaveBeenCalled();
      expect(f.repository.complete).not.toHaveBeenCalled();
      expect(f.repository.dispose).toHaveBeenCalledOnce();
    },
  );
  it('refuses an authenticated operation belonging to a different actor before any snapshot can publish', async () => {
    const f = fixture();
    f.operations[1].actorId = id(80);
    await expect(f.worker.runOne()).rejects.toMatchObject({ code: 'snapshot_invalid' });
    expect(f.repository.complete).not.toHaveBeenCalled();
    expect(f.repository.stageChunk).not.toHaveBeenCalled();
  });
  it.each(['index', 'bytes', 'sha256'] as const)(
    'refuses a changed staged %s receipt and wipes the chunk',
    async (field) => {
      const f = fixture();
      const stage = f.repository.stageChunk.getMockImplementation()!;
      f.repository.stageChunk.mockImplementationOnce(async (...args) => {
        const result = await stage(...args);
        return {
          ...result,
          [field]: field === 'sha256' ? '0'.repeat(64) : result[field as 'bytes' | 'index'] + 1,
        };
      });
      await expect(f.worker.runOne()).rejects.toMatchObject({
        code: 'materialization_chunk_invalid',
      });
      expect(f.repository.complete).not.toHaveBeenCalled();
      expect(f.buffers[0].every((byte) => byte === 0)).toBe(true);
    },
  );
  it('refuses a completion receipt from another submission even when recovery repeats it', async () => {
    const f = fixture();
    const result = {
      submissionId: id(90),
      workId: f.claim.workId,
      frozenCursor: 3,
      state: 'materialized' as const,
      manifestSha256: 'b'.repeat(64),
      chunkCount: 1,
      duplicate: false,
    };
    f.repository.complete.mockResolvedValueOnce(result);
    f.repository.receipt.mockResolvedValueOnce(result);
    await expect(f.worker.runOne()).rejects.toMatchObject({
      code: 'materialization_receipt_invalid',
    });
    expect(f.repository.dispose).toHaveBeenCalledOnce();
  });
  it('does no claim work when already cancelled and leaves admission available', async () => {
    const f = fixture(0),
      controller = new AbortController();
    controller.abort();
    await expect(f.worker.runOne(controller.signal)).rejects.toMatchObject({
      code: 'processor_interrupted',
    });
    expect(f.repository.claimNext).not.toHaveBeenCalled();
    expect(await f.worker.runOne()).toMatchObject({ state: 'materialized' });
  });
  it('holds admission after a deadline until ignored provider work settles and disposes its late ticket', async () => {
    vi.useFakeTimers();
    const f = fixture(0, 100),
      gate = deferred<typeof f.prepared>();
    f.repository.prepare.mockReturnValueOnce(gate.promise);
    const run = f.worker.runOne();
    const rejected = expect(run).rejects.toMatchObject({ code: 'processor_interrupted' });
    await vi.advanceTimersByTimeAsync(100);
    await rejected;
    await expect(f.worker.runOne()).rejects.toMatchObject({ code: 'processor_busy' });
    gate.resolve(f.prepared);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.repository.dispose).toHaveBeenCalledExactlyOnceWith(f.ticket);
    expect(f.repository.stageChunk).not.toHaveBeenCalled();
    expect(f.repository.receipt).not.toHaveBeenCalled();
    expect(f.repository.retry).not.toHaveBeenCalled();
    f.repository.claimNext.mockResolvedValueOnce(null as never);
    expect(await f.worker.runOne()).toBeNull();
  });
  it('holds admission while an aborted stage settles, never publishes, then clears plaintext', async () => {
    const f = fixture(),
      controller = new AbortController(),
      entered = deferred<void>(),
      gate = deferred<void>();
    const stage = f.repository.stageChunk.getMockImplementation()!;
    f.repository.stageChunk.mockImplementationOnce(async (...args) => {
      const result = await stage(...args);
      entered.resolve();
      await gate.promise;
      return result;
    });
    const run = f.worker.runOne(controller.signal);
    const rejected = expect(run).rejects.toMatchObject({ code: 'processor_interrupted' });
    await entered.promise;
    controller.abort();
    await rejected;
    await expect(f.worker.runOne()).rejects.toMatchObject({ code: 'processor_busy' });
    gate.resolve();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(f.buffers[0].every((byte) => byte === 0)).toBe(true);
    expect(f.repository.complete).not.toHaveBeenCalled();
    expect(f.repository.dispose).toHaveBeenCalledOnce();
    expect(f.repository.receipt).not.toHaveBeenCalled();
  });
  it('cleans prepared state even when replay context is invalid', async () => {
    const f = fixture();
    f.prepared.replay.expectedCanonicalBytes = 0;
    await expect(f.worker.runOne()).rejects.toMatchObject({ code: 'snapshot_invalid' });
    expect(f.repository.dispose).toHaveBeenCalledOnce();
    expect(f.repository.readBatch).not.toHaveBeenCalled();
  });
  it('does not leak provider exception text in worker errors', async () => {
    const f = fixture();
    f.repository.prepare.mockRejectedValueOnce(
      Error('Synthetic provider credentials must not escape'),
    );
    const error = await f.worker.runOne().catch((value) => value);
    expect(error).toBeInstanceOf(SubmissionProcessingError);
    expect(error.message).not.toContain('credentials');
    expect(error.code).toBe('materialization_unavailable');
  });
  it.each([0, -1, 540001, Infinity, NaN, 1.5])('rejects unsafe job deadlines %s', (deadlineMs) => {
    expect(() => fixture(0, deadlineMs)).toThrow('deadline');
  });
});
