import type { KeyManagementProvider, WrappedDataKey } from '../../encryption.js';
import { decrypt, unwrapKey, type Ciphertext } from '../../sync/encryption.js';
import { canonical, identifier, parseOperation } from '../../sync/validation.js';
import { AssignmentError } from '../types.js';
import { fingerprint, hash, type Snapshot } from '../submissions/processing/authority.js';
import type { MaterializationSummary } from '../submissions/processing/types.js';
import type { ReviewChunk } from './types.js';
export const integrity = () =>
  new AssignmentError(503, 'review_integrity', 'The frozen submission could not be authenticated.');
export interface CompletionRow extends Ciphertext {
  submission_id: string;
  claim_id: string;
  attempt: number;
  manifest_sha256: string;
  chunk_count: number;
  wrapped_key: WrappedDataKey;
}
export interface ChunkRow extends Ciphertext {
  submission_id: string;
  claim_id: string;
  attempt: number;
  chunk_index: number;
  plaintext_sha256: string;
  plaintext_bytes: number;
  wrapped_key: WrappedDataKey;
}
export interface ChunkMetadata extends Omit<ChunkRow, 'ciphertext'> {
  ciphertext_hash: string;
}
export const metadataSql = `SELECT submission_id,claim_id,attempt,chunk_index,plaintext_sha256,plaintext_bytes,nonce,tag,wrapped_key,encode(sha256(ciphertext),'hex') AS ciphertext_hash FROM margin_submissions.materialization_chunks WHERE submission_id=$1 AND claim_id=$2 ORDER BY chunk_index LIMIT 2049`;
export const descriptor = (r: ChunkRow | ChunkMetadata) => ({
  index: r.chunk_index,
  sha256: r.plaintext_sha256,
  bytes: r.plaintext_bytes,
  sealed: fingerprint({
    submissionId: r.submission_id,
    claimId: r.claim_id,
    attempt: r.attempt,
    index: r.chunk_index,
    sha256: r.plaintext_sha256,
    bytes: r.plaintext_bytes,
    ciphertextHash: 'ciphertext' in r ? hash(r.ciphertext) : r.ciphertext_hash,
    nonce: r.nonce.toString('base64'),
    tag: r.tag.toString('base64'),
    wrappedKey: r.wrapped_key,
  }),
});
export interface CompletionManifest {
  schema: 1;
  submissionId: string;
  workId: string;
  claimId: string;
  attempt: number;
  pin: string;
  summary: MaterializationSummary;
  chunks: Array<ReturnType<typeof descriptor>>;
}
/** Reuse the original v1 envelope identity, without creating a worker claim or lease capability. */
const keyContext = (s: Snapshot, r: CompletionRow) =>
  canonical([
    'margin-submission-materialization-key-v1',
    s.attempt.id,
    s.work.id,
    r.claim_id,
    r.attempt,
  ]);
const receiptContext = (s: Snapshot, r: CompletionRow) =>
  canonical([
    'margin-submission-materialization-receipt-v1',
    s.attempt.id,
    s.work.id,
    r.claim_id,
    r.attempt,
  ]);
const chunkContext = (s: Snapshot, r: ChunkRow) =>
  canonical([
    'margin-submission-materialization-chunk-v1',
    s.attempt.id,
    s.work.id,
    r.claim_id,
    r.attempt,
    r.chunk_index,
    r.plaintext_sha256,
    r.plaintext_bytes,
  ]);
const exact = (v: unknown, keys: string[]) =>
  !!v &&
  typeof v === 'object' &&
  !Array.isArray(v) &&
  Object.keys(v).sort().join(',') === keys.sort().join(',');
const integer = (v: unknown, max: number, min = 0): v is number =>
  Number.isSafeInteger(v) && (v as number) >= min && (v as number) <= max;
