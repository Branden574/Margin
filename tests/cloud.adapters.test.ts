import { describe, expect, it, vi, afterEach } from 'vitest';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { readFileSync } from 'node:fs';
import { EncryptCommand, DecryptCommand, ReEncryptCommand } from '@aws-sdk/client-kms';
import {
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  type GetObjectCommandOutput,
} from '@aws-sdk/client-s3';
import { LocalKeyProvider, type WrappedDataKey } from '../apps/api/src/encryption';
import {
  AwsKmsKeyProvider,
  S3EncryptedArtifactRepository,
  S3ArtifactVersionPurger,
  type KmsTransport,
  type S3Transport,
  type ArtifactIdentity,
  type ArtifactMetadata,
  type ArtifactReceipt,
} from '../apps/api/src/cloud/index';
import { artifactPath } from '../apps/api/src/cloud/envelope';
const keyArn = 'arn:aws:kms:us-east-1:111122223333:key/10000000-0000-4000-8000-000000000001';
const oldArn = 'arn:aws:kms:us-east-1:111122223333:key/10000000-0000-4000-8000-000000000002';
const storageArn = 'arn:aws:kms:us-east-1:111122223333:key/10000000-0000-4000-8000-000000000003';
const scope = (): ArtifactIdentity => ({
  organizationId: randomUUID(),
  documentId: randomUUID(),
  versionId: randomUUID(),
  artifactId: randomUUID(),
  kind: 'source-pdf',
});
const meta: ArtifactMetadata = {
  name: 'Disposable synthetic student worksheet.pdf',
  mimeType: 'application/pdf',
};
const content = Buffer.from(
  '%PDF-1.7\nMargin SDK contract fixture. Not an actual student document.\n%%EOF',
);
/** Local SDK command-contract double. It does not emulate AWS IAM, durability, networking or KMS itself. */
class KmsContractDouble implements KmsTransport {
  calls: (EncryptCommand | DecryptCommand | ReEncryptCommand)[] = [];
  readonly local = new Map([
    [keyArn, new LocalKeyProvider(randomBytes(32), 'fixture-new')],
    [oldArn, new LocalKeyProvider(randomBytes(32), 'fixture-old')],
  ]);
  plaintextResponse?: Uint8Array;
  async send(command: EncryptCommand | DecryptCommand | ReEncryptCommand): Promise<any> {
    this.calls.push(command);
    const input = command.input as any;
    const binding = (value: unknown) => JSON.stringify(value);
    if (command instanceof EncryptCommand) {
      const value = await this.local
        .get(input.KeyId)!
        .wrapKey(Buffer.from(input.Plaintext), binding(input.EncryptionContext));
      return {
        $metadata: {},
        KeyId: input.KeyId,
        EncryptionAlgorithm: 'SYMMETRIC_DEFAULT',
        CiphertextBlob: Buffer.from(JSON.stringify(value)),
      };
    }
    const wrapped = JSON.parse(Buffer.from(input.CiphertextBlob).toString()) as WrappedDataKey;
    if (command instanceof DecryptCommand) {
      const value = await this.local
        .get(input.KeyId)!
        .unwrapKey(wrapped, binding(input.EncryptionContext));
      this.plaintextResponse = value;
      return {
        $metadata: {},
        KeyId: input.KeyId,
        EncryptionAlgorithm: 'SYMMETRIC_DEFAULT',
        Plaintext: value,
      };
    }
    const plain = await this.local
      .get(input.SourceKeyId)!
      .unwrapKey(wrapped, binding(input.SourceEncryptionContext));
    try {
      const value = await this.local
        .get(input.DestinationKeyId)!
        .wrapKey(plain, binding(input.DestinationEncryptionContext));
      return {
        $metadata: {},
        KeyId: input.DestinationKeyId,
        SourceKeyId: input.SourceKeyId,
        SourceEncryptionAlgorithm: 'SYMMETRIC_DEFAULT',
        DestinationEncryptionAlgorithm: 'SYMMETRIC_DEFAULT',
        CiphertextBlob: Buffer.from(JSON.stringify(value)),
      };
    } finally {
      plain.fill(0);
    }
  }
}
interface Stored {
  bytes: Buffer;
  version: string;
  etag: string;
  storageKey: string;
}
/** In-memory SDK contract only. Passing these tests is not evidence that an AWS bucket was accessed. */
class S3ContractDouble implements S3Transport {
  calls: (PutObjectCommand | GetObjectCommand | DeleteObjectCommand)[] = [];
  records = new Map<string, Stored>();
  getOverride?: Partial<GetObjectCommandOutput>;
  putOverride?: Record<string, unknown>;
  async send(command: PutObjectCommand | GetObjectCommand | DeleteObjectCommand): Promise<any> {
    this.calls.push(command);
    const input = command.input;
    if (command instanceof PutObjectCommand) {
      if (this.records.has(input.Key!))
        throw Object.assign(new Error('synthetic conditional write conflict'), {
          name: 'PreconditionFailed',
        });
      const body = Buffer.from(command.input.Body as Uint8Array),
        version = `synthetic-version-${this.records.size + 1}`,
        etag = `"${createHash('sha256').update(body).digest('hex')}"`;
      this.records.set(input.Key!, {
        bytes: body,
        version,
        etag,
        storageKey: command.input.SSEKMSKeyId!,
      });
      return {
        $metadata: {},
        VersionId: version,
        ETag: etag,
        ServerSideEncryption: 'aws:kms',
        SSEKMSKeyId: command.input.SSEKMSKeyId,
        ...this.putOverride,
      };
    }
    const stored = this.records.get(input.Key!)!;
    if (command instanceof DeleteObjectCommand) {
      if (command.input.VersionId === stored?.version) this.records.delete(input.Key!);
      return { $metadata: {} };
    }
    if (!stored) throw new Error('synthetic unavailable object');
    return {
      $metadata: {},
      VersionId: stored.version,
      ETag: stored.etag,
      ContentLength: stored.bytes.length,
      ServerSideEncryption: 'aws:kms',
      SSEKMSKeyId: stored.storageKey,
      Body: Readable.from([stored.bytes.subarray(0, 25), stored.bytes.subarray(25)]),
      ...this.getOverride,
    };
  }
}
function fixture() {
  const kms = new KmsContractDouble(),
    provider = new AwsKmsKeyProvider({
      region: 'us-east-1',
      keyArn,
      readKeyArns: [oldArn],
      client: kms,
    }),
    s3 = new S3ContractDouble();
  const options = {
    region: 'us-east-1',
    bucket: 'synthetic-private-margin',
    expectedBucketOwner: '111122223333',
    storageKeyArn: storageArn,
    keyManagementProvider: provider,
    client: s3,
  };
  return { kms, provider, s3, options, repo: new S3EncryptedArtifactRepository(options) };
}
afterEach(() => vi.useRealTimers());
describe('AWS SDK command-contract tests — no AWS services or credentials used', () => {
  it('uses explicit KMS key IDs, symmetric encryption, hashed binding and clears transient plaintext keys', async () => {
    const { provider, kms } = fixture(),
      key = randomBytes(32),
      context = 'private document name must never enter CloudTrail context';
    const envelope = await provider.wrapKey(key, context);
    expect(envelope).toMatchObject({ provider: 'aws-kms-v1', keyId: keyArn, iv: '', tag: '' });
    const request = kms.calls[0].input as any;
    expect(request.KeyId).toBe(keyArn);
    expect(request.EncryptionAlgorithm).toBe('SYMMETRIC_DEFAULT');
    expect(request.EncryptionContext).toEqual({
      application: 'margin',
      purpose: 'envelope-v1',
      binding: createHash('sha256').update(context).digest('hex'),
    });
    expect(JSON.stringify(request.EncryptionContext)).not.toContain('private document');
    expect(Buffer.from(request.Plaintext).every((v) => v === 0)).toBe(true);
    const unwrapped = await provider.unwrapKey(envelope, context);
    expect(unwrapped).toEqual(key);
    expect(kms.plaintextResponse!.every((v) => v === 0)).toBe(true);
    unwrapped.fill(0);
    await expect(provider.unwrapKey(envelope, 'other binding')).rejects.toThrow();
  });
  it('uses KMS ReEncrypt for authorized key rotation without returning a plaintext key', async () => {
    const { kms } = fixture(),
      old = new AwsKmsKeyProvider({ region: 'us-east-1', keyArn: oldArn, client: kms }),
      current = new AwsKmsKeyProvider({
        region: 'us-east-1',
        keyArn,
        readKeyArns: [oldArn],
        client: kms,
      });
    const key = randomBytes(32),
      wrapped = await old.wrapKey(key, 'context');
    const rotated = await current.rewrapKey(wrapped, 'context');
    expect(rotated.keyId).toBe(keyArn);
    const rewrap = kms.calls.at(-1)!;
    expect(rewrap).toBeInstanceOf(ReEncryptCommand);
    expect(rewrap.input).toMatchObject({
      SourceKeyId: oldArn,
      DestinationKeyId: keyArn,
      SourceEncryptionAlgorithm: 'SYMMETRIC_DEFAULT',
      DestinationEncryptionAlgorithm: 'SYMMETRIC_DEFAULT',
    });
    expect(kms.plaintextResponse).toBeUndefined();
    expect(await current.unwrapKey(rotated, 'context')).toEqual(key);
    await expect(current.rewrapKey(wrapped, 'context', storageArn)).rejects.toThrow(
      'explicitly allowed',
    );
  });
  it('fails closed on unexpected key IDs, malformed envelopes and invalid KMS responses', async () => {
    const { provider, kms } = fixture(),
      wrapped = await provider.wrapKey(randomBytes(32), 'context');
    const before = kms.calls.length;
    for (const bad of [
      { ...wrapped, keyId: storageArn },
      { ...wrapped, iv: 'nonce' },
      { ...wrapped, ciphertext: 'not base64' },
      { ...wrapped, provider: 'local-aes-256-gcm' },
    ])
      await expect(provider.unwrapKey(bad, 'context')).rejects.toMatchObject({
        code: 'invalid_key_envelope',
      });
    expect(kms.calls).toHaveLength(before);
    const unexpected = new AwsKmsKeyProvider({
      region: 'us-east-1',
      keyArn,
      client: {
        send: async () => ({
          $metadata: {},
          KeyId: oldArn,
          EncryptionAlgorithm: 'SYMMETRIC_DEFAULT',
          CiphertextBlob: Buffer.from('bad'),
        }),
      } as KmsTransport,
    });
    await expect(unexpected.wrapKey(randomBytes(32), 'context')).rejects.toMatchObject({
      code: 'invalid_kms_response',
    });
    expect(
      () => new AwsKmsKeyProvider({ region: 'us-east-1', keyArn: 'alias/margin', client: kms }),
    ).toThrow('key ARN');
    expect(() => new AwsKmsKeyProvider({ region: 'us-west-2', keyArn, client: kms })).toThrow(
      'configured AWS region',
    );
  });
  it('bounds KMS timeouts and clears a plaintext key returned late by a broken transport', async () => {
    vi.useFakeTimers();
    let resolve!: (value: any) => void;
    const late = Buffer.alloc(32, 7);
    const provider = new AwsKmsKeyProvider({
      region: 'us-east-1',
      keyArn,
      client: {
        send: () =>
          new Promise((done) => {
            resolve = done;
          }),
      } as KmsTransport,
    });
    const pending = provider.unwrapKey(
      {
        provider: 'aws-kms-v1',
        keyId: keyArn,
        iv: '',
        tag: '',
        ciphertext: Buffer.from('opaque').toString('base64'),
      },
      'context',
    );
    const failure = expect(pending).rejects.toMatchObject({ code: 'operation_aborted' });
    await vi.advanceTimersByTimeAsync(3001);
    await failure;
    resolve({
      $metadata: {},
      KeyId: keyArn,
      EncryptionAlgorithm: 'SYMMETRIC_DEFAULT',
      Plaintext: late,
    });
    await vi.advanceTimersByTimeAsync(1);
    expect(late.every((v) => v === 0)).toBe(true);
  });
  it('stores only ciphertext with private immutable request settings and an exact version receipt', async () => {
    const { repo, s3 } = fixture(),
      identity = scope();
    const receipt = await repo.put(
      identity,
      Readable.from([content.subarray(0, 20), content.subarray(20)]),
      meta,
      content.length,
    );
    expect(receipt.objectVersionId).toBe('synthetic-version-1');
    const put = s3.calls[0] as PutObjectCommand;
    expect(put.input).toMatchObject({
      ExpectedBucketOwner: '111122223333',
      Key: artifactPath(identity),
      ContentType: 'application/octet-stream',
      CacheControl: 'no-store',
      ServerSideEncryption: 'aws:kms',
      SSEKMSKeyId: storageArn,
      BucketKeyEnabled: false,
      IfNoneMatch: '*',
    });
    expect(put.input.ACL).toBeUndefined();
    expect(put.input.Metadata).toBeUndefined();
    const stored = s3.records.get(artifactPath(identity))!.bytes;
    expect(stored.includes(content)).toBe(false);
    expect(stored.includes(Buffer.from(meta.name))).toBe(false);
    expect(stored.includes(Buffer.from(meta.mimeType))).toBe(false);
    expect(createHash('sha256').update(stored).digest('hex')).toBe(receipt.ciphertextSha256);
    const read = await repo.get(identity, receipt);
    expect(read.bytes).toEqual(content);
    expect(read.metadata).toEqual(meta);
    expect((s3.calls[1] as GetObjectCommand).input).toMatchObject({
      VersionId: receipt.objectVersionId,
      IfMatch: receipt.etag,
      ChecksumMode: 'ENABLED',
    });
  });
  it('rejects immutable object collisions and never reports unversioned or wrongly encrypted puts as confirmed', async () => {
    const { repo, s3 } = fixture(),
      identity = scope();
    await repo.put(identity, content, meta, content.length);
    const first = Buffer.from(s3.records.get(artifactPath(identity))!.bytes);
    await expect(repo.put(identity, content, meta, content.length)).rejects.toMatchObject({
      code: 'artifact_exists',
    });
    expect(s3.records.get(artifactPath(identity))!.bytes).toEqual(first);
    s3.putOverride = { VersionId: 'null' };
    await expect(repo.put(scope(), content, meta, content.length)).rejects.toMatchObject({
      code: 'upload_unconfirmed',
    });
    s3.putOverride = { SSEKMSKeyId: oldArn };
    await expect(repo.put(scope(), content, meta, content.length)).rejects.toMatchObject({
      code: 'upload_unconfirmed',
    });
  });
  it('rejects truncated or oversized producer streams before any S3 write and closes them', async () => {
    const { repo, s3 } = fixture();
    let closed = false;
    async function* tooLong() {
      try {
        yield content;
        yield Buffer.from('extra');
      } finally {
        closed = true;
      }
    }
    await expect(repo.put(scope(), tooLong(), meta, content.length)).rejects.toMatchObject({
      code: 'artifact_size_mismatch',
    });
    expect(closed).toBe(true);
    expect(s3.calls).toHaveLength(0);
    await expect(repo.put(scope(), content, meta, content.length + 1)).rejects.toMatchObject({
      code: 'artifact_size_mismatch',
    });
    await expect(repo.put(scope(), content, meta, 100 * 1024 * 1024 + 1)).rejects.toMatchObject({
      code: 'artifact_too_large',
    });
    expect(s3.calls).toHaveLength(0);
  });
  it('authenticates tenant/document/version/artifact/kind binding even if a stored object is substituted', async () => {
    const { repo, s3 } = fixture(),
      identity = scope(),
      receipt = await repo.put(identity, content, meta, content.length),
      record = s3.records.get(artifactPath(identity))!;
    for (const field of [
      'organizationId',
      'documentId',
      'versionId',
      'artifactId',
      'kind',
    ] as const) {
      const other = {
        ...identity,
        [field]: field === 'kind' ? 'pdf-export' : randomUUID(),
      } as ArtifactIdentity;
      s3.records.set(artifactPath(other), record);
      await expect(repo.get(other, receipt)).rejects.toMatchObject({
        code: 'artifact_authentication_failed',
      });
    }
  });
  it('rejects checksum corruption, GCM tampering, truncated responses and receipt metadata mismatches', async () => {
    const { repo, s3 } = fixture(),
      identity = scope(),
      reference = await repo.put(identity, content, meta, content.length),
      record = s3.records.get(artifactPath(identity))!;
    const original = Buffer.from(record.bytes);
    record.bytes[record.bytes.length - 1] ^= 1;
    await expect(repo.get(identity, reference)).rejects.toMatchObject({
      code: 'artifact_checksum_mismatch',
    });
    const tampered = {
      ...reference,
      ciphertextSha256: createHash('sha256').update(record.bytes).digest('hex'),
    };
    await expect(repo.get(identity, tampered)).rejects.toMatchObject({
      code: 'artifact_authentication_failed',
    });
    record.bytes = original;
    s3.getOverride = { Body: Readable.from([original.subarray(0, -1)]) as any };
    await expect(repo.get(identity, reference)).rejects.toMatchObject({
      code: 'artifact_size_mismatch',
    });
    s3.getOverride = { ContentLength: reference.storedBytes + 1 };
    await expect(repo.get(identity, reference)).rejects.toMatchObject({
      code: 'artifact_receipt_mismatch',
    });
    await expect(
      repo.get(identity, { ...reference, objectVersionId: 'null' }),
    ).rejects.toMatchObject({ code: 'invalid_object_version' });
  });
  it('bounds concurrent memory work and aborts a hanging producer without writing an artifact', async () => {
    const { repo, s3 } = fixture(),
      abort = new AbortController();
    let entered!: () => void;
    const begin = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let closed = false;
    const source: AsyncIterable<Uint8Array> = {
      [Symbol.asyncIterator]() {
        return {
          next() {
            entered();
            return new Promise(() => {});
          },
          async return() {
            closed = true;
            return { done: true, value: undefined };
          },
        };
      },
    };
    const pending = repo.put(scope(), source, meta, content.length, abort.signal);
    await begin;
    await expect(repo.put(scope(), content, meta, content.length)).rejects.toMatchObject({
      code: 'cloud_busy',
    });
    const stopped = expect(pending).rejects.toMatchObject({ code: 'operation_aborted' });
    abort.abort();
    await stopped;
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(closed).toBe(true);
    expect(s3.calls).toHaveLength(0);
    await expect(repo.put(scope(), content, meta, content.length)).resolves.toHaveProperty(
      'objectVersionId',
    );
  });
  it('coalesces finite empty and one-byte chunks for authenticated upload and download', async () => {
    const { repo, s3 } = fixture(),
      identity = scope();
    const payload = Buffer.alloc(4096, 42);
    async function* tiny(bytes: Buffer) {
      for (let index = 0; index < bytes.length; index++) {
        if (index % 16 === 0) yield Buffer.alloc(0);
        yield bytes.subarray(index, index + 1);
      }
    }
    const reference = await repo.put(identity, tiny(payload), meta, payload.length);
    s3.getOverride = { Body: tiny(s3.records.get(artifactPath(identity))!.bytes) as any };
    expect((await repo.get(identity, reference)).bytes).toEqual(payload);
  });
  it('bounds never-ending empty producers and responses without accumulating chunk objects', async () => {
    const { repo, s3 } = fixture();
    let produced = 0,
      closed = 0;
    async function* empty() {
      try {
        while (true) {
          produced++;
          yield Buffer.alloc(0);
        }
      } finally {
        closed++;
      }
    }
    await expect(repo.put(scope(), empty(), meta, 1)).rejects.toMatchObject({
      code: 'stream_chunk_limit',
    });
    expect(produced).toBe(1025);
    expect(closed).toBe(1);
    expect(s3.calls).toHaveLength(0);
    const identity = scope(),
      reference = await repo.put(identity, content, meta, content.length);
    produced = 0;
    s3.getOverride = { Body: empty() as any };
    await expect(repo.get(identity, reference)).rejects.toMatchObject({
      code: 'stream_chunk_limit',
    });
    expect(produced).toBe(1025);
    expect(closed).toBe(2);
  });
  it('allows cancellation timers to run during immediately resolving endless tiny-chunk streams', async () => {
    const { repo, s3 } = fixture();
    let chunks = 0,
      closed = false,
      timerFired = false;
    async function* endless() {
      try {
        while (true) {
          chunks++;
          yield Buffer.from([1]);
        }
      } finally {
        closed = true;
      }
    }
    const uploadAbort = new AbortController();
    const upload = repo.put(scope(), endless(), meta, 100000, uploadAbort.signal);
    const uploadFailure = expect(upload).rejects.toMatchObject({ code: 'operation_aborted' });
    const uploadTimer = setTimeout(() => {
      timerFired = true;
      uploadAbort.abort();
    }, 0);
    try {
      await uploadFailure;
      await new Promise((resolve) => setImmediate(resolve));
    } finally {
      clearTimeout(uploadTimer);
      uploadAbort.abort();
    }
    expect(timerFired).toBe(true);
    expect(chunks).toBeGreaterThan(0);
    expect(chunks).toBeLessThan(65536);
    expect(closed).toBe(true);
    expect(s3.calls).toHaveLength(0);
    const identity = scope(),
      payload = Buffer.alloc(100000, 8),
      reference = await repo.put(identity, payload, meta, payload.length);
    chunks = 0;
    closed = false;
    timerFired = false;
    s3.getOverride = { Body: endless() as any };
    const downloadAbort = new AbortController();
    const download = repo.get(identity, reference, downloadAbort.signal);
    const downloadFailure = expect(download).rejects.toMatchObject({ code: 'operation_aborted' });
    const downloadTimer = setTimeout(() => {
      timerFired = true;
      downloadAbort.abort();
    }, 0);
    try {
      await downloadFailure;
      await new Promise((resolve) => setImmediate(resolve));
    } finally {
      clearTimeout(downloadTimer);
      downloadAbort.abort();
    }
    expect(timerFired).toBe(true);
    expect(chunks).toBeGreaterThan(0);
    expect(chunks).toBeLessThan(65536);
    expect(closed).toBe(true);
  });
  it('caps total iterator work even when tiny chunks continue making byte progress', async () => {
    const { repo, s3 } = fixture();
    let chunks = 0,
      closed = false;
    async function* fragmented() {
      try {
        while (true) {
          chunks++;
          yield Buffer.from([1]);
        }
      } finally {
        closed = true;
      }
    }
    await expect(repo.put(scope(), fragmented(), meta, 100000)).rejects.toMatchObject({
      code: 'stream_chunk_limit',
    });
    expect(chunks).toBe(65537);
    expect(closed).toBe(true);
    expect(s3.calls).toHaveLength(0);
  });
  it('requires explicit version deletion through a separate purger, without delete markers or broad deletes', async () => {
    const { repo, s3, options } = fixture(),
      identity = scope(),
      reference = await repo.put(identity, content, meta, content.length),
      purger = new S3ArtifactVersionPurger(options);
    expect('delete' in repo).toBe(false);
    await expect(purger.purgeVersion(identity, 'null')).rejects.toMatchObject({
      code: 'invalid_object_version',
    });
    await purger.purgeVersion(identity, reference.objectVersionId);
    const command = s3.calls.at(-1)!;
    expect(command).toBeInstanceOf(DeleteObjectCommand);
    expect(command.input).toMatchObject({
      VersionId: reference.objectVersionId,
      ExpectedBucketOwner: '111122223333',
      Key: artifactPath(identity),
    });
    expect(s3.records.size).toBe(0);
  });
  it('rejects insecure region/key/identity and never incorporates names into S3 paths', async () => {
    const { options, repo, s3 } = fixture();
    expect(
      () => new S3EncryptedArtifactRepository({ ...options, bucket: 'public.example' }),
    ).toThrow('private general-purpose');
    await expect(
      repo.put({ ...scope(), documentId: '../escape' }, content, meta, content.length),
    ).rejects.toMatchObject({ code: 'invalid_identity' });
    await expect(
      repo.put(scope(), content, { ...meta, name: 'hidden\nheader' }, content.length),
    ).rejects.toMatchObject({ code: 'invalid_metadata' });
    expect(s3.calls).toHaveLength(0);
  });
});
describe('AWS infrastructure static contract — not CloudFormation or IAM execution', () => {
  const template = JSON.parse(
    readFileSync(new URL('../infra/aws/artifacts.cloudformation.json', import.meta.url), 'utf8'),
  );
  it('retains versioned private objects and keys, disables ACLs, and requires TLS plus the designated SSE-KMS key', () => {
    const bucket = template.Resources.ArtifactBucket;
    expect(bucket.DeletionPolicy).toBe('Retain');
    expect(bucket.UpdateReplacePolicy).toBe('Retain');
    expect(bucket.Properties.VersioningConfiguration.Status).toBe('Enabled');
    expect(Object.values(bucket.Properties.PublicAccessBlockConfiguration)).toEqual([
      true,
      true,
      true,
      true,
    ]);
    expect(bucket.Properties.OwnershipControls.Rules).toEqual([
      { ObjectOwnership: 'BucketOwnerEnforced' },
    ]);
    expect(bucket.Properties.WebsiteConfiguration).toBeUndefined();
    expect(bucket.Properties.CorsConfiguration).toBeUndefined();
    expect(
      bucket.Properties.LifecycleConfiguration.Rules.every(
        (r: any) => !r.ExpirationInDays && !r.NoncurrentVersionExpiration,
      ),
    ).toBe(true);
    const policy = template.Resources.ArtifactBucketPolicy.Properties.PolicyDocument.Statement;
    expect(
      policy.find((s: any) => s.Sid === 'DenyInsecureTransport').Condition.Bool[
        'aws:SecureTransport'
      ],
    ).toBe('false');
    expect(
      policy.find((s: any) => s.Sid === 'DenyUnexpectedStorageKey').Condition.ArnNotEqualsIfExists[
        's3:x-amz-server-side-encryption-aws-kms-key-id'
      ],
    ).toEqual({ 'Fn::GetAtt': ['StorageKey', 'Arn'] });
    expect(
      policy.find((s: any) => s.Sid === 'DenyUnconditionalArtifactWrites').Condition.Null[
        's3:if-none-match'
      ],
    ).toBe('true');
    for (const name of ['EnvelopeKey', 'StorageKey']) {
      expect(template.Resources[name].Properties.EnableKeyRotation).toBe(true);
      expect(template.Resources[name].DeletionPolicy).toBe('Retain');
    }
  });
  it('separates runtime access, administrative rewrap and version purge permissions', () => {
    const role = template.Resources.ArtifactTaskRole.Properties;
    const statements = role.Policies.flatMap((p: any) => p.PolicyDocument.Statement);
    const actions = statements.flatMap((s: any) => s.Action);
    expect(actions).not.toContain('s3:DeleteObject');
    expect(actions).not.toContain('s3:DeleteObjectVersion');
    expect(actions).not.toContain('s3:PutObjectAcl');
    expect(actions).not.toContain('s3:ListBucket');
    expect(actions).not.toContain('kms:ReEncryptFrom');
    expect(actions).not.toContain('kms:ScheduleKeyDeletion');
    expect(
      statements.find((s: any) => s.Sid === 'ApplicationEnvelopes').Condition.StringEquals[
        'kms:EncryptionContext:purpose'
      ],
    ).toBe('envelope-v1');
    expect(template.Resources.ArtifactPurgePolicy.Properties.Roles).toBeUndefined();
    expect(template.Resources.EnvelopeRewrapPolicy.Properties.Roles).toBeUndefined();
    expect(
      role.AssumeRolePolicyDocument.Statement[0].Condition.StringEquals['aws:SourceAccount'],
    ).toEqual({ Ref: 'AWS::AccountId' });
  });
});
