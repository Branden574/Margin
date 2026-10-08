import type { IncomingMessage, ServerResponse } from 'node:http';
import type { SessionPrincipal } from './identity/types.js';
import { AssignmentError } from './assignments/types.js';
import type {
  AssignmentSubmissionService,
  SubmissionRequest,
  SubmissionStatus,
  SubmissionReprocessRequest,
} from './assignments/submissions/types.js';

const collection = '/api/assignments/work/submissions';
const requests = '/api/assignments/work/submission-requests/';
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;

export function isSubmissionPath(path: string): boolean {
  return path === collection || path.startsWith(collection + '/') || path.startsWith(requests);
}

function student(principal: SessionPrincipal) {
  if (principal.authenticationMethod !== 'lti' || principal.role !== 'student')
    throw new AssignmentError(
      403,
      'student_launch_required',
      'Open your work from an approved Canvas assignment.',
    );
}

/** Keep storage identity, receipts, hashes and delivery credentials out of the browser DTO. */
function publicStatus(status: SubmissionStatus): SubmissionStatus {
  return {
    id: status.id,
    requestId: status.requestId,
    attempt: status.attempt,
    frozenCursor: status.frozenCursor,
    frozenAt: status.frozenAt,
    revision: status.revision,
    phase: status.phase,
    confirmedAt: status.confirmedAt,
    retryAllowed: status.retryAllowed,
    errorCode: status.errorCode,
  };
}
function publicRequest(value: SubmissionRequest): SubmissionRequest {
  return value.state === 'captured'
    ? {
        requestId: value.requestId,
        expectedCursor: value.expectedCursor,
        state: value.state,
        submission: publicStatus(value.submission),
      }
    : {
        requestId: value.requestId,
        expectedCursor: value.expectedCursor,
        state: value.state,
        code: value.code,
      };
}
function publicReprocess(value: SubmissionReprocessRequest): SubmissionReprocessRequest {
  return {
    request: publicRequest(value.request) as SubmissionReprocessRequest['request'],
    expectedRevision: value.expectedRevision,
    state: value.state,
    acceptedRevision: value.acceptedRevision,
    code: value.code,
  };
}
function requestStatus(value: SubmissionRequest): number {
  return value.state === 'rejected' ? 409 : value.submission.phase === 'confirmed' ? 200 : 202;
}

