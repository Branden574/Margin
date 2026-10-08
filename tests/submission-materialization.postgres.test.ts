import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { submissionFixture as f } from './helpers/submission-fixture';
import { PostgresAssignmentSubmissionService } from '../apps/api/src/assignments/submissions/service';
import { PostgresSubmissionProcessor } from '../apps/api/src/assignments/submissions/processing/postgres';
import { SubmissionMaterializationWorker } from '../apps/api/src/assignments/submissions/processing/worker';
import { SubmissionReplay } from '../apps/api/src/assignments/submissions/processing/replay';
import type { SubmissionProcessingClaim } from '../apps/api/src/assignments/submissions/processing/types';
let capture: PostgresAssignmentSubmissionService, processor: PostgresSubmissionProcessor, sql: Pool;
beforeAll(async () => {
  await f.boot({ materialization: true });
  capture = new PostgresAssignmentSubmissionService(f.config('submission_api'), f.kms, {
    captureEnabled: true,
  });
  processor = new PostgresSubmissionProcessor(f.config('submission_processor'), f.kms);
  sql = new Pool(f.config('submission_processor'));
}, 30000);
afterAll(async () => {
  await Promise.allSettled([capture?.close(), processor?.close(), sql?.end()]);
  await f.stop();
}, 30000);
async function captured(count = 1) {
  const fixture = await f.ready();
  const described = await f.workApi.describe(fixture.studentP);
  if (described.work?.status !== 'provisioned') throw Error('Fixture not ready');
  const manifest = described.work.document;
  for (let i = 0; i < count; i++)
    await f.workApi.append(fixture.studentP, f.operation(fixture, manifest.pages[0].id));
  const result = await capture.capture(fixture.studentP, {
    requestId: randomUUID(),
    expectedCursor: count,
  });
  if (result.request.state !== 'captured') throw Error('Capture rejected');
  const claim = (await processor.claimNext())!;
  expect(claim.submissionId).toBe(result.request.submission.id);
  return { fixture, claim, manifest };
}
async function staged(claim: SubmissionProcessingClaim) {
  const prepared = await processor.prepare(claim, f.reader, f.storage);
  const replay = new SubmissionReplay(prepared.replay);
  let cursor = 0;
  do {
    const batch = await processor.readBatch(claim, prepared.ticket, cursor);
    replay.appendBatch(batch.operations);
    cursor = batch.nextCursor;
    if (!batch.hasMore) break;
  } while (true);
  for (const chunk of replay.chunks()) {
    try {
      await processor.stageChunk(claim, prepared.ticket, chunk.index, chunk.plaintext);
    } finally {
      chunk.plaintext.fill(0);
    }
  }
  return { ...prepared, summary: replay.summary() };
}
describe('durable immutable submission materialization', () => {
  it('retains admission for raw object reads after cancellation and does not lease extra jobs', async () => {
    const isolated = new PostgresSubmissionProcessor(f.config('submission_processor'), f.kms);
    const pending: Array<{
      resolve: (v: {
        bytes: Buffer;
        metadata: { name: string; mimeType: 'application/pdf' };
      }) => void;
      bytes: Buffer;
    }> = [];
    try {
      for (let i = 0; i < 2; i++) {
        const { claim } = await captured(0);
        const abort = new AbortController();
        let entered!: () => void;
        const started = new Promise<void>((resolve) => {
          entered = resolve;
        });
        const preparation = isolated.prepare(
          claim,
          f.reader,
          {
            get() {
              entered();
              return new Promise((resolve) =>
                pending.push({ resolve, bytes: Buffer.from(f.body) }),
              );
            },
          },
          abort.signal,
        );
        const rejected = expect(preparation).rejects.toMatchObject({ code: 'operation_aborted' });
        await started;
        abort.abort();
        await rejected;
      }
      const third = await captured(0);
      await processor.retry(third.claim, 0);
      const before = (
        await f.admin.query(
          'SELECT materialization_attempt,claim_id FROM margin_submissions.outbox WHERE attempt_id=$1',
          [third.claim.submissionId],
        )
      ).rows[0];
      await expect(isolated.claimNext()).rejects.toMatchObject({ code: 'processor_busy' });
      await expect(isolated.prepare(third.claim, f.reader, f.storage)).rejects.toMatchObject({
        code: 'processor_busy',
      });
      expect(
        (
          await f.admin.query(
            'SELECT materialization_attempt,claim_id FROM margin_submissions.outbox WHERE attempt_id=$1',
            [third.claim.submissionId],
          )
        ).rows[0],
      ).toEqual(before);
      for (const item of pending)
        item.resolve({
          bytes: item.bytes,
          metadata: { name: 'Synthetic', mimeType: 'application/pdf' },
        });
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(pending.every((item) => item.bytes.every((b) => b === 0))).toBe(true);
      const recovered = (await isolated.claimNext())!;
      expect(recovered.submissionId).toBe(third.claim.submissionId);
      expect(recovered.attempt).toBe(third.claim.attempt + 1);
      await isolated.retry(recovered, 3600);
    } finally {
      for (const item of pending)
        item.resolve({
          bytes: item.bytes,
          metadata: { name: 'Synthetic', mimeType: 'application/pdf' },
        });
      await isolated.close();
    }
  }, 20000);

  it('fences an actually expired lease after a new worker claims the job', async () => {
    const { claim } = await captured();
    const old = await staged(claim);
    const admin = await f.admin.connect();
    try {
      await admin.query('BEGIN');
      await admin.query("SET LOCAL session_replication_role='replica'");
      await admin.query(
        "UPDATE margin_submissions.outbox SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE attempt_id=$1",
        [claim.submissionId],
      );
      await admin.query('COMMIT');
    } catch (error) {
      await admin.query('ROLLBACK');
      throw error;
    } finally {
      admin.release();
    }
    const next = (await processor.claimNext())!;
    expect(next.submissionId).toBe(claim.submissionId);
    expect(next.claimId).not.toBe(claim.claimId);
    expect(next.attempt).toBe(claim.attempt + 1);
    await expect(processor.complete(claim, old.ticket, old.summary)).rejects.toMatchObject({
      code: 'stale_claim',
    });
    processor.dispose(old.ticket);
    const current = await staged(next);
    await processor.complete(next, current.ticket, current.summary);
    await expect(processor.receipt(claim)).rejects.toMatchObject({ code: 'stale_claim' });
  }, 20000);

  it('pins READ COMMITTED despite a REPEATABLE READ database session default', async () => {
    const { claim } = await captured(0);
    await processor.retry(claim, 0);
    const inherited = new PostgresSubmissionProcessor(
      {
        ...f.config('submission_processor'),
        options: '-c default_transaction_isolation=repeatable\\ read',
      },
      f.kms,
    );
    await f.admin.query(
      `CREATE FUNCTION public.require_materialization_read_committed() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'Materialization must use READ COMMITTED'; END IF; RETURN NEW; END $$; CREATE TRIGGER check_materialization_isolation BEFORE INSERT ON margin_submissions.materialization_chunks FOR EACH ROW EXECUTE FUNCTION public.require_materialization_read_committed();`,
    );
    try {
      expect(
        await new SubmissionMaterializationWorker(inherited, f.reader, f.storage).runOne(),
      ).toMatchObject({ state: 'materialized', submissionId: claim.submissionId });
    } finally {
      await inherited.close();
      await f.admin.query(
        'DROP TRIGGER check_materialization_isolation ON margin_submissions.materialization_chunks; DROP FUNCTION public.require_materialization_read_committed()',
      );
    }
  }, 20000);

  it('runs the complete worker through real PostgreSQL and replay without including later edits', async () => {
    const { fixture, claim, manifest } = await captured(2);
    await f.workApi.append(fixture.studentP, f.operation(fixture, manifest.pages[0].id));
    await processor.retry(claim, 0);
    const worker = new SubmissionMaterializationWorker(processor, f.reader, f.storage);
    expect(await worker.runOne()).toMatchObject({
      submissionId: claim.submissionId,
      workId: claim.workId,
      state: 'materialized',
      frozenCursor: 2,
      chunkCount: 1,
      duplicate: false,
    });
    expect(await worker.runOne()).toBeNull();
    expect((await capture.list(fixture.studentP, {})).submissions[0]).toMatchObject({
      phase: 'processing',
      confirmedAt: null,
      retryAllowed: false,
    });
    expect(
      (
        await f.admin.query(
          'SELECT cursor FROM margin_sync.documents WHERE organization_id=$1 AND id=$2',
          [fixture.org, fixture.reservation.documentId],
        )
      ).rows[0].cursor,
    ).toBe('3');
  }, 20000);

  it('reads long frozen prefixes in bounded batches and preserves later draft work', async () => {
    const { fixture, claim, manifest } = await captured(101);
    await f.workApi.append(fixture.studentP, f.operation(fixture, manifest.pages[0].id));
    const prepared = await processor.prepare(claim, f.reader, f.storage);
    const replay = new SubmissionReplay(prepared.replay);
    const first = await processor.readBatch(claim, prepared.ticket, 0);
    expect(first.operations).toHaveLength(100);
    expect(first.hasMore).toBe(true);
    replay.appendBatch(first.operations);
    const last = await processor.readBatch(claim, prepared.ticket, 100);
    expect(last.operations).toHaveLength(1);
    expect(last.nextCursor).toBe(101);
    expect(last.hasMore).toBe(false);
    replay.appendBatch(last.operations);
    for (const chunk of replay.chunks()) {
      try {
        await processor.stageChunk(claim, prepared.ticket, chunk.index, chunk.plaintext);
      } finally {
        chunk.plaintext.fill(0);
      }
    }
    expect(replay.summary().annotationCount).toBe(101);
    await processor.complete(claim, prepared.ticket, replay.summary());
  }, 30000);
  it.each(['teacher', 'installation', 'target', 'grant'] as const)(
    'rejects current %s authority revoked before publication',
    async (kind) => {
      const { fixture, claim } = await captured();
      const ready = await staged(claim);
      if (kind === 'teacher')
        await f.admin.query(
          'UPDATE margin_identity.memberships SET revoked_at=clock_timestamp() WHERE organization_id=$1 AND user_id=$2',
          [fixture.org, fixture.teacher],
        );
      if (kind === 'installation')
        await f.admin.query(
          'UPDATE margin_lms.installations SET enabled=false,version=version+1 WHERE id=$1',
          [fixture.installation],
        );
      if (kind === 'target')
        await f.admin.query(
          'UPDATE margin_sync.documents SET deleted_at=clock_timestamp() WHERE organization_id=$1 AND id=$2',
          [fixture.org, fixture.reservation.documentId],
        );
      if (kind === 'grant')
        await f.admin.query(
          'UPDATE margin_sync.grants SET revoked_at=clock_timestamp() WHERE organization_id=$1 AND document_id=$2 AND user_id=$3',
          [fixture.org, fixture.reservation.documentId, fixture.student],
        );
      await expect(processor.complete(claim, ready.ticket, ready.summary)).rejects.toMatchObject({
        code: 'authority_revoked',
      });
      processor.dispose(ready.ticket);
    },
    20000,
  );
  it.each(['tag', 'wrapped_key'] as const)(
    'rejects captured envelope %s corruption before materialization',
    async (field) => {
      const { claim } = await captured();
      if (field === 'tag')
        await f.admin.query(
          "UPDATE margin_submissions.requests SET tag=decode(repeat('02',16),'hex') WHERE work_id=$1",
          [claim.workId],
        );
      else
        await f.admin.query(
          "UPDATE margin_submissions.requests SET wrapped_key='{}' WHERE work_id=$1",
          [claim.workId],
        );
      await expect(processor.prepare(claim, f.reader, f.storage)).rejects.toMatchObject({
        code: 'submission_integrity',
      });
      await processor.retry(claim, 3600);
    },
    20000,
  );
  it('rejects changed source bytes and wipes returned plaintext even on failure', async () => {
    const { claim } = await captured();
    const bytes = Buffer.from('wrong source');
    await expect(
      processor.prepare(claim, f.reader, {
        async get() {
          return { bytes, metadata: { name: 'synthetic', mimeType: 'application/pdf' } };
        },
      }),
    ).rejects.toMatchObject({ code: 'source_content_mismatch' });
    expect(bytes.every((v) => v === 0)).toBe(true);
    await processor.retry(claim, 3600);
  }, 20000);
  it('requires contiguous chunks and exact duplicate content', async () => {
    const { claim } = await captured();
    const prepared = await processor.prepare(claim, f.reader, f.storage);
    const replay = new SubmissionReplay(prepared.replay);
    replay.appendBatch((await processor.readBatch(claim, prepared.ticket, 0)).operations);
    const chunks = Array.from(replay.chunks(), (chunk) => ({
      ...chunk,
      plaintext: Buffer.from(chunk.plaintext),
    }));
    try {
      await expect(
        processor.stageChunk(claim, prepared.ticket, 1, chunks[0].plaintext),
      ).rejects.toMatchObject({ code: 'invalid_chunk' });
      expect(
        (await processor.stageChunk(claim, prepared.ticket, 0, chunks[0].plaintext)).duplicate,
      ).toBe(false);
      expect(
        (await processor.stageChunk(claim, prepared.ticket, 0, chunks[0].plaintext)).duplicate,
      ).toBe(true);
      await processor.complete(claim, prepared.ticket, replay.summary());
    } finally {
      for (const chunk of chunks) chunk.plaintext.fill(0);
    }
  }, 20000);
  it('refuses to finalize a missing staged chunk', async () => {
    const { claim } = await captured();
    const ready = await staged(claim);
    await f.admin.query(
      'DELETE FROM margin_submissions.materialization_chunks WHERE submission_id=$1',
      [claim.submissionId],
    );
    await expect(processor.complete(claim, ready.ticket, ready.summary)).rejects.toMatchObject({
      code: 'staged_chunks_changed',
    });
    processor.dispose(ready.ticket);
    await processor.retry(claim, 3600);
  }, 20000);

  it('materializes frozen history after launch expiry without claiming Canvas delivery', async () => {
    const { fixture, claim } = await captured();
    await f.admin.query(
      "UPDATE margin_identity.sessions SET idle_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",
      [fixture.studentP.sessionId],
    );
    const ready = await staged(claim);
    const done = await processor.complete(claim, ready.ticket, ready.summary);
    expect(done).toMatchObject({
      state: 'materialized',
      frozenCursor: 1,
      chunkCount: 1,
      duplicate: false,
    });
    expect(await processor.receipt(claim)).toEqual({ ...done, duplicate: true });
    expect(
      (
        await f.admin.query(
          'SELECT phase,materialization_state FROM margin_submissions.outbox WHERE attempt_id=$1',
          [claim.submissionId],
        )
      ).rows[0],
    ).toEqual({ phase: 'processing', materialization_state: 'completed' });
    expect(await processor.claimNext()).toBeNull();
  }, 20000);
  it('supports empty captures and excludes later draft edits', async () => {
    const { fixture, claim, manifest } = await captured(0);
    await f.workApi.append(fixture.studentP, f.operation(fixture, manifest.pages[0].id));
    const ready = await staged(claim);
    expect(ready.summary).toMatchObject({
      frozenCursor: 0,
      operationCount: 0,
      annotationCount: 0,
      chunkCount: 1,
    });
    await processor.complete(claim, ready.ticket, ready.summary);
  }, 20000);
  it('hides partial staged output and supports same-claim restart', async () => {
    const { claim } = await captured();
    const ready = await staged(claim);
    expect(await processor.receipt(claim)).toBeNull();
    const api = new Pool(f.config('submission_api'));
    try {
      await expect(
        api.query('SELECT * FROM margin_submissions.materialization_chunks'),
      ).rejects.toThrow();
    } finally {
      await api.end();
    }
    processor.dispose(ready.ticket);
    const again = await staged(claim);
    await processor.complete(claim, again.ticket, again.summary);
  }, 20000);
  it('rejects incomplete or modified summary and preserves retryable claim', async () => {
    const { claim } = await captured();
    const ready = await staged(claim);
    await expect(
      processor.complete(claim, ready.ticket, { ...ready.summary, outputSha256: '0'.repeat(64) }),
    ).rejects.toMatchObject({ code: 'materialization_summary_mismatch' });
    expect(await processor.receipt(claim)).toBeNull();
    await processor.complete(claim, ready.ticket, ready.summary);
  }, 20000);
  it('fences released claims and retries under a new claim', async () => {
    const { claim } = await captured();
    const ready = await staged(claim);
    await processor.retry(claim, 0);
    await expect(processor.complete(claim, ready.ticket, ready.summary)).rejects.toMatchObject({
      code: 'invalid_preparation',
    });
    const next = (await processor.claimNext())!;
    expect(next.attempt).toBe(claim.attempt + 1);
    await expect(processor.receipt(claim)).rejects.toMatchObject({ code: 'stale_claim' });
    const nextReady = await staged(next);
    await processor.complete(next, nextReady.ticket, nextReady.summary);
  }, 20000);
  it('rejects source revocation during external object read', async () => {
    const { fixture, claim } = await captured();
    await expect(
      processor.prepare(claim, f.reader, {
        async get(identity, receipt, signal) {
          const out = await f.storage.get(identity, receipt, signal);
          await f.admin.query(
            'UPDATE margin_ingestion.artifacts SET revoked_at=clock_timestamp() WHERE artifact_id=$1',
            [fixture.source.identity.artifactId],
          );
          return out;
        },
      }),
    ).rejects.toMatchObject({ code: 'source_changed' });
    expect(
      (
        await f.admin.query(
          'SELECT count(*)::int AS n FROM margin_submissions.materialization_receipts WHERE submission_id=$1',
          [claim.submissionId],
        )
      ).rows[0].n,
    ).toBe(0);
  }, 20000);
  it('rejects student enrollment revoked after staging', async () => {
    const { fixture, claim } = await captured();
    const ready = await staged(claim);
    await f.admin.query(
      'UPDATE margin_lms.enrollments SET disabled_at=clock_timestamp() WHERE installation_id=$1 AND user_id=$2',
      [fixture.installation, fixture.student],
    );
    await expect(processor.complete(claim, ready.ticket, ready.summary)).rejects.toMatchObject({
      code: 'authority_revoked',
    });
    processor.dispose(ready.ticket);
  }, 20000);
  it('rejects staged ciphertext corruption before publication', async () => {
    const { claim } = await captured();
    const ready = await staged(claim);
    await f.admin.query(
      "UPDATE margin_submissions.materialization_chunks SET tag=decode(repeat('01',16),'hex') WHERE submission_id=$1",
      [claim.submissionId],
    );
    await expect(processor.complete(claim, ready.ticket, ready.summary)).rejects.toMatchObject({
      code: 'staged_chunks_changed',
    });
    processor.dispose(ready.ticket);
    await processor.retry(claim, 3600);
  }, 20000);
  it('rejects ciphertext corruption on completion recovery', async () => {
    const { claim } = await captured();
    const ready = await staged(claim);
    await processor.complete(claim, ready.ticket, ready.summary);
    await f.admin.query(
      "UPDATE margin_submissions.materialization_chunks SET tag=decode(repeat('01',16),'hex') WHERE submission_id=$1",
      [claim.submissionId],
    );
    await expect(processor.receipt(claim)).rejects.toMatchObject({ code: 'completion_integrity' });
  }, 20000);
  it('rejects fake tickets, cancelled claims, and content reads without current claim context', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(processor.claimNext(controller.signal)).rejects.toMatchObject({
      code: 'processing_cancelled',
    });
    expect(
      (await sql.query('SELECT count(*)::int AS n FROM margin_sync.operations')).rows[0].n,
    ).toBe(0);
    expect(
      (await sql.query('SELECT count(*)::int AS n FROM margin_sync.document_keys')).rows[0].n,
    ).toBe(0);
    const { claim } = await captured();
    await expect(
      processor.readBatch(claim, { kind: 'prepared-submission' }, 0),
    ).rejects.toMatchObject({ code: 'invalid_preparation' });
    await processor.retry(claim, 3600);
  }, 20000);
});
