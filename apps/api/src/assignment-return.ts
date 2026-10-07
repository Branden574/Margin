import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AuthenticatedRequest, IdentityService } from './identity/service.js';
import { AssignmentError, type AssignmentService } from './assignments/index.js';

const uuid = '[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}';
const route = new RegExp(`^/api/assignments/selections/(${uuid})/return$`, 'i');
const assignmentId = new RegExp(`^${uuid}$`, 'i');
const MAXIMUM_BYTES = 1024;

/** Only this dedicated native-form route may obtain CSRF from a bounded form body. */
export function isCanvasAssignmentReturnPath(path: string): boolean {
  return route.test(path);
}

async function formBody(
  req: IncomingMessage,
): Promise<{ csrfToken: string; assignmentId: string | null }> {
  if (
    !/^application\/x-www-form-urlencoded(?:\s*;\s*charset=utf-8)?\s*$/i.test(
      req.headers['content-type'] ?? '',
    )
  )
    throw new AssignmentError(415, 'form_required', 'Send this selection as a UTF-8 form.');
  if (req.headers['content-encoding'] && req.headers['content-encoding'] !== 'identity')
    throw new AssignmentError(415, 'encoding_not_supported', 'Compressed forms are not supported.');
  const length = req.headers['content-length'];
  if (length !== undefined && (!/^(0|[1-9][0-9]*)$/.test(length) || Number(length) > MAXIMUM_BYTES))
    throw new AssignmentError(
      413,
      'return_request_too_large',
      'The selection form must fit within 1 KiB.',
    );
  if (req.aborted || req.destroyed)
    throw new AssignmentError(400, 'request_aborted', 'The selection request was interrupted.');
  const bytes = Buffer.allocUnsafe(MAXIMUM_BYTES);
  let size = 0;
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (error?: AssignmentError) => {
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
        const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, size));
        const pairs = text.split('&');
        if (pairs.length !== 2) throw new Error();
        const fields = new Map<string, string>();
        for (const pair of pairs) {
          const separator = pair.indexOf('=');
          if (separator < 1) throw new Error();
          const decode = (value: string) => decodeURIComponent(value.replace(/\+/g, ' '));
          const key = decode(pair.slice(0, separator));
          const value = decode(pair.slice(separator + 1));
          if (!['csrfToken', 'assignmentId'].includes(key) || fields.has(key)) throw new Error();
          fields.set(key, value);
        }
        const selected = fields.get('assignmentId');
        if (selected === undefined || (selected !== '' && !assignmentId.test(selected)))
          throw new Error();
        resolve({
          csrfToken: fields.get('csrfToken')!,
          assignmentId: selected.toLowerCase() || null,
        });
      } catch {
        reject(
          new AssignmentError(
            400,
            'invalid_return_form',
            'Send exactly one CSRF token and one assignment selection, or an empty selection to cancel.',
          ),
        );
      } finally {
        bytes.fill(0);
      }
    };
    const data = (chunk: Buffer) => {
      if (size + chunk.length > MAXIMUM_BYTES)
        finish(
          new AssignmentError(
            413,
            'return_request_too_large',
            'The selection form must fit within 1 KiB.',
          ),
        );
      else {
        bytes.set(chunk, size);
        size += chunk.length;
      }
    };
    const end = () => finish();
    const aborted = () =>
      finish(new AssignmentError(400, 'request_aborted', 'The selection request was interrupted.'));
    const timeout = setTimeout(
      () =>
        finish(
          new AssignmentError(
            408,
            'request_timeout',
            'The selection form took too long. Restart from Canvas.',
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

/** Called after initial authentication and tenant admission; never inject this HTML into the SPA. */
export async function handleCanvasAssignmentReturn(
  req: IncomingMessage,
  res: ServerResponse,
  service: Pick<AssignmentService, 'completeDeepLink'>,
  identity: Pick<IdentityService, 'authenticateRequest' | 'verifyCsrf' | 'requireSameOrigin'>,
  authenticated: AuthenticatedRequest,
): Promise<void> {
  const path = new URL(req.url ?? '/', 'https://localhost').pathname;
  const match = route.exec(path);
  if (!match || req.url !== path)
    throw new AssignmentError(
      400,
      'invalid_return_route',
      'Use the exact selection return path without query parameters.',
    );
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    throw new AssignmentError(405, 'method_not_allowed', 'Return a selection using POST.');
  }
  const teacher = (session: AuthenticatedRequest) => {
    if (session.principal.authenticationMethod !== 'lti' || session.principal.role !== 'teacher')
      throw new AssignmentError(
        403,
        'teacher_launch_required',
        'Open content selection from an approved Canvas teacher launch.',
      );
  };
  teacher(authenticated);
  identity.requireSameOrigin(req, true);
  const input = await formBody(req);
  // Copy only the identity request shape. Never mutate IncomingMessage headers or
  // let body tokens satisfy the shared JSON/header-CSRF branch.
  const csrfRequest = { headers: { ...req.headers, 'x-csrf-token': input.csrfToken } };
  identity.verifyCsrf(csrfRequest, authenticated);
  const current = await identity.authenticateRequest(req);
  teacher(current);
  identity.verifyCsrf(csrfRequest, current);
  const checkConnected = () => {
    if (req.aborted || res.destroyed)
      throw new AssignmentError(400, 'request_aborted', 'The selection request was interrupted.');
  };
  checkConnected();
  const result = await service.completeDeepLink(
    current.principal,
    match[1].toLowerCase(),
    input.assignmentId,
  );
  // Completion can consume a one-use selection. A disconnected client is not a rollback.
  checkConnected();
  res.writeHead(200, result.headers);
  res.end(result.html);
}