async function submissionBody(req: IncomingMessage, reprocessing = false) {
  const maximum = 1024;
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?\s*$/i.test(req.headers['content-type'] ?? ''))
    throw new AssignmentError(415, 'json_required', 'Send this submission request as UTF-8 JSON.');
  if (req.headers['content-encoding'] && req.headers['content-encoding'] !== 'identity')
    throw new AssignmentError(
      415,
      'encoding_not_supported',
      'Compressed bodies are not supported.',
    );
  const length = req.headers['content-length'];
  if (length !== undefined && (!/^(0|[1-9][0-9]*)$/.test(length) || Number(length) > maximum))
    throw new AssignmentError(
      413,
      'submission_request_too_large',
      'Submission requests must fit within 1 KiB.',
    );
  if (req.aborted || req.destroyed)
    throw new AssignmentError(400, 'request_aborted', 'The submission request was interrupted.');
  const bytes = Buffer.alloc(maximum);
  let size = 0;
  return new Promise<{ requestId: string; expectedCursor: number } | { expectedRevision: number }>(
    (resolve, reject) => {
      let done = false;
      const finish = (error?: Error) => {
        if (done) return;
        done = true;
        clearTimeout(timeout);
        req.off('data', data);
        req.off('end', end);
        req.off('aborted', aborted);
        req.off('error', aborted);
        try {
          if (error) {
            req.resume();
            reject(error);
            return;
          }
          const value: unknown = JSON.parse(
            new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, size)),
          );
          if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
          const input = value as Record<string, unknown>;
          if (reprocessing) {
            if (
              Object.keys(input).length !== 1 ||
              !Object.hasOwn(input, 'expectedRevision') ||
              !Number.isSafeInteger(input.expectedRevision) ||
              Number(input.expectedRevision) < 1 ||
              Number(input.expectedRevision) >= Number.MAX_SAFE_INTEGER
            )
              throw new Error();
            resolve({ expectedRevision: input.expectedRevision as number });
            return;
          }
          if (
            Object.keys(input).length !== 2 ||
            !Object.hasOwn(input, 'requestId') ||
            !Object.hasOwn(input, 'expectedCursor') ||
            typeof input.requestId !== 'string' ||
            !uuid.test(input.requestId) ||
            !Number.isSafeInteger(input.expectedCursor) ||
            (input.expectedCursor as number) < 0 ||
            (input.expectedCursor as number) > 100_000
          )
            throw new Error();
          resolve({
            requestId: input.requestId.toLowerCase(),
            expectedCursor: input.expectedCursor as number,
          });
        } catch {
          reject(
            new AssignmentError(
              400,
              'invalid_submission_request',
              reprocessing
                ? 'Send only a positive saved submission revision.'
                : 'Send only a request ID and a bounded saved-work cursor.',
            ),
          );
        } finally {
          bytes.fill(0);
        }
      };
      const data = (chunk: Buffer) => {
        if (size + chunk.length > maximum)
          finish(
            new AssignmentError(
              413,
              'submission_request_too_large',
              'Submission requests must fit within 1 KiB.',
            ),
          );
        else {
          bytes.set(chunk, size);
          size += chunk.length;
        }
      };
      const end = () => finish();
      const aborted = () =>
        finish(
          new AssignmentError(400, 'request_aborted', 'The submission request was interrupted.'),
        );
      const timeout = setTimeout(
        () =>
          finish(
            new AssignmentError(408, 'request_timeout', 'The submission request took too long.'),
          ),
        5000,
      );
      timeout.unref();
      req.on('data', data);
      req.on('end', end);
      req.on('aborted', aborted);
      req.on('error', aborted);
    },
  );
}

