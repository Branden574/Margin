import { createHash, randomBytes, randomUUID, type Hash } from 'node:crypto';
import { Pool, type PoolClient, type PoolConfig } from 'pg';
import type { KeyManagementProvider, WrappedDataKey } from '../../../encryption.js';
import { bounded } from '../../../cloud/limits.js';
import { PostgresIngestionRepository } from '../../../ingestion/postgres.js';
import type { ArtifactReader } from '../../../ingestion/types.js';
import { canonical } from '../../../sync/validation.js';
import {
  decrypt,
  encrypt,
  keyContext,
  newWrappedKey,
  unwrapKey,
  type Ciphertext,
} from '../../../sync/encryption.js';
import { decodeOperation, type OperationRow } from '../../../sync/operations.js';
import { assignmentId } from '../../policy.js';
import type { Decoded } from '../../work/manifest.js';
import { authenticate } from './envelope.js';
import { SubmissionProviderAdmission } from './providers.js';
import {
  capture,
  cancelled,
  fail,
  fingerprint,
  fresh,
  hash,
  lockAuthority,
  type Snapshot,
} from './authority.js';
import type {
  SubmissionProcessingClaim,
  PreparedSubmission,
  PreparedSubmissionResult,
  SubmissionOperationBatch,
  StagedSubmissionChunk,
  MaterializationReceipt,
  MaterializationSummary,
  SubmissionReplayContext,
} from './types.js';
interface Job {
  attempt_id: string;
  work_id: string;
  materialization_state: 'pending' | 'completed';
  materialization_attempt: number;
  claim_id: string | null;
  token_digest: string | null;
  lease_expires_at: Date | null;
}
interface Chunk extends Ciphertext {
  submission_id: string;
  claim_id: string;
  attempt: number;
  chunk_index: number;
  plaintext_sha256: string;
  plaintext_bytes: number;
  wrapped_key: WrappedDataKey;
}
interface ChunkMetadata extends Omit<Chunk, 'ciphertext'> {
  ciphertext_hash: string;
}
const chunkMetadataSql = `SELECT submission_id,claim_id,attempt,chunk_index,plaintext_sha256,plaintext_bytes,nonce,tag,wrapped_key,encode(sha256(ciphertext),'hex') AS ciphertext_hash FROM margin_submissions.materialization_chunks WHERE submission_id=$1 AND claim_id=$2 ORDER BY chunk_index LIMIT 2049`;
const chunkSeal = (r: Chunk | ChunkMetadata) =>
  fingerprint({
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
  });
/** The authenticated manifest pins these ciphertext fingerprints. No bulk content read is needed
 * in the final transaction or recovery; plaintext was authenticated when each chunk was staged. */
const chunkDescriptor = (r: Chunk | ChunkMetadata) => ({
  index: r.chunk_index,
  sha256: r.plaintext_sha256,
  bytes: r.plaintext_bytes,
  sealed: chunkSeal(r),
});
interface Receipt extends Ciphertext {
  submission_id: string;
  claim_id: string;
  attempt: number;
  manifest_sha256: string;
  chunk_count: number;
  wrapped_key: WrappedDataKey;
}
interface Prepared {
  claim: SubmissionProcessingClaim;
  snapshot: Snapshot;
  decoded: Decoded;
  replay: SubmissionReplayContext;
  annotationKey: Buffer;
  outputKey: Buffer;
  wrappedKey: WrappedDataKey;
  readCursor: number;
  readBytes: number;
  chunks: Array<{ index: number; sha256: string; bytes: number; sealed: string }>;
  outputHash: Hash;
  outputBytes: number;
  entries: number;
  disposed: boolean;
  timer?: ReturnType<typeof setTimeout>;
}
const outputContext = (c: SubmissionProcessingClaim) =>
  canonical([
    'margin-submission-materialization-key-v1',
    c.submissionId,
    c.workId,
    c.claimId,
    c.attempt,
  ]);
const chunkContext = (c: SubmissionProcessingClaim, index: number, sha: string, bytes: number) =>
  canonical([
    'margin-submission-materialization-chunk-v1',
    c.submissionId,
    c.workId,
    c.claimId,
    c.attempt,
    index,
    sha,
    bytes,
  ]);