const sha = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
export async function openCompletion(
  kms: KeyManagementProvider,
  s: Snapshot,
  r: CompletionRow,
  operationBytes: number,
): Promise<CompletionManifest> {
  let key: Buffer | undefined, body: Buffer | undefined;
  try {
    key = await unwrapKey(kms, r.wrapped_key, keyContext(s, r));
    body = decrypt(key, r, receiptContext(s, r), 262144);
    const m: CompletionManifest = JSON.parse(body.toString('utf8')),
      v = m.summary;
    if (
      hash(body) !== r.manifest_sha256 ||
      canonical(m) !== body.toString('utf8') ||
      !exact(m, [
        'schema',
        'submissionId',
        'workId',
        'claimId',
        'attempt',
        'pin',
        'summary',
        'chunks',
      ]) ||
      m.schema !== 1 ||
      m.submissionId !== s.attempt.id ||
      m.workId !== s.work.id ||
      m.claimId !== r.claim_id ||
      m.attempt !== r.attempt ||
      m.pin !== fingerprint(s) ||
      r.submission_id !== s.attempt.id ||
      !exact(v, [
        'schema',
        'frozenCursor',
        'operationCount',
        'canonicalOperationBytes',
        'annotationCount',
        'outputBytes',
        'chunkCount',
        'outputSha256',
      ]) ||
      v.schema !== 1 ||
      v.frozenCursor !== Number(s.attempt.frozen_cursor) ||
      v.operationCount !== v.frozenCursor ||
      v.canonicalOperationBytes !== operationBytes ||
      !integer(v.annotationCount, 100000) ||
      v.annotationCount > v.operationCount ||
      !integer(v.outputBytes, 268435456, 1) ||
      !integer(v.chunkCount, 2048, 1) ||
      v.chunkCount !== r.chunk_count ||
      !sha(v.outputSha256) ||
      !Array.isArray(m.chunks) ||
      m.chunks.length !== r.chunk_count
    )
      throw integrity();
    let total = 0;
    for (const [index, d] of m.chunks.entries()) {
      if (
        !exact(d, ['index', 'sha256', 'bytes', 'sealed']) ||
        d.index !== index ||
        !sha(d.sha256) ||
        !sha(d.sealed) ||
        !integer(d.bytes, 262144, 1)
      )
        throw integrity();
      total += d.bytes;
    }
    if (total !== v.outputBytes) throw integrity();
    return m;
  } catch {
    throw integrity();
  } finally {
    key?.fill(0);
    body?.fill(0);
  }
}
export async function openChunk(
  kms: KeyManagementProvider,
  s: Snapshot,
  receipt: CompletionRow,
  row: ChunkRow,
  manifest: CompletionManifest,
): Promise<Buffer> {
  let key: Buffer | undefined, body: Buffer | undefined;
  try {
    if (
      row.submission_id !== s.attempt.id ||
      row.claim_id !== receipt.claim_id ||
      row.attempt !== receipt.attempt ||
      canonical(descriptor(row)) !== canonical(manifest.chunks[row.chunk_index]) ||
      canonical(row.wrapped_key) !== canonical(receipt.wrapped_key)
    )
      throw integrity();
    key = await unwrapKey(kms, row.wrapped_key, keyContext(s, receipt));
    body = decrypt(key, row, chunkContext(s, row), 262144);
    if (body.length !== row.plaintext_bytes || hash(body) !== row.plaintext_sha256)
      throw integrity();
    const value: ReviewChunk = JSON.parse(body.toString('utf8'));
    if (
      !exact(value, [
        'schema',
        'organizationId',
        'workId',
        'documentId',
        'versionId',
        'frozenCursor',
        'index',
        'entries',
      ]) ||
      canonical(value) !== body.toString('utf8') ||
      value.schema !== 1 ||
      value.organizationId !== s.work.organization_id ||
      value.workId !== s.work.id ||
      value.documentId !== s.work.document_id ||
      value.versionId !== s.work.version_id ||
      value.frozenCursor !== Number(s.attempt.frozen_cursor) ||
      value.index !== row.chunk_index ||
      !Array.isArray(value.entries) ||
      value.entries.length > manifest.summary.annotationCount
    )
      throw integrity();
    let previous = '';
    const layers = new Set<number>(),
      pages = new Set(s.pages.map((p) => p.id));
    for (const entry of value.entries) {
      if (
        !exact(
          entry,
          entry.deleted
            ? ['annotationId', 'pageId', 'revision', 'latestCursor', 'deleted', 'layerOrder']
            : [
                'annotationId',
                'pageId',
                'revision',
                'latestCursor',
                'deleted',
                'layerOrder',
                'annotation',
              ],
        ) ||
        identifier(entry.annotationId) !== entry.annotationId ||
        entry.annotationId <= previous ||
        !pages.has(entry.pageId) ||
        !integer(entry.revision, value.frozenCursor, 1) ||
        !integer(entry.latestCursor, value.frozenCursor, entry.revision) ||
        typeof entry.deleted !== 'boolean' ||
        (entry.deleted
          ? entry.layerOrder !== null
          : !integer(entry.layerOrder, entry.latestCursor, 1))
      )
        throw integrity();
      if (!entry.deleted) {
        if (layers.has(entry.layerOrder!)) throw integrity();
        layers.add(entry.layerOrder!);
        const parsed = parseOperation({
          documentId: value.documentId,
          versionId: value.versionId,
          pageId: entry.pageId,
          annotationId: entry.annotationId,
          operationId: entry.annotationId,
          baseRevision: entry.revision - 1,
          kind: 'put',
          annotation: entry.annotation,
        });
        if (canonical(parsed.annotation) !== canonical(entry.annotation)) throw integrity();
      }
      previous = entry.annotationId;
    }
    const result = body;
    body = undefined;
    return result;
  } catch {
    throw integrity();
  } finally {
    key?.fill(0);
    body?.fill(0);
  }
}
