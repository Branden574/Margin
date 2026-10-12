import type { IncomingMessage, ServerResponse } from 'node:http';
import type { SessionPrincipal } from './identity/types.js';
import { IngestionError, type SourceUploadInput } from './ingestion/types.js';
import type { SourceUploadService, SourceUploadStatus } from './ingestion/upload.js';
import { strictJson } from './strict-json.js';

const collection = '/api/assignments/source-uploads';
const maximumFile = 100 * 1024 * 1024;
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
export const isSourceUploadPath = (path: string) =>
  path === collection || path.startsWith(collection + '/');
const view = (value: SourceUploadStatus): SourceUploadStatus => ({
  id: value.id,
  requestId: value.requestId,
  status: value.status,
});
function teacher(principal: SessionPrincipal | undefined): asserts principal is SessionPrincipal {
  if (!principal || principal.authenticationMethod !== 'lti' || principal.role !== 'teacher')
    throw new IngestionError(
      403,
      'teacher_launch_required',
      'Open assignment setup from an approved Canvas teacher account.',
    );
}
async function jsonBody(req: IncomingMessage, signal: AbortSignal): Promise<SourceUploadInput> {
  const maximum = 4096;
  const bytes = Buffer.alloc(maximum);
  let size = 0;
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (error?: Error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      req.off('data', data);
      req.off('end', end);
      req.off('aborted', abort);
      req.off('error', abort);
      signal.removeEventListener('abort', abort);
      try {
        if (error) {
          req.resume();
          reject(error);
          return;
        }
        const value: unknown = strictJson(
          new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, size)),
        );
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
        const input = value as Record<string, unknown>;
        const keys = ['requestId', 'metadata', 'plaintextBytes', 'plaintextSha256'];
        const metadata = input.metadata as Record<string, unknown> | undefined;
        if (
          Object.keys(input).length !== keys.length ||
          keys.some((key) => !Object.hasOwn(input, key)) ||
          typeof input.requestId !== 'string' ||
          !uuid.test(input.requestId) ||
          !metadata ||
          typeof metadata !== 'object' ||
          Array.isArray(metadata) ||
          Object.keys(metadata).length !== 2 ||
          typeof metadata.name !== 'string' ||
          metadata.name.length < 1 ||
          metadata.name.length > 240 ||
          /[\u0000-\u001f\u007f]/.test(metadata.name) ||
          metadata.mimeType !== 'application/pdf' ||
          !Number.isSafeInteger(input.plaintextBytes) ||
          Number(input.plaintextBytes) < 1 ||
          Number(input.plaintextBytes) > maximumFile ||
          typeof input.plaintextSha256 !== 'string' ||
          !/^[a-f0-9]{64}$/.test(input.plaintextSha256)
        )
          throw new Error();
        resolve({
          requestId: input.requestId,
          metadata: { name: metadata.name, mimeType: 'application/pdf' },
          plaintextBytes: input.plaintextBytes as number,
          plaintextSha256: input.plaintextSha256,
        });
      } catch {
        reject(
          new IngestionError(
            400,
            'invalid_source_upload',
            'Send only the saved PDF upload request, name, size and digest.',
          ),
        );
      } finally {
        bytes.fill(0);
      }
    };
    const data = (chunk: Buffer) => {
      if (size + chunk.length > maximum)
        finish(
          new IngestionError(
            413,
            'source_request_too_large',
            'Source requests must fit within 4 KiB.',
          ),
        );
      else {
        bytes.set(chunk, size);
        size += chunk.length;
      }
    };
    const end = () => finish();
    const abort = () =>
      finish(
        new IngestionError(
          400,
          'source_request_interrupted',
          'The source request was interrupted. Keep its saved request ID.',
        ),
      );
    const timer = setTimeout(
      () =>
        finish(
          new IngestionError(
            408,
            'request_timeout',
            'The source request took too long. Retry its saved request.',
          ),
        ),
      5000,
    );
    timer.unref();
    req.on('data', data);
    req.once('end', end);
    req.once('aborted', abort);
    req.once('error', abort);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted || req.aborted || req.destroyed) abort();
  });
}

/** The shared API has already enforced session authentication, Origin, CSRF and request admission. */
export async function handleSourceUploads(
  ...args: Parameters<typeof handleValidatedSourceUploads>
) {
  const [req, res] = args;
  try {
    return await handleValidatedSourceUploads(...args);
  } finally {
    // Includes early route/header rejection, before the streaming handler installs its listeners.
    if (!req.complete && !res.headersSent && !res.destroyed) {
      res.setHeader('Connection', 'close');
      req.resume();
    }
  }
}

