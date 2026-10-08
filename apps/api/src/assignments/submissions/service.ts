import { createHash, randomUUID } from 'node:crypto';
import type { PoolClient, PoolConfig } from 'pg';
import type { KeyManagementProvider, WrappedDataKey } from '../../encryption.js';
import type { SessionPrincipal } from '../../identity/types.js';
import { bounded } from '../../cloud/limits.js';
import { canonical } from '../../sync/validation.js';
import {
  encrypt,
  decrypt,
  newWrappedKey,
  unwrapKey,
  type Ciphertext,
} from '../../sync/encryption.js';
import { assignmentId } from '../policy.js';
import { AssignmentError } from '../types.js';
import { WorkPool } from '../work/pool.js';
import { WorkAuthority, workCancelled } from '../work/authority.js';
import {
  projectSubmissionStatus,
  recoverableProcessingError,
  type SubmissionProcessingStatusRow,
} from './status.js';
import type {
  AssignmentSubmissionService,
  SubmissionInput,
  SubmissionPage,
  SubmissionRequest,
  SubmissionRequestOptions,
  SubmissionStatus,
  SubmissionReprocessRequest,
} from './types.js';
interface Row extends Ciphertext {
  organization_id: string;
  work_id: string;
  request_id: string;
  expected_cursor: string;
  outcome: 'captured' | 'rejected';
  wrapped_key: WrappedDataKey;
}
interface ReprocessRow {
  attempt_id: string;
  organization_id: string;
  work_id: string;
  expected_revision: string;
  state: 'accepted' | 'rejected';
  accepted_revision: string | null;
  code: 'revision_changed' | 'not_retryable' | 'retry_limit' | null;
  processing_generation: number;
  prior_error_code: SubmissionProcessingStatusRow['published_error_code'];
}
type Prepared = Awaited<ReturnType<WorkAuthority['prepare']>>;
function expectedRevision(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) >= Number.MAX_SAFE_INTEGER)
    throw new AssignmentError(
      400,
      'invalid_submission_revision',
      'Use a positive saved submission revision.',
    );
  return value as number;
}
const sha = (v: string) => createHash('sha256').update(v).digest('hex');
const rowHash = (r: Row) => sha(canonical(JSON.parse(JSON.stringify(r))));
const context = (org: string, work: string, id: string, cursor: number) =>
  canonical(['margin-submission-request-v1', org, work, id, cursor]);
const integrity = () =>
  new AssignmentError(
    503,
    'submission_integrity',
    'The encrypted submission record could not be authenticated. Preserve the exact request.',
  );
