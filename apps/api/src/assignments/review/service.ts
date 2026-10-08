import type { PoolClient, PoolConfig } from 'pg';
import type { KeyManagementProvider } from '../../encryption.js';
import type { SessionPrincipal } from '../../identity/types.js';
import { bounded } from '../../cloud/limits.js';
import type { ArtifactReader } from '../../ingestion/types.js';
import { PostgresIngestionRepository, type ReadyManifest } from '../../ingestion/postgres.js';
import { canonical } from '../../sync/validation.js';
import { assignmentId } from '../policy.js';
import { AssignmentError } from '../types.js';
import { decodeManifest, type Decoded } from '../work/manifest.js';
import { authenticate } from '../submissions/processing/envelope.js';
import {
  capture,
  fingerprint,
  fresh,
  hash,
  lockAuthority,
  type Snapshot,
} from '../submissions/processing/authority.js';
import { SubmissionProviderAdmission } from '../submissions/processing/providers.js';
import { SubmissionProcessingError } from '../submissions/processing/types.js';
import {
  projectSubmissionStatus,
  type SubmissionProcessingStatusRow,
} from '../submissions/status.js';
import {
  ReviewPool,
  authority,
  check,
  interrupted,
  lockCurrent,
  unavailable,
  type ReviewAuthority,
} from './pool.js';
import {
  descriptor,
  integrity,
  metadataSql,
  openChunk,
  openCompletion,
  type ChunkMetadata,
  type ChunkRow,
  type CompletionManifest,
  type CompletionRow,
} from './materialization.js';
import type {
  AssignmentReviewService,
  ReviewContext,
  ReviewOptions,
  ReviewPage,
  ReviewPin,
  ReviewSnapshot,
  ReviewSubmission,
} from './types.js';
interface Job extends SubmissionProcessingStatusRow {
  attempt_id: string;
  work_id: string;
  claim_id: string | null;
  materialization_attempt: number;
}
interface Prepared {
  context: ReviewAuthority;
  snapshot: Snapshot;
  job: Job;
  receipt: CompletionRow | null;
  decoded: Decoded;
  status: ReviewSubmission;
  manifest: CompletionManifest | null;
}
const jobSql = `SELECT attempt_id,work_id,claim_id,materialization_attempt,status_revision,materialization_state,published_error_code,processing_generation,failed_at,materialized_at FROM margin_submissions.outbox WHERE attempt_id=$1`;
const id = (value: unknown) => {
  const result = assignmentId(value);
  if (result !== value)
    throw new AssignmentError(400, 'invalid_identifier', 'Use a canonical submission identifier.');
  return result;
};
const pin = (value: ReviewPin) => {
  if (
    !value ||
    Object.keys(value).length !== 1 ||
    typeof value.snapshotPin !== 'string' ||
    !/^[a-f0-9]{64}$/.test(value.snapshotPin)
  )
    throw new AssignmentError(400, 'invalid_review_pin', 'Use the exact frozen review snapshot.');
  return value.snapshotPin;
};
const notReady = () =>
  new AssignmentError(409, 'review_not_ready', 'This frozen submission is not ready for review.');
const pinChanged = () =>
  new AssignmentError(
    409,
    'review_snapshot_changed',
    'Reload the frozen submission before opening its content.',
  );
