import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { submissionFixture as f } from './helpers/submission-fixture';
import { PostgresAssignmentSubmissionService } from '../apps/api/src/assignments/submissions/service';
import { PostgresSubmissionProcessor } from '../apps/api/src/assignments/submissions/processing/postgres';
import { SubmissionReplay } from '../apps/api/src/assignments/submissions/processing/replay';
import { SubmissionMaterializationWorker } from '../apps/api/src/assignments/submissions/processing/worker';
import { WorkPool } from '../apps/api/src/assignments/work/pool';
import type { SubmissionProcessingClaim } from '../apps/api/src/assignments/submissions/processing/types';
let capture: PostgresAssignmentSubmissionService, processor: PostgresSubmissionProcessor;
beforeAll(async () => {
  await f.boot({ processingStatus: true });
  capture = new PostgresAssignmentSubmissionService(f.config('submission_api'), f.kms, {
    captureEnabled: true,
  });
  processor = new PostgresSubmissionProcessor(f.config('submission_processor'), f.kms);
}, 30000);
afterAll(async () => {
  await Promise.allSettled([capture?.close(), processor?.close()]);
  await f.stop();
}, 30000);
async function captured() {
  const fixture = await f.ready();
  const request = await capture.capture(fixture.studentP, {
    requestId: randomUUID(),
    expectedCursor: 0,
  });
  if (request.request.state !== 'captured') throw Error('Capture not ready');
  const claim = (await processor.claimNext())!;
  expect(claim.submissionId).toBe(request.request.submission.id);
  return { fixture, claim };
}
async function job(claim: SubmissionProcessingClaim) {
  return (
    await f.admin.query('SELECT * FROM margin_submissions.outbox WHERE attempt_id=$1', [
      claim.submissionId,
    ])
  ).rows[0];
}
async function tenth(initial: SubmissionProcessingClaim) {
  let claim = initial;
  for (let n = 1; n < 10; n++) {
    await processor.retry(claim, 0);
    claim = (await processor.claimNext())!;
    expect(claim.submissionId).toBe(initial.submissionId);
    expect(claim.attempt).toBe(n + 1);
  }
  return claim;
}
async function expire(claim: SubmissionProcessingClaim) {
  const c = await f.admin.connect();
  try {
    await c.query('BEGIN');
    await c.query("SET LOCAL session_replication_role='replica'");
    await c.query(
      "UPDATE margin_submissions.outbox SET lease_expires_at=statement_timestamp()-interval '1 second' WHERE attempt_id=$1",
      [claim.submissionId],
    );
    await c.query('COMMIT');
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    c.release();
  }
}
describe('durable processing failure outcomes', () => {
  it('records an immutable terminal failure and idempotent exact repeats', async () => {
    const { claim } = await captured();
    await processor.fail(claim, 'snapshot_invalid');
    const first = await job(claim);
    expect(first).toMatchObject({
      materialization_state: 'failed',
      published_error_code: 'snapshot_invalid',
      status_revision: '2',
      processing_generation: 1,
    });
    await processor.fail(claim, 'snapshot_invalid');
    expect(await job(claim)).toEqual(first);
    await expect(processor.fail(claim, 'source_unavailable')).rejects.toMatchObject({
      code: 'failure_conflict',
    });
    await expect(processor.retry(claim, 0)).rejects.toMatchObject({ code: 'stale_claim' });
    expect(await processor.claimNext()).toBeNull();
  }, 20000);
  it('automatically retries transient failure with bounded backoff, then terminalizes claim ten', async () => {
    const { claim } = await captured();
    const last = await tenth(claim);
    await processor.retry(last, 0);
    expect(await job(last)).toMatchObject({
      materialization_state: 'failed',
      materialization_attempt: 10,
      published_error_code: 'retry_exhausted',
      status_revision: '2',
    });
    expect(await processor.claimNext()).toBeNull();
  }, 20000);
  it('settles a crashed tenth claimant only after lease expiry', async () => {
    const { claim } = await captured();
    const last = await tenth(claim);
    expect(await processor.settleStalled()).toBe(0);
    expect((await job(last)).materialization_state).toBe('pending');
    await expire(last);
    await processor.settleStalled();
    expect(await job(last)).toMatchObject({
      materialization_state: 'failed',
      published_error_code: 'retry_exhausted',
      status_revision: '2',
    });
    await expect(processor.fail(last, 'snapshot_invalid')).rejects.toMatchObject({
      code: 'stale_claim',
    });
  }, 20000);
  it('records redacted revocation outcomes without accessing source/key providers', async () => {
    const { fixture, claim } = await captured();
    await f.admin.query(
      'UPDATE margin_lms.enrollments SET disabled_at=statement_timestamp() WHERE installation_id=$1 AND user_id=$2',
      [fixture.installation, fixture.student],
    );
    await processor.fail(claim, 'authority_revoked');
    expect(await job(claim)).toMatchObject({
      materialization_state: 'failed',
      published_error_code: 'authority_revoked',
      status_revision: '2',
    });
    await expect(processor.prepare(claim, f.reader, f.storage)).rejects.toMatchObject({
      code: 'stale_claim',
    });
  }, 20000);
  it('settles a revoked abandoned job without stealing an active lease', async () => {
    const { fixture, claim } = await captured();
    await f.admin.query(
      'UPDATE margin_identity.memberships SET revoked_at=statement_timestamp() WHERE organization_id=$1 AND user_id=$2',
      [fixture.org, fixture.student],
    );
    await processor.settleStalled();
    expect((await job(claim)).materialization_state).toBe('pending');
    await expire(claim);
    await processor.claimNext();
    expect(await job(claim)).toMatchObject({
      materialization_state: 'failed',
      published_error_code: 'authority_revoked',
      status_revision: '2',
    });
  }, 20000);
  it('terminalizes a verified source-content mismatch and keeps the capture immutable', async () => {
    const { claim } = await captured();
    await processor.retry(claim, 0);
    const before = (
      await f.admin.query(
        'SELECT ciphertext,nonce,tag,wrapped_key FROM margin_submissions.requests WHERE work_id=$1',
        [claim.workId],
      )
    ).rows[0];
    const worker = new SubmissionMaterializationWorker(processor, f.reader, {
      async get() {
        return {
          bytes: Buffer.from('incorrect'),
          metadata: { name: 'Synthetic', mimeType: 'application/pdf' },
        };
      },
    });
    await expect(worker.runOne()).rejects.toMatchObject({ code: 'source_content_mismatch' });
    expect(await job(claim)).toMatchObject({
      materialization_state: 'failed',
      published_error_code: 'snapshot_invalid',
      status_revision: '2',
    });
    expect(
      (
        await f.admin.query(
          'SELECT ciphertext,nonce,tag,wrapped_key FROM margin_submissions.requests WHERE work_id=$1',
          [claim.workId],
        )
      ).rows[0],
    ).toEqual(before);
  }, 20000);
  it('preserves pending state and backoff after an unknown provider failure', async () => {
    const { claim } = await captured();
    await processor.retry(claim, 0);
    const worker = new SubmissionMaterializationWorker(processor, f.reader, {
      async get() {
        throw Error('Synthetic unavailable provider');
      },
    });
    await expect(worker.runOne()).rejects.toMatchObject({ code: 'materialization_unavailable' });
    const current = await job(claim);
    expect(current).toMatchObject({
      materialization_state: 'pending',
      published_error_code: null,
      status_revision: '1',
      materialization_attempt: 2,
      claim_id: null,
    });
    expect(current.next_attempt_at.getTime()).toBeGreaterThan(Date.now() + 50000);
  }, 20000);
  it('a materialized receipt wins over later valid-claim failure bookkeeping', async () => {
    const { claim } = await captured();
    const prepared = await processor.prepare(claim, f.reader, f.storage);
    const replay = new SubmissionReplay(prepared.replay);
    for (const chunk of replay.chunks()) {
      try {
        await processor.stageChunk(claim, prepared.ticket, chunk.index, chunk.plaintext);
      } finally {
        chunk.plaintext.fill(0);
      }
    }
    const done = await processor.complete(claim, prepared.ticket, replay.summary());
    const before = await job(claim);
    expect(before.status_revision).toBe('2');
    await processor.fail(claim, 'snapshot_invalid');
    expect(await job(claim)).toEqual(before);
    expect(await processor.receipt(claim)).toEqual({ ...done, duplicate: true });
  }, 20000);
  it('fences an earlier processor generation before a new worker has claimed the same capture', async () => {
    const { fixture, claim } = await captured();
    const oldProcessor = new PostgresSubmissionProcessor(f.config('submission_processor'), f.kms);
    try {
      const prepared = await oldProcessor.prepare(claim, f.reader, f.storage);
      const replay = new SubmissionReplay(prepared.replay);
      for (const chunk of replay.chunks()) {
        try {
          await oldProcessor.stageChunk(claim, prepared.ticket, chunk.index, chunk.plaintext);
        } finally {
          chunk.plaintext.fill(0);
        }
      }
      const summary = replay.summary();
      // A different process cannot erase this instance's in-memory ticket when recording failure.
      await processor.fail(claim, 'source_unavailable');
      const accepted = await capture.reprocess(fixture.studentP, claim.submissionId, {
        expectedRevision: 2,
      });
      expect(accepted).toMatchObject({ state: 'accepted', acceptedRevision: 3 });
      expect(await job(claim)).toMatchObject({
        processing_generation: 2,
        materialization_attempt: 0,
        claim_id: null,
      });
      await expect(oldProcessor.complete(claim, prepared.ticket, summary)).rejects.toMatchObject({
        code: 'stale_claim',
      });
      await expect(oldProcessor.receipt(claim)).rejects.toMatchObject({ code: 'stale_claim' });
      await expect(oldProcessor.fail(claim, 'snapshot_invalid')).rejects.toMatchObject({
        code: 'stale_claim',
      });
      oldProcessor.dispose(prepared.ticket);
      const next = new SubmissionMaterializationWorker(processor, f.reader, f.storage);
      expect(await next.runOne()).toMatchObject({ submissionId: claim.submissionId });
      expect(await job(claim)).toMatchObject({
        materialization_state: 'completed',
        status_revision: '4',
        processing_generation: 2,
        materialization_attempt: 1,
      });
    } finally {
      await oldProcessor.close();
    }
  }, 20000);
  it('denies direct runtime journal forgery, unjournaled restart and processor journal writes', async () => {
    const { fixture, claim } = await captured();
    await processor.fail(claim, 'source_unavailable');
    const runtime = new WorkPool(f.config('submission_api'), 'margin_submission_runtime');
    const workerSql = new Pool(f.config('submission_processor'));
    const before = await job(claim);
    try {
      const insert = `INSERT INTO margin_submissions.reprocess_commands
        (attempt_id,organization_id,work_id,expected_revision,state,accepted_revision,code,processing_generation,prior_error_code)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`;
      const identity = [claim.submissionId, fixture.org, claim.workId];
      for (const values of [
        [3, 'rejected', null, 'revision_changed', 1, 'source_unavailable'],
        [2, 'accepted', 3, null, 3, 'source_unavailable'],
        [2, 'accepted', 3, null, 2, 'retry_exhausted'],
      ])
        await expect(
          runtime.transaction(fixture.studentP, (c) => c.query(insert, [...identity, ...values])),
        ).rejects.toMatchObject({ code: '42501' });
      await expect(
        runtime.transaction(fixture.studentP, (c) =>
          c.query(
            `UPDATE margin_submissions.outbox SET materialization_state='pending',status_revision=3,
             processing_generation=2,published_error_code=NULL,failed_at=NULL,materialization_attempt=0,
             claim_id=NULL,token_digest=NULL,lease_expires_at=NULL,next_attempt_at=statement_timestamp()
             WHERE attempt_id=$1`,
            [claim.submissionId],
          ),
        ),
      ).rejects.toMatchObject({ code: 'P0001' });
      expect(await job(claim)).toEqual(before);
      expect(
        (
          await f.admin.query(
            'SELECT * FROM margin_submissions.reprocess_commands WHERE attempt_id=$1',
            [claim.submissionId],
          )
        ).rows,
      ).toEqual([]);
      await capture.reprocess(fixture.studentP, claim.submissionId, { expectedRevision: 2 });
      await expect(
        runtime.transaction(fixture.studentP, (c) =>
          c.query(
            "UPDATE margin_submissions.reprocess_commands SET prior_error_code='retry_exhausted' WHERE attempt_id=$1",
            [claim.submissionId],
          ),
        ),
      ).rejects.toMatchObject({ code: '42501' });
      await expect(
        workerSql.query(insert, [...identity, 1, 'rejected', null, 'revision_changed', 2, null]),
      ).rejects.toMatchObject({ code: '42501' });
      await expect(
        workerSql.query('DELETE FROM margin_submissions.reprocess_commands WHERE attempt_id=$1', [
          claim.submissionId,
        ]),
      ).rejects.toMatchObject({ code: '42501' });
      // Leave no pending eligible work for subsequent FIFO queue assertions.
      const current = (await processor.claimNext())!;
      expect(current.submissionId).toBe(claim.submissionId);
      await processor.fail(current, 'snapshot_invalid');
    } finally {
      await Promise.allSettled([runtime.close(), workerSql.end()]);
    }
  }, 20000);
  it('settles no more than ten abandoned revoked jobs per sweep', async () => {
    const claims: SubmissionProcessingClaim[] = [];
    for (let n = 0; n < 11; n++) {
      const { fixture, claim } = await captured();
      claims.push(claim);
      await f.admin.query(
        'UPDATE margin_identity.memberships SET revoked_at=statement_timestamp() WHERE organization_id=$1 AND user_id=$2',
        [fixture.org, fixture.student],
      );
    }
    for (const claim of claims) await expire(claim);
    expect(await processor.settleStalled()).toBe(10);
    expect(await processor.settleStalled()).toBe(1);
    expect(await processor.settleStalled()).toBe(0);
    for (const claim of claims)
      expect(await job(claim)).toMatchObject({
        materialization_state: 'failed',
        published_error_code: 'authority_revoked',
        status_revision: '2',
      });
  }, 60000);
});
