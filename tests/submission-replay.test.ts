import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  MAX_SUBMISSION_CHUNK_BYTES,
  SubmissionReplay,
  type SubmissionReplayEntry,
} from '../apps/api/src/assignments/submissions/processing/replay';
import type { SubmissionReplayContext } from '../apps/api/src/assignments/submissions/processing/types';
import type { CommittedOperation } from '../apps/api/src/sync/types';
import { canonical } from '../apps/api/src/sync/validation';

const id = (number: number) => `60000000-0000-4000-8000-${number.toString(16).padStart(12, '0')}`;
const documentId = id(1),
  versionId = id(2),
  pageId = id(3),
  actorId = id(4);
function operation(cursor = 1, change: Partial<CommittedOperation> = {}): CommittedOperation {
  return {
    documentId,
    versionId,
    pageId,
    annotationId: id(1000 + cursor),
    operationId: id(200000 + cursor),
    baseRevision: 0,
    kind: 'put',
    annotation: {
      type: 'text',
      x: 10,
      y: 10,
      text: 'Saved work',
      color: '#123456',
      strokeWidth: 1,
      opacity: 1,
    },
    actorId,
    cursor,
    annotationRevision: 1,
    committedAt: '2026-10-08T00:00:00.000Z',
    ...change,
  };
}
function canonicalBytes(operations: readonly CommittedOperation[]) {
  return operations.reduce((total, value) => {
    const {
      actorId: _actor,
      cursor: _cursor,
      annotationRevision: _revision,
      committedAt: _time,
      ...wire
    } = value;
    return total + Buffer.byteLength(canonical(wire));
  }, 0);
}
function context(
  operations: readonly CommittedOperation[],
  change: Partial<SubmissionReplayContext> = {},
): SubmissionReplayContext {
  return {
    organizationId: id(5),
    workId: id(6),
    documentId,
    versionId,
    actorId,
    frozenCursor: operations.length,
    expectedCanonicalBytes: canonicalBytes(operations),
    pages: [{ id: pageId, index: 0, width: 612, height: 792 }],
    ...change,
  };
}
function deletion(cursor: number, annotationId: string, baseRevision: number) {
  const value = operation(cursor, {
    annotationId,
    baseRevision,
    annotationRevision: baseRevision + 1,
    kind: 'delete',
  });
  delete value.annotation;
  return value;
}
function materialize(operations: readonly CommittedOperation[], batchSize = 100) {
  const replay = new SubmissionReplay(context(operations));
  for (let offset = 0; offset < operations.length; offset += batchSize)
    replay.appendBatch(operations.slice(offset, offset + batchSize));
  const chunks = [] as Buffer[];
  const entries = [] as SubmissionReplayEntry[];
  for (const chunk of replay.chunks()) {
    expect(chunk.index).toBe(chunks.length);
    expect(chunk.plaintext.length).toBeLessThanOrEqual(MAX_SUBMISSION_CHUNK_BYTES);
    expect(chunk.sha256).toBe(createHash('sha256').update(chunk.plaintext).digest('hex'));
    const decoded = JSON.parse(chunk.plaintext.toString());
    expect(canonical(decoded)).toBe(chunk.plaintext.toString());
    expect(decoded.entries).toHaveLength(chunk.entries);
    expect(decoded).toMatchObject({
      schema: 1,
      organizationId: id(5),
      workId: id(6),
      documentId,
      versionId,
      frozenCursor: operations.length,
      index: chunk.index,
    });
    entries.push(...decoded.entries);
    chunks.push(Buffer.from(chunk.plaintext));
  }
  const summary = replay.summary();
  expect(summary).toEqual({
    schema: 1,
    frozenCursor: operations.length,
    operationCount: operations.length,
    canonicalOperationBytes: canonicalBytes(operations),
    annotationCount: entries.length,
    outputBytes: chunks.reduce((n, b) => n + b.length, 0),
    chunkCount: chunks.length,
    outputSha256: createHash('sha256').update(Buffer.concat(chunks)).digest('hex'),
  });
  return { replay, chunks, entries, summary };
}

