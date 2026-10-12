import { createVaultGuard, vaultTransaction } from '../vault';
import { readAuthorContext } from './client';
import { id, upload, uploadIntent } from './decode';
import {
  MAX_AUTHOR_UPLOAD_BYTES,
  type AuthorContext,
  type AuthorUpload,
  type AuthorUploadIntent,
} from './types';

export interface AuthorUploadTask {
  revision: string;
  intent: AuthorUploadIntent;
  upload: AuthorUpload | null;
}
export class AuthorUploadConflict extends Error {
  constructor() {
    super('This upload changed in another tab. Reload its saved status before continuing.');
  }
}
const damaged = () =>
  new Error('The saved upload is damaged or unsupported. Its encrypted copy has not been changed.');
function binding(context: AuthorContext) {
  const { origin, session, selection } = readAuthorContext(context);
  return [
    origin,
    session.sessionId,
    session.organizationId,
    session.userId,
    selection.id,
    selection.courseId,
    selection.expiresAt,
  ];
}
function lifecycle(context: AuthorContext, signal?: AbortSignal) {
  const identity = binding(context),
    vault = createVaultGuard();
  const guard = () => {
    vault();
    if (signal?.aborted)
      throw new DOMException('The transfer was cancelled. Its saved copy is kept.', 'AbortError');
    if (JSON.stringify(binding(context)) !== JSON.stringify(identity))
      throw new Error('Reopen this selection from Canvas.');
  };
  const key = JSON.stringify(identity);
  return { identity, key, blobKey: `${key}:pdf`, guard };
}
function parse(value: unknown, identity: unknown): AuthorUploadTask {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw damaged();
  const row = value as Record<string, unknown>;
  if (
    Object.keys(row).some(
      (key) => !['schema', 'binding', 'revision', 'intent', 'upload'].includes(key),
    ) ||
    row.schema !== 1 ||
    JSON.stringify(row.binding) !== JSON.stringify(identity)
  )
    throw damaged();
  try {
    const intent = uploadIntent(row.intent),
      receipt = row.upload === null ? null : upload(row.upload);
    if (receipt && receipt.requestId !== intent.requestId) throw damaged();
    return { revision: id(row.revision), intent, upload: receipt };
  } catch {
    throw damaged();
  }
}
export async function authorUploadDigest(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  try {
    return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (byte) =>
      byte.toString(16).padStart(2, '0'),
    ).join('');
  } finally {
    bytes.fill(0);
  }
}
export async function readAuthorUpload(
  context: AuthorContext,
): Promise<AuthorUploadTask | undefined> {
  const { identity, key, blobKey, guard } = lifecycle(context);
  const result = await vaultTransaction(
    async (tx) => {
      const found = await tx.get<unknown>('author-uploads', key);
      if (found === undefined) return undefined;
      const parsed = parse(found, identity);
      if (!(await tx.has('author-uploads', blobKey))) throw damaged();
      return parsed;
    },
    { guard },
  );
  guard();
  return result;
}
/** File and exact request commit in the same encrypted transaction, before any network mutation. */
export async function prepareAuthorUpload(
  context: AuthorContext,
  file: File,
  signal?: AbortSignal,
): Promise<AuthorUploadTask> {
  const { identity, key, blobKey, guard } = lifecycle(context, signal);
  if (
    !(file instanceof Blob) ||
    typeof file.name !== 'string' ||
    !file.name.trim() ||
    file.name.length > 240 ||
    /[\u0000-\u001f\u007f]/.test(file.name) ||
    file.size < 5 ||
    file.size > MAX_AUTHOR_UPLOAD_BYTES ||
    (file.type !== '' &&
      file.type !== 'application/pdf' &&
      file.type !== 'application/octet-stream')
  )
    throw new Error('Choose a PDF up to 100 MB with a filename of 240 characters or fewer.');
  const header = await file.slice(0, 5).text();
  guard();
  if (header !== '%PDF-')
    throw new Error('This file does not have a PDF header. Choose a PDF document.');
  const blob = file.slice(0, file.size, 'application/pdf');
  const intent = uploadIntent({
    requestId: crypto.randomUUID(),
    metadata: { name: file.name, mimeType: 'application/pdf' },
    plaintextBytes: blob.size,
    plaintextSha256: await authorUploadDigest(blob),
  });
  guard();
  const result = await vaultTransaction(
    async (tx) => {
      const previous = await tx.get<unknown>('author-uploads', key);
      if (previous !== undefined) {
        const task = parse(previous, identity);
        if (!task.upload || !['ready', 'rejected'].includes(task.upload.status))
          throw new Error(
            'Resume the saved upload before choosing another file. Its original bytes are kept.',
          );
      }
      const task: AuthorUploadTask = { revision: crypto.randomUUID(), intent, upload: null };
      tx.put('author-uploads', key, { schema: 1, binding: identity, ...task });
      tx.put('author-uploads', blobKey, blob);
      return task;
    },
    { guard, signal },
  );
  guard();
  return result;
}
export async function saveAuthorUploadStatus(
  context: AuthorContext,
  task: AuthorUploadTask,
  receipt: AuthorUpload,
  signal?: AbortSignal,
): Promise<AuthorUploadTask> {
  const { identity, key, blobKey, guard } = lifecycle(context, signal);
  const expected = structuredClone(task),
    next = upload(receipt);
  const result = await vaultTransaction(
    async (tx) => {
      const previous = parse(await tx.get('author-uploads', key), identity);
      if (
        previous.revision !== expected.revision ||
        JSON.stringify(previous.intent) !== JSON.stringify(expected.intent)
      )
        throw new AuthorUploadConflict();
      if (!(await tx.has('author-uploads', blobKey))) throw damaged();
      if (
        next.requestId !== previous.intent.requestId ||
        (previous.upload && next.id !== previous.upload.id)
      )
        throw damaged();
      if (
        previous.upload &&
        ((['ready', 'rejected'].includes(previous.upload.status) &&
          next.status !== previous.upload.status) ||
          (previous.upload.status === 'quarantined' && next.status === 'pending'))
      )
        throw damaged();
      const updated: AuthorUploadTask = {
        ...previous,
        revision: crypto.randomUUID(),
        upload: next,
      };
      tx.put('author-uploads', key, { schema: 1, binding: identity, ...updated });
      return updated;
    },
    { guard, signal },
  );
  guard();
  return result;
}
export async function readAuthorUploadFile(
  context: AuthorContext,
  task: AuthorUploadTask,
  signal?: AbortSignal,
): Promise<Blob> {
  const { identity, key, blobKey, guard } = lifecycle(context, signal);
  const expected = structuredClone(task);
  const blob = await vaultTransaction(
    async (tx) => {
      const previous = parse(await tx.get('author-uploads', key), identity);
      if (
        previous.revision !== expected.revision ||
        JSON.stringify(previous.intent) !== JSON.stringify(expected.intent)
      )
        throw new AuthorUploadConflict();
      const file = await tx.get<unknown>('author-uploads', blobKey);
      if (
        !(file instanceof Blob) ||
        file.type !== 'application/pdf' ||
        file.size !== previous.intent.plaintextBytes
      )
        throw damaged();
      return file;
    },
    { guard, signal },
  );
  guard();
  if ((await authorUploadDigest(blob)) !== expected.intent.plaintextSha256) throw damaged();
  guard();
  return blob;
}
