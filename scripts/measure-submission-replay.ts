import { performance } from 'node:perf_hooks';
import { setImmediate } from 'node:timers/promises';
import os from 'node:os';
import {
  SubmissionReplay,
  MAX_SUBMISSION_CHUNK_BYTES,
} from '../apps/api/src/assignments/submissions/processing/replay.js';
import { canonical } from '../apps/api/src/sync/validation.js';
import type { CommittedOperation } from '../apps/api/src/sync/types.js';

const count = 100000;
const id = (n: number) => `70000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
function operation(cursor: number): CommittedOperation {
  return {
    documentId: id(1),
    versionId: id(2),
    pageId: id(3),
    annotationId: id(cursor + 1000),
    operationId: id(cursor + 200000),
    baseRevision: 0,
    kind: 'put',
    annotation: {
      type: 'text',
      x: 10,
      y: 10,
      text: 'Deterministic submission benchmark',
      color: '#123456',
      strokeWidth: 1,
      opacity: 1,
    },
    actorId: id(4),
    cursor,
    annotationRevision: 1,
    committedAt: '2026-10-08T00:00:00.000Z',
  };
}

const setupStarted = performance.now();
let expectedCanonicalBytes = 0;
for (let cursor = 1; cursor <= count; cursor++) {
  const { actorId, cursor: _cursor, annotationRevision, committedAt, ...wire } = operation(cursor);
  expectedCanonicalBytes += Buffer.byteLength(canonical(wire));
}
const setupMs = performance.now() - setupStarted;
const startingRssBytes = process.memoryUsage().rss;
let sampledPeakRssBytes = startingRssBytes;
const observe = () => {
  sampledPeakRssBytes = Math.max(sampledPeakRssBytes, process.memoryUsage().rss);
};
const replayStarted = performance.now();
const replay = new SubmissionReplay({
  organizationId: id(5),
  workId: id(6),
  documentId: id(1),
  versionId: id(2),
  actorId: id(4),
  frozenCursor: count,
  expectedCanonicalBytes,
  pages: [{ id: id(3), index: 0, width: 612, height: 792 }],
});
for (let cursor = 1; cursor <= count; cursor += 100) {
  replay.appendBatch(Array.from({ length: 100 }, (_, offset) => operation(cursor + offset)));
  observe();
  await setImmediate();
}
const appendMs = performance.now() - replayStarted;
const outputStarted = performance.now();
let chunkCount = 0,
  outputBytes = 0,
  maximumChunkBytes = 0,
  minimumChunkBytes = Infinity,
  entries = 0;
for (const chunk of replay.chunks()) {
  if (chunk.index !== chunkCount || chunk.plaintext.length > MAX_SUBMISSION_CHUNK_BYTES)
    throw Error('Chunk bounds mismatch');
  outputBytes += chunk.plaintext.length;
  maximumChunkBytes = Math.max(maximumChunkBytes, chunk.plaintext.length);
  minimumChunkBytes = Math.min(minimumChunkBytes, chunk.plaintext.length);
  entries += chunk.entries;
  chunkCount++;
  chunk.plaintext.fill(0);
  observe();
  await setImmediate();
}
const outputMs = performance.now() - outputStarted;
const replayMs = performance.now() - replayStarted;
const summary = replay.summary();
if (summary.outputBytes !== outputBytes || summary.chunkCount !== chunkCount || entries !== count)
  throw Error('Summary mismatch');
replay.dispose();
observe();
const limits = {
  inputBytes: 134217728,
  inputOperations: 100000,
  outputBytes: 268435456,
  chunkBytes: 262144,
  chunkCount: 2048,
  manifestBytes: 262144,
};
// Conservative proof bounds: an entry adds <128 B versus its last operation;
// each operation is <=64 KiB, each context-only chunk envelope is <512 B.
const maximumEntryBytes = 65536 + 128;
const maximumRetainedEntryBytes = limits.inputBytes + 128 * limits.inputOperations;
const minimumNonfinalChunkPayloadBytes = limits.chunkBytes - 512 - maximumEntryBytes - 1;
const derivedMaximumChunks =
  Math.floor(
    (maximumRetainedEntryBytes + limits.inputOperations) / minimumNonfinalChunkPayloadBytes,
  ) + 1;
const worstReceipt = {
  schema: 1,
  submissionId: id(1),
  workId: id(2),
  claimId: id(3),
  attempt: 999999,
  pin: 'f'.repeat(64),
  summary: {
    schema: 1,
    frozenCursor: count,
    operationCount: count,
    canonicalOperationBytes: limits.inputBytes,
    annotationCount: count,
    outputBytes: limits.outputBytes,
    chunkCount: derivedMaximumChunks,
    outputSha256: 'f'.repeat(64),
  },
  chunks: Array.from({ length: derivedMaximumChunks }, (_, index) => ({
    index,
    sha256: 'f'.repeat(64),
    bytes: limits.chunkBytes,
    sealed: 'f'.repeat(64),
  })),
};
console.log(
  JSON.stringify(
    {
      workload:
        'One pure replay of 100000 distinct deterministic text annotations; no database, encryption, provider, browser, concurrency or capacity qualification.',
      runtime: {
        node: process.version,
        platform: process.platform,
        arch: process.arch,
        cpu: os.cpus()[0]?.model,
        logicalCpus: os.cpus().length,
        totalMemoryBytes: os.totalmem(),
      },
      timingsMs: {
        prefixMetadataSetup: setupMs,
        appendWithSyntheticInputCreationAndYields: appendMs,
        outputWithWipingAndYields: outputMs,
        replayTotal: replayMs,
      },
      memory: {
        startingRssBytes,
        sampledPeakRssBytes,
        processPeakRssKiB: process.resourceUsage().maxRSS,
        note: 'Process RSS includes Node/tsx and harness; starting RSS is after deterministic metadata preparation. No forced GC.',
      },
      output: { ...summary, minimumChunkBytes, maximumChunkBytes },
      bounds: {
        ...limits,
        maximumEntryBytes,
        maximumRetainedEntryBytes,
        minimumNonfinalChunkPayloadBytes,
        derivedMaximumChunks,
        derivedMaximumOutputBytes: maximumRetainedEntryBytes + count + derivedMaximumChunks * 512,
        conservativeManifestBytes: Buffer.byteLength(canonical(worstReceipt)),
      },
    },
    null,
    2,
  ),
);
