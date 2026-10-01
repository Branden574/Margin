import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type { KeyManagementProvider, WrappedDataKey } from '../encryption.js';
import type { ArtifactIdentity, ArtifactMetadata, ArtifactSource, ReadArtifact } from './types.js';
import { cancelStream, CloudArtifactError, nextChunk, StreamBudget } from './limits.js';
export const MAX_ARTIFACT_BYTES = 100 * 1024 * 1024;
export const MAX_ENVELOPE_OVERHEAD = 20 * 1024;
const MAGIC = Buffer.from('MGART001');
const MAX_HEADER = 16 * 1024,
  MAX_METADATA = 2048;
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const kinds = ['source-pdf', 'pdf-export', 'thumbnail', 'ocr-text', 'attachment'];
export function artifactIdentity(input: ArtifactIdentity): ArtifactIdentity {
  if (
    !input ||
    typeof input !== 'object' ||
    Object.keys(input).some(
      (key) => !['organizationId', 'documentId', 'versionId', 'artifactId', 'kind'].includes(key),
    ) ||
    !kinds.includes(input.kind)
  )
    throw new CloudArtifactError('invalid_identity', 'Use a server-authorized artifact identity.');
  for (const id of [input.organizationId, input.documentId, input.versionId, input.artifactId])
    if (typeof id !== 'string' || !uuid.test(id))
      throw new CloudArtifactError('invalid_identity', 'Artifact identities must be valid UUIDs.');
  return {
    organizationId: input.organizationId.toLowerCase(),
    documentId: input.documentId.toLowerCase(),
    versionId: input.versionId.toLowerCase(),
    artifactId: input.artifactId.toLowerCase(),
    kind: input.kind,
  };
}
export function artifactContext(identity: ArtifactIdentity) {
  return JSON.stringify([
    'margin-artifact-v1',
    identity.organizationId,
    identity.documentId,
    identity.versionId,
    identity.artifactId,
    identity.kind,
  ]);
}
export function artifactPath(identity: ArtifactIdentity) {
  return `artifacts/v1/${identity.organizationId}/${identity.documentId}/${identity.versionId}/${identity.artifactId}.mga`;
}
function metadata(input: ArtifactMetadata): ArtifactMetadata {
  if (
    !input ||
    typeof input !== 'object' ||
    Object.keys(input).some((key) => !['name', 'mimeType'].includes(key)) ||
    typeof input.name !== 'string' ||
    !input.name ||
    input.name.length > 255 ||
    /[\u0000-\u001f\u007f]/.test(input.name) ||
    ![
      'application/pdf',
      'image/png',
      'image/jpeg',
      'text/plain',
      'application/octet-stream',
    ].includes(input.mimeType)
  )
    throw new CloudArtifactError('invalid_metadata', 'Artifact metadata is invalid.');
  return { name: input.name, mimeType: input.mimeType };
}
interface Header {
  version: 1;
  algorithm: 'AES-256-GCM';
  nonce: string;
  wrappedKey: WrappedDataKey;
  payloadBytes: number;
}
function headerFrom(bytes: Buffer): { header: Header; ciphertext: Buffer; tag: Buffer } {
  if (bytes.length < 12 + 16 || !bytes.subarray(0, 8).equals(MAGIC))
    throw new CloudArtifactError('invalid_envelope', 'The encrypted artifact format is invalid.');
  const size = bytes.readUInt32BE(8);
  if (size < 1 || size > MAX_HEADER || 12 + size + 16 >= bytes.length)
    throw new CloudArtifactError('invalid_envelope', 'The encrypted artifact header is invalid.');
  let header: Header;
  try {
    header = JSON.parse(bytes.subarray(12, 12 + size).toString('utf8')) as Header;
  } catch {
    throw new CloudArtifactError('invalid_envelope', 'The encrypted artifact header is invalid.');
  }
  if (
    !header ||
    typeof header !== 'object' ||
    Object.keys(header).some(
      (key) => !['version', 'algorithm', 'nonce', 'wrappedKey', 'payloadBytes'].includes(key),
    ) ||
    header.version !== 1 ||
    header.algorithm !== 'AES-256-GCM' ||
    typeof header.nonce !== 'string' ||
    Buffer.from(header.nonce, 'base64').length !== 12 ||
    Buffer.from(header.nonce, 'base64').toString('base64') !== header.nonce ||
    !Number.isSafeInteger(header.payloadBytes) ||
    header.payloadBytes < 1 ||
    header.payloadBytes > MAX_ARTIFACT_BYTES ||
    !header.wrappedKey ||
    typeof header.wrappedKey !== 'object'
  )
    throw new CloudArtifactError('invalid_envelope', 'The encrypted artifact header is invalid.');
  return { header, ciphertext: bytes.subarray(12 + size, -16), tag: bytes.subarray(-16) };
}
export async function sealArtifact(
  identity: ArtifactIdentity,
  source: ArtifactSource,
  properties: ArtifactMetadata,
  expectedBytes: number,
  provider: KeyManagementProvider,
  signal: AbortSignal,
): Promise<Buffer> {
  if (
    !Number.isSafeInteger(expectedBytes) ||
    expectedBytes < 1 ||
    expectedBytes > MAX_ARTIFACT_BYTES
  )
    throw new CloudArtifactError(
      'artifact_too_large',
      'Artifacts must contain between one byte and 100 MiB.',
    );
  const info = Buffer.from(JSON.stringify(metadata(properties)));
  if (info.length > MAX_METADATA)
    throw new CloudArtifactError('invalid_metadata', 'Artifact metadata exceeds its limit.');
  const key = randomBytes(32),
    nonce = randomBytes(12);
  let iterator: AsyncIterator<Uint8Array> | undefined;
  try {
    const wrappedKey = await provider.wrapKey(key, artifactContext(identity));
    if (signal.aborted)
      throw new CloudArtifactError('operation_aborted', 'The artifact upload was interrupted.');
    const header: Header = {
      version: 1,
      algorithm: 'AES-256-GCM',
      nonce: nonce.toString('base64'),
      wrappedKey,
      payloadBytes: expectedBytes,
    };
    const encoded = Buffer.from(JSON.stringify(header));
    if (encoded.length > MAX_HEADER)
      throw new CloudArtifactError(
        'invalid_key_envelope',
        'The wrapped key envelope exceeds its limit.',
      );
    const cipher = createCipheriv('aes-256-gcm', key, nonce, { authTagLength: 16 });
    cipher.setAAD(Buffer.from(`${artifactContext(identity)}:${expectedBytes}`));
    const metadataSize = Buffer.alloc(4);
    metadataSize.writeUInt32BE(info.length);
    // One bounded ciphertext allocation; do not retain an object per producer chunk.
    const body = Buffer.alloc(12 + encoded.length + 4 + info.length + expectedBytes + 16);
    MAGIC.copy(body);
    body.writeUInt32BE(encoded.length, 8);
    encoded.copy(body, 12);
    let offset = 12 + encoded.length;
    for (const part of [metadataSize, info]) {
      const encrypted = cipher.update(part);
      offset += encrypted.copy(body, offset);
    }
    let size = 0;
    const budget = new StreamBudget();
    const iterable: AsyncIterable<Uint8Array> =
      source instanceof Uint8Array
        ? (async function* () {
            yield source;
          })()
        : source;
    if (!iterable?.[Symbol.asyncIterator])
      throw new CloudArtifactError('invalid_stream', 'Use a bounded binary artifact stream.');
    iterator = iterable[Symbol.asyncIterator]();
    while (true) {
      const result = await nextChunk(iterator, signal);
      if (result.done) break;
      const chunk = result.value;
      if (!(chunk instanceof Uint8Array))
        throw new CloudArtifactError(
          'invalid_stream',
          'Artifact streams must produce binary chunks.',
        );
      if (!(await budget.observe(chunk.byteLength, signal))) continue;
      size += chunk.byteLength;
      if (size > expectedBytes)
        throw new CloudArtifactError(
          'artifact_size_mismatch',
          'The artifact stream exceeds its declared size.',
        );
      const encrypted = cipher.update(chunk);
      offset += encrypted.copy(body, offset);
    }
    if (size !== expectedBytes)
      throw new CloudArtifactError(
        'artifact_size_mismatch',
        'The artifact stream ended before its declared size.',
      );
    const final = cipher.final();
    if (final.length || offset !== body.length - 16)
      throw new CloudArtifactError('invalid_envelope', 'The encrypted artifact length is invalid.');
    cipher.getAuthTag().copy(body, offset);
    return body;
  } finally {
    key.fill(0);
    info.fill(0);
    cancelStream(source);
    if (iterator) cancelStream(iterator);
  }
}
export async function openArtifact(
  identity: ArtifactIdentity,
  bytes: Buffer,
  provider: KeyManagementProvider,
  signal: AbortSignal,
): Promise<ReadArtifact> {
  if (bytes.length > MAX_ARTIFACT_BYTES + MAX_ENVELOPE_OVERHEAD)
    throw new CloudArtifactError(
      'artifact_too_large',
      'The stored artifact exceeds its size limit.',
    );
  const { header, ciphertext, tag } = headerFrom(bytes);
  let key: Buffer | undefined, plain: Buffer | undefined;
  try {
    key = await provider.unwrapKey(header.wrappedKey, artifactContext(identity));
    if (key.length !== 32 || signal.aborted) throw new Error('Key unavailable or interrupted.');
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(header.nonce, 'base64'), {
      authTagLength: 16,
    });
    decipher.setAAD(Buffer.from(`${artifactContext(identity)}:${header.payloadBytes}`));
    decipher.setAuthTag(tag);
    plain = decipher.update(ciphertext);
    const final = decipher.final();
    if (final.length) throw new Error('Unexpected GCM final output.');
    const size = plain.readUInt32BE(0);
    if (size < 1 || size > MAX_METADATA || plain.length !== 4 + size + header.payloadBytes)
      throw new Error('Invalid encrypted metadata size.');
    const info = metadata(
      JSON.parse(plain.subarray(4, 4 + size).toString('utf8')) as ArtifactMetadata,
    );
    const payload = plain.subarray(4 + size);
    plain.subarray(0, 4 + size).fill(0);
    plain = undefined;
    return { bytes: payload, metadata: info };
  } catch {
    plain?.fill(0);
    throw new CloudArtifactError(
      'artifact_authentication_failed',
      'The stored artifact could not be authenticated. No content was released.',
    );
  } finally {
    key?.fill(0);
  }
}
