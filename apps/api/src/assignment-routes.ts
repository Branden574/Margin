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
> &
  Partial<Pick<AssignmentService, 'listSources'>>;

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
  const catalog = url.pathname === '/api/assignments/sources';
  if (url.search && !catalog)
    throw new AssignmentError(
      400,
      'invalid_query',
      'Assignment routes do not accept query parameters.',
    );
  let after: string | undefined;
  if (catalog) {
    for (const [key, value] of url.searchParams) {
      if (
        key !== 'after' ||
        url.searchParams.getAll(key).length !== 1 ||
        !/^[A-Za-z0-9_-]{1,128}$/.test(value)
      )
        throw new AssignmentError(
          400,
          'invalid_source_cursor',
          'Use only the source cursor returned by discovery.',
        );
      after = value;
    }
  }
  const response = (status: number, value: unknown) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(value));
  };
  const complete = /^\/api\/assignments\/selections\/([a-f0-9-]{36})\/complete$/i.exec(
    url.pathname,
  );
  const get =
    catalog || ['/api/assignments/selection', '/api/assignments/current'].includes(url.pathname);
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
    if (catalog) {
      if (principal.role !== 'teacher')
        throw new AssignmentError(
          403,
          'teacher_required',
          'Source discovery requires a verified teacher course session.',
        );
      if (!service.listSources)
        throw new AssignmentError(
          503,
          'source_catalog_unconfigured',
          'Inspected source discovery is not configured.',
        );
      const controller = new AbortController();
      const aborted = () => controller.abort();
      req.once('aborted', aborted);
      res.once('close', aborted);
      const timeout = setTimeout(aborted, 30_000);
      try {
        const page = await service.listSources(principal, after, { signal: controller.signal });
        if (controller.signal.aborted || res.destroyed)
          throw new AssignmentError(
            409,
            'source_catalog_cancelled',
            'Source discovery was interrupted.',
          );
        // Deliberate allowlist: injected service implementation fields cannot leak
        // storage receipts, artifact identity, hashes or infrastructure URLs.
        response(200, {
          sources: page.sources.map((source) => ({
            documentId: source.documentId,
            versionId: source.versionId,
            name: source.name,
            pageCount: source.pageCount,
            bytes: source.bytes,
            inspection: source.inspection,
            availability: source.availability,
          })),
          nextCursor: page.nextCursor,
        });
      } finally {
        clearTimeout(timeout);
        req.removeListener('aborted', aborted);
        res.removeListener('close', aborted);
      }
    } else if (url.pathname === '/api/assignments/selection')
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

let activeSourceResponses = 0;

/** Returns false only for another assignment route; all work ownership comes from the launch. */
export async function handleCanvasWork(
  req: IncomingMessage,
  res: ServerResponse,
  service: import('./assignments/work/types.js').AssignmentWorkService,
  principal: SessionPrincipal,
): Promise<boolean> {
  if ((req.url?.length ?? 0) > 8192)
    throw new AssignmentError(414, 'request_too_large', 'The work request is too large.');
  const url = new URL(req.url ?? '/', 'https://localhost');
  const manifest = url.pathname === '/api/assignments/work' && req.method !== 'POST';
  const source = url.pathname === '/api/assignments/work/source';
  const operations = url.pathname === '/api/assignments/work/operations';
  if (!manifest && !source && !operations) return false;
  if (principal.authenticationMethod !== 'lti' || principal.role !== 'student')
    throw new AssignmentError(
      403,
      'student_launch_required',
      'Open your work from an approved Canvas assignment.',
    );
  const methods = operations ? ['GET', 'POST'] : ['GET'];
  if (!methods.includes(req.method ?? '')) {
    res.setHeader('Allow', methods.join(', '));
    throw new AssignmentError(405, 'method_not_allowed', 'This work action is not supported.');
  }
  if (req.headers.range)
    throw new AssignmentError(
      400,
      'range_not_supported',
      'Partial work responses are not supported.',
    );
  const parameters: { afterCursor?: number; limit?: number } = {};
  for (const [key, value] of url.searchParams) {
    if (
      !operations ||
      req.method !== 'GET' ||
      !['afterCursor', 'limit'].includes(key) ||
      url.searchParams.getAll(key).length !== 1 ||
      !/^(0|[1-9][0-9]{0,5})$/.test(value)
    )
      throw new AssignmentError(
        400,
        'invalid_query',
        'Use only bounded operation cursor and limit parameters.',
      );
    parameters[key as 'afterCursor' | 'limit'] = Number(value);
  }
  if (
    req.method === 'GET' &&
    (req.headers['transfer-encoding'] || Number(req.headers['content-length'] ?? 0) !== 0)
  )
    throw new AssignmentError(400, 'body_not_allowed', 'Work reads do not accept request bodies.');
  const controller = new AbortController();
  let bytes: Buffer | undefined;
  let sourceSlot = false;
  const dispose = () => {
    if (sourceSlot) {
      sourceSlot = false;
      activeSourceResponses--;
    }
    bytes?.fill(0);
    bytes = undefined;
  };
  const closed = () => {
    if (!res.writableFinished) controller.abort();
    dispose();
  };
  const aborted = () => controller.abort();
  req.once('aborted', aborted);
  res.once('close', closed);
  res.once('finish', dispose);
  const timeout = setTimeout(() => {
    controller.abort();
    if (res.headersSent) res.destroy();
  }, 35000);
  const options = { signal: controller.signal };
  try {
    const value = manifest
      ? await service.describe(principal, options)
      : operations
        ? req.method === 'POST'
          ? await service.append(principal, await jsonObject(req), options)
          : await service.catchUp(principal, parameters, options)
        : undefined;
    if (source) {
      if (activeSourceResponses >= 2)
        throw new AssignmentError(
          503,
          'source_reader_busy',
          'Source delivery is busy. Retry shortly.',
        );
      activeSourceResponses++;
      sourceSlot = true;
      bytes = await service.source(principal, options);
    }
    if (controller.signal.aborted || res.destroyed)
      throw new AssignmentError(409, 'work_request_cancelled', 'The work request was interrupted.');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    if (source) {
      res.writeHead(200, {
        'Content-Type': 'application/pdf',
        'Content-Length': bytes!.length,
        'Content-Disposition': 'inline; filename="assignment.pdf"',
      });
      // Keep bytes intact until Node finishes flushing or closes; end() can retain this buffer.
      res.end(bytes);
    } else {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(
        JSON.stringify(
          manifest ? value : operations && req.method === 'POST' ? { receipt: value } : value,
        ),
      );
    }
    return true;
  } catch (error) {
    clearTimeout(timeout);
    dispose();
    throw error;
  } finally {
    req.removeListener('aborted', aborted);
    // Response listeners own disposal after end() and remove each other once settled.
    const cleanup = () => {
      clearTimeout(timeout);
      res.removeListener('close', closed);
      res.removeListener('finish', dispose);
    };
    if (res.writableFinished || res.destroyed) {
      dispose();
      cleanup();
    } else {
      res.once('finish', cleanup);
      res.once('close', cleanup);
    }
  }
}
