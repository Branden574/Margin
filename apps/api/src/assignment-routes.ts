import type { IncomingMessage, ServerResponse } from 'node:http';
import type { SessionPrincipal } from './identity/types.js';
import {
  AssignmentError,
  type AssignmentRecord,
  type AssignmentService,
} from './assignments/index.js';

export type CanvasAssignmentService = Pick<
  AssignmentService,
  'create' | 'currentSelection' | 'currentAssignment' | 'completeDeepLink' | 'reserveStudentWork'
>;

/** Source receipts and infrastructure identities are never part of the editor's assignment view. */
function publicAssignment(record: AssignmentRecord | null) {
  if (!record) return null;
  return {
    id: record.id,
    title: record.title,
    instructions: record.instructions,
    policy: record.policy,
    createdAt: record.createdAt,
  };
}

async function jsonObject(req: IncomingMessage): Promise<Record<string, unknown>> {
  const maximum = 65536;
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?\s*$/i.test(req.headers['content-type'] ?? ''))
    throw new AssignmentError(415, 'json_required', 'Send this assignment request as UTF-8 JSON.');
  if (req.headers['content-encoding'] && req.headers['content-encoding'] !== 'identity')
    throw new AssignmentError(
      415,
      'encoding_not_supported',
      'Compressed request bodies are not supported.',
    );
  const length = req.headers['content-length'];
  if (length !== undefined && (!/^(0|[1-9][0-9]*)$/.test(length) || Number(length) > maximum))
    throw new AssignmentError(
      413,
      'assignment_request_too_large',
      'Assignment requests must fit within 64 KiB.',
    );
  const bytes = Buffer.allocUnsafe(maximum);
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
        resolve(value as Record<string, unknown>);
      } catch {
        reject(new AssignmentError(400, 'invalid_json', 'Send a valid UTF-8 JSON object.'));
      } finally {
        bytes.fill(0);
      }
    };
    const data = (chunk: Buffer) => {
      if (size + chunk.length > maximum)
        finish(
          new AssignmentError(
            413,
            'assignment_request_too_large',
            'Assignment requests must fit within 64 KiB.',
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
        new AssignmentError(400, 'request_aborted', 'The assignment request was interrupted.'),
      );
    const timeout = setTimeout(
      () =>
        finish(
          new AssignmentError(
            408,
            'request_timeout',
            'The assignment request took too long. Retry from Canvas.',
          ),
        ),
      5000,
    );
    timeout.unref();
    req.on('data', data);
    req.on('end', end);
    req.on('aborted', aborted);
    req.on('error', aborted);
  });
}

/** Called after live identity authentication, CSRF verification and tenant admission limits. */
export async function handleCanvasAssignments(
  req: IncomingMessage,
  res: ServerResponse,
  service: CanvasAssignmentService,
  principal: SessionPrincipal,
): Promise<void> {
  if (principal.authenticationMethod !== 'lti')
    throw new AssignmentError(
      403,
      'canvas_launch_required',
      'Open this workspace from an approved Canvas course.',
    );
  if ((req.url?.length ?? 0) > 8192)
    throw new AssignmentError(414, 'request_too_large', 'The assignment request is too large.');
  const url = new URL(req.url ?? '/', 'https://localhost');
  if (url.search)
    throw new AssignmentError(
      400,
      'invalid_query',
      'Assignment routes do not accept query parameters.',
    );
  const response = (status: number, value: unknown) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(value));
  };
  const complete = /^\/api\/assignments\/selections\/([a-f0-9-]{36})\/complete$/i.exec(
    url.pathname,
  );
  const get = ['/api/assignments/selection', '/api/assignments/current'].includes(url.pathname);
  const post =
    ['/api/assignments', '/api/assignments/work'].includes(url.pathname) || Boolean(complete);
  if (!get && !post)
    throw new AssignmentError(
      404,
      'assignment_route_not_found',
      'This assignment route does not exist.',
    );
  if (req.method !== (get ? 'GET' : 'POST')) {
    res.setHeader('Allow', get ? 'GET' : 'POST');
    throw new AssignmentError(
      405,
      'method_not_allowed',
      'This assignment action is not supported.',
    );
  }
  if (get) {
    if (req.headers['transfer-encoding'] || Number(req.headers['content-length'] ?? 0) !== 0)
      throw new AssignmentError(
        400,
        'body_not_allowed',
        'Assignment reads do not accept request bodies.',
      );
    if (url.pathname === '/api/assignments/selection')
      response(200, { selection: await service.currentSelection(principal) });
    else
      response(200, { assignment: publicAssignment(await service.currentAssignment(principal)) });
    return;
  }
  const input = await jsonObject(req);
  if (url.pathname === '/api/assignments') {
    response(201, { assignment: publicAssignment(await service.create(principal, input)) });
  } else if (url.pathname === '/api/assignments/work') {
    if (Object.keys(input).length)
      throw new AssignmentError(
        400,
        'unexpected_field',
        'The work assignment and student come from the verified launch.',
      );
    response(202, { work: await service.reserveStudentWork(principal) });
  } else if (complete) {
    if (
      Object.keys(input).length !== 1 ||
      !Object.hasOwn(input, 'assignmentId') ||
      (input.assignmentId !== null &&
        (typeof input.assignmentId !== 'string' ||
          !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(
            input.assignmentId,
          )))
    )
      throw new AssignmentError(
        400,
        'invalid_selection',
        'Select one assignment, or send null to cancel.',
      );
    const result = await service.completeDeepLink(
      principal,
      complete[1].toLowerCase(),
      input.assignmentId as string | null,
    );
    res.writeHead(200, result.headers);
    res.end(result.html);
  }
}
