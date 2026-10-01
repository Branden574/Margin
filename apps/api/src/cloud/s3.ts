import { createHash, timingSafeEqual } from 'node:crypto';
import { Agent } from 'node:https';
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  type PutObjectCommandOutput,
  type GetObjectCommandOutput,
  type DeleteObjectCommandOutput,
} from '@aws-sdk/client-s3';
import { NodeHttpHandler } from '@smithy/node-http-handler';
import type { KeyManagementProvider } from '../encryption.js';
import {
  artifactIdentity,
  artifactPath,
  MAX_ARTIFACT_BYTES,
  MAX_ENVELOPE_OVERHEAD,
  openArtifact,
  sealArtifact,
} from './envelope.js';
import {
  awsEndpoint,
  bounded,
  cancelStream,
  checkedKeyArn,
  checkedRegion,
  CloudArtifactError,
  nextChunk,
  StreamBudget,
} from './limits.js';
import type {
  ArtifactIdentity,
  ArtifactMetadata,
  ArtifactReceipt,
  ArtifactSource,
  ReadArtifact,
} from './types.js';
export interface S3Transport {
  send(
    command: PutObjectCommand,
    options?: { abortSignal?: AbortSignal },
  ): Promise<PutObjectCommandOutput>;
  send(
    command: GetObjectCommand,
    options?: { abortSignal?: AbortSignal },
  ): Promise<GetObjectCommandOutput>;
  send(
    command: DeleteObjectCommand,
    options?: { abortSignal?: AbortSignal },
  ): Promise<DeleteObjectCommandOutput>;
  destroy?(): void;
}
export interface S3ArtifactOptions {
  region: string;
  bucket: string;
  expectedBucketOwner: string;
  storageKeyArn: string;
  keyManagementProvider: KeyManagementProvider;
  /** SDK-contract test injection; production uses the real SDK client. */ client?: S3Transport;
}
function objectVersion(value: string) {
  if (
    typeof value !== 'string' ||
    value === 'null' ||
    value.length < 1 ||
    value.length > 1024 ||
    /[^\x21-\x7e]/.test(value)
  )
    throw new CloudArtifactError(
      'invalid_object_version',
      'Use an exact stored S3 object version.',
    );
  return value;
}
function receipt(input: ArtifactReceipt) {
  objectVersion(input.objectVersionId);
  if (
    !/^"[^"\x00-\x1f]{1,256}"$/.test(input.etag) ||
    !/^([a-f0-9]{64})$/.test(input.ciphertextSha256) ||
    !Number.isSafeInteger(input.storedBytes) ||
    input.storedBytes < 1 ||
    input.storedBytes > MAX_ARTIFACT_BYTES + MAX_ENVELOPE_OVERHEAD
  )
    throw new CloudArtifactError('invalid_receipt', 'Use the complete trusted artifact receipt.');
}
function client(options: S3ArtifactOptions) {
  const region = checkedRegion(options.region);
  checkedKeyArn(options.storageKeyArn, region);
  if (
    !/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(options.bucket) ||
    !/^\d{12}$/.test(options.expectedBucketOwner)
  )
    throw new Error('Configure a private general-purpose bucket and its AWS account owner.');
  const endpoint = awsEndpoint('s3', region);
  return (
    options.client ??
    new S3Client({
      region,
      endpoint,
      maxAttempts: 2,
      followRegionRedirects: false,
      requestHandler: new NodeHttpHandler({
        connectionTimeout: 2000,
        requestTimeout: 30000,
        httpsAgent: new Agent({
          keepAlive: true,
          maxSockets: 4,
          rejectUnauthorized: true,
          minVersion: 'TLSv1.2',
        }),
      }),
    })
  );
}
/** Storage primitive, not an authorization layer. Call only after checking current grants and scan policy. */
export class S3EncryptedArtifactRepository {
  private readonly client: S3Transport;
  private busy = false;
  constructor(private readonly options: S3ArtifactOptions) {
    this.client = client(options);
  }
  close() {
    this.client.destroy?.();
  }
  private async run<T>(
    signal: AbortSignal | undefined,
    work: (signal: AbortSignal) => Promise<T>,
    disposeLate?: (value: T) => void,
  ) {
    if (this.busy)
      throw new CloudArtifactError(
        'cloud_busy',
        'This artifact worker is busy. Keep local work and retry.',
      );
    if (signal?.aborted)
      throw new CloudArtifactError('operation_aborted', 'The cloud operation was cancelled.');
    this.busy = true;
    let entered = false;
    try {
      return await bounded(
        60000,
        signal,
        async (active) => {
          entered = true;
          try {
            return await work(active);
          } finally {
            this.busy = false;
          }
        },
        disposeLate,
      );
    } catch (error) {
      if (!entered) this.busy = false;
      throw error;
    }
  }
  async put(
    identity: ArtifactIdentity,
    source: ArtifactSource,
    metadata: ArtifactMetadata,
    expectedBytes: number,
    signal?: AbortSignal,
  ): Promise<ArtifactReceipt> {
    const scope = artifactIdentity(identity);
    return this.run(signal, async (active) => {
      const body = await sealArtifact(
        scope,
        source,
        metadata,
        expectedBytes,
        this.options.keyManagementProvider,
        active,
      );
      if (active.aborted)
        throw new CloudArtifactError('operation_aborted', 'The artifact upload was interrupted.');
      const hash = createHash('sha256').update(body).digest();
      let result: PutObjectCommandOutput;
      try {
        result = await this.client.send(
          new PutObjectCommand({
            Bucket: this.options.bucket,
            ExpectedBucketOwner: this.options.expectedBucketOwner,
            Key: artifactPath(scope),
            Body: body,
            ContentLength: body.length,
            ContentType: 'application/octet-stream',
            CacheControl: 'no-store',
            ServerSideEncryption: 'aws:kms',
            SSEKMSKeyId: this.options.storageKeyArn,
            BucketKeyEnabled: false,
            ChecksumSHA256: hash.toString('base64'),
            IfNoneMatch: '*',
          }),
          { abortSignal: active },
        );
      } catch (error) {
        if ((error as { name?: string }).name === 'PreconditionFailed')
          throw new CloudArtifactError(
            'artifact_exists',
            'This immutable artifact already exists. Reconcile the prior receipt before retrying; do not overwrite it.',
          );
        throw new CloudArtifactError(
          'upload_unconfirmed',
          'The cloud upload was not confirmed. Preserve local data and reconcile this artifact before retrying.',
        );
      }
      if (
        !result.VersionId ||
        result.VersionId === 'null' ||
        !result.ETag ||
        result.ServerSideEncryption !== 'aws:kms' ||
        result.SSEKMSKeyId !== this.options.storageKeyArn
      )
        throw new CloudArtifactError(
          'upload_unconfirmed',
          'Storage did not confirm a versioned encrypted object. Preserve local data and reconcile the artifact.',
        );
      const stored: ArtifactReceipt = {
        objectVersionId: result.VersionId,
        etag: result.ETag,
        ciphertextSha256: hash.toString('hex'),
        storedBytes: body.length,
      };
      receipt(stored);
      return stored;
    });
  }
  async get(
    identity: ArtifactIdentity,
    reference: ArtifactReceipt,
    signal?: AbortSignal,
  ): Promise<ReadArtifact> {
    const scope = artifactIdentity(identity);
    receipt(reference);
    return this.run(
      signal,
      async (active) => {
        let stream: unknown;
        let iterator: AsyncIterator<Uint8Array> | undefined;
        try {
          const response = await this.client.send(
            new GetObjectCommand({
              Bucket: this.options.bucket,
              ExpectedBucketOwner: this.options.expectedBucketOwner,
              Key: artifactPath(scope),
              VersionId: reference.objectVersionId,
              IfMatch: reference.etag,
              ChecksumMode: 'ENABLED',
            }),
            { abortSignal: active },
          );
          stream = response.Body;
          if (
            response.VersionId !== reference.objectVersionId ||
            response.ETag !== reference.etag ||
            response.ContentLength !== reference.storedBytes ||
            response.ServerSideEncryption !== 'aws:kms' ||
            response.SSEKMSKeyId !== this.options.storageKeyArn ||
            response.DeleteMarker
          )
            throw new CloudArtifactError(
              'artifact_receipt_mismatch',
              'The stored object does not match its authorized receipt.',
            );
          const source = response.Body as AsyncIterable<Uint8Array> | undefined;
          if (!source?.[Symbol.asyncIterator])
            throw new CloudArtifactError(
              'invalid_stream',
              'Storage returned an unsupported artifact stream.',
            );
          iterator = source[Symbol.asyncIterator]();
          const bytes = Buffer.alloc(reference.storedBytes);
          const budget = new StreamBudget();
          let size = 0;
          while (true) {
            const result = await nextChunk(iterator, active);
            if (result.done) break;
            if (!(result.value instanceof Uint8Array))
              throw new CloudArtifactError(
                'invalid_stream',
                'Storage returned non-binary content.',
              );
            if (!(await budget.observe(result.value.byteLength, active))) continue;
            const offset = size;
            size += result.value.byteLength;
            if (size > reference.storedBytes)
              throw new CloudArtifactError(
                'artifact_size_mismatch',
                'Storage exceeded the authorized artifact size.',
              );
            bytes.set(result.value, offset);
          }
          if (size !== reference.storedBytes)
            throw new CloudArtifactError(
              'artifact_size_mismatch',
              'The stored artifact was truncated.',
            );
          const digest = createHash('sha256').update(bytes).digest();
          if (!timingSafeEqual(digest, Buffer.from(reference.ciphertextSha256, 'hex')))
            throw new CloudArtifactError(
              'artifact_checksum_mismatch',
              'The stored artifact does not match its recorded checksum.',
            );
          return await openArtifact(scope, bytes, this.options.keyManagementProvider, active);
        } finally {
          cancelStream(stream);
          if (iterator) cancelStream(iterator);
        }
      },
      (value) => value.bytes.fill(0),
    );
  }
}
/** Separate deletion worker credentials only. Runtime IAM intentionally lacks this permission. */
export class S3ArtifactVersionPurger {
  private readonly client: S3Transport;
  constructor(private readonly options: S3ArtifactOptions) {
    this.client = client(options);
  }
  close() {
    this.client.destroy?.();
  }
  async purgeVersion(
    identity: ArtifactIdentity,
    objectVersionId: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const scope = artifactIdentity(identity),
      version = objectVersion(objectVersionId);
    await bounded(30000, signal, async (active) => {
      await this.client.send(
        new DeleteObjectCommand({
          Bucket: this.options.bucket,
          ExpectedBucketOwner: this.options.expectedBucketOwner,
          Key: artifactPath(scope),
          VersionId: version,
        }),
        { abortSignal: active },
      );
    });
  }
}
