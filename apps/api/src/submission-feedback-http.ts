import type { IncomingMessage, ServerResponse } from 'node:http';
import type { SessionPrincipal } from './identity/types.js';
import { AssignmentError } from './assignments/types.js';
import {
  MAX_FEEDBACK_BYTES,
  type AssignmentFeedbackService,
  type FeedbackCapture,
  type FeedbackCommand,
  type FeedbackContent,
  type FeedbackRelease,
} from './assignments/feedback/types.js';
import { strictJson } from './strict-json.js';

const route =
  /^\/api\/assignments\/(review|work)\/submissions\/([^/]+)\/feedback(?:\/(release|commands)(?:\/([^/]+))?)?$/;
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
export const isSubmissionFeedbackPath = (path: string) =>
  /^\/api\/assignments\/(review|work)\/submissions\/[^/]+\/feedback(?:\/|$)/.test(path);
const invalid = (code: string, message: string) => new AssignmentError(400, code, message);

function publicCapture(capture: FeedbackCapture): FeedbackCapture {
  return {
    submissionId: capture.submissionId,
    snapshotPin: capture.snapshotPin,
    documentId: capture.documentId,
    versionId: capture.versionId,
    frozenCursor: capture.frozenCursor,
    frozenAt: capture.frozenAt,
    pages: capture.pages.map((page) => ({
      id: page.id,
      index: page.index,
      width: page.width,
      height: page.height,
    })),
    source: {
      sha256: capture.source.sha256,
      bytes: capture.source.bytes,
      mimeType: capture.source.mimeType,
    },
  };
}
function publicContent(content: FeedbackContent): FeedbackContent {
  return {
    comment: content.comment,
    annotations: content.annotations.map((a) => ({
      id: a.id,
      pageIndex: a.pageIndex,
      type: a.type,
      x: a.x,
      y: a.y,
      width: a.width,
      height: a.height,
      rotation: a.rotation,
      text: a.text,
      points: a.points?.map((p) => ({
        x: p.x,
        y: p.y,
        ...(p.pressure === undefined ? {} : { pressure: p.pressure }),
      })),
      color: a.color,
      strokeWidth: a.strokeWidth,
      opacity: a.opacity,
      createdAt: a.createdAt,
      author: a.author,
    })),
  };
}
const publicRelease = (release: FeedbackRelease | null): FeedbackRelease | null =>
  release && {
    revision: release.revision,
    releasedAt: release.releasedAt,
    content: publicContent(release.content),
  };
const publicCommand = (value: FeedbackCommand): FeedbackCommand => ({
  requestId: value.requestId,
  action: value.action,
  expectedRevision: value.expectedRevision,
  snapshotPin: value.snapshotPin,
  state: value.state,
  revision: value.revision,
  code: value.code,
  savedAt: value.savedAt,
  releasedAt: value.releasedAt,
});

function authorize(
  principal: SessionPrincipal | undefined,
  teacher: boolean,
): asserts principal is SessionPrincipal {
  if (
    !principal ||
    principal.authenticationMethod !== 'lti' ||
    principal.role !== (teacher ? 'teacher' : 'student')
  )
    throw new AssignmentError(
      403,
      'feedback_launch_required',
      'Open this assignment from your approved Canvas activity.',
    );
}

/** Byte/depth/key bounds apply before the service performs semantic validation. */
async function body(req: IncomingMessage, signal: AbortSignal): Promise<unknown> {
  const maximum = MAX_FEEDBACK_BYTES + 1024;
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?\s*$/i.test(req.headers['content-type'] ?? ''))
    throw new AssignmentError(415, 'json_required', 'Send feedback as UTF-8 JSON.');
  if (req.headers['content-encoding'] && req.headers['content-encoding'] !== 'identity')
    throw new AssignmentError(
      415,
      'encoding_not_supported',
      'Compressed feedback requests are not supported.',
    );
  const length = req.headers['content-length'];
  const tooLarge = () =>
    new AssignmentError(413, 'feedback_too_large', 'Reduce the feedback size before saving.');
  if (length !== undefined && (!/^(0|[1-9][0-9]*)$/.test(length) || Number(length) > maximum))
    throw tooLarge();
  if (signal.aborted || req.aborted || req.destroyed)
    throw invalid('request_aborted', 'The feedback request was interrupted.');
  const bytes = Buffer.alloc(maximum);
  let size = 0;
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (error?: Error) => {
      if (done) return;
      done = true;
      clearTimeout(timeout);
      req.off('data', data);
      req.off('end', end);
      req.off('aborted', aborted);
      req.off('error', aborted);
      signal.removeEventListener('abort', aborted);
      try {
        if (error) {
          req.resume();
          reject(error);
          return;
        }
        resolve(
          strictJson(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, size))),
        );
      } catch {
        reject(invalid('invalid_json', 'Send valid UTF-8 JSON with unique object keys.'));
      } finally {
        bytes.fill(0);
      }
    };
    const data = (chunk: Buffer) => {
      if (size + chunk.length > maximum) finish(tooLarge());
      else {
        bytes.set(chunk, size);
        size += chunk.length;
      }
    };
    const end = () => finish();
    const aborted = () =>
      finish(invalid('request_aborted', 'The feedback request was interrupted.'));
    const timeout = setTimeout(
      () =>
        finish(
          new AssignmentError(
            408,
            'request_timeout',
            'The feedback request took too long. Check its status before trying again.',
          ),
        ),
      5000,
    );
    timeout.unref();
    req.on('data', data);
    req.on('end', end);
    req.on('aborted', aborted);
    req.on('error', aborted);
    signal.addEventListener('abort', aborted, { once: true });
  });
}

