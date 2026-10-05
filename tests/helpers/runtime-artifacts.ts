import { createHash, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { GetObjectCommand, PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { S3EncryptedArtifactRepository, type S3Transport } from '../../apps/api/src/cloud';
import type { KeyManagementProvider } from '../../apps/api/src/encryption';

/** Test-only SDK transport: preserves exact encrypted bytes/versions, exercises no AWS resources. */
export function runtimeFixtureArtifacts(keys: KeyManagementProvider) {
  const records = new Map<string, { bytes: Buffer; version: string; etag: string; key: string }>();
  let unavailable = false;
  let destroyed = false;
  const client: S3Transport = {
    async send(command: PutObjectCommand | GetObjectCommand | DeleteObjectCommand): Promise<any> {
      if (destroyed || unavailable) throw new Error('Synthetic artifact transport unavailable.');
      const input = command.input;
      if (command instanceof PutObjectCommand) {
        if (records.has(input.Key!)) throw new Error('Synthetic conditional write conflict.');
        const bytes = Buffer.from(command.input.Body as Uint8Array);
        const value = {
          bytes,
          version: 'synthetic-' + randomUUID(),
          etag: '"' + createHash('sha256').update(bytes).digest('hex') + '"',
          key: command.input.SSEKMSKeyId!,
        };
        records.set(input.Key!, value);
        return {
          $metadata: {},
          VersionId: value.version,
          ETag: value.etag,
          ServerSideEncryption: 'aws:kms',
          SSEKMSKeyId: value.key,
        };
      }
      if (!(command instanceof GetObjectCommand)) throw new Error('Unexpected fixture command.');
      const stored = records.get(input.Key!);
      if (!stored || command.input.VersionId !== stored.version)
        throw new Error('Exact synthetic object version unavailable.');
      return {
        $metadata: {},
        VersionId: stored.version,
        ETag: stored.etag,
        ContentLength: stored.bytes.length,
        ServerSideEncryption: 'aws:kms',
        SSEKMSKeyId: stored.key,
        Body: Readable.from([Buffer.from(stored.bytes)]),
      };
    },
    destroy() {
      destroyed = true;
      for (const value of records.values()) value.bytes.fill(0);
      records.clear();
    },
  };
  return {
    repository: new S3EncryptedArtifactRepository({
      region: 'us-east-1',
      bucket: 'synthetic-margin-composition',
      expectedBucketOwner: '111122223333',
      storageKeyArn: 'arn:aws:kms:us-east-1:111122223333:key/10000000-0000-4000-8000-000000000003',
      keyManagementProvider: keys,
      client,
    }),
    setUnavailable(value: boolean) {
      unavailable = value;
    },
    get destroyed() {
      return destroyed;
    },
    ciphertexts() {
      return [...records.values()].map((record) => Buffer.from(record.bytes));
    },
  };
}