describe('immutable submission prefix replay', () => {
  it('materializes a valid empty frozen prefix into a single identity-bound empty chunk', () => {
    const result = materialize([]);
    expect(result.entries).toEqual([]);
    expect(result.summary.chunkCount).toBe(1);
  });

  it('preserves synced editor paint order through overlapping edits, deletion and resurrection', () => {
    // Sort IDs in the opposite order to paint order to expose accidental UUID ordering.
    const first = operation(1, { annotationId: id(100) });
    const second = operation(2, { annotationId: id(99) });
    const update = operation(3, {
      annotationId: first.annotationId,
      baseRevision: 1,
      annotationRevision: 2,
      annotation: { ...first.annotation!, text: 'Updated beneath the second annotation' },
    });
    const erased = deletion(4, first.annotationId, 2);
    const restored = operation(5, {
      annotationId: first.annotationId,
      baseRevision: 3,
      annotationRevision: 4,
    });
    const tombstone = deletion(6, second.annotationId, 1);
    const beforeErase = materialize([first, second, update]).entries;
    expect(beforeErase.map((entry) => [entry.annotationId, entry.layerOrder])).toEqual([
      [second.annotationId, 2],
      [first.annotationId, 1],
    ]);
    const duringErase = materialize([first, second, update, erased]).entries;
    expect(duringErase[1]).toEqual({
      annotationId: first.annotationId,
      pageId,
      revision: 3,
      latestCursor: 4,
      deleted: true,
      layerOrder: null,
    });
    const afterRestore = materialize([first, second, update, erased, restored, tombstone]).entries;
    expect(afterRestore[1]).toMatchObject({
      annotationId: first.annotationId,
      revision: 4,
      latestCursor: 5,
      deleted: false,
      layerOrder: 1,
    });
    expect(afterRestore[0]).toEqual({
      annotationId: second.annotationId,
      pageId,
      revision: 2,
      latestCursor: 6,
      deleted: true,
      layerOrder: null,
    });
  });

  it('keeps accepted appearance independent of caller mutations and rejects all edits beyond the frozen prefix', () => {
    const original = operation();
    original.annotation = {
      type: 'pen',
      x: 1,
      y: 2,
      points: [{ x: 3, y: 4, pressure: 0.5 }],
      color: '#123456',
      strokeWidth: 1,
      opacity: 1,
    };
    const replay = new SubmissionReplay(context([original]));
    replay.appendBatch([original]);
    original.annotation.points![0].x = 900;
    const chunks = replay.chunks();
    const chunk = chunks.next().value!;
    expect(JSON.parse(chunk.plaintext.toString()).entries[0].annotation.points[0].x).toBe(3);
    chunks.next();
    expect(() => replay.appendBatch([operation(2)])).toThrowError(
      expect.objectContaining({ code: 'snapshot_invalid' }),
    );
    expect(() => replay.summary()).toThrowError(
      expect.objectContaining({ code: 'snapshot_invalid' }),
    );
  });

  it('splits UTF-8 output on entry boundaries with deterministic chunk hashes across input batch sizes', () => {
    const operations = Array.from({ length: 21 }, (_, i) =>
      operation(i + 1, {
        annotation: { ...operation().annotation!, text: '😀'.repeat(8000) },
      }),
    );
    const oneAtATime = materialize(operations, 1);
    const oneBatch = materialize(operations, 100);
    expect(oneAtATime.chunks.length).toBeGreaterThan(2);
    expect(oneAtATime.chunks).toEqual(oneBatch.chunks);
    expect(oneAtATime.summary).toEqual(oneBatch.summary);
  });

  it('allows the server-supported repeated tombstone while requiring its revision chain', () => {
    const first = operation();
    const result = materialize([
      first,
      deletion(2, first.annotationId, 1),
      deletion(3, first.annotationId, 2),
    ]);
    expect(result.entries).toEqual([
      {
        annotationId: first.annotationId,
        pageId,
        revision: 3,
        latestCursor: 3,
        deleted: true,
        layerOrder: null,
      },
    ]);
  });

  it.each([
    ['wrong actor', { actorId: id(999) }],
    ['wrong document', { documentId: id(999) }],
    ['wrong version', { versionId: id(999) }],
    ['unknown page', { pageId: id(999) }],
    ['missing first cursor', { cursor: 2 }],
    ['fractional cursor', { cursor: 1.5 }],
    ['incorrect committed revision', { annotationRevision: 2 }],
    ['nonzero initial revision', { baseRevision: 1, annotationRevision: 2 }],
    ['invalid identifier', { operationId: 'not-an-identifier' }],
    ['noncanonical identifier', { operationId: id(999).toUpperCase() }],
    ['noncanonical timestamp', { committedAt: '2026-10-08T00:00:00Z' }],
    ['invalid timestamp', { committedAt: 'not-a-date' }],
    ['unexpected metadata', { unexpected: 'secret' }],
    ['unsupported annotation', { annotation: { ...operation().annotation!, type: 'unknown' } }],
    ['noncanonical color', { annotation: { ...operation().annotation!, color: '#ABCDEF' } }],
  ] as const)('rejects %s and makes partially accumulated data unusable', (_name, mutation) => {
    const value = { ...operation(), ...mutation } as CommittedOperation;
    const replay = new SubmissionReplay(context([operation()]));
    expect(() => replay.appendBatch([value])).toThrowError(
      expect.objectContaining({ code: 'snapshot_invalid' }),
    );
    expect(() => replay.appendBatch([operation()])).toThrowError(
      expect.objectContaining({ code: 'snapshot_invalid' }),
    );
    expect(() => replay.chunks().next()).toThrowError(
      expect.objectContaining({ code: 'snapshot_invalid' }),
    );
  });

  it.each([
    ['cursor gap', (a: CommittedOperation) => operation(3)],
    ['repeated cursor', (a: CommittedOperation) => operation(1)],
    [
      'reused operation ID',
      (a: CommittedOperation) => operation(2, { operationId: a.operationId }),
    ],
    ['stale revision', (a: CommittedOperation) => operation(2, { annotationId: a.annotationId })],
    [
      'skipped revision',
      (a: CommittedOperation) =>
        operation(2, { annotationId: a.annotationId, baseRevision: 2, annotationRevision: 3 }),
    ],
    ['new-annotation deletion', (_a: CommittedOperation) => deletion(2, id(999), 0)],
    [
      'page move',
      (a: CommittedOperation) =>
        operation(2, {
          annotationId: a.annotationId,
          pageId: id(88),
          baseRevision: 1,
          annotationRevision: 2,
        }),
    ],
  ] as const)('rejects %s after a valid prefix', (_name, next) => {
    const first = operation(),
      second = next(first);
    const replay = new SubmissionReplay(
      context([first, second], {
        pages: [
          { id: pageId, index: 0, width: 612, height: 792 },
          { id: id(88), index: 1, width: 600, height: 800 },
        ],
      }),
    );
    replay.appendBatch([first]);
    expect(() => replay.appendBatch([second])).toThrowError(
      expect.objectContaining({ code: 'snapshot_invalid' }),
    );
    expect(() => replay.chunks().next()).toThrow();
  });

  it('requires the exact complete canonical-byte total and full contiguous cursor before output', () => {
    const first = operation(),
      second = operation(2);
    for (const change of [
      { expectedCanonicalBytes: canonicalBytes([first]) - 1 },
      { expectedCanonicalBytes: canonicalBytes([first]) + 1 },
      { frozenCursor: 2, expectedCanonicalBytes: canonicalBytes([first, second]) },
    ]) {
      const replay = new SubmissionReplay(context([first], change));
      expect(() => {
        replay.appendBatch([first]);
        replay.chunks().next();
      }).toThrowError(expect.objectContaining({ code: 'snapshot_invalid' }));
    }
  });

  it.each([
    { frozenCursor: 100001 },
    { frozenCursor: -1 },
    { frozenCursor: 1.2 },
    { expectedCanonicalBytes: 134217729 },
    { expectedCanonicalBytes: -1 },
    { expectedCanonicalBytes: 0 },
    { organizationId: 'invalid' },
    { pages: [] },
    { pages: [{ id: pageId, index: 1, width: 612, height: 792 }] },
    { pages: [{ id: pageId, index: 0, width: Infinity, height: 792 }] },
    {
      pages: [
        { id: pageId, index: 0, width: 612, height: 792 },
        { id: pageId, index: 1, width: 612, height: 792 },
      ],
    },
  ])('rejects an invalid frozen context %j', (change) => {
    expect(() => new SubmissionReplay(context([operation()], change))).toThrowError(
      expect.objectContaining({ code: 'snapshot_invalid' }),
    );
  });

  it('rejects batches larger than 100 and operations after the frozen cursor', () => {
    const operations = Array.from({ length: 101 }, (_, i) => operation(i + 1));
    const oversized = new SubmissionReplay(context(operations));
    expect(() => oversized.appendBatch(operations)).toThrowError(
      expect.objectContaining({ code: 'snapshot_invalid' }),
    );
    const frozen = new SubmissionReplay(context([operations[0]]));
    frozen.appendBatch([operations[0]]);
    expect(() => frozen.appendBatch([operations[1]])).toThrowError(
      expect.objectContaining({ code: 'snapshot_invalid' }),
    );
  });

  it('erases yielded plaintext on resume, early iterator return and explicit disposal', () => {
    for (const end of ['finish', 'return', 'dispose'] as const) {
      const replay = new SubmissionReplay(context([operation()]));
      replay.appendBatch([operation()]);
      const iterator = replay.chunks(),
        chunk = iterator.next().value!;
      expect(chunk.plaintext.some((byte) => byte !== 0)).toBe(true);
      if (end === 'finish') iterator.next();
      if (end === 'return') iterator.return(undefined);
      if (end === 'dispose') {
        replay.dispose();
        expect(() => iterator.next()).toThrowError(
          expect.objectContaining({ code: 'snapshot_invalid' }),
        );
      }
      expect(chunk.plaintext.every((byte) => byte === 0)).toBe(true);
      if (end !== 'finish') expect(() => replay.summary()).toThrow();
    }
  });

  it('clears retained work on abort before append or between output chunks', () => {
    const abort = new AbortController();
    abort.abort();
    const before = new SubmissionReplay(context([operation()]));
    expect(() => before.appendBatch([operation()], abort.signal)).toThrowError(
      expect.objectContaining({ code: 'processing_cancelled' }),
    );
    expect(() => before.chunks().next()).toThrow();
    const during = new SubmissionReplay(context([operation()]));
    during.appendBatch([operation()]);
    const controller = new AbortController(),
      iterator = during.chunks(controller.signal),
      chunk = iterator.next().value!;
    controller.abort();
    expect(() => iterator.next()).toThrowError(
      expect.objectContaining({ code: 'processing_cancelled' }),
    );
    expect(chunk.plaintext.every((byte) => byte === 0)).toBe(true);
    expect(() => during.summary()).toThrow();
  });

  it("erases another iterator's suspended plaintext when a duplicate chunk iterator is rejected", () => {
    const replay = new SubmissionReplay(context([operation()]));
    replay.appendBatch([operation()]);
    const first = replay.chunks(),
      chunk = first.next().value!;
    expect(chunk.plaintext.some((byte) => byte !== 0)).toBe(true);
    expect(() => replay.chunks().next()).toThrowError(
      expect.objectContaining({ code: 'snapshot_invalid' }),
    );
    expect(chunk.plaintext.every((byte) => byte === 0)).toBe(true);
    expect(() => first.next()).toThrowError(expect.objectContaining({ code: 'snapshot_invalid' }));
  });

  it('rejects incomplete summary reads and cannot replay finalized or disposed data twice', () => {
    const incomplete = new SubmissionReplay(context([operation()]));
    expect(() => incomplete.summary()).toThrow();
    const result = materialize([operation()]);
    const summary = result.replay.summary();
    summary.annotationCount = 800;
    expect(result.replay.summary().annotationCount).toBe(1);
    expect(() => result.replay.chunks().next()).toThrow();
    expect(() => result.replay.summary()).toThrow();
  });

  it('materializes the maximum supported 100,000-operation prefix in bounded batches and chunks', () => {
    const count = 100000;
    let bytes = 0;
    for (let cursor = 1; cursor <= count; cursor++) bytes += canonicalBytes([operation(cursor)]);
    const replay = new SubmissionReplay(
      context([], { frozenCursor: count, expectedCanonicalBytes: bytes }),
    );
    for (let cursor = 1; cursor <= count; cursor += 100)
      replay.appendBatch(Array.from({ length: 100 }, (_, offset) => operation(cursor + offset)));
    let entries = 0,
      chunks = 0;
    for (const chunk of replay.chunks()) {
      expect(chunk.plaintext.length).toBeLessThanOrEqual(MAX_SUBMISSION_CHUNK_BYTES);
      entries += chunk.entries;
      chunks++;
    }
    expect(replay.summary()).toMatchObject({
      operationCount: count,
      annotationCount: count,
      canonicalOperationBytes: bytes,
      chunkCount: chunks,
    });
    expect(entries).toBe(count);
  }, 30000);
});
