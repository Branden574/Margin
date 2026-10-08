import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { PostgresAssignmentSubmissionService } from '../apps/api/src/assignments/submissions/service';
import { PostgresSubmissionProcessor } from '../apps/api/src/assignments/submissions/processing/postgres';
import { SubmissionMaterializationWorker } from '../apps/api/src/assignments/submissions/processing/worker';
import { submissionFixture as f } from './helpers/submission-fixture';
let service: PostgresAssignmentSubmissionService, processor: PostgresSubmissionProcessor;
async function captured() {
  const fixture = await f.ready();
  const input = { requestId: randomUUID(), expectedCursor: 0 };
  const outcome = await service.capture(fixture.studentP, input);
  if (outcome.request.state !== 'captured') throw Error('Fixture rejected');
  return { fixture, input, request: outcome.request, id: outcome.request.submission.id };
}
async function failed(code: 'source_unavailable' | 'snapshot_invalid' = 'source_unavailable') {
  const result = await captured();
  const claim = await processor.claimNext();
  expect(claim?.submissionId).toBe(result.id);
  await processor.fail(claim!, code);
  return { ...result, claim: claim! };
}
async function frozen(id: string) {
  return (
    await f.admin.query(
      'SELECT r.*,a.* FROM margin_submissions.requests r JOIN margin_submissions.attempts a USING(work_id,request_id) WHERE a.id=$1',
      [id],
    )
  ).rows[0];
}
async function queue(id: string) {
  return (await f.admin.query('SELECT * FROM margin_submissions.outbox WHERE attempt_id=$1', [id]))
    .rows[0];
}
describe.skipIf(!f.available)(
  'durable public reprocessing over the same frozen capture',
  { timeout: 20000 },
  () => {
    beforeAll(async () => {
      await f.boot({ processingStatus: true });
      service = new PostgresAssignmentSubmissionService(f.config('submission_api'), f.kms, {
        captureEnabled: true,
      });
      processor = new PostgresSubmissionProcessor(f.config('submission_processor'), f.kms);
    }, 30000);
    afterEach(async () => {
      vi.restoreAllMocks();
      await f.admin.query(
        'UPDATE margin_identity.organizations SET disabled_at=clock_timestamp() WHERE disabled_at IS NULL',
      );
    });
    afterAll(async () => {
      await Promise.allSettled([service?.close(), processor?.close()]);
      await f.stop();
    }, 30000);
    it('projects durable failure through capture recovery, lookup and list without changing encrypted capture', async () => {
      const t = await captured(),
        original = await frozen(t.id);
      const claim = await processor.claimNext();
      await processor.fail(claim!, 'source_unavailable');
      const expected = {
        ...t.request,
        submission: {
          ...t.request.submission,
          revision: 2,
          phase: 'failed',
          errorCode: 'source_unavailable',
          retryAllowed: true,
        },
      };
      expect(await service.request(t.fixture.studentP, t.input.requestId)).toEqual({
        request: expected,
      });
      expect(await service.capture(t.fixture.studentP, t.input)).toEqual({
        request: expected,
        duplicate: true,
      });
      expect(await service.list(t.fixture.studentP, {})).toEqual({
        submissions: [expected.submission],
        nextCursor: null,
      });
      expect(await frozen(t.id)).toEqual(original);
    });
    it('accepts exactly one concurrent retry, retains its cause, fences the retired claim and keeps the frozen prefix', async () => {
      const t = await failed(),
        original = await frozen(t.id);
      const description = await f.workApi.describe(t.fixture.studentP);
      if (description.work?.status !== 'provisioned') throw Error();
      await f.workApi.append(
        t.fixture.studentP,
        f.operation(t.fixture, description.work.document.pages[0].id),
      );
      const [a, b] = await Promise.all([
        service.reprocess(t.fixture.studentP, t.id, { expectedRevision: 2 }),
        service.reprocess(t.fixture.studentP, t.id, { expectedRevision: 2 }),
      ]);
      expect(a).toEqual(b);
      expect(a).toMatchObject({
        expectedRevision: 2,
        state: 'accepted',
        acceptedRevision: 3,
        code: null,
        request: { ...t.request, submission: { ...t.request.submission, revision: 3 } },
      });
      const job = await queue(t.id);
      expect(job).toMatchObject({
        status_revision: '3',
        processing_generation: 2,
        materialization_state: 'pending',
        materialization_attempt: 0,
        claim_id: null,
        token_digest: null,
        lease_expires_at: null,
        failed_at: null,
        published_error_code: null,
      });
      const commands = (
        await f.admin.query(
          'SELECT * FROM margin_submissions.reprocess_commands WHERE attempt_id=$1',
          [t.id],
        )
      ).rows;
      expect(commands).toHaveLength(1);
      expect(commands[0]).toMatchObject({
        prior_error_code: 'source_unavailable',
        processing_generation: 2,
      });
      expect(await frozen(t.id)).toEqual(original);
      await expect(processor.fail(t.claim, 'source_unavailable')).rejects.toMatchObject({
        code: 'stale_claim',
      });
      const next = await processor.claimNext();
      expect(next?.submissionId).toBe(t.id);
      expect(next?.attempt).toBe(1);
      expect(next?.claimId).not.toBe(t.claim.claimId);
      await processor.fail(next!, 'source_unavailable');
      const recovered = await service.reprocessRequest(t.fixture.studentP, t.id, 2);
      expect(recovered).toMatchObject({
        expectedRevision: 2,
        state: 'accepted',
        acceptedRevision: 3,
        request: { submission: { revision: 4, phase: 'failed', frozenCursor: 0 } },
      });
      expect(await service.reprocess(t.fixture.studentP, t.id, { expectedRevision: 2 })).toEqual(
        recovered,
      );
      expect((await queue(t.id)).processing_generation).toBe(2);
      expect(await frozen(t.id)).toEqual(original);
    });
    it('does not poison future revision keys, and recovers absent outcomes only after a command is recorded', async () => {
      const t = await captured();
      await expect(service.reprocessRequest(t.fixture.studentP, t.id, 2)).rejects.toMatchObject({
        status: 404,
      });
      await expect(
        service.reprocess(t.fixture.studentP, t.id, { expectedRevision: 2 }),
      ).rejects.toMatchObject({ status: 409 });
      expect(
        (
          await f.admin.query(
            'SELECT 1 FROM margin_submissions.reprocess_commands WHERE attempt_id=$1',
            [t.id],
          )
        ).rowCount,
      ).toBe(0);
      await processor.fail((await processor.claimNext())!, 'source_unavailable');
      expect(
        await service.reprocess(t.fixture.studentP, t.id, { expectedRevision: 2 }),
      ).toMatchObject({ state: 'accepted', acceptedRevision: 3 });
    });
    it('permanently retains rejected keys when later revisions become retryable', async () => {
      const t = await captured();
      expect(
        await service.reprocess(t.fixture.studentP, t.id, { expectedRevision: 1 }),
      ).toMatchObject({ state: 'rejected', code: 'not_retryable', acceptedRevision: null });
      await processor.fail((await processor.claimNext())!, 'source_unavailable');
      expect(
        await service.reprocess(t.fixture.studentP, t.id, { expectedRevision: 1 }),
      ).toMatchObject({
        state: 'rejected',
        code: 'not_retryable',
        request: { submission: { revision: 2, retryAllowed: true } },
      });
      expect((await queue(t.id)).processing_generation).toBe(1);
      expect(
        await service.reprocess(t.fixture.studentP, t.id, { expectedRevision: 2 }),
      ).toMatchObject({ state: 'accepted' });
      const key = (
        await f.admin.query(
          'SELECT * FROM margin_submissions.reprocess_commands WHERE attempt_id=$1 AND expected_revision=1',
          [t.id],
        )
      ).rows[0];
      expect(key).toMatchObject({
        state: 'rejected',
        code: 'not_retryable',
        processing_generation: 1,
      });
    });
    it('durably rejects stale revisions and invalid snapshots, and enforces three processing generations', async () => {
      const invalid = await failed('snapshot_invalid');
      expect(
        await service.reprocess(invalid.fixture.studentP, invalid.id, { expectedRevision: 2 }),
      ).toMatchObject({
        state: 'rejected',
        code: 'not_retryable',
        request: { submission: { retryAllowed: false } },
      });
      const t = await failed();
      expect(
        await service.reprocess(t.fixture.studentP, t.id, { expectedRevision: 1 }),
      ).toMatchObject({ state: 'rejected', code: 'revision_changed' });
      for (const revision of [2, 4]) {
        expect(
          await service.reprocess(t.fixture.studentP, t.id, { expectedRevision: revision }),
        ).toMatchObject({ state: 'accepted', acceptedRevision: revision + 1 });
        await processor.fail((await processor.claimNext())!, 'source_unavailable');
      }
      expect(
        await service.reprocess(t.fixture.studentP, t.id, { expectedRevision: 6 }),
      ).toMatchObject({
        state: 'rejected',
        code: 'retry_limit',
        request: { submission: { revision: 6, phase: 'failed', retryAllowed: false } },
      });
      expect((await queue(t.id)).processing_generation).toBe(3);
    });
    it('keeps materialized work processing and rejects a new retry without implying Canvas delivery', async () => {
      const t = await captured();
      const worker = new SubmissionMaterializationWorker(processor, f.reader, f.storage);
      await worker.runOne();
      expect(await service.request(t.fixture.studentP, t.input.requestId)).toMatchObject({
        request: {
          submission: { phase: 'processing', revision: 2, confirmedAt: null, retryAllowed: false },
        },
      });
      expect(
        await service.reprocess(t.fixture.studentP, t.id, { expectedRevision: 2 }),
      ).toMatchObject({ state: 'rejected', code: 'not_retryable' });
      expect((await queue(t.id)).materialization_state).toBe('completed');
    });
    it('requires the same current student launch for commands and receipts', async () => {
      const t = await failed(),
        other = await f.ready();
      for (const p of [
        t.fixture.peerP,
        t.fixture.teacherP,
        other.studentP,
        { ...t.fixture.studentP, authenticationMethod: 'oidc' as const },
      ]) {
        await expect(service.reprocess(p, t.id, { expectedRevision: 2 })).rejects.toBeDefined();
        await expect(service.reprocessRequest(p, t.id, 2)).rejects.toBeDefined();
      }
      await f.admin.query(
        'UPDATE margin_identity.sessions SET revoked_at=clock_timestamp() WHERE id=$1',
        [t.fixture.studentP.sessionId],
      );
      await expect(
        service.reprocess(t.fixture.studentP, t.id, { expectedRevision: 2 }),
      ).rejects.toMatchObject({ status: 403 });
      await expect(service.reprocessRequest(t.fixture.studentP, t.id, 2)).rejects.toMatchObject({
        status: 403,
      });
      expect((await queue(t.id)).processing_generation).toBe(1);
    });
    it('withholds a retry after authority is revoked during capture decryption, without recording a command', async () => {
      const t = await failed();
      const unwrap = f.kms.unwrapKey.bind(f.kms);
      let revoked = false;
      vi.spyOn(f.kms, 'unwrapKey').mockImplementation(async (...args) => {
        expect(
          (
            await f.admin.query(
              "SELECT count(*) FROM pg_stat_activity WHERE usename='submission_api' AND state='idle in transaction'",
            )
          ).rows[0].count,
        ).toBe('0');
        if (!revoked && args[1].includes('margin-submission-request-v1')) {
          revoked = true;
          await f.admin.query(
            'UPDATE margin_lms.enrollments SET disabled_at=clock_timestamp() WHERE user_id=$1',
            [t.fixture.student],
          );
        }
        return unwrap(...args);
      });
      await expect(
        service.reprocess(t.fixture.studentP, t.id, { expectedRevision: 2 }),
      ).rejects.toBeDefined();
      expect(revoked).toBe(true);
      expect((await queue(t.id)).processing_generation).toBe(1);
      expect(
        (
          await f.admin.query(
            'SELECT 1 FROM margin_submissions.reprocess_commands WHERE attempt_id=$1',
            [t.id],
          )
        ).rowCount,
      ).toBe(0);
    });
    it('recovers the exact accepted command after cancellation loses its post-commit response', async () => {
      const t = await failed();
      const controller = new AbortController();
      const unwrap = f.kms.unwrapKey.bind(f.kms);
      let captureUnwraps = 0;
      let finished!: () => void;
      const settled = new Promise<void>((resolve) => {
        finished = resolve;
      });
      vi.spyOn(f.kms, 'unwrapKey').mockImplementation(async (...args) => {
        if (args[1].includes('margin-submission-request-v1') && ++captureUnwraps === 2) {
          controller.abort();
          const key = await unwrap(...args);
          finished();
          return key;
        }
        return unwrap(...args);
      });
      await expect(
        service.reprocess(
          t.fixture.studentP,
          t.id,
          { expectedRevision: 2 },
          { signal: controller.signal },
        ),
      ).rejects.toBeDefined();
      await settled;
      vi.restoreAllMocks();
      const recovered = await service.reprocessRequest(t.fixture.studentP, t.id, 2);
      expect(recovered).toMatchObject({
        state: 'accepted',
        acceptedRevision: 3,
        request: { submission: { revision: 3, frozenCursor: 0 } },
      });
      expect(await service.reprocess(t.fixture.studentP, t.id, { expectedRevision: 2 })).toEqual(
        recovered,
      );
      expect((await queue(t.id)).processing_generation).toBe(2);
    });
    it('withholds an accepted command receipt after authority changes during its post-commit decryption', async () => {
      const t = await failed();
      const unwrap = f.kms.unwrapKey.bind(f.kms);
      let captureUnwraps = 0;
      vi.spyOn(f.kms, 'unwrapKey').mockImplementation(async (...args) => {
        if (args[1].includes('margin-submission-request-v1') && ++captureUnwraps === 2)
          await f.admin.query(
            'UPDATE margin_lms.enrollments SET disabled_at=clock_timestamp() WHERE user_id=$1',
            [t.fixture.student],
          );
        return unwrap(...args);
      });
      await expect(
        service.reprocess(t.fixture.studentP, t.id, { expectedRevision: 2 }),
      ).rejects.toBeDefined();
      expect((await queue(t.id)).processing_generation).toBe(2);
      vi.restoreAllMocks();
      await expect(service.reprocessRequest(t.fixture.studentP, t.id, 2)).rejects.toBeDefined();
      // Restoring current enrollment permits recovery of the accepted command, not a new capture.
      await f.admin.query('UPDATE margin_lms.enrollments SET disabled_at=NULL WHERE user_id=$1', [
        t.fixture.student,
      ]);
      expect(await service.reprocessRequest(t.fixture.studentP, t.id, 2)).toMatchObject({
        state: 'accepted',
        acceptedRevision: 3,
      });
    });
    it.each([
      {},
      null,
      [],
      { expectedRevision: 0 },
      { expectedRevision: -1 },
      { expectedRevision: 1.5 },
      { expectedRevision: '2' },
      { expectedRevision: Number.MAX_SAFE_INTEGER },
      { expectedRevision: 2, expectedCursor: 0 },
    ])('rejects malformed commands before any durable write %#', async (input) => {
      const t = await failed();
      await expect(service.reprocess(t.fixture.studentP, t.id, input)).rejects.toMatchObject({
        status: 400,
      });
      expect((await queue(t.id)).processing_generation).toBe(1);
    });
  },
);