async function scope(c: PoolClient, submissionId: string) {
  await c.query("SELECT set_config('margin_review.submission_id',$1,true)", [submissionId]);
}
/** Optional composition only. Reads retained capture/completion bytes, never mutable annotations. */
export class PostgresAssignmentReviewService implements AssignmentReviewService {
  private readonly pool: ReviewPool;
  private readonly external = new SubmissionProviderAdmission();
  private readonly keys: KeyManagementProvider;
  private active = 0;
  constructor(
    database: PoolConfig,
    keys: KeyManagementProvider,
    private readonly reader: PostgresIngestionRepository,
    private readonly storage: ArtifactReader,
  ) {
    if (reader.purpose !== 'reader') throw Error('Submission review requires an ingestion reader.');
    this.pool = new ReviewPool(database);
    this.keys = this.external.keys(keys);
  }
  async close() {
    this.external.close();
    await this.pool.close();
  }
  private async run<T>(
    options: ReviewOptions,
    work: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    check(options.signal);
    if (this.active >= 2)
      throw new AssignmentError(503, 'review_busy', 'Review is busy. Try again shortly.');
    try {
      this.external.assertAvailable();
    } catch {
      throw new AssignmentError(503, 'review_busy', 'Review is busy. Try again shortly.');
    }
    this.active++;
    let started = false;
    try {
      return await bounded(
        60000,
        options.signal,
        async (signal) => {
          started = true;
          try {
            return await work(signal);
          } finally {
            this.active--;
          }
        },
        (late) => {
          if (Buffer.isBuffer(late)) late.fill(0);
        },
      );
    } catch (error) {
      if (options.signal?.aborted) throw interrupted();
      if (error instanceof AssignmentError) {
        if (['work_integrity', 'submission_integrity'].includes(error.code)) throw integrity();
        throw error;
      }
      if (
        error instanceof SubmissionProcessingError &&
        ['submission_unavailable', 'authority_revoked'].includes(error.code)
      )
        throw unavailable();
      throw integrity();
    } finally {
      if (!started) this.active--;
    }
  }
  private async load(
    p: SessionPrincipal,
    submissionId: string,
    signal: AbortSignal,
    expectedPin?: string,
  ): Promise<Prepared> {
    const initial = await this.pool.transaction(
      p,
      async (c) => {
        await scope(c, submissionId);
        const context = await authority(c),
          snapshot = await capture(c, submissionId);
        const job = (await c.query<Job>(jobSql, [submissionId])).rows[0];
        if (
          !job ||
          job.work_id !== snapshot.work.id ||
          snapshot.assignment.id !== context.assignment.id
        )
          throw unavailable();
        const receipt =
          job.materialization_state === 'completed'
            ? (
                await c.query<CompletionRow>(
                  'SELECT * FROM margin_submissions.materialization_receipts WHERE submission_id=$1',
                  [submissionId],
                )
              ).rows[0]
            : null;
        if (
          job.materialization_state === 'completed' &&
          (!receipt ||
            receipt.claim_id !== job.claim_id ||
            receipt.attempt !== job.materialization_attempt)
        )
          throw integrity();
        if (expectedPin && (!receipt || receipt.manifest_sha256 !== expectedPin))
          throw pinChanged();
        return { context, snapshot, job, receipt };
      },
      signal,
    );
    const opened = await authenticate(this.keys, initial.snapshot);
    check(signal);
    const s = initial.snapshot,
      status = projectSubmissionStatus(
        {
          id: s.attempt.id,
          requestId: s.attempt.request_id,
          attempt: 1,
          frozenCursor: Number(s.attempt.frozen_cursor),
          frozenAt: opened.frozenAt,
          revision: 1,
          phase: 'processing',
          confirmedAt: null,
          retryAllowed: false,
          errorCode: null,
        },
        initial.job,
      );
    const manifest = initial.receipt
      ? await openCompletion(this.keys, s, initial.receipt, opened.bytes)
      : null;
    check(signal);
    return {
      ...initial,
      decoded: opened.decoded,
      manifest,
      status: {
        id: status.id,
        frozenCursor: status.frozenCursor,
        frozenAt: status.frozenAt,
        revision: status.revision,
        preparation:
          initial.job.materialization_state === 'completed'
            ? 'ready'
            : initial.job.materialization_state === 'failed'
              ? 'failed'
              : 'preparing',
        errorCode: initial.job.published_error_code,
      },
    };
  }
  private async verify(
    c: PoolClient,
    value: Prepared,
    signal: AbortSignal,
    allChunks = false,
    chunk?: ChunkRow,
  ) {
    await scope(c, value.snapshot.attempt.id);
    await lockCurrent(c, value.context);
    await lockAuthority(c, value.snapshot, value.decoded);
    await fresh(c, value.snapshot, value.decoded, signal);
    if (
      fingerprint((await c.query<Job>(jobSql, [value.snapshot.attempt.id])).rows[0]) !==
      fingerprint(value.job)
    )
      throw pinChanged();
    if (value.receipt && value.manifest) {
      const receipt = (
        await c.query<CompletionRow>(
          'SELECT * FROM margin_submissions.materialization_receipts WHERE submission_id=$1',
          [value.snapshot.attempt.id],
        )
      ).rows[0];
      if (!receipt || fingerprint(receipt) !== fingerprint(value.receipt)) throw integrity();
      if (allChunks) {
        const chunks = (
          await c.query<ChunkMetadata>(metadataSql, [receipt.submission_id, receipt.claim_id])
        ).rows;
        if (
          chunks.some((r) => r.attempt !== receipt.attempt) ||
          canonical(chunks.map(descriptor)) !== canonical(value.manifest.chunks)
        )
          throw integrity();
      }
      if (chunk) {
        const current = (
          await c.query<ChunkRow>(
            'SELECT * FROM margin_submissions.materialization_chunks WHERE submission_id=$1 AND claim_id=$2 AND chunk_index=$3',
            [receipt.submission_id, receipt.claim_id, chunk.chunk_index],
          )
        ).rows[0];
        if (!current || fingerprint(current) !== fingerprint(chunk)) throw integrity();
      }
    }
    check(signal);
  }
  private async ready(
    value: Prepared,
    signal: AbortSignal,
  ): Promise<ReadyManifest & { plaintextBytes: number }> {
    const result = await bounded(10000, signal, (s) => {
      check(s);
      return this.external.run(() => this.reader.readySnapshot(value.decoded.source));
    });
    check(signal);
    if (
      !result ||
      !value.decoded.completion ||
      result.stateToken !== value.decoded.completion.approval ||
      canonical(result.receipt) !== canonical(value.decoded.completion.storage) ||
      canonical(result.pageGeometry) !==
        canonical(value.snapshot.pages.map(({ id: _, ...page }) => page)) ||
      !Number.isSafeInteger(result.plaintextBytes) ||
      result.plaintextBytes! < 1 ||
      result.plaintextBytes! > 104857600
    )
      throw integrity();
    return result as ReadyManifest & { plaintextBytes: number };
  }
  context(p: SessionPrincipal, options: ReviewOptions = {}): Promise<ReviewContext> {
    return this.run(options, async (signal) => {
      const initial = await this.pool.transaction(p, authority, signal);
      const decoded = await decodeManifest(this.keys, initial.assignment, null, null);
      check(signal);
      return this.pool.transaction(
        p,
        async (c) => {
          await lockCurrent(c, initial);
          return {
            assignment: {
              id: initial.assignment.id,
              title: decoded.title,
              instructions: decoded.instructions,
            },
            mode: 'author-only',
          };
        },
        signal,
      );
    });
  }
  list(
    p: SessionPrincipal,
    input: { after?: string },
    options: ReviewOptions = {},
  ): Promise<ReviewPage> {
    return this.run(options, async (signal) => {
      if (!input || Object.keys(input).some((k) => k !== 'after'))
        throw new AssignmentError(400, 'invalid_review_cursor', 'Use a saved review cursor.');
      const after = input.after === undefined ? null : id(input.after);
      const initial = await this.pool.transaction(
        p,
        async (c) => ({
          context: await authority(c),
          ids: (
            await c.query<{ id: string }>(
              'SELECT id FROM margin_submissions.attempts WHERE ($1::uuid IS NULL OR id>$1) ORDER BY id LIMIT 21',
              [after],
            )
          ).rows,
        }),
        signal,
      );
      const values: Prepared[] = [];
      for (const row of initial.ids.slice(0, 20)) {
        const value = await this.load(p, row.id, signal);
        if (fingerprint(value.context) !== fingerprint(initial.context)) throw unavailable();
        values.push(value);
      }
      return this.pool.transaction(
        p,
        async (c) => {
          await lockCurrent(c, initial.context);
          for (const value of values) await this.verify(c, value, signal, true);
          return {
            submissions: values.map((v) => v.status),
            nextCursor: initial.ids.length > 20 ? initial.ids[19].id : null,
          };
        },
        signal,
      );
    });
  }
  snapshot(
    p: SessionPrincipal,
    submissionId: string,
    options: ReviewOptions = {},
  ): Promise<ReviewSnapshot> {
    return this.run(options, async (signal) => {
      const value = await this.load(p, id(submissionId), signal);
      if (!value.receipt || !value.manifest) throw notReady();
      const source = await this.ready(value, signal);
      const w = value.snapshot.work,
        m = value.manifest;
      return this.pool.transaction(
        p,
        async (c) => {
          await this.verify(c, value, signal, true);
          return {
            assignmentId: value.context.assignment.id,
            submission: value.status,
            snapshotPin: value.receipt!.manifest_sha256,
            organizationId: w.organization_id,
            workId: w.id,
            documentId: w.document_id,
            versionId: w.version_id,
            pages: structuredClone(value.snapshot.pages),
            source: {
              sha256: value.decoded.source.sha256,
              bytes: source.plaintextBytes,
              mimeType: 'application/pdf',
            },
            annotationCount: m.summary.annotationCount,
            outputBytes: m.summary.outputBytes,
            outputSha256: m.summary.outputSha256,
            chunks: m.chunks.map(({ index, sha256, bytes }) => ({ index, sha256, bytes })),
          };
        },
        signal,
      );
    });
  }
  chunk(
    p: SessionPrincipal,
    submissionId: string,
    index: number,
    valuePin: ReviewPin,
    options: ReviewOptions = {},
  ): Promise<Buffer> {
    return this.run(options, async (signal) => {
      if (!Number.isInteger(index) || index < 0 || index > 2047)
        throw new AssignmentError(400, 'invalid_review_chunk', 'Use a valid frozen chunk index.');
      const value = await this.load(p, id(submissionId), signal, pin(valuePin));
      if (!value.receipt || !value.manifest) throw notReady();
      if (index >= value.manifest.chunks.length) throw unavailable();
      const row = await this.pool.transaction(
        p,
        async (c) => {
          await this.verify(c, value, signal);
          return (
            await c.query<ChunkRow>(
              'SELECT * FROM margin_submissions.materialization_chunks WHERE submission_id=$1 AND claim_id=$2 AND chunk_index=$3',
              [submissionId, value.receipt!.claim_id, index],
            )
          ).rows[0];
        },
        signal,
      );
      if (!row) throw integrity();
      let body: Buffer | undefined;
      try {
        body = await openChunk(this.keys, value.snapshot, value.receipt, row, value.manifest);
        check(signal);
        await this.pool.transaction(p, (c) => this.verify(c, value, signal, false, row), signal);
        check(signal);
        const result = body;
        body = undefined;
        return result;
      } finally {
        body?.fill(0);
      }
    });
  }
  source(
    p: SessionPrincipal,
    submissionId: string,
    valuePin: ReviewPin,
    options: ReviewOptions = {},
  ): Promise<Buffer> {
    return this.run(options, async (signal) => {
      const value = await this.load(p, id(submissionId), signal, pin(valuePin));
      if (!value.receipt || !value.manifest) throw notReady();
      const source = await this.ready(value, signal);
      await this.pool.transaction(p, (c) => this.verify(c, value, signal), signal);
      let body: Buffer | undefined;
      try {
        const content = await bounded(
          20000,
          signal,
          (s) => {
            check(s);
            return this.external.run(() => this.storage.get(source.identity, source.receipt, s));
          },
          (late) => late.bytes.fill(0),
        );
        body = content.bytes;
        check(signal);
        if (
          !Buffer.isBuffer(body) ||
          body.length !== source.plaintextBytes ||
          content.metadata.mimeType !== 'application/pdf' ||
          hash(body) !== value.decoded.source.sha256
        )
          throw integrity();
        await this.pool.transaction(p, (c) => this.verify(c, value, signal), signal);
        check(signal);
        const result = body;
        body = undefined;
        return result;
      } finally {
        body?.fill(0);
      }
    });
  }
}
