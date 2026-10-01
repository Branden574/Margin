import type { IncomingMessage, ServerResponse } from 'node:http';
import type { SessionPrincipal } from './identity/types.js';
import { SyncError, type PostgresSyncService } from './sync/index.js';

export type DocumentSyncService = Pick<
  PostgresSyncService,
  'append' | 'describeDocument' | 'catchUp'
>;

async function operationBody(req: IncomingMessage): Promise<unknown> {
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] ?? ''))
    throw new SyncError(415, 'json_required', 'Send an annotation operation as JSON.');
  const limit = 65536;
  if (Number(req.headers['content-length'] ?? 0) > limit)
    throw new SyncError(413, 'operation_too_large', 'The operation exceeds 64 KiB.');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit)
      throw new SyncError(413, 'operation_too_large', 'The operation exceeds 64 KiB.');
    chunks.push(Buffer.from(chunk));
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new SyncError(400, 'invalid_json', 'The annotation operation contains invalid JSON.');
  }
}

/** Invoked only after fresh session authentication and, on writes, CSRF verification. */
export async function handleDocumentSync(
  req: IncomingMessage,
  res: ServerResponse,
  service: DocumentSyncService,
  principal: SessionPrincipal,
): Promise<boolean> {
  const url = new URL(req.url ?? '/', 'https://localhost');
  const match = /^\/api\/sync\/documents\/([a-f0-9-]{36})(\/operations)?$/i.exec(url.pathname);
  if (!match) return false;
  const documentId = match[1].toLowerCase();
  const send = (value: unknown) => {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(value));
  };
  const allowed = req.method === 'GET' && match[2] ? ['afterCursor', 'limit'] : [];
  for (const name of url.searchParams.keys()) {
    if (!allowed.includes(name) || url.searchParams.getAll(name).length !== 1)
      throw new SyncError(400, 'invalid_query', 'The synchronization query is invalid.');
  }
  if (req.method === 'GET' && !match[2]) {
    send(await service.describeDocument(principal, documentId));
    return true;
  }
  if (req.method === 'GET' && match[2]) {
    const integer = (name: string, maximum: number) => {
      const value = url.searchParams.get(name);
      if (value === null) return undefined;
      if (
        !/^(0|[1-9][0-9]*)$/.test(value) ||
        !Number.isSafeInteger(Number(value)) ||
        Number(value) > maximum
      )
        throw new SyncError(
          400,
          'invalid_query',
          'Use bounded integer synchronization cursors and limits.',
        );
      return Number(value);
    };
    send(
      await service.catchUp(principal, {
        documentId,
        afterCursor: integer('afterCursor', 100000),
        limit: integer('limit', 100),
      }),
    );
    return true;
  }
  if (req.method === 'POST' && match[2]) {
    const input = await operationBody(req);
    if (
      !input ||
      typeof input !== 'object' ||
      Array.isArray(input) ||
      (input as Record<string, unknown>).documentId !== documentId
    )
      throw new SyncError(400, 'document_mismatch', 'The operation must belong to this document.');
    send(await service.append(principal, input));
    return true;
  }
  res.setHeader('Allow', match[2] ? 'GET, POST' : 'GET');
  throw new SyncError(405, 'method_not_allowed', 'This synchronization action is not supported.');
}
