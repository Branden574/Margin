import type { IncomingMessage, ServerResponse } from 'node:http';
import type { SessionPrincipal } from '../../identity/types.js';
import { bounded } from '../../cloud/limits.js';
import { AssignmentError } from '../types.js';
import type { ReviewSnapshot } from '../review/types.js';
import type { AssignmentFeedbackService } from './types.js';

let activeResponses = 0;
const unavailable = () =>
  new AssignmentError(
    503,
    'feedback_capture_unavailable',
    'The captured work could not be loaded. Refresh returned feedback and try again.',
  );
const cancelled = () =>
  new AssignmentError(409, 'feedback_cancelled', 'The returned feedback request was interrupted.');

/** Only the public review DTO crosses this boundary; no retained seals or keys. */
function publicSnapshot(value: ReviewSnapshot): ReviewSnapshot {
  return {
    assignmentId: value.assignmentId,
    submission: {
      id: value.submission.id,
      frozenCursor: value.submission.frozenCursor,
      frozenAt: value.submission.frozenAt,
      revision: value.submission.revision,
      preparation: value.submission.preparation,
      errorCode: value.submission.errorCode,
    },
    snapshotPin: value.snapshotPin,
    organizationId: value.organizationId,
    workId: value.workId,
    documentId: value.documentId,
    versionId: value.versionId,
    pages: value.pages.map(({ id, index, width, height }) => ({ id, index, width, height })),
    source: {
      sha256: value.source.sha256,
      bytes: value.source.bytes,
      mimeType: value.source.mimeType,
    },
    annotationCount: value.annotationCount,
    outputBytes: value.outputBytes,
    outputSha256: value.outputSha256,
    chunks: value.chunks.map(({ index, sha256, bytes }) => ({ index, sha256, bytes })),
  };
}

/** Admission stays occupied until both provider work and delivery have settled. */
export async function sendReturnedCapture(
  req: IncomingMessage,
  res: ServerResponse,
  service: AssignmentFeedbackService,
  principal: SessionPrincipal,
  id: string,
  chunk?: { index: number; snapshotPin: string },
): Promise<void> {
  if (req.aborted || req.destroyed) throw cancelled();
  if (activeResponses >= 2)
    throw new AssignmentError(
      503,
      'feedback_reader_busy',
      'Returned feedback is busy. Retry shortly.',
    );
  activeResponses++;
  const controller = new AbortController();
  let bytes: Buffer | undefined;
  let operationSettled = false,
    responseSettled = false,
    released = false;
  const releaseSlot = () => {
    if (!released && operationSettled && responseSettled) {
      released = true;
      activeResponses--;
    }
  };
  const dispose = () => {
    responseSettled = true;
    bytes?.fill(0);
    bytes = undefined;
    releaseSlot();
  };
  const aborted = () => controller.abort();
  const closed = () => {
    if (!res.writableFinished) aborted();
    dispose();
  };
  const timer = setTimeout(() => {
    aborted();
    if (res.headersSent) res.destroy();
  }, 35000);
  timer.unref();
  req.once('aborted', aborted);
  res.once('close', closed);
  res.once('finish', dispose);
  const cleanup = () => {
    clearTimeout(timer);
    req.off('aborted', aborted);
    res.off('close', closed);
    res.off('finish', dispose);
  };
  try {
    const options = { signal: controller.signal };
    const work = (async () => {
      try {
        return chunk
          ? await service.studentChunk(
              principal,
              id,
              chunk.index,
              { snapshotPin: chunk.snapshotPin },
              options,
            )
          : publicSnapshot(await service.studentCapture(principal, id, options));
      } finally {
        operationSettled = true;
        releaseSlot();
      }
    })();
    const value = await bounded(
      30000,
      controller.signal,
      async () => work,
      (late) => {
        if (Buffer.isBuffer(late)) late.fill(0);
      },
    );
    bytes = Buffer.isBuffer(value) ? value : Buffer.from(JSON.stringify(value));
    if (
      bytes.length < 1 ||
      bytes.length > (chunk ? 262144 : 1048576) ||
      (chunk && !Buffer.isBuffer(value))
    )
      throw unavailable();
    if (controller.signal.aborted || req.aborted || res.destroyed) throw cancelled();
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': bytes.length,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
    });
    res.end(bytes);
  } catch (error) {
    controller.abort();
    dispose();
    cleanup();
    if (error instanceof AssignmentError) throw error;
    throw unavailable();
  } finally {
    if (res.writableFinished || res.destroyed || responseSettled) {
      dispose();
      cleanup();
    } else {
      res.once('finish', cleanup);
      res.once('close', cleanup);
    }
  }
}
