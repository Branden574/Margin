# AWS encrypted artifact foundation

`apps/api/src/cloud/` provides real AWS SDK v3 adapters for KMS and private S3 storage. The application still uses its existing local encrypted filestore. These adapters are not enabled by environment variables, mounted as HTTP routes, or deployed. The production startup gate remains in place. No AWS account, bucket, key, credential, purchase or external write was used to validate this slice.

The local tests exercise AWS SDK command shapes and failure handling with explicitly named test doubles. They do **not** verify AWS IAM decisions, networking, regional availability, CloudFormation deployment, service durability, quotas, billing, load, or recovery from an actual AWS outage. Capacity for 100,000 concurrent users remains unverified.

## Concrete adapter contract

```ts
import { AwsKmsKeyProvider, S3EncryptedArtifactRepository } from './cloud/index.js';

const keys = new AwsKmsKeyProvider({
  region: 'us-east-1',
  keyArn: envelopeKeyArn,
  readKeyArns: priorEnvelopeKeyArns,
});
const artifacts = new S3EncryptedArtifactRepository({
  region: 'us-east-1',
  bucket: privateBucketName,
  expectedBucketOwner: awsAccountId,
  storageKeyArn: s3EncryptionKeyArn,
  keyManagementProvider: keys,
});

// All IDs must come from an authorized, server-owned document/version manifest.
const identity = {
  organizationId,
  documentId,
  versionId,
  artifactId,
  kind: 'source-pdf' as const,
};
const receipt = await artifacts.put(
  identity,
  binaryStream,
  { name: 'Worksheet.pdf', mimeType: 'application/pdf' },
  expectedByteLength,
  abortSignal,
);
// Commit receipt to the document manifest before exposing this artifact to readers.
const recovered = await artifacts.get(identity, receipt, abortSignal);
// recovered = { bytes: Buffer, metadata: { name, mimeType } }
```

Credentials use the SDK's normal credential chain. Production must supply a short-lived workload role, such as the generated ECS task role, rather than a browser credential or committed access key. Constructors accept no arbitrary endpoint URL. They set the region's AWS HTTPS endpoint, verified TLS 1.2+, limited sockets, bounded request deadlines and two SDK attempts. The optional injected clients exist for SDK-contract tests and trusted composition; they do not establish transport security if a caller substitutes a custom client.

`AwsKmsKeyProvider` implements the existing `KeyManagementProvider` without changing local storage or sync interfaces. It accepts a specific regional KMS key ARN, plus at most 16 explicitly permitted previous key ARNs. Aliases, arbitrary returned key IDs and noncanonical envelopes are rejected. It wraps only 32-byte data keys with `Encrypt`, decrypts with an explicit key ID, and exposes `rewrapKey(envelope, context, destinationKeyArn?)` for a separately authorized rotation job. KMS calls have a three-second deadline; temporary plaintext key buffers are cleared, including plaintext returned after an aborted request.