async function handleValidatedSourceUploads(
  req: IncomingMessage,
  res: ServerResponse,
  service: SourceUploadService | undefined,
  principal: SessionPrincipal | undefined,
  refreshPrincipal: () => Promise<SessionPrincipal>,
) {
  teacher(principal);
  if ((req.url?.length ?? 0) > 1024)
    throw new IngestionError(414, 'request_too_large', 'The source upload request is too large.');
  const url = new URL(req.url ?? '/', 'https://localhost');
  if (url.search || req.headers.range)
    throw new IngestionError(
      400,
      'invalid_source_query',
      'Source uploads do not accept query parameters or ranges.',
    );
  const match = /^\/api\/assignments\/source-uploads\/([^/]+)(\/content)?$/.exec(url.pathname);
  if (url.pathname !== collection && (!match || !uuid.test(match[1])))
    throw new IngestionError(
      404,
      'source_route_not_found',
      'This source upload action is unavailable.',
    );
  const method = url.pathname === collection ? 'POST' : match?.[2] ? 'PUT' : 'GET';
  if (req.method !== method) {
    res.setHeader('Allow', method);
    throw new IngestionError(
      405,
      'method_not_allowed',
      'This source upload action is not supported.',
    );
  }
  if (req.headers['content-encoding'] && req.headers['content-encoding'] !== 'identity')
    throw new IngestionError(
      415,
      'encoding_not_supported',
      'Compressed upload bodies are not supported.',
    );
  const length = req.headers['content-length'];
  if (
    length !== undefined &&
    (!/^(0|[1-9][0-9]*)$/.test(length) ||
      Number(length) > (method === 'POST' ? 4096 : method === 'PUT' ? maximumFile : 0))
  )
    throw new IngestionError(
      413,
      'source_upload_size',
      'The source request exceeds its size limit.',
    );
  if (method === 'GET' && req.headers['transfer-encoding'])
    throw new IngestionError(400, 'body_not_allowed', 'Source status reads do not accept a body.');
  const type = req.headers['content-type'] ?? '';
  if (method === 'POST' && !/^application\/json(?:\s*;\s*charset=utf-8)?\s*$/i.test(type))
    throw new IngestionError(415, 'json_required', 'Send source requests as UTF-8 JSON.');
  if (method === 'PUT' && type !== 'application/pdf')
    throw new IngestionError(
      415,
      'pdf_required',
      'Send the PDF with Content-Type: application/pdf.',
    );
  if (!service)
    throw new IngestionError(
      503,
      'source_upload_unconfigured',
      'Teacher source uploads are not configured in this workspace.',
    );
  const controller = new AbortController();
  let timedOut = false;
  const abort = () => controller.abort();
  req.once('aborted', abort);
  res.once('close', abort);
  const timeout = setTimeout(() => {
    timedOut = true;
    abort();
  }, 60_000);
  timeout.unref();
  const send = (status: number, value: unknown) => {
    if (controller.signal.aborted || req.aborted || res.destroyed)
      throw new IngestionError(
        timedOut ? 408 : 409,
        'source_request_interrupted',
        'Check the saved upload status before retrying.',
      );
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(value));
  };
  try {
    const options = { signal: controller.signal };
    if (method === 'GET') {
      send(200, { upload: view(await service.read(principal, match![1], options)) });
      return;
    }
    const input = method === 'POST' ? await jsonBody(req, controller.signal) : undefined;
    const current = await refreshPrincipal();
    teacher(current);
    if (
      current.sessionId !== principal.sessionId ||
      current.userId !== principal.userId ||
      current.organizationId !== principal.organizationId
    )
      throw new IngestionError(
        409,
        'source_session_changed',
        'Reopen assignment setup from Canvas. Your saved upload is kept.',
      );
    if (controller.signal.aborted)
      throw new IngestionError(
        409,
        'source_request_interrupted',
        'Check the saved upload status before retrying.',
      );
    const result =
      method === 'POST'
        ? await service.reserve(current, input!, options)
        : await service.upload(
            current,
            match![1],
            req.iterator({ destroyOnReturn: false }),
            options,
          );
    send(result.upload.status === 'ready' || result.upload.status === 'rejected' ? 200 : 202, {
      upload: view(result.upload),
      duplicate: result.duplicate,
    });
  } finally {
    clearTimeout(timeout);
    req.off('aborted', abort);
    res.off('close', abort);
  }
}