function canonicalId(value: unknown): string {
  const id = assignmentId(value);
  if (id !== id.toLowerCase())
    throw new AssignmentError(400, 'invalid_identifier', 'Use a canonical submission identifier.');
  return id;
}
function input(value: unknown): SubmissionInput {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new AssignmentError(
      400,
      'invalid_submission',
      'Supply a request identifier and expected cursor.',
    );
  const v = value as Record<string, unknown>;
  if (
    Object.keys(v).length !== 2 ||
    !Object.hasOwn(v, 'requestId') ||
    !Object.hasOwn(v, 'expectedCursor') ||
    !Number.isSafeInteger(v.expectedCursor) ||
    Number(v.expectedCursor) < 0 ||
    Number(v.expectedCursor) > 100000
  )
    throw new AssignmentError(
      400,
      'invalid_submission',
      'Supply only a request identifier and bounded expected cursor.',
    );
  return { requestId: canonicalId(v.requestId), expectedCursor: v.expectedCursor as number };
}
/** Capture is opt-in and processing-only. It neither reads PDFs nor sends/acknowledges Canvas work. */
export class PostgresAssignmentSubmissionService implements AssignmentSubmissionService {
  private readonly pool: WorkPool;
  private readonly authority: WorkAuthority;
  private readonly enabled: boolean;
  private active = 0;
  constructor(
    database: PoolConfig,
    private readonly keys: KeyManagementProvider,
    options: { captureEnabled?: boolean } = {},
  ) {
    this.enabled = options.captureEnabled === true;
    this.pool = new WorkPool(database, 'margin_submission_runtime');
    this.authority = new WorkAuthority(this.pool, keys);
  }
  close() {
    return this.pool.close();
  }
  private async run<T>(
    p: SessionPrincipal,
    options: SubmissionRequestOptions,
    fn: (p: SessionPrincipal, signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    if (!this.enabled)
      throw new AssignmentError(
        503,
        'submission_unconfigured',
        'Submission capture is not configured. Your saved work remains available.',
      );
    if (this.active >= 2)
      throw new AssignmentError(
        503,
        'submission_busy',
        'Submission capture is busy. Retry the same request shortly.',
      );
    const principal = { ...p };
    this.active++;
    let started = false;
    try {
      return await bounded(25000, options.signal, async (signal) => {
        started = true;
        try {
          return await fn(principal, signal);
        } finally {
          this.active--;
        }
      });
    } catch (e) {
      if (e instanceof AssignmentError) throw e;
      throw new AssignmentError(
        503,
        'submission_unavailable',
        'The submission outcome is unavailable. Preserve and retry the exact request.',
      );
    } finally {
      if (!started) this.active--;
    }
  }
  private pin(s: Prepared) {
    const w = this.authority.requireReady(s.snapshot, s.decoded).work;
    return {
      organizationId: w.organization_id,
      workId: w.id,
      assignmentId: w.assignment_id,
      documentId: w.document_id,
      versionId: w.version_id,
      source: s.decoded.source,
      completion: s.decoded.completion,
      wrappedAnnotationKey: s.snapshot.wrappedKey,
    };
  }
  private async rows(c: PoolClient, work: string, id: string) {
    return (
      await c.query<Row>(
        'SELECT * FROM margin_submissions.requests WHERE work_id=$1 AND request_id=$2',
        [work, id],
      )
    ).rows[0];
  }
  private async decode(row: Row, s: Prepared): Promise<SubmissionRequest> {
    let key: Buffer | undefined, plain: Buffer | undefined;
    try {
      const aad = context(
        row.organization_id,
        row.work_id,
        row.request_id,
        Number(row.expected_cursor),
      );
      key = await unwrapKey(this.keys, row.wrapped_key, aad);
      plain = decrypt(key, row, aad, 262144);
      const data = JSON.parse(plain.toString('utf8'));
      if (
        data.schema !== 1 ||
        canonical(data.pin) !== canonical(this.pin(s)) ||
        Object.keys(data).sort().join(',') !==
          (row.outcome === 'captured' ? 'pin,prefix,request,schema' : 'pin,request,schema')
      )
        throw integrity();
      if (
        row.outcome === 'captured' &&
        (Object.keys(data.prefix ?? {})
          .sort()
          .join(',') !== 'bytes,cursor' ||
          data.prefix?.cursor !== Number(row.expected_cursor) ||
          !Number.isSafeInteger(data.prefix?.bytes) ||
          data.prefix.bytes < 0 ||
          data.prefix.bytes > 134217728)
      )
        throw integrity();
      const r = data.request as SubmissionRequest;
      if (
        r.requestId !== row.request_id ||
        r.expectedCursor !== Number(row.expected_cursor) ||
        r.state !== row.outcome
      )
        throw integrity();
      if (r.state === 'rejected') {
        if (
          !['cursor_changed', 'attempt_exists'].includes(r.code) ||
          Object.keys(r).sort().join(',') !== 'code,expectedCursor,requestId,state'
        )
          throw integrity();
      } else {
        const v = r.submission;
        if (
          assignmentId(v.id) !== v.id ||
          v.requestId !== r.requestId ||
          v.attempt !== 1 ||
          v.frozenCursor !== r.expectedCursor ||
          !Number.isFinite(Date.parse(v.frozenAt)) ||
          new Date(v.frozenAt).toISOString() !== v.frozenAt ||
          v.revision !== 1 ||
          v.phase !== 'processing' ||
          v.confirmedAt !== null ||
          v.retryAllowed !== false ||
          v.errorCode !== null ||
          Object.keys(v).sort().join(',') !==
            'attempt,confirmedAt,errorCode,frozenAt,frozenCursor,id,phase,requestId,retryAllowed,revision' ||
          Object.keys(r).sort().join(',') !== 'expectedCursor,requestId,state,submission'
        )
          throw integrity();
      }
      return r;
    } catch {
      throw integrity();
    } finally {
      key?.fill(0);
      plain?.fill(0);
    }
  }
  private async release(
    p: SessionPrincipal,
    s: Prepared,
    rows: Row[],
    signal: AbortSignal,
  ): Promise<SubmissionRequest[]> {
    const result: SubmissionRequest[] = [];
    for (const row of rows) {
      workCancelled(signal);
      result.push(await this.decode(row, s));
    }
    await this.pool.transaction(
      p,
      async (c) => {
        await this.authority.locks(c, p, s.snapshot, s.decoded);
        await this.authority.fresh(c, s.snapshot, s.decoded, signal);
        for (let i = 0; i < rows.length; i++) {
          const row = rows[i],
            current = await this.rows(c, row.work_id, row.request_id);
          if (!current || rowHash(current) !== rowHash(row)) throw integrity();
          if (result[i].state === 'captured') {
            const r = result[i] as Extract<SubmissionRequest, { state: 'captured' }>;
            const pin = (
              await c.query(
                'SELECT a.*,o.phase,o.status_revision,o.materialization_state,o.published_error_code,o.processing_generation,o.failed_at,o.materialized_at FROM margin_submissions.attempts a JOIN margin_submissions.outbox o ON o.attempt_id=a.id AND o.work_id=a.work_id WHERE a.id=$1 AND a.work_id=$2 AND a.request_id=$3',
                [r.submission.id, row.work_id, row.request_id],
              )
            ).rows[0];
            if (
              !pin ||
              pin.organization_id !== p.organizationId ||
              pin.document_id !== s.snapshot.work!.document_id ||
              pin.version_id !== s.snapshot.work!.version_id ||
              Number(pin.frozen_cursor) !== r.expectedCursor ||
              pin.source_artifact_id !== s.decoded.source.artifactId ||
              pin.scan_receipt_id !== s.decoded.source.scanReceiptId ||
              pin.phase !== 'processing'
            )
              throw integrity();
            r.submission = projectSubmissionStatus(r.submission, pin);
          }
        }
      },
      signal,
    );
    workCancelled(signal);
    return result;
  }
  private async reprocessAction(
    p: SessionPrincipal,
    id: string,
    revision: number,
    write: boolean,
    options: SubmissionRequestOptions,
  ): Promise<SubmissionReprocessRequest> {
    const submissionId = canonicalId(id);
    expectedRevision(revision);
    return this.run(p, options, async (principal, signal) => {
      const s = await this.authority.prepare(principal, { signal });
      const { work } = this.authority.requireReady(s.snapshot, s.decoded);
      const row = await this.pool.transaction(
        principal,
        async (c) =>
          (
            await c.query<Row>(
              'SELECT r.* FROM margin_submissions.requests r JOIN margin_submissions.attempts a ON a.work_id=r.work_id AND a.request_id=r.request_id WHERE a.id=$1 AND a.work_id=$2',
              [submissionId, work.id],
            )
          ).rows[0],
        signal,
      );
      if (!row)
        throw new AssignmentError(
          404,
          'submission_not_found',
          'This saved submission is not available through the current launch.',
        );
      const decoded = await this.decode(row, s);
      if (decoded.state !== 'captured' || decoded.submission.id !== submissionId) throw integrity();
      const command = await this.pool.transaction(
        principal,
        async (c) => {
          await this.authority.locks(c, principal, s.snapshot, s.decoded);
          await this.authority.fresh(c, s.snapshot, s.decoded, signal);
          const current = await this.rows(c, work.id, row.request_id);
          if (!current || rowHash(current) !== rowHash(row)) throw integrity();
          const status = (
            await c.query(
              'SELECT a.*,o.phase,o.status_revision,o.materialization_state,o.published_error_code,o.processing_generation,o.failed_at,o.materialized_at FROM margin_submissions.attempts a JOIN margin_submissions.outbox o ON o.attempt_id=a.id AND o.work_id=a.work_id WHERE a.id=$1 AND a.work_id=$2 AND a.request_id=$3 FOR UPDATE OF o',
              [submissionId, work.id, row.request_id],
            )
          ).rows[0];
          // Check the retained structural pin before recording or applying a command, not
          // merely when releasing the authenticated response after commit.
          if (
            !status ||
            status.organization_id !== principal.organizationId ||
            status.document_id !== work.document_id ||
            status.version_id !== work.version_id ||
            Number(status.frozen_cursor) !== decoded.expectedCursor ||
            status.source_artifact_id !== s.decoded.source.artifactId ||
            status.scan_receipt_id !== s.decoded.source.scanReceiptId ||
            status.phase !== 'processing'
          )
            throw integrity();
          const projected = projectSubmissionStatus(decoded.submission, status);
          const previous = (
            await c.query<ReprocessRow>(
              'SELECT * FROM margin_submissions.reprocess_commands WHERE attempt_id=$1 AND expected_revision=$2',
              [submissionId, revision],
            )
          ).rows[0];
          if (previous) return previous;
          if (!write)
            throw new AssignmentError(
              404,
              'submission_reprocess_request_not_found',
              'No outcome is available for this exact preparation request.',
            );
          if (revision > projected.revision)
            throw new AssignmentError(
              409,
              'submission_revision_changed',
              'Check the current saved submission status before trying again.',
            );
          const code: ReprocessRow['code'] =
            revision < projected.revision
              ? 'revision_changed'
              : projected.phase === 'failed' &&
                  recoverableProcessingError(status.published_error_code) &&
                  status.processing_generation >= 3
                ? 'retry_limit'
                : !projected.retryAllowed
                  ? 'not_retryable'
                  : null;
          const accepted = code === null;
          const value = (
            await c.query<ReprocessRow>(
              'INSERT INTO margin_submissions.reprocess_commands(attempt_id,organization_id,work_id,expected_revision,state,accepted_revision,code,processing_generation,prior_error_code) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *',
              [
                submissionId,
                principal.organizationId,
                work.id,
                revision,
                accepted ? 'accepted' : 'rejected',
                accepted ? revision + 1 : null,
                code,
                status.processing_generation + (accepted ? 1 : 0),
                status.published_error_code,
              ],
            )
          ).rows[0];
          if (accepted) {
            const changed = await c.query(
              "UPDATE margin_submissions.outbox SET materialization_state='pending',status_revision=status_revision+1,processing_generation=processing_generation+1,published_error_code=NULL,failed_at=NULL,materialization_attempt=0,claim_id=NULL,token_digest=NULL,lease_expires_at=NULL,next_attempt_at=statement_timestamp(),materialized_at=NULL WHERE attempt_id=$1 AND work_id=$2 AND status_revision=$3",
              [submissionId, work.id, revision],
            );
            if (changed.rowCount !== 1) throw integrity();
          }
          await this.authority.fresh(c, s.snapshot, s.decoded, signal);
          return value;
        },
        signal,
      );
      // Every response, including an exact ledger replay, authenticates the original capture
      // and obtains a current operational projection after the command transaction commits.
      const [request] = await this.release(principal, s, [row], signal);
      if (request.state !== 'captured') throw integrity();
      const acceptedRevision =
        command.accepted_revision === null ? null : Number(command.accepted_revision);
      if (
        command.attempt_id !== submissionId ||
        command.organization_id !== principal.organizationId ||
        command.work_id !== work.id ||
        Number(command.expected_revision) !== revision ||
        !Number.isInteger(command.processing_generation) ||
        command.processing_generation < 1 ||
        command.processing_generation > 3 ||
        (command.state === 'accepted'
          ? command.code !== null ||
            acceptedRevision !== revision + 1 ||
            request.submission.revision < acceptedRevision
          : command.state !== 'rejected' ||
            acceptedRevision !== null ||
            !['revision_changed', 'not_retryable', 'retry_limit'].includes(command.code ?? '') ||
            request.submission.revision < revision ||
            (command.code === 'revision_changed' && request.submission.revision <= revision))
      )
        throw integrity();
      return {
        request,
        expectedRevision: revision,
        state: command.state,
        acceptedRevision,
        code: command.code,
      };
    });
  }
  async reprocess(
    p: SessionPrincipal,
    id: string,
    value: unknown,
    options: SubmissionRequestOptions = {},
  ) {
    if (
      !value ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      Object.keys(value).length !== 1 ||
      !Object.hasOwn(value, 'expectedRevision')
    )
      throw new AssignmentError(
        400,
        'invalid_submission_revision',
        'Send only the expected saved submission revision.',
      );
    return this.reprocessAction(
      p,
      id,
      expectedRevision((value as { expectedRevision: unknown }).expectedRevision),
      true,
      options,
    );
  }
  async reprocessRequest(
    p: SessionPrincipal,
    id: string,
    revision: number,
    options: SubmissionRequestOptions = {},
  ) {
    return this.reprocessAction(p, id, expectedRevision(revision), false, options);
  }
  async capture(p: SessionPrincipal, value: unknown, options: SubmissionRequestOptions = {}) {
    const v = input(value);
    return this.run(p, options, async (principal, signal) => {
      const s = await this.authority.prepare(principal, { signal }),
        { work } = this.authority.requireReady(s.snapshot, s.decoded);
      const prior = await this.pool.transaction(
        principal,
        (c) => this.rows(c, work.id, v.requestId),
        signal,
      );
      if (prior) {
        const [request] = await this.release(principal, s, [prior], signal);
        if (request.expectedCursor !== v.expectedCursor)
          throw new AssignmentError(
            409,
            'submission_request_conflict',
            'This request identifier already belongs to a different cursor.',
          );
        return { request, duplicate: true };
      }
      const status: SubmissionStatus = {
        id: randomUUID(),
        requestId: v.requestId,
        attempt: 1,
        frozenCursor: v.expectedCursor,
        frozenAt: new Date().toISOString(),
        revision: 1,
        phase: 'processing',
        confirmedAt: null,
        retryAllowed: false,
        errorCode: null,
      };
      const outcomes: SubmissionRequest[] = [
        { ...v, state: 'captured', submission: status },
        { ...v, state: 'rejected', code: 'cursor_changed' },
        { ...v, state: 'rejected', code: 'attempt_exists' },
      ];
      const aad = context(principal.organizationId, work.id, v.requestId, v.expectedCursor),
        wrapped = await newWrappedKey(this.keys, aad);
      workCancelled(signal);
      const key = await unwrapKey(this.keys, wrapped, aad);
      let envelopes: Ciphertext[];
      try {
        envelopes = outcomes.map((request) => {
          const bytes = Buffer.from(
            canonical({
              schema: 1,
              pin: this.pin(s),
              request,
              ...(request.state === 'captured'
                ? {
                    prefix: {
                      cursor: request.expectedCursor,
                      bytes: Number(s.snapshot.document!.operation_bytes),
                    },
                  }
                : {}),
            }),
          );
          try {
            if (bytes.length > 262144) throw integrity();
            return encrypt(key, bytes, aad);
          } finally {
            bytes.fill(0);
          }
        });
      } finally {
        key.fill(0);
      }
      const committed = await this.pool.transaction(
        principal,
        async (c) => {
          await this.authority.locks(c, principal, s.snapshot, s.decoded, true);
          const current = await this.authority.fresh(c, s.snapshot, s.decoded, signal),
            existing = await this.rows(c, work.id, v.requestId);
          if (existing) return { existing };
          const count = (
            await c.query(
              'SELECT count(*)::int AS n FROM (SELECT 1 FROM margin_submissions.requests WHERE work_id=$1 LIMIT 1000) r',
              [work.id],
            )
          ).rows[0].n;
          if (count >= 1000)
            throw new AssignmentError(
              429,
              'submission_request_limit',
              'Submission recovery needs administrator attention. Preserve your work.',
            );
          const already = (
            await c.query('SELECT id FROM margin_submissions.attempts WHERE work_id=$1', [work.id])
          ).rowCount;
          const choice = already
            ? 2
            : Number(current.document!.cursor) !== v.expectedCursor ||
                Number(s.snapshot.document!.cursor) !== v.expectedCursor
              ? 1
              : 0;
          if (
            choice === 0 &&
            current.document!.operation_bytes !== s.snapshot.document!.operation_bytes
          )
            throw integrity();
          const envelope = envelopes[choice],
            request = outcomes[choice];
          await c.query(
            'INSERT INTO margin_submissions.requests(organization_id,work_id,request_id,expected_cursor,outcome,ciphertext,nonce,tag,wrapped_key) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',
            [
              principal.organizationId,
              work.id,
              v.requestId,
              v.expectedCursor,
              request.state,
              envelope.ciphertext,
              envelope.nonce,
              envelope.tag,
              JSON.stringify(wrapped),
            ],
          );
          if (request.state === 'captured') {
            await c.query(
              'INSERT INTO margin_submissions.attempts(id,organization_id,work_id,request_id,document_id,version_id,frozen_cursor,source_artifact_id,scan_receipt_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',
              [
                status.id,
                principal.organizationId,
                work.id,
                v.requestId,
                work.document_id,
                work.version_id,
                v.expectedCursor,
                s.decoded.source.artifactId,
                s.decoded.source.scanReceiptId,
              ],
            );
            await c.query(
              'INSERT INTO margin_submissions.outbox(attempt_id,work_id) VALUES($1,$2)',
              [status.id, work.id],
            );
          }
          await this.authority.fresh(c, s.snapshot, s.decoded, signal);
          return { request };
        },
        signal,
      );
      if ('existing' in committed && committed.existing) {
        const [request] = await this.release(principal, s, [committed.existing], signal);
        if (request.expectedCursor !== v.expectedCursor)
          throw new AssignmentError(
            409,
            'submission_request_conflict',
            'This request identifier already belongs to a different cursor.',
          );
        return { request, duplicate: true };
      }
      workCancelled(signal);
      return { request: committed.request!, duplicate: false };
    });
  }
  async request(p: SessionPrincipal, id: string, options: SubmissionRequestOptions = {}) {
    const requestId = canonicalId(id);
    return this.run(p, options, async (principal, signal) => {
      const s = await this.authority.prepare(principal, { signal }),
        { work } = this.authority.requireReady(s.snapshot, s.decoded),
        row = await this.pool.transaction(
          principal,
          (c) => this.rows(c, work.id, requestId),
          signal,
        );
      if (!row)
        throw new AssignmentError(
          404,
          'submission_request_not_found',
          'No captured request is available for this launch.',
        );
      const [request] = await this.release(principal, s, [row], signal);
      return { request };
    });
  }
  async list(
    p: SessionPrincipal,
    v: { after?: string },
    options: SubmissionRequestOptions = {},
  ): Promise<SubmissionPage> {
    let after: string | null = null;
    if (v.after !== undefined) {
      try {
        if (!/^[A-Za-z0-9_-]{1,128}$/.test(v.after)) throw Error();
        after = Buffer.from(v.after, 'base64url').toString('ascii');
        if (Buffer.from(after).toString('base64url') !== v.after) throw Error();
        canonicalId(after);
      } catch {
        throw new AssignmentError(
          400,
          'invalid_submission_cursor',
          'Use the cursor returned with submission history.',
        );
      }
    }
    return this.run(p, options, async (principal, signal) => {
      const s = await this.authority.prepare(principal, { signal }),
        { work } = this.authority.requireReady(s.snapshot, s.decoded);
      const rows = await this.pool.transaction(
        principal,
        async (c) =>
          (
            await c.query<Row>(
              'SELECT r.* FROM margin_submissions.requests r JOIN margin_submissions.attempts a ON a.work_id=r.work_id AND a.request_id=r.request_id WHERE r.work_id=$1 AND ($2::uuid IS NULL OR a.id>$2::uuid) ORDER BY a.id LIMIT 11',
              [work.id, after],
            )
          ).rows,
        signal,
      );
      const result = await this.release(principal, s, rows.slice(0, 10), signal);
      const submissions = result.map((r) => {
        if (r.state !== 'captured') throw integrity();
        return r.submission;
      });
      return {
        submissions,
        nextCursor:
          rows.length > 10 ? Buffer.from(submissions.at(-1)!.id).toString('base64url') : null,
      };
    });
  }
}