KMS encryption context contains `{ application: 'margin', purpose: 'envelope-v1', binding: SHA256(context) }`. Names and content never enter that context. AWS treats encryption context as public authenticated metadata and records it in CloudTrail, so the adapter hashes the complete application binding before sending it. [AWS encryption-context guidance](https://docs.aws.amazon.com/kms/latest/developerguide/encrypt_context.html).

## Ciphertext and read integrity

Each artifact gets a fresh random 256-bit data key and 96-bit nonce. Node/OpenSSL AES-256-GCM encrypts the artifact content and its filename/MIME metadata before any S3 call. The authenticated data binds a versioned protocol label, organization, document, document version, artifact ID, artifact kind and expected plaintext length. Supported kinds are `source-pdf`, `pdf-export`, `thumbnail`, `ocr-text` and `attachment`; MIME metadata remains a claim to validate through ingestion/scanning, not proof of safety.

The binary container starts with `MGART001`, a bounded JSON-header length, and a header containing the algorithm/version, nonce, wrapped key and payload byte count. Encrypted metadata and content follow, ending with the GCM authentication tag. This is application framing around standard AES-GCM and KMS wrapping, not a new cryptographic algorithm. The full encrypted object also receives a SHA-256 checksum recorded in the trusted manifest receipt. IDs, object size, key identifiers and ciphertext lengths remain metadata; filename and content are encrypted. This is server-side envelope encryption, not end-to-end encryption: the authorized service can decrypt it.

Object paths contain only validated UUIDs under `artifacts/v1/<org>/<document>/<version>/<artifact>.mga`. There are no public URLs, presigned downloads, ACLs, filename-derived paths, plaintext user metadata, or browser-direct uploads. Writes use `If-None-Match: *`, SSE-KMS with the designated storage key, expected bucket-owner validation and `Cache-Control: no-store`. The S3 server-side key is separate from the application envelope key. AWS supports conditional writes to prevent overwriting an existing key. [AWS conditional-write contract](https://docs.aws.amazon.com/AmazonS3/latest/userguide/conditional-writes.html).

A successful `put` returns `{ objectVersionId, etag, ciphertextSha256, storedBytes }`. Missing versioning or a mismatched SSE-KMS response produces an unconfirmed result, never a success receipt. `get` requires that entire trusted receipt, requests the exact S3 object version with its ETag, bounds the response stream, checks the ciphertext checksum, verifies the GCM tag and authenticated binding, and only then returns plaintext. A substituted tenant/document/version/artifact/kind, truncated stream or modified container fails closed without returning partial content.

An artifact is between one byte and 100 MiB. The header and metadata have separate small limits. Upload plaintext is processed from a bounded binary stream into one preallocated ciphertext container. Downloads fill one preallocated bounded ciphertext buffer before authenticated decryption. No list of chunk buffers is retained. Streams accept at most 65,536 chunks and 1,024 consecutive empty chunks, skip empty payloads, and yield to the event loop every 64 chunks so cancellation timers cannot be starved by immediately resolving iterators. Producers that fragment large artifacts too finely must coalesce chunks before retrying. They do not release unauthenticated streaming plaintext and do not write plaintext temporary files. One active artifact operation is allowed per repository instance; excess work receives `cloud_busy`, with no unbounded queue. This intentionally conservative slice can use several hundred MiB at the maximum object size. Production must size workers and apply a process-wide concurrency budget; creating unlimited instances would defeat the per-instance bound. Worker isolation/large-file profiling remain required before deployment.

Cancellation closes producer/response streams where supported, aborts SDK requests, and preserves the operation slot until underlying work stops. `operation_aborted`, `upload_unconfirmed` and `artifact_exists` must keep local data/pending intent intact. If a network failure occurs after S3 accepted a write, retrying the same key may report an existing artifact. The adapter does not invent its missing version receipt or overwrite it. A separately authorized reconciliation job must inspect the immutable candidate version, authenticate it against its pending upload, and commit the verified receipt. That recovery workflow and the database/object-store commit bridge are not implemented here; they are required before replacing the existing filestore.

The repository is a storage primitive, not an authorization layer. Every future HTTP caller must authenticate the account, recheck current document grants and version ownership, and enforce quarantine/scan readiness before reading or issuing a receipt. Receipts must come from server-side manifest rows, not arbitrary client JSON. The underlying workload IAM role can access its application prefix across tenants; tenant separation is currently enforced by the service's authorization plus authenticated artifact binding, not by per-tenant IAM sessions.

## Infrastructure template

`infra/aws/artifacts.cloudformation.json` is a concrete CloudFormation template using standard resource types. It creates:

- One versioned private S3 bucket with all public-access blocks enabled and `BucketOwnerEnforced` ownership, disabling ACLs.
- Separate symmetric application-envelope and S3 storage KMS keys with annual automatic rotation and 30-day key-deletion windows.
- Bucket policies denying HTTP transport, unexpected SSE mode/key and writes lacking the conditional creation header.
- An ECS task role scoped to immutable writes and exact-version reads under `artifacts/v1/`, envelope-key encrypt/decrypt, and the storage key only through S3 with the matching encryption context.
- Unattached managed policies for exact-version deletion and envelope rewrap, to assign only to reviewed dedicated control-plane workers.

The bucket and keys use `DeletionPolicy: Retain` and `UpdateReplacePolicy: Retain`. No current/noncurrent object expiration policy is installed; the only lifecycle action aborts incomplete multipart uploads. This adapter itself uses single-object puts and does not perform multipart uploads. The template does not create a website, public ACL, permissive CORS rule, static access key, application deployment, database, CloudTrail trail, VPC, network endpoint or public data. [AWS S3 security guidance](https://docs.aws.amazon.com/AmazonS3/latest/userguide/security-best-practices.html).

The required `KeyAdministratorArn` parameter names an existing reviewed administration role, distinct from the workload role. Standard account-level key-policy delegation permits IAM administration; the runtime policy grants only the documented cryptographic actions. The template does not attach the purge/rewrap policies. A future deployment must provide reviewed parameters, use a CloudFormation change set, review IAM/resource-policy effects and cost, establish CloudTrail data events/key-event retention, configure VPC endpoint/egress policies and monitoring, and validate deny paths with the actual workload role. No such deployment or AWS authorization test has been run. After enabling S3 versioning, account for AWS's documented propagation interval before first writes. [CloudFormation S3 bucket reference](https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-resource-s3-bucket.html).

## Rotation and deletion

Automatic KMS key-material rotation keeps the same key ARN and retains material needed for existing ciphertext; it does not rewrite artifacts. Both template keys have rotation enabled. [CloudFormation KMS key reference](https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-resource-kms-key.html).

For a deliberate change to a different envelope key ARN, `rewrapKey` uses AWS `ReEncrypt` with explicit source/destination IDs and the same source/destination binding. AWS performs that operation internally, without returning the data key. The new envelope must be persisted atomically in its owning manifest or new artifact generation before retiring the old key. This method does not mutate existing S3 containers, alter their checksum receipts, or migrate old versions automatically. For this immutable-container format, provision a new artifact generation through an authorized migration and update the manifest only after verifying its receipt. Old versions/backups remain dependent on old keys until their retention ends. [AWS ReEncrypt contract](https://docs.aws.amazon.com/kms/latest/APIReference/API_ReEncrypt.html).

`S3ArtifactVersionPurger` is a separate explicitly invoked control-plane class. It requires an exact non-null S3 version ID and sends only `DeleteObject` with that version; it never creates a delete marker, deletes the current key indiscriminately, or loops over a bucket. The workload role cannot perform this action. Grant the unattached purge policy only after a retention/legal-hold/authorization review. A successful deletion request is not proof that every replica, backup, noncurrent version or wrapped key has been erased. Bucket/key removal, whole-document erasure, rollback protection and audit receipts require a durable deletion workflow outside this slice. Do not disable/delete old KMS keys merely because a new key is configured.

## Local verification

```sh
npx vitest run tests/cloud.adapters.test.ts
npx tsc -p apps/api/tsconfig.json --noEmit
npx prettier --check apps/api/src/cloud infra/aws tests/cloud.adapters.test.ts docs/CLOUD.md
```

The SDK-contract suite covers explicit key binding, hashed KMS context, temporary key clearing, KMS rewrap, timeout/late response handling, ciphertext-only private puts, version-pinned authenticated reads, cross-identity substitution, corruption/truncation, immutable collisions, unknown upload outcomes, producer bounds/cancellation (including endless empty/tiny chunks and timer delivery), concurrency rejection and exact-version purge. Static template tests check private/versioned retention, TLS/encryption/conditional-write policies, and role separation. These checks run entirely with synthetic local data; they are deliberately distinct from real AWS integration evidence.
