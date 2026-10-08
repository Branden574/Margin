import type { IncomingMessage, ServerResponse } from 'node:http';
import type { SessionPrincipal } from './identity/types.js';
import { AssignmentError } from './assignments/types.js';
import { bounded } from './cloud/limits.js';
import type {
  AssignmentReviewService,
  ReviewContext,
  ReviewPage,
  ReviewSnapshot,
  ReviewSubmission,
} from './assignments/review/types.js';

const root = '/api/assignments/review';
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
let activeContentResponses = 0;
export const isSubmissionReviewPath = (path: string) =>
  path === root || path.startsWith(root + '/');
const invalid = (code: string, message: string) => new AssignmentError(400, code, message);
const unavailable = () =>
  new AssignmentError(
    503,
    'review_unavailable',
    'Frozen submission review is unavailable. Reopen this assignment from Canvas.',
  );
const publicSubmission = (value: ReviewSubmission): ReviewSubmission => ({
  id: value.id,
  frozenCursor: value.frozenCursor,
  frozenAt: value.frozenAt,
  revision: value.revision,
  preparation: value.preparation,
  errorCode: value.errorCode,
});
const publicContext = (value: ReviewContext): ReviewContext => ({
  assignment: {
    id: value.assignment.id,
    title: value.assignment.title,
    instructions: value.assignment.instructions,
  },
  mode: value.mode,
});
const publicPage = (value: ReviewPage): ReviewPage => ({
  submissions: value.submissions.map(publicSubmission),
  nextCursor: value.nextCursor,
});
const publicSnapshot = (value: ReviewSnapshot): ReviewSnapshot => ({
  assignmentId: value.assignmentId,
  submission: publicSubmission(value.submission),
  snapshotPin: value.snapshotPin,
  organizationId: value.organizationId,
  workId: value.workId,
  documentId: value.documentId,
  versionId: value.versionId,
  pages: value.pages.map((page) => ({
    id: page.id,
    index: page.index,
    width: page.width,
    height: page.height,
  })),
  source: {
    sha256: value.source.sha256,
    bytes: value.source.bytes,
    mimeType: value.source.mimeType,
  },
  annotationCount: value.annotationCount,
  outputBytes: value.outputBytes,
  outputSha256: value.outputSha256,
  chunks: value.chunks.map((chunk) => ({
    index: chunk.index,
    sha256: chunk.sha256,
    bytes: chunk.bytes,
  })),
});

/** Read-only adapter. The service independently verifies the current author and bound assignment. */
export async function handleSubmissionReview(
  req: IncomingMessage,
  res: ServerResponse,
  service: AssignmentReviewService | undefined,
  principal: SessionPrincipal | undefined,
): Promise<void> {
  if (!principal || principal.authenticationMethod !== 'lti' || principal.role !== 'teacher')
    throw new AssignmentError(
      403,
      'teacher_launch_required',
      'Open your assignment from an approved Canvas teacher launch.',
    );
  if ((req.url?.length ?? 0) > 2048)
    throw new AssignmentError(414, 'request_too_large', 'The review request is too large.');
  const url = new URL(req.url ?? '/', 'https://localhost');
  const context = url.pathname === root;
  const list = url.pathname === root + '/submissions';
  const selected =
    /^\/api\/assignments\/review\/submissions\/([^/]+)(?:\/(source|chunks)(?:\/([^/]+))?)?$/.exec(
      url.pathname,
    );
  const source = selected?.[2] === 'source' && selected[3] === undefined;
  const chunk = selected?.[2] === 'chunks' && selected[3] !== undefined;
  const snapshot = !!selected && selected[2] === undefined;
  if (!context && !list && !source && !chunk && !snapshot)
    throw new AssignmentError(
      404,
      'review_route_not_found',
      'This submission review route is unavailable.',
    );
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    throw new AssignmentError(405, 'method_not_allowed', 'Submission review is read-only.');
  }
  if (req.headers.range)
    throw invalid('range_not_supported', 'Partial review responses are not supported.');
  if (req.headers['transfer-encoding'] || Number(req.headers['content-length'] ?? 0) !== 0)
    throw invalid('body_not_allowed', 'Review reads do not accept request bodies.');
  const id = selected?.[1];
  if (id !== undefined && !uuid.test(id))
    throw invalid('invalid_identifier', 'Use a saved submission identifier.');
  const index = chunk ? Number(selected![3]) : undefined;
  if (chunk && (!/^(0|[1-9][0-9]{0,3})$/.test(selected![3]) || index! > 2047))
    throw invalid('invalid_review_chunk', 'Use a bounded chunk index from the frozen snapshot.');
  let after: string | undefined, pin: string | undefined;
  for (const [key, value] of url.searchParams) {
    if (url.searchParams.getAll(key).length !== 1)
      throw invalid('invalid_review_query', 'Use the exact review cursor or snapshot pin.');
    if (list && key === 'after' && /^[A-Za-z0-9_-]{1,128}$/.test(value)) after = value;
    else if ((source || chunk) && key === 'pin' && /^[a-f0-9]{64}$/.test(value)) pin = value;
    else
      throw invalid(
        'invalid_review_query',
        'Use only the cursor or snapshot pin returned by review.',
      );
  }
  if ((source || chunk) && !pin)
    throw invalid('snapshot_pin_required', 'The exact frozen snapshot pin is required.');
  if (!service)
    throw new AssignmentError(
      503,
      'review_unconfigured',
      'Teacher submission review is not configured.',
    );

  if (req.aborted || req.destroyed)
    throw new AssignmentError(409, 'review_cancelled', 'The review request was interrupted.');
  const content = source || chunk;
  if (content && activeContentResponses >= 2)
    throw new AssignmentError(
      503,
      'review_reader_busy',
      'Submission review is busy. Retry shortly.',
    );
  if (content) activeContentResponses++;
  const controller = new AbortController();
  let bytes: Buffer | undefined;
  let operationSettled = false,
    responseSettled = false,
    released = false;
  const releaseSlot = () => {
    if (content && !released && operationSettled && responseSettled) {
      released = true;
      activeContentResponses--;
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
        if (source)
          return await service.source(principal, id!.toLowerCase(), { snapshotPin: pin! }, options);
        if (chunk)
          return await service.chunk(
            principal,
            id!.toLowerCase(),
            index!,
            { snapshotPin: pin! },
            options,
          );
        if (context) return publicContext(await service.context(principal, options));
        if (list)
          return publicPage(
            await service.list(principal, { ...(after ? { after } : {}) }, options),
          );
        return publicSnapshot(await service.snapshot(principal, id!.toLowerCase(), options));
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
    const maxBytes = source ? 100 * 1024 * 1024 : chunk ? 262144 : 1024 * 1024;
    if (bytes.length < 1 || bytes.length > maxBytes || (content && !Buffer.isBuffer(value)))
      throw unavailable();
    if (controller.signal.aborted || req.aborted || res.destroyed)
      throw new AssignmentError(409, 'review_cancelled', 'The review request was interrupted.');
    res.writeHead(200, {
      'Content-Type': source ? 'application/pdf' : 'application/json; charset=utf-8',
      'Content-Length': bytes.length,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      ...(source ? { 'Content-Disposition': 'inline; filename="assignment.pdf"' } : {}),
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
