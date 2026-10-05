import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type { KeyManagementProvider, WrappedDataKey } from '../encryption.js';
import type { AppendOperation } from './types.js';
import { MAX_OPERATION_BYTES } from './validation.js';
export const keyContext = (organizationId: string, documentId: string) =>
  `margin-sync-document-v1:${organizationId}:${documentId}`;
export const operationContext = (
  organizationId: string,
  actorId: string,
  input: AppendOperation,
  cursor: number,
) =>
  JSON.stringify([
    'margin-sync-operation-v1',
    organizationId,
    input.documentId,
    input.versionId,
    input.pageId,
    input.annotationId,
    actorId,
    input.operationId,
    input.baseRevision,
    cursor,
  ]);
export interface Ciphertext {
  ciphertext: Buffer;
  nonce: Buffer;
  tag: Buffer;
}
async function deadline<T>(promise: Promise<T>, disposeLate?: (value: T) => void): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let expired = false;
  const guarded = promise.then((value) => {
    if (expired) {
      disposeLate?.(value);
      throw new Error('Key management request exceeded its deadline.');
    }
    return value;
  });
  try {
    return await Promise.race([
      guarded,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          expired = true;
          reject(new Error('Key management request exceeded its deadline.'));
        }, 3000);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
export async function unwrapKey(
  provider: KeyManagementProvider,
  wrapped: WrappedDataKey,
  context: string,
): Promise<Buffer> {
  const key = await deadline(provider.unwrapKey(wrapped, context), (key) => key.fill(0));
  if (key.length !== 32) {
    key.fill(0);
    throw new Error('Invalid document data key.');
  }
  return key;
}
export async function newWrappedKey(provider: KeyManagementProvider, context: string) {
  const key = randomBytes(32);
  try {
    return await deadline(provider.wrapKey(key, context));
  } finally {
    key.fill(0);
  }
}
export function encrypt(key: Buffer, body: Buffer, context: string): Ciphertext {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce, { authTagLength: 16 });
  cipher.setAAD(Buffer.from(context));
  return {
    ciphertext: Buffer.concat([cipher.update(body), cipher.final()]),
    nonce,
    tag: cipher.getAuthTag(),
  };
}
export function decrypt(
  key: Buffer,
  record: Ciphertext,
  context: string,
  maximumBytes = MAX_OPERATION_BYTES,
): Buffer {
  if (
    !Number.isSafeInteger(maximumBytes) ||
    maximumBytes < 1 ||
    maximumBytes > 262144 ||
    record.ciphertext.length > maximumBytes ||
    record.nonce.length !== 12 ||
    record.tag.length !== 16
  )
    throw new Error('Invalid encrypted operation envelope.');
  const decipher = createDecipheriv('aes-256-gcm', key, record.nonce, { authTagLength: 16 });
  decipher.setAAD(Buffer.from(context));
  decipher.setAuthTag(record.tag);
  const pending = decipher.update(record.ciphertext);
  try {
    return Buffer.concat([pending, decipher.final()]);
  } catch (error) {
    pending.fill(0);
    throw error;
  }
}