/** Invoked only after the shared session, Origin, header-CSRF and admission checks. */
export async function handleSubmissions(
  req: IncomingMessage,
  res: ServerResponse,
  service: AssignmentSubmissionService | undefined,
  principal: SessionPrincipal | undefined,
  refreshPrincipal: () => Promise<SessionPrincipal>,
): Promise<void> {
  if (!principal)
    throw new AssignmentError(403, 'student_launch_required', 'Open this assignment from Canvas.');
  student(principal);
  if ((req.url?.length ?? 0) > 1024)
    throw new AssignmentError(414, 'request_too_large', 'The submission request is too large.');
  const url = new URL(req.url ?? '/', 'https://localhost');
  const list = url.pathname === collection;
  const reprocess = /^\/api\/assignments\/work\/submissions\/([^/]+)\/reprocess$/.exec(
    url.pathname,
  );
  const reprocessLookup =
    /^\/api\/assignments\/work\/submissions\/([^/]+)\/reprocess-requests\/([^/]+)$/.exec(
      url.pathname,
    );
  if (!list && !reprocess && !reprocessLookup && !url.pathname.startsWith(requests))
    throw new AssignmentError(
      404,
      'submission_route_not_found',
      'This submission action is unavailable.',
    );
  const methods = list ? ['GET', 'POST'] : reprocess ? ['POST'] : ['GET'];
  if (!methods.includes(req.method ?? '')) {
    res.setHeader('Allow', methods.join(', '));
    throw new AssignmentError(
      405,
      'method_not_allowed',
      'This submission action is not supported.',
    );
  }
  let after: string | undefined;
  for (const [key, value] of url.searchParams) {
    if (
      !list ||
      req.method !== 'GET' ||
      key !== 'after' ||
      url.searchParams.getAll(key).length !== 1 ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(value)
    )
      throw new AssignmentError(
        400,
        'invalid_query',
        'Use only the submission cursor returned by the service.',
      );
    after = value;
  }
  const requestId =
    list || reprocess || reprocessLookup ? undefined : url.pathname.slice(requests.length);
  const submissionId = reprocess?.[1] ?? reprocessLookup?.[1];
  if (submissionId !== undefined && !uuid.test(submissionId))
    throw new AssignmentError(
      400,
      'invalid_submission_request',
      'Use a valid saved submission ID.',
    );
  const expectedRevision = reprocessLookup ? Number(reprocessLookup[2]) : undefined;
  if (
    reprocessLookup &&
    (!/^[1-9][0-9]*$/.test(reprocessLookup[2]) ||
      !Number.isSafeInteger(expectedRevision) ||
      Number(expectedRevision) < 1 ||
      Number(expectedRevision) >= Number.MAX_SAFE_INTEGER)
  )
    throw new AssignmentError(
      400,
      'invalid_submission_request',
      'Use a positive saved submission revision.',
    );
  if (requestId !== undefined && !uuid.test(requestId))
    throw new AssignmentError(
      400,
      'invalid_submission_request',
      'Use a valid submission request ID.',
    );
  if (req.headers.range)
    throw new AssignmentError(
      400,
      'range_not_supported',
      'Partial submission responses are not supported.',
    );
  if (
    req.method === 'GET' &&
    (req.headers['transfer-encoding'] || Number(req.headers['content-length'] ?? 0) !== 0)
  )
    throw new AssignmentError(
      400,
      'body_not_allowed',
      'Submission reads do not accept request bodies.',
    );
  if (!service)
    throw new AssignmentError(
      503,
      'submission_unconfigured',
      'Assignment submissions are not configured.',
    );

  const controller = new AbortController();
  const aborted = () => controller.abort();
  req.once('aborted', aborted);
  res.once('close', aborted);
  const timeout = setTimeout(aborted, 35_000);
  timeout.unref();
  const send = (status: number, value: unknown) => {
    if (controller.signal.aborted || req.aborted || res.destroyed)
      throw new AssignmentError(
        409,
        'submission_request_cancelled',
        'The submission request was interrupted. Check its exact request ID before trying again.',
      );
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(value));
  };
  try {
    const options = { signal: controller.signal };
    if (req.method === 'POST') {
      const input = await submissionBody(req, !!reprocess);
      const current = await refreshPrincipal();
      student(current);
      if (
        current.sessionId !== principal.sessionId ||
        current.userId !== principal.userId ||
        current.organizationId !== principal.organizationId
      )
        throw new AssignmentError(409, 'session_changed', 'Reopen this assignment from Canvas.');
      if (controller.signal.aborted || res.destroyed)
        throw new AssignmentError(
          400,
          'request_aborted',
          'The submission request was interrupted.',
        );
      if (reprocess) {
        const value = await service.reprocess(current, submissionId!.toLowerCase(), input, options);
        send(value.state === 'accepted' ? 202 : 409, publicReprocess(value));
      } else {
        const value = await service.capture(current, input, options);
        send(requestStatus(value.request), {
          request: publicRequest(value.request),
          duplicate: value.duplicate,
        });
      }
    } else if (reprocessLookup) {
      const value = await service.reprocessRequest(
        principal,
        submissionId!.toLowerCase(),
        expectedRevision!,
        options,
      );
      send(200, publicReprocess(value));
    } else if (requestId !== undefined) {
      const value = await service.request(principal, requestId.toLowerCase(), options);
      send(200, { request: publicRequest(value.request) });
    } else {
      const value = await service.list(principal, { after }, options);
      send(200, { submissions: value.submissions.map(publicStatus), nextCursor: value.nextCursor });
    }
  } finally {
    clearTimeout(timeout);
    req.removeListener('aborted', aborted);
    res.removeListener('close', aborted);
  }
}
