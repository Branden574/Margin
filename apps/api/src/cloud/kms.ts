import { createHash } from 'node:crypto';
import { Agent } from 'node:https';
import {
  KMSClient,
  EncryptCommand,
  DecryptCommand,
  ReEncryptCommand,
  type EncryptCommandOutput,
  type DecryptCommandOutput,
  type ReEncryptCommandOutput,
} from '@aws-sdk/client-kms';
import { NodeHttpHandler } from '@smithy/node-http-handler';
import type { KeyManagementProvider, WrappedDataKey } from '../encryption.js';
import {
  awsEndpoint,
  bounded,
  checkedKeyArn,
  checkedRegion,
  CloudArtifactError,
} from './limits.js';
export interface KmsTransport {
  send(
    command: EncryptCommand,
    options?: { abortSignal?: AbortSignal },
  ): Promise<EncryptCommandOutput>;
  send(
    command: DecryptCommand,
    options?: { abortSignal?: AbortSignal },
  ): Promise<DecryptCommandOutput>;
  send(
    command: ReEncryptCommand,
    options?: { abortSignal?: AbortSignal },
  ): Promise<ReEncryptCommandOutput>;
  destroy?(): void;
}
export interface AwsKmsOptions {
  region: string;
  keyArn: string;
  readKeyArns?: readonly string[];
  /** SDK-contract test injection; production uses the real SDK client. */ client?: KmsTransport;
}
/** Existing envelope interface: KMS ciphertext is opaque; iv/tag are intentionally empty. */
export class AwsKmsKeyProvider implements KeyManagementProvider {
  private readonly client: KmsTransport;
  private readonly keyArn: string;
  private readonly permitted: Set<string>;
  constructor(options: AwsKmsOptions) {
    const region = checkedRegion(options.region);
    this.keyArn = checkedKeyArn(options.keyArn, region);
    if ((options.readKeyArns?.length ?? 0) > 16)
      throw new Error('Allow at most 16 previous KMS keys during rotation.');
    this.permitted = new Set([
      this.keyArn,
      ...(options.readKeyArns ?? []).map((key) => checkedKeyArn(key, region)),
    ]);
    const endpoint = awsEndpoint('kms', region);
    this.client =
      options.client ??
      new KMSClient({
        region,
        endpoint,
        maxAttempts: 2,
        requestHandler: new NodeHttpHandler({
          connectionTimeout: 1000,
          requestTimeout: 2500,
          httpsAgent: new Agent({
            keepAlive: true,
            maxSockets: 8,
            rejectUnauthorized: true,
            minVersion: 'TLSv1.2',
          }),
        }),
      });
  }
  close() {
    this.client.destroy?.();
  }
  private context(value: string) {
    if (typeof value !== 'string' || !value || Buffer.byteLength(value) > 8192)
      throw new Error('Invalid envelope encryption context.');
    return {
      application: 'margin',
      purpose: 'envelope-v1',
      binding: createHash('sha256').update(value).digest('hex'),
    };
  }
  private blob(envelope: WrappedDataKey) {
    if (
      envelope.provider !== 'aws-kms-v1' ||
      !this.permitted.has(envelope.keyId) ||
      envelope.iv !== '' ||
      envelope.tag !== '' ||
      typeof envelope.ciphertext !== 'string' ||
      envelope.ciphertext.length > 8192 ||
      !envelope.ciphertext
    )
      throw new CloudArtifactError(
        'invalid_key_envelope',
        'The artifact key envelope is not accepted.',
      );
    const bytes = Buffer.from(envelope.ciphertext, 'base64');
    if (bytes.length < 1 || bytes.length > 6144 || bytes.toString('base64') !== envelope.ciphertext)
      throw new CloudArtifactError(
        'invalid_key_envelope',
        'The artifact key envelope is not accepted.',
      );
    return bytes;
  }
  private envelope(
    result: Pick<EncryptCommandOutput, 'KeyId' | 'EncryptionAlgorithm' | 'CiphertextBlob'>,
    expectedKey: string,
  ): WrappedDataKey {
    if (
      result.KeyId !== expectedKey ||
      result.EncryptionAlgorithm !== 'SYMMETRIC_DEFAULT' ||
      !result.CiphertextBlob?.length ||
      result.CiphertextBlob.length > 6144
    )
      throw new CloudArtifactError(
        'invalid_kms_response',
        'The key service returned an invalid envelope.',
      );
    return {
      provider: 'aws-kms-v1',
      keyId: result.KeyId,
      iv: '',
      tag: '',
      ciphertext: Buffer.from(result.CiphertextBlob).toString('base64'),
    };
  }
  async wrapKey(key: Buffer, context: string): Promise<WrappedDataKey> {
    if (key.length !== 32) throw new Error('Artifact data keys must contain exactly 32 bytes.');
    const copy = Buffer.from(key);
    try {
      return this.envelope(
        await bounded(3000, undefined, (signal) =>
          this.client.send(
            new EncryptCommand({
              KeyId: this.keyArn,
              EncryptionAlgorithm: 'SYMMETRIC_DEFAULT',
              EncryptionContext: this.context(context),
              Plaintext: copy,
            }),
            { abortSignal: signal },
          ),
        ),
        this.keyArn,
      );
    } finally {
      copy.fill(0);
    }
  }
  async unwrapKey(envelope: WrappedDataKey, context: string): Promise<Buffer> {
    const result = await bounded(
      3000,
      undefined,
      (signal) =>
        this.client.send(
          new DecryptCommand({
            KeyId: envelope.keyId,
            CiphertextBlob: this.blob(envelope),
            EncryptionAlgorithm: 'SYMMETRIC_DEFAULT',
            EncryptionContext: this.context(context),
          }),
          { abortSignal: signal },
        ),
      (result) => result.Plaintext?.fill(0),
    );
    try {
      if (
        result.KeyId !== envelope.keyId ||
        result.EncryptionAlgorithm !== 'SYMMETRIC_DEFAULT' ||
        result.Plaintext?.length !== 32
      )
        throw new CloudArtifactError(
          'invalid_kms_response',
          'The key service returned an invalid data key.',
        );
      return Buffer.from(result.Plaintext);
    } finally {
      result.Plaintext?.fill(0);
    }
  }
  /** Trusted rotation job only. AWS rewraps the DEK without returning plaintext to this process. */
  async rewrapKey(
    envelope: WrappedDataKey,
    context: string,
    destinationKeyArn = this.keyArn,
  ): Promise<WrappedDataKey> {
    if (!this.permitted.has(destinationKeyArn))
      throw new Error('The destination KMS key is not explicitly allowed.');
    const binding = this.context(context);
    const result = await bounded(3000, undefined, (signal) =>
      this.client.send(
        new ReEncryptCommand({
          CiphertextBlob: this.blob(envelope),
          SourceKeyId: envelope.keyId,
          DestinationKeyId: destinationKeyArn,
          SourceEncryptionAlgorithm: 'SYMMETRIC_DEFAULT',
          DestinationEncryptionAlgorithm: 'SYMMETRIC_DEFAULT',
          SourceEncryptionContext: binding,
          DestinationEncryptionContext: binding,
        }),
        { abortSignal: signal },
      ),
    );
    if (
      result.SourceKeyId !== envelope.keyId ||
      result.SourceEncryptionAlgorithm !== 'SYMMETRIC_DEFAULT'
    )
      throw new CloudArtifactError(
        'invalid_kms_response',
        'The key service returned an invalid source key.',
      );
    return this.envelope(
      {
        KeyId: result.KeyId,
        CiphertextBlob: result.CiphertextBlob,
        EncryptionAlgorithm: result.DestinationEncryptionAlgorithm,
      },
      destinationKeyArn,
    );
  }
}
