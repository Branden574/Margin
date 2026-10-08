import { afterAll, beforeAll, expect, it } from 'vitest';
import { randomUUID, createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { submissionFixture as f } from './helpers/submission-fixture';
beforeAll(() => f.boot({ materialization: true }), 30000);
afterAll(() => f.stop(), 30000);
it('migrates existing010 completed bookkeeping to revision2 without changing retained ciphertext', async () => {
  const fixture = await f.ready();
  const submissionId = randomUUID(),
    requestId = randomUUID(),
    claimId = randomUUID();
  // Structural legacy migration fixture only: cryptographic materialization is covered separately.
  const ciphertext = Buffer.from('synthetic legacy encrypted record'),
    nonce = Buffer.alloc(12, 1),
    tag = Buffer.alloc(16, 2);
  const digest = createHash('sha256').update(ciphertext).digest('hex');
  const c = await f.admin.connect();
  try {
    await c.query('BEGIN');
    await c.query(
      "INSERT INTO margin_submissions.requests(organization_id,work_id,request_id,expected_cursor,outcome,ciphertext,nonce,tag,wrapped_key) VALUES($1,$2,$3,0,'captured',$4,$5,$6,'{}')",
      [fixture.org, fixture.reservation.id, requestId, ciphertext, nonce, tag],
    );
    await c.query(
      'INSERT INTO margin_submissions.attempts(id,organization_id,work_id,request_id,document_id,version_id,frozen_cursor,source_artifact_id,scan_receipt_id) VALUES($1,$2,$3,$4,$5,$6,0,$7,$8)',
      [
        submissionId,
        fixture.org,
        fixture.reservation.id,
        requestId,
        fixture.reservation.documentId,
        fixture.reservation.versionId,
        fixture.manifest.source.artifactId,
        fixture.manifest.source.scanReceiptId,
      ],
    );
    await c.query('INSERT INTO margin_submissions.outbox(attempt_id,work_id) VALUES($1,$2)', [
      submissionId,
      fixture.reservation.id,
    ]);
    await c.query(
      "INSERT INTO margin_submissions.materialization_receipts(submission_id,claim_id,attempt,manifest_sha256,chunk_count,ciphertext,nonce,tag,wrapped_key) VALUES($1,$2,1,$3,1,$4,$5,$6,'{}')",
      [submissionId, claimId, digest, ciphertext, nonce, tag],
    );
    await c.query("SET LOCAL session_replication_role='replica'");
    await c.query(
      "UPDATE margin_submissions.outbox SET materialization_state='completed',materialization_attempt=1,claim_id=$2,token_digest=$3,lease_expires_at=statement_timestamp()+interval '600 seconds',materialized_at=statement_timestamp() WHERE attempt_id=$1",
      [submissionId, claimId, 'a'.repeat(64)],
    );
    await c.query('COMMIT');
  } catch (error) {
    await c.query('ROLLBACK');
    throw error;
  } finally {
    c.release();
  }
  const before = (
    await f.admin.query(
      'SELECT * FROM margin_submissions.materialization_receipts WHERE submission_id=$1',
      [submissionId],
    )
  ).rows[0];
  await f.admin.query(
    readFileSync(
      new URL('../infra/migrations/011-submission-outcomes.sql', import.meta.url),
      'utf8',
    ),
  );
  expect(
    (
      await f.admin.query(
        'SELECT status_revision,processing_generation,materialization_state,published_error_code FROM margin_submissions.outbox WHERE attempt_id=$1',
        [submissionId],
      )
    ).rows[0],
  ).toEqual({
    status_revision: '2',
    processing_generation: 1,
    materialization_state: 'completed',
    published_error_code: null,
  });
  expect(
    (
      await f.admin.query(
        'SELECT * FROM margin_submissions.materialization_receipts WHERE submission_id=$1',
        [submissionId],
      )
    ).rows[0],
  ).toEqual(before);
  expect(
    (
      await f.admin.query(
        "SELECT tgenabled FROM pg_trigger WHERE tgname='protect_materialization_job' AND tgrelid='margin_submissions.outbox'::regclass",
      )
    ).rows[0].tgenabled,
  ).toBe('O');
  const invalid = await f.admin.connect();
  try {
    await invalid.query('BEGIN');
    // Check the storage invariant independently of the transition trigger.
    await invalid.query("SET LOCAL session_replication_role='replica'");
    await expect(
      invalid.query('UPDATE margin_submissions.outbox SET status_revision=3 WHERE attempt_id=$1', [
        submissionId,
      ]),
    ).rejects.toMatchObject({ code: '23514', constraint: 'processing_revision' });
  } finally {
    await invalid.query('ROLLBACK');
    invalid.release();
  }
}, 20000);