/** Runs after shared session, Origin, CSRF and request admission checks. */
export async function handleSubmissionFeedback(
  req: IncomingMessage,
  res: ServerResponse,
  service: AssignmentFeedbackService | undefined,
  principal: SessionPrincipal | undefined,
  refreshPrincipal: () => Promise<SessionPrincipal>,
): Promise<void> {
  if ((req.url?.length ?? 0) > 2048)
    throw new AssignmentError(414, 'request_too_large', 'The feedback request is too large.');
  const url = new URL(req.url ?? '/', 'https://localhost');
  const selected = route.exec(url.pathname);
  const teacher = selected?.[1] === 'review';
  authorize(principal, teacher);
  if (
    !selected ||
    (!teacher && selected[3]) ||
    (selected[3] === 'release' && selected[4]) ||
    (selected[3] === 'commands' && !selected[4])
  )
    throw new AssignmentError(
      404,
      'feedback_route_not_found',
      'This feedback action is unavailable.',
    );
  if (!uuid.test(selected[2]) || (selected[4] !== undefined && !uuid.test(selected[4])))
    throw invalid(
      'invalid_identifier',
      'Use the exact saved submission and feedback request identifiers.',
    );
  if (url.search) throw invalid('invalid_query', 'Feedback routes do not accept query parameters.');
  const command = selected[3] === 'commands',
    release = selected[3] === 'release';
  const methods = release ? ['POST'] : teacher && !command ? ['GET', 'PUT'] : ['GET'];
  if (!methods.includes(req.method ?? '')) {
    res.setHeader('Allow', methods.join(', '));
    throw new AssignmentError(405, 'method_not_allowed', 'This feedback action is not supported.');
  }
  if (req.headers.range)
    throw invalid('range_not_supported', 'Partial feedback responses are not supported.');
  if (
    req.method === 'GET' &&
    (req.headers['transfer-encoding'] || Number(req.headers['content-length'] ?? 0) !== 0)
  )
    throw invalid('body_not_allowed', 'Feedback reads do not accept request bodies.');
  if (!service)
    throw new AssignmentError(
      503,
      'feedback_unconfigured',
      'Assignment feedback is not configured.',
    );

  const controller = new AbortController();
  const aborted = () => controller.abort();
  req.once('aborted', aborted);
  res.once('close', aborted);
  const timeout = setTimeout(aborted, 35000);
  timeout.unref();
  const send = (status: number, value: unknown) => {
    if (controller.signal.aborted || req.aborted || res.destroyed)
      throw new AssignmentError(
        409,
        'feedback_cancelled',
        'The feedback request was interrupted. Check its exact request status before trying again.',
      );
    const serialized = JSON.stringify(value);
    if (Buffer.byteLength(serialized) > 1048576)
      throw new AssignmentError(
        503,
        'feedback_response_too_large',
        'The saved feedback could not be loaded within its size limit.',
      );
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(serialized);
  };
  try {
    const options = { signal: controller.signal },
      id = selected[2];
    if (req.method !== 'GET') {
      const input = await body(req, controller.signal);
      const fresh = await refreshPrincipal();
      authorize(fresh, true);
      if (
        fresh.sessionId !== principal.sessionId ||
        fresh.organizationId !== principal.organizationId ||
        fresh.userId !== principal.userId
      )
        throw new AssignmentError(409, 'session_changed', 'Reopen this assignment from Canvas.');
      if (controller.signal.aborted)
        throw invalid('request_aborted', 'The feedback request was interrupted.');
      const result = release
        ? await service.release(fresh, id, input, options)
        : await service.save(fresh, id, input, options);
      send(result.state === 'accepted' ? 200 : 409, publicCommand(result));
    } else if (command)
      send(200, publicCommand(await service.command(principal, id, selected[4], options)));
    else if (teacher) {
      const value = await service.teacher(principal, id, options);
      send(200, {
        capture: publicCapture(value.capture),
        revision: value.revision,
        savedAt: value.savedAt,
        content: publicContent(value.content),
        released: publicRelease(value.released),
      });
    } else {
      const value = await service.student(principal, id, options);
      send(200, { capture: publicCapture(value.capture), released: publicRelease(value.released) });
    }
  } finally {
    clearTimeout(timeout);
    req.off('aborted', aborted);
    res.off('close', aborted);
  }
}