const receiptContext = (c: SubmissionProcessingClaim) =>
  canonical([
    'margin-submission-materialization-receipt-v1',
    c.submissionId,
    c.workId,
    c.claimId,
    c.attempt,
  ]);
/** Dedicated processing credentials. No provider delivery or public submission phase changes. */
export class PostgresSubmissionProcessor {
  private readonly pool: Pool;
  private readonly tickets = new WeakMap<PreparedSubmission, Prepared>();
  private readonly live = new Set<Prepared>();
  private preparing = 0;
  private readonly external = new SubmissionProviderAdmission();
  private readonly kms: KeyManagementProvider;
  constructor(options: PoolConfig, kms: KeyManagementProvider) {
    this.kms = this.external.keys(kms);
    const socket =
      process.env.NODE_ENV === 'test' && options.host?.startsWith('/') && !options.connectionString;
    if (
      process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0' ||
      (!socket &&
        (!options.ssl ||
          (typeof options.ssl === 'object' && options.ssl.rejectUnauthorized === false)))
    )
      throw Error('Submission processing requires verified PostgreSQL TLS.');
    if (
      options.connectionString &&
      [...new URL(options.connectionString).searchParams.keys()].some((k) => k.startsWith('ssl'))
    )
      throw Error('Configure verified PostgreSQL TLS separately.');
    this.pool = new Pool({
      ...options,
      max: 4,
      connectionTimeoutMillis: 5000,
      idleTimeoutMillis: 30000,
      query_timeout: 6000,
      statement_timeout: 5000,
      idle_in_transaction_session_timeout: 5000,
    });
  }
  async close() {
    this.external.close();
    for (const p of this.live) this.destroy(p);
    await this.pool.end();
  }
  private destroy(p: Prepared) {
    p.disposed = true;
    if (p.timer) clearTimeout(p.timer);
    p.annotationKey.fill(0);
    p.outputKey.fill(0);
    this.live.delete(p);
  }
  dispose(ticket: PreparedSubmission) {
    const p = this.tickets.get(ticket);
    if (p) this.destroy(p);
    this.tickets.delete(ticket);
  }
  private async tx<T>(fn: (c: PoolClient) => Promise<T>, signal?: AbortSignal): Promise<T> {
    cancelled(signal);
    const c = await this.pool.connect();
    let discard = false;
    try {
      cancelled(signal);
      await c.query('BEGIN ISOLATION LEVEL READ COMMITTED');
      await c.query("SET LOCAL synchronous_commit='on'");
      await c.query("SET LOCAL lock_timeout='2s'");
      const guard = (
        await c.query<{ unsafe: boolean }>(
          `SELECT (current_setting('fsync')<>'on' OR current_setting('full_page_writes')<>'on' OR r.rolsuper OR r.rolbypassrls OR r.rolcreaterole OR r.rolcreatedb OR NOT pg_has_role(current_user,'margin_submission_processor','MEMBER') OR EXISTS(SELECT 1 FROM pg_roles p WHERE p.rolname IN ('margin_identity_runtime','margin_identity_provisioner','margin_sync_runtime','margin_sync_provisioner','margin_lms_runtime','margin_lms_provisioner','margin_assignments_runtime','margin_assignment_work_runtime','margin_assignment_provisioner','margin_submission_runtime','margin_submission_retention_guard','margin_ingestion_runtime','margin_ingestion_inspector','margin_ingestion_reader') AND pg_has_role(current_user,p.oid,'MEMBER')) OR EXISTS(SELECT 1 FROM pg_class t JOIN pg_namespace n ON n.oid=t.relnamespace WHERE n.nspname IN ('margin_identity','margin_sync','margin_lms','margin_assignments','margin_ingestion','margin_work','margin_submissions') AND pg_has_role(current_user,t.relowner,'MEMBER'))) AS unsafe FROM pg_roles r WHERE r.rolname=current_user`,
        )
      ).rows[0];
      if (!guard || guard.unsafe) throw fail('dedicated_processor_credentials_required');
      const result = await fn(c);
      cancelled(signal);
      await c.query('COMMIT');
      cancelled(signal);
      return result;
    } catch (e) {
      try {
        await c.query('ROLLBACK');
      } catch {
        discard = true;
      }
      throw e;
    } finally {
      c.release(discard);
    }
  }
  private async state(c: PoolClient, claim: SubmissionProcessingClaim, completed = false) {
    for (const value of [claim.submissionId, claim.workId, claim.claimId])
      if (assignmentId(value) !== value) throw fail('invalid_claim');
    if (
      !/^[a-f0-9]{64}$/.test(claim.token) ||
      !Number.isInteger(claim.attempt) ||
      claim.attempt < 1 ||
      claim.attempt > 10 ||
      !Number.isFinite(claim.expiresAt)
    )
      throw fail('invalid_claim');
    for (const [key, value] of [
      ['submission_id', claim.submissionId],
      ['work_id', claim.workId],
      ['claim_id', claim.claimId],
      ['token_digest', hash(claim.token)],
    ])
      await c.query('SELECT set_config($1,$2,true)', [`margin_submissions.${key}`, value]);
    const j = (
      await c.query<Job>('SELECT * FROM margin_submissions.outbox WHERE attempt_id=$1 FOR UPDATE', [
        claim.submissionId,
      ])
    ).rows[0];
    if (
      !j ||
      j.work_id !== claim.workId ||
      j.claim_id !== claim.claimId ||
      j.token_digest !== hash(claim.token) ||
      j.materialization_attempt !== claim.attempt ||
      !j.lease_expires_at ||
      j.lease_expires_at.getTime() !== claim.expiresAt ||
      (!(completed && j.materialization_state === 'completed') &&
        (j.materialization_state !== 'pending' || j.lease_expires_at.getTime() <= Date.now()))
    )
      throw fail('stale_claim');
    if (
      !(
        await c.query<{ active: boolean }>('SELECT margin_submissions.active($1) AS active', [
          claim.workId,
        ])
      ).rows[0]?.active
    )
      throw fail('authority_revoked');
    return j;
  }
  async claimNext(signal?: AbortSignal): Promise<SubmissionProcessingClaim | null> {
    cancelled(signal);
    this.external.assertAvailable();
    if (this.preparing + this.live.size >= 2) throw fail('processor_busy');
    return this.tx(async (c) => {
      const j = (
        await c.query<Job>(
          `SELECT j.* FROM margin_submissions.outbox j WHERE j.materialization_state='pending' AND j.materialization_attempt<10 AND j.next_attempt_at<=statement_timestamp() AND (j.lease_expires_at IS NULL OR j.lease_expires_at<=statement_timestamp()) AND margin_submissions.active(j.work_id) ORDER BY j.next_attempt_at,j.created_at FOR UPDATE OF j SKIP LOCKED LIMIT 1`,
        )
      ).rows[0];
      if (!j) return null;
      this.external.assertAvailable();
      if (this.preparing + this.live.size >= 2) throw fail('processor_busy');
      const claimId = randomUUID(),
        token = randomBytes(32).toString('hex');
      const u = (
        await c.query<Job>(
          `UPDATE margin_submissions.outbox SET materialization_attempt=materialization_attempt+1,claim_id=$2,token_digest=$3,lease_expires_at=statement_timestamp()+interval '600 seconds' WHERE attempt_id=$1 RETURNING *`,
          [j.attempt_id, claimId, hash(token)],
        )
      ).rows[0];
      return {
        submissionId: j.attempt_id,
        workId: j.work_id,
        claimId,
        token,
        attempt: u.materialization_attempt,
        expiresAt: u.lease_expires_at!.getTime(),
      };
    }, signal);
  }
  private prepared(
    claim: SubmissionProcessingClaim,
    ticket: PreparedSubmission,
    signal?: AbortSignal,
  ) {
    cancelled(signal);
    const p = this.tickets.get(ticket);
    if (
      !p ||
      p.disposed ||
      p.claim.expiresAt <= Date.now() ||
      canonical(p.claim) !== canonical(claim)
    )
      throw fail('invalid_preparation');
    return p;
  }
  private async check(
    c: PoolClient,
    claim: SubmissionProcessingClaim,
    p: Prepared,
    signal?: AbortSignal,
  ) {
    await this.state(c, claim);
    await lockAuthority(c, p.snapshot, p.decoded);
    await fresh(c, p.snapshot, p.decoded, signal);
  }
  async prepare(
    claim: SubmissionProcessingClaim,
    reader: PostgresIngestionRepository,
    storage: ArtifactReader,
    signal?: AbortSignal,
  ): Promise<PreparedSubmissionResult> {
    cancelled(signal);
    if (reader.purpose !== 'reader') throw fail('reader_credentials_required');
    this.external.assertAvailable();
    if (this.preparing + this.live.size >= 2) throw fail('processor_busy');
    this.preparing++;
    let annotationKey: Buffer | undefined, outputKey: Buffer | undefined;
    try {
      const snapshot = await this.tx(async (c) => {
        await this.state(c, claim);
        return capture(c, claim.submissionId);
      }, signal);
      const { decoded, bytes } = await authenticate(this.kms, snapshot);
      cancelled(signal);
      const manifest = await reader.readySnapshot(decoded.source);
      cancelled(signal);
      if (
        !manifest ||
        !decoded.completion ||
        manifest.stateToken !== decoded.completion.approval ||
        canonical(manifest.receipt) !== canonical(decoded.completion.storage) ||
        canonical(manifest.pageGeometry) !==
          canonical(snapshot.pages.map(({ id: _, ...page }) => page))
      )
        throw fail('source_changed');
      let content: Buffer | undefined;
      try {
        const result = await bounded(
          20000,
          signal,
          (s) => {
            cancelled(s);
            return this.external.run(() => storage.get(manifest.identity, manifest.receipt, s));
          },
          (late) => late.bytes.fill(0),
        );
        content = result.bytes;
        if (
          content.length < 1 ||
          content.length > 104857600 ||
          result.metadata.mimeType !== 'application/pdf' ||
          hash(content) !== decoded.source.sha256
        )
          throw fail('source_content_mismatch');
      } finally {
        content?.fill(0);
      }
      const after = await reader.readySnapshot(decoded.source);
      if (!after || canonical(after) !== canonical(manifest)) throw fail('source_changed');
      cancelled(signal);
      annotationKey = await unwrapKey(
        this.kms,
        snapshot.wrappedKey,
        keyContext(snapshot.work.organization_id, snapshot.work.document_id),
      );
      cancelled(signal);
      const wrappedKey = await newWrappedKey(this.kms, outputContext(claim));
      cancelled(signal);
      outputKey = await unwrapKey(this.kms, wrappedKey, outputContext(claim));
      cancelled(signal);
      const replay: SubmissionReplayContext = {
        organizationId: snapshot.work.organization_id,
        workId: snapshot.work.id,
        documentId: snapshot.work.document_id,
        versionId: snapshot.work.version_id,
        actorId: snapshot.work.user_id,
        frozenCursor: Number(snapshot.attempt.frozen_cursor),
        expectedCanonicalBytes: bytes,
        pages: structuredClone(snapshot.pages),
      };
      const p: Prepared = {
        claim: structuredClone(claim),
        snapshot,
        decoded,
        replay,
        annotationKey,
        outputKey,
        wrappedKey,
        readCursor: 0,
        readBytes: 0,
        chunks: [],
        outputHash: createHash('sha256'),
        outputBytes: 0,
        entries: 0,
        disposed: false,
      };
      await this.tx((c) => this.check(c, claim, p, signal), signal);
      const ticket: PreparedSubmission = Object.freeze({ kind: 'prepared-submission' });
      this.tickets.set(ticket, p);
      this.live.add(p);
      p.timer = setTimeout(() => this.destroy(p), Math.max(1, claim.expiresAt - Date.now()));
      p.timer.unref();
      annotationKey = undefined;
      outputKey = undefined;
      return { ticket, replay: structuredClone(replay) };
    } finally {
      this.preparing--;
      annotationKey?.fill(0);
      outputKey?.fill(0);
    }
  }
  async readBatch(
    claim: SubmissionProcessingClaim,
    ticket: PreparedSubmission,
    afterCursor: number,
    signal?: AbortSignal,
  ): Promise<SubmissionOperationBatch> {
    const p = this.prepared(claim, ticket, signal);
    if (
      afterCursor !== p.readCursor ||
      !Number.isSafeInteger(afterCursor) ||
      afterCursor < 0 ||
      afterCursor > p.replay.frozenCursor
    )
      throw fail('invalid_read_cursor');
    const rows = await this.tx(async (c) => {
      await this.check(c, claim, p, signal);
      return (
        await c.query<OperationRow>(
          'SELECT * FROM margin_sync.operations WHERE organization_id=$1 AND document_id=$2 AND cursor>$3 AND cursor<=$4 ORDER BY cursor LIMIT 100',
          [p.replay.organizationId, p.replay.documentId, afterCursor, p.replay.frozenCursor],
        )
      ).rows;
    }, signal);
    let bytes = 0,
      cursor = afterCursor;
    const operations = rows.map((row) => {
      cancelled(signal);
      if (
        Number(row.cursor) !== ++cursor ||
        row.actor_id !== p.replay.actorId ||
        row.version_id !== p.replay.versionId ||
        row.annotation_revision !== row.base_revision + 1
      )
        throw fail('operation_prefix_invalid');
      const operation = decodeOperation(p.annotationKey, p.replay.organizationId, row);
      bytes += Buffer.byteLength(canonical(operation));
      return {
        ...operation,
        actorId: row.actor_id,
        cursor: Number(row.cursor),
        annotationRevision: row.annotation_revision,
        committedAt: row.committed_at.toISOString(),
      };
    });
    if (
      (rows.length === 0 && afterCursor < p.replay.frozenCursor) ||
      p.readBytes + bytes > p.replay.expectedCanonicalBytes ||
      (cursor === p.replay.frozenCursor && p.readBytes + bytes !== p.replay.expectedCanonicalBytes)
    )
      throw fail('operation_prefix_invalid');
    await this.tx((c) => this.check(c, claim, p, signal), signal);
    this.prepared(claim, ticket, signal);
    p.readCursor = cursor;
    p.readBytes += bytes;
    return { operations, nextCursor: cursor, hasMore: cursor < p.replay.frozenCursor };
  }
  async stageChunk(
    claim: SubmissionProcessingClaim,
    ticket: PreparedSubmission,
    index: number,
    chunk: Buffer,
    signal?: AbortSignal,
  ): Promise<StagedSubmissionChunk> {
    const p = this.prepared(claim, ticket, signal);
    if (
      p.readCursor !== p.replay.frozenCursor ||
      p.readBytes !== p.replay.expectedCanonicalBytes ||
      !Buffer.isBuffer(chunk) ||
      chunk.length < 1 ||
      chunk.length > 262144 ||
      !Number.isInteger(index) ||
      index < 0 ||
      index > 2047 ||
      index > p.chunks.length
    )
      throw fail('invalid_chunk');
    const plain = Buffer.from(chunk);
    try {
      const sha = hash(plain),
        bytes = plain.length,
        data = JSON.parse(plain.toString('utf8'));
      if (
        data.schema !== 1 ||
        data.organizationId !== p.replay.organizationId ||
        data.workId !== claim.workId ||
        data.documentId !== p.replay.documentId ||
        data.versionId !== p.replay.versionId ||
        data.frozenCursor !== p.replay.frozenCursor ||
        data.index !== index ||
        !Array.isArray(data.entries) ||
        Buffer.from(canonical(data)).compare(plain) !== 0
      )
        throw fail('invalid_chunk');
      const descriptor = { index, sha256: sha, bytes };
      if (
        index < p.chunks.length &&
        (p.chunks[index].sha256 !== sha || p.chunks[index].bytes !== bytes)
      )
        throw fail('chunk_conflict');
      if (
        index === p.chunks.length &&
        (p.outputBytes + bytes > 268435456 || p.entries + data.entries.length > 100000)
      )
        throw fail('materialization_limit');
      const sealed = encrypt(p.outputKey, plain, chunkContext(claim, index, sha, bytes));
      const existing = await this.tx(async (c) => {
        await this.check(c, claim, p, signal);
        const previous = (
          await c.query<Chunk>(
            'SELECT * FROM margin_submissions.materialization_chunks WHERE submission_id=$1 AND claim_id=$2 AND chunk_index=$3',
            [claim.submissionId, claim.claimId, index],
          )
        ).rows[0];
        if (previous) return previous;
        await c.query(
          'INSERT INTO margin_submissions.materialization_chunks(submission_id,claim_id,attempt,chunk_index,plaintext_sha256,plaintext_bytes,ciphertext,nonce,tag,wrapped_key) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
          [
            claim.submissionId,
            claim.claimId,
            claim.attempt,
            index,
            sha,
            bytes,
            sealed.ciphertext,
            sealed.nonce,
            sealed.tag,
            p.wrappedKey,
          ],
        );
        await fresh(c, p.snapshot, p.decoded, signal);
        return null;
      }, signal);
      if (existing) {
        let k: Buffer | undefined, b: Buffer | undefined;
        try {
          k = await unwrapKey(this.kms, existing.wrapped_key, outputContext(claim));
          b = decrypt(
            k,
            existing,
            chunkContext(claim, index, existing.plaintext_sha256, existing.plaintext_bytes),
            262144,
          );
          if (
            existing.attempt !== claim.attempt ||
            existing.plaintext_sha256 !== sha ||
            existing.plaintext_bytes !== bytes ||
            !b.equals(plain)
          )
            throw fail('chunk_conflict');
        } finally {
          k?.fill(0);
          b?.fill(0);
        }
        await this.tx((c) => this.check(c, claim, p, signal), signal);
      }
      this.prepared(claim, ticket, signal);
      if (index === p.chunks.length) {
        p.chunks.push({
          ...descriptor,
          sealed: chunkSeal(
            existing ?? {
              submission_id: claim.submissionId,
              claim_id: claim.claimId,
              attempt: claim.attempt,
              chunk_index: index,
              plaintext_sha256: sha,
              plaintext_bytes: bytes,
              ...sealed,
              wrapped_key: p.wrappedKey,
            },
          ),
        });
        p.outputHash.update(plain);
        p.outputBytes += bytes;
        p.entries += data.entries.length;
      }
      return { ...descriptor, duplicate: !!existing };
    } finally {
      plain.fill(0);
    }
  }
  async complete(
    claim: SubmissionProcessingClaim,
    ticket: PreparedSubmission,
    summary: MaterializationSummary,
    signal?: AbortSignal,
  ): Promise<MaterializationReceipt> {
    const p = this.prepared(claim, ticket, signal);
    const expected: MaterializationSummary = {
      schema: 1,
      frozenCursor: p.replay.frozenCursor,
      operationCount: p.replay.frozenCursor,
      canonicalOperationBytes: p.replay.expectedCanonicalBytes,
      annotationCount: p.entries,
      outputBytes: p.outputBytes,
      chunkCount: p.chunks.length,
      outputSha256: p.outputHash.copy().digest('hex'),
    };
    if (
      p.readCursor !== p.replay.frozenCursor ||
      p.readBytes !== p.replay.expectedCanonicalBytes ||
      p.chunks.length < 1 ||
      canonical(summary) !== canonical(expected)
    )
      throw fail('materialization_summary_mismatch');
    const body = Buffer.from(
      canonical({
        schema: 1,
        submissionId: claim.submissionId,
        workId: claim.workId,
        claimId: claim.claimId,
        attempt: claim.attempt,
        pin: fingerprint(p.snapshot),
        summary: expected,
        chunks: p.chunks,
      }),
    );
    try {
      if (body.length > 262144) throw fail('materialization_manifest_limit');
      const manifestSha256 = hash(body),
        sealed = encrypt(p.outputKey, body, receiptContext(claim));
      const result = await this.tx(async (c) => {
        await this.check(c, claim, p, signal);
        const rows = (
          await c.query<ChunkMetadata>(chunkMetadataSql, [claim.submissionId, claim.claimId])
        ).rows;
        if (
          canonical(rows.map(chunkDescriptor)) !== canonical(p.chunks) ||
          rows.some((r) => r.attempt !== claim.attempt)
        )
          throw fail('staged_chunks_changed');
        await c.query(
          'INSERT INTO margin_submissions.materialization_receipts(submission_id,claim_id,attempt,manifest_sha256,chunk_count,ciphertext,nonce,tag,wrapped_key) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',
          [
            claim.submissionId,
            claim.claimId,
            claim.attempt,
            manifestSha256,
            p.chunks.length,
            sealed.ciphertext,
            sealed.nonce,
            sealed.tag,
            p.wrappedKey,
          ],
        );
        await c.query(
          "UPDATE margin_submissions.outbox SET materialization_state='completed',materialized_at=clock_timestamp() WHERE attempt_id=$1",
          [claim.submissionId],
        );
        await fresh(c, p.snapshot, p.decoded, signal);
        return {
          submissionId: claim.submissionId,
          workId: claim.workId,
          frozenCursor: p.replay.frozenCursor,
          state: 'materialized' as const,
          manifestSha256,
          chunkCount: p.chunks.length,
          duplicate: false,
        };
      }, signal);
      this.dispose(ticket);
      return result;
    } finally {
      body.fill(0);
    }
  }
  async receipt(
    claim: SubmissionProcessingClaim,
    signal?: AbortSignal,
  ): Promise<MaterializationReceipt | null> {
    const initial = await this.tx(async (c) => {
      const job = await this.state(c, claim, true);
      if (job.materialization_state !== 'completed') return null;
      const snapshot = await capture(c, claim.submissionId);
      const row = (
        await c.query<Receipt>(
          'SELECT * FROM margin_submissions.materialization_receipts WHERE submission_id=$1',
          [claim.submissionId],
        )
      ).rows[0];
      if (!row) throw fail('completion_integrity');
      return { snapshot, row };
    }, signal);
    if (!initial) return null;
    const { decoded, bytes } = await authenticate(this.kms, initial.snapshot);
    let key: Buffer | undefined, body: Buffer | undefined;
    let manifest: any;
    try {
      key = await unwrapKey(this.kms, initial.row.wrapped_key, outputContext(claim));
      body = decrypt(key, initial.row, receiptContext(claim), 262144);
      manifest = JSON.parse(body.toString('utf8'));
      if (
        hash(body) !== initial.row.manifest_sha256 ||
        manifest.schema !== 1 ||
        manifest.submissionId !== claim.submissionId ||
        manifest.workId !== claim.workId ||
        manifest.claimId !== claim.claimId ||
        manifest.attempt !== claim.attempt ||
        manifest.pin !== fingerprint(initial.snapshot) ||
        manifest.summary?.schema !== 1 ||
        manifest.summary.frozenCursor !== Number(initial.snapshot.attempt.frozen_cursor) ||
        manifest.summary.operationCount !== Number(initial.snapshot.attempt.frozen_cursor) ||
        manifest.summary.canonicalOperationBytes !== bytes ||
        manifest.summary.chunkCount !== initial.row.chunk_count ||
        !Array.isArray(manifest.chunks) ||
        manifest.chunks.length !== initial.row.chunk_count ||
        initial.row.claim_id !== claim.claimId ||
        initial.row.attempt !== claim.attempt
      )
        throw fail('completion_integrity');
    } finally {
      key?.fill(0);
      body?.fill(0);
    }
    return this.tx(async (c) => {
      await this.state(c, claim, true);
      await lockAuthority(c, initial.snapshot, decoded);
      await fresh(c, initial.snapshot, decoded, signal);
      const row = (
        await c.query<Receipt>(
          'SELECT * FROM margin_submissions.materialization_receipts WHERE submission_id=$1',
          [claim.submissionId],
        )
      ).rows[0];
      const chunks = (
        await c.query<ChunkMetadata>(chunkMetadataSql, [claim.submissionId, claim.claimId])
      ).rows;
      if (
        fingerprint(row) !== fingerprint(initial.row) ||
        canonical(chunks.map(chunkDescriptor)) !== canonical(manifest.chunks)
      )
        throw fail('completion_integrity');
      return {
        submissionId: claim.submissionId,
        workId: claim.workId,
        frozenCursor: manifest.summary.frozenCursor,
        state: 'materialized',
        manifestSha256: row.manifest_sha256,
        chunkCount: row.chunk_count,
        duplicate: true,
      };
    }, signal);
  }
  async retry(
    claim: SubmissionProcessingClaim,
    delaySeconds = 30,
    signal?: AbortSignal,
  ): Promise<void> {
    if (!Number.isInteger(delaySeconds) || delaySeconds < 0 || delaySeconds > 3600)
      throw fail('invalid_retry');
    await this.tx(async (c) => {
      await this.state(c, claim);
      await c.query(
        "UPDATE margin_submissions.outbox SET claim_id=NULL,token_digest=NULL,lease_expires_at=NULL,next_attempt_at=statement_timestamp()+($2::text||' seconds')::interval WHERE attempt_id=$1",
        [claim.submissionId, delaySeconds],
      );
    }, signal);
    for (const p of this.live) if (p.claim.claimId === claim.claimId) this.destroy(p);
  }
}
