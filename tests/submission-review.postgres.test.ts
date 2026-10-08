import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { setImmediate as tick } from 'node:timers/promises';
import { submissionFixture as f } from './helpers/submission-fixture';
import { PostgresAssignmentSubmissionService } from '../apps/api/src/assignments/submissions/service';
import { PostgresSubmissionProcessor } from '../apps/api/src/assignments/submissions/processing/postgres';
import { SubmissionMaterializationWorker } from '../apps/api/src/assignments/submissions/processing/worker';
import { SubmissionReplay } from '../apps/api/src/assignments/submissions/processing/replay';
import { PostgresAssignmentReviewService } from '../apps/api/src/assignments/review/service';
import { ReviewPool } from '../apps/api/src/assignments/review/pool';
import type { SessionPrincipal } from '../apps/api/src/identity/types';
let capture: PostgresAssignmentSubmissionService,
  processor: PostgresSubmissionProcessor,
  review: PostgresAssignmentReviewService;
const hash = (v: string | Buffer) => createHash('sha256').update(v).digest('hex');
async function captured(edits = 1, launch = true) {
  const t = await f.ready();
  if (launch)
    await f.admin.query(
      'INSERT INTO margin_assignments.launch_bindings(session_id,installation_id,resource_digest,assignment_id,user_id) VALUES($1,$2,$3,$4,$5)',
      [t.teacherP.sessionId, t.installation, hash(t.assignment.id), t.assignment.id, t.teacher],
    );
  const d = await f.workApi.describe(t.studentP);
  if (d.work?.status !== 'provisioned') throw Error();
  const ops = [];
  for (let i = 0; i < edits; i++) {
    const op = f.operation(t, d.work.document.pages[0].id);
    ops.push(op);
    await f.workApi.append(t.studentP, op);
  }
  const result = await capture.capture(t.studentP, {
    requestId: randomUUID(),
    expectedCursor: edits,
  });
  if (result.request.state !== 'captured') throw Error();
  return {
    ...t,
    id: result.request.submission.id,
    frozenAt: result.request.submission.frozenAt,
    ops,
    pages: d.work.document.pages,
  };
}
async function completed(edits = 1) {
  const t = await captured(edits);
  expect(
    (await new SubmissionMaterializationWorker(processor, f.reader, f.storage).runOne())
      ?.submissionId,
  ).toBe(t.id);
  return t;
}
describe.skipIf(!f.available)(
  'author-only frozen submission review with real PostgreSQL',
  { timeout: 30000 },
  () => {
    beforeAll(async () => {
      await f.boot({ review: true });
      capture = new PostgresAssignmentSubmissionService(f.config('submission_api'), f.kms, {
        captureEnabled: true,
      });
      processor = new PostgresSubmissionProcessor(f.config('submission_processor'), f.kms);
      review = new PostgresAssignmentReviewService(
        f.config('submission_reviewer'),
        f.kms,
        f.reader,
        f.storage,
      );
    }, 30000);
    afterEach(async () => {
      vi.restoreAllMocks();
      await f.admin.query(
        'UPDATE margin_identity.organizations SET disabled_at=clock_timestamp() WHERE disabled_at IS NULL',
      );
    });
    afterAll(async () => {
      await Promise.allSettled([capture?.close(), processor?.close(), review?.close()]);
      await f.stop();
    }, 30000);
    it('authenticates exact completed source/chunks and never includes later draft edits', async () => {
      const t = await captured();
      await f.workApi.append(t.studentP, {
        ...t.ops[0],
        operationId: randomUUID(),
        baseRevision: 1,
        annotation: { ...t.ops[0].annotation, text: 'LATER DRAFT MUST STAY PRIVATE' },
      });
      await new SubmissionMaterializationWorker(processor, f.reader, f.storage).runOne();
      expect(await review.context(t.teacherP)).toEqual({
        assignment: {
          id: t.assignment.id,
          title: t.assignment.title,
          instructions: t.assignment.instructions,
        },
        mode: 'author-only',
      });
      const page = await review.list(t.teacherP, {});
      expect(page).toEqual({
        submissions: [
          {
            id: t.id,
            frozenAt: t.frozenAt,
            frozenCursor: 1,
            revision: 2,
            preparation: 'ready',
            errorCode: null,
          },
        ],
        nextCursor: null,
      });
      const snapshot = await review.snapshot(t.teacherP, t.id);
      expect(snapshot).toMatchObject({
        assignmentId: t.assignment.id,
        submission: page.submissions[0],
        pages: t.pages,
        source: { sha256: hash(f.body), bytes: f.body.length, mimeType: 'application/pdf' },
        annotationCount: 1,
      });
      const bytes = await review.chunk(t.teacherP, t.id, 0, { snapshotPin: snapshot.snapshotPin });
      try {
        const chunk = JSON.parse(bytes.toString());
        expect(hash(bytes)).toBe(snapshot.chunks[0].sha256);
        expect(chunk.entries).toHaveLength(1);
        expect(chunk.entries[0]).toMatchObject({
          annotationId: t.ops[0].annotationId,
          layerOrder: 1,
          annotation: { text: 'Private student answer' },
        });
        expect(bytes.includes('LATER DRAFT')).toBe(false);
      } finally {
        bytes.fill(0);
      }
      const source = await review.source(t.teacherP, t.id, { snapshotPin: snapshot.snapshotPin });
      try {
        expect(source).toEqual(f.body);
      } finally {
        source.fill(0);
      }
      const encoded = JSON.stringify(snapshot);
      for (const prohibited of [
        'claimId',
        'wrappedKey',
        'storage',
        'scanReceipt',
        'token_digest',
        'studentName',
        'provider',
      ])
        expect(encoded).not.toContain(prohibited);
    });
    it('shows preparing/failed captures and refuses content until completion', async () => {
      const t = await captured(0);
      expect((await review.list(t.teacherP, {})).submissions[0]).toMatchObject({
        preparation: 'preparing',
        revision: 1,
      });
      await expect(review.snapshot(t.teacherP, t.id)).rejects.toMatchObject({
        code: 'review_not_ready',
      });
      const claim = (await processor.claimNext())!;
      await processor.fail(claim, 'snapshot_invalid');
      expect((await review.list(t.teacherP, {})).submissions[0]).toMatchObject({
        preparation: 'failed',
        revision: 2,
        errorCode: 'snapshot_invalid',
      });
      await expect(review.snapshot(t.teacherP, t.id)).rejects.toMatchObject({
        code: 'review_not_ready',
      });
    });
    it('requires a current author resource launch, rather than a teacher role or opaque id', async () => {
      const t = await captured(0, false);
      await expect(review.context(t.teacherP)).rejects.toMatchObject({
        code: 'review_unavailable',
      });
      for (const p of [
        t.studentP,
        t.peerP,
        { ...t.teacherP, authenticationMethod: 'password' },
        { ...t.teacherP, role: 'admin' },
      ] as SessionPrincipal[])
        await expect(review.snapshot(p, t.id)).rejects.toMatchObject({
          code: 'review_unavailable',
        });
    });
    it('rejects wrong pins before source I/O and does not expose ordinary draft access', async () => {
      const t = await completed(0),
        snapshot = await review.snapshot(t.teacherP, t.id),
        get = vi.spyOn(f.storage, 'get');
      await expect(
        review.source(t.teacherP, t.id, { snapshotPin: 'a'.repeat(64) }),
      ).rejects.toMatchObject({ code: 'review_snapshot_changed' });
      expect(get).not.toHaveBeenCalled();
      await expect(
        review.chunk(t.teacherP, t.id, 1, { snapshotPin: snapshot.snapshotPin }),
      ).rejects.toMatchObject({ code: 'review_unavailable' });
      const sql = new Pool(f.config('submission_reviewer'));
      try {
        for (const statement of [
          'SELECT * FROM margin_sync.operations',
          'SELECT * FROM margin_sync.annotations',
          'SELECT cursor FROM margin_sync.documents',
          'INSERT INTO margin_submissions.materialization_receipts DEFAULT VALUES',
        ])
          await expect(sql.query(statement)).rejects.toMatchObject({ code: '42501' });
      } finally {
        await sql.end();
      }
    });
    it("hides a previous failed generation's partial chunks after a later generation completes", async () => {
      const t = await captured(0),
        claim = (await processor.claimNext())!;
      const prepared = await processor.prepare(claim, f.reader, f.storage),
        replay = new SubmissionReplay(prepared.replay);
      try {
        for (const chunk of replay.chunks())
          try {
            await processor.stageChunk(claim, prepared.ticket, chunk.index, chunk.plaintext);
          } finally {
            chunk.plaintext.fill(0);
          }
        const sql = new ReviewPool(f.config('submission_reviewer'));
        const rows = () =>
          sql.transaction(t.teacherP, async (c) => {
            await c.query("SELECT set_config('margin_review.submission_id',$1,true)", [t.id]);
            return (
              await c.query(
                'SELECT submission_id,claim_id FROM margin_submissions.materialization_chunks',
              )
            ).rows;
          });
        try {
          expect(await rows()).toEqual([]);
          await processor.fail(claim, 'source_unavailable');
          await capture.reprocess(t.studentP, t.id, { expectedRevision: 2 });
          await new SubmissionMaterializationWorker(processor, f.reader, f.storage).runOne();
          expect(
            (
              await f.admin.query(
                'SELECT * FROM margin_submissions.materialization_chunks WHERE submission_id=$1',
                [t.id],
              )
            ).rows,
          ).toHaveLength(2);
          const visible = await rows();
          expect(visible).toHaveLength(1);
          expect(visible[0].claim_id).not.toBe(claim.claimId);
          expect(await review.snapshot(t.teacherP, t.id)).toMatchObject({
            submission: { revision: 4, preparation: 'ready' },
            annotationCount: 0,
          });
        } finally {
          await sql.close();
        }
      } finally {
        processor.dispose(prepared.ticket);
        replay.dispose();
      }
    });
    it('denies a non-author teacher and another tenant, and binds the author to the exact resource', async () => {
      const t = await completed(0),
        other = await captured(0);
      await expect(review.snapshot(other.teacherP, t.id)).rejects.toMatchObject({
        code: 'review_unavailable',
      });
      await f.admin.query(
        "UPDATE margin_identity.memberships SET role='teacher' WHERE organization_id=$1 AND user_id=$2",
        [t.org, t.peer],
      );
      await f.admin.query(
        "UPDATE margin_lms.enrollments SET role='teacher' WHERE installation_id=$1 AND user_id=$2",
        [t.installation, t.peer],
      );
      await f.admin.query(
        "UPDATE margin_lms.session_bindings SET role='teacher' WHERE session_id=$1",
        [t.peerP.sessionId],
      );
      await expect(review.context({ ...t.peerP, role: 'teacher' })).rejects.toMatchObject({
        code: 'review_unavailable',
      });
      const resource = hash(randomUUID());
      await f.admin.query(
        'INSERT INTO margin_assignments.resource_links(installation_id,resource_digest,organization_id,course_id,assignment_id) VALUES($1,$2,$3,$4,$5)',
        [t.installation, resource, t.org, t.course, t.assignment.id],
      );
      await f.admin.query(
        'UPDATE margin_assignments.launch_bindings SET resource_digest=$2 WHERE session_id=$1',
        [t.teacherP.sessionId, resource],
      );
      expect(await review.list(t.teacherP, {})).toEqual({ submissions: [], nextCursor: null });
      await expect(review.snapshot(t.teacherP, t.id)).rejects.toMatchObject({
        code: 'review_unavailable',
      });
    });
    it.each([
      'session',
      'teacher',
      'student',
      'installation',
      'source',
      'target',
      'assignment',
    ] as const)(
      'rechecks current %s authority for a previously obtained snapshot pin',
      async (kind) => {
        const t = await completed(0),
          snapshot = await review.snapshot(t.teacherP, t.id);
        if (kind === 'session')
          await f.admin.query(
            'UPDATE margin_identity.sessions SET revoked_at=clock_timestamp() WHERE id=$1',
            [t.teacherP.sessionId],
          );
        if (kind === 'teacher' || kind === 'student')
          await f.admin.query(
            'UPDATE margin_lms.enrollments SET disabled_at=clock_timestamp() WHERE installation_id=$1 AND user_id=$2',
            [t.installation, kind === 'teacher' ? t.teacher : t.student],
          );
        if (kind === 'installation')
          await f.admin.query(
            'UPDATE margin_lms.installations SET enabled=false,version=version+1 WHERE id=$1',
            [t.installation],
          );
        if (kind === 'source')
          await f.admin.query(
            'UPDATE margin_ingestion.artifacts SET revoked_at=clock_timestamp() WHERE artifact_id=$1',
            [t.source.identity.artifactId],
          );
        if (kind === 'target')
          await f.admin.query(
            'UPDATE margin_sync.grants SET revoked_at=clock_timestamp() WHERE organization_id=$1 AND document_id=$2',
            [t.org, t.reservation.documentId],
          );
        if (kind === 'assignment')
          await f.admin.query(
            'UPDATE margin_assignments.assignments SET disabled_at=clock_timestamp() WHERE id=$1',
            [t.assignment.id],
          );
        await expect(
          review.source(t.teacherP, t.id, { snapshotPin: snapshot.snapshotPin }),
        ).rejects.toBeDefined();
        await expect(
          review.chunk(t.teacherP, t.id, 0, { snapshotPin: snapshot.snapshotPin }),
        ).rejects.toBeDefined();
      },
    );
    it.each(['capture', 'master', 'receipt', 'chunk', 'chunk-key'] as const)(
      'refuses corrupted %s data instead of returning unauthenticated content',
      async (kind) => {
        const t = await completed(),
          snapshot = await review.snapshot(t.teacherP, t.id);
        if (kind === 'capture')
          await f.admin.query(
            'UPDATE margin_submissions.requests SET ciphertext=set_byte(ciphertext,0,get_byte(ciphertext,0)#1) WHERE work_id=$1',
            [t.reservation.id],
          );
        if (kind === 'master')
          await f.admin.query(
            'UPDATE margin_assignments.assignments SET ciphertext=set_byte(ciphertext,0,get_byte(ciphertext,0)#1) WHERE id=$1',
            [t.assignment.id],
          );
        if (kind === 'receipt')
          await f.admin.query(
            'UPDATE margin_submissions.materialization_receipts SET ciphertext=set_byte(ciphertext,0,get_byte(ciphertext,0)#1) WHERE submission_id=$1',
            [t.id],
          );
        if (kind === 'chunk')
          await f.admin.query(
            'UPDATE margin_submissions.materialization_chunks SET ciphertext=set_byte(ciphertext,0,get_byte(ciphertext,0)#1) WHERE submission_id=$1',
            [t.id],
          );
        if (kind === 'chunk-key')
          await f.admin.query(
            "UPDATE margin_submissions.materialization_chunks SET wrapped_key='{}' WHERE submission_id=$1",
            [t.id],
          );
        await expect(
          review.chunk(t.teacherP, t.id, 0, { snapshotPin: snapshot.snapshotPin }),
        ).rejects.toMatchObject({ code: 'review_integrity' });
        await expect(review.snapshot(t.teacherP, t.id)).rejects.toMatchObject({
          code: 'review_integrity',
        });
      },
    );
    it('keeps key/source I/O outside review transactions and wipes content revoked during the object read', async () => {
      const t = await completed(0),
        snapshot = await review.snapshot(t.teacherP, t.id),
        unwrap = f.kms.unwrapKey.bind(f.kms),
        get = f.storage.get.bind(f.storage);
      let returned: Buffer | undefined;
      const noTransaction = async () =>
        expect(
          (
            await f.admin.query(
              "SELECT count(*) FROM pg_stat_activity WHERE usename='submission_reviewer' AND state IN ('active','idle in transaction')",
            )
          ).rows[0].count,
        ).toBe('0');
      vi.spyOn(f.kms, 'unwrapKey').mockImplementation(async (...args) => {
        await noTransaction();
        return unwrap(...args);
      });
      vi.spyOn(f.storage, 'get').mockImplementation(async (...args) => {
        await noTransaction();
        const content = await get(...args);
        returned = content.bytes;
        await f.admin.query(
          'UPDATE margin_lms.enrollments SET disabled_at=clock_timestamp() WHERE installation_id=$1 AND user_id=$2',
          [t.installation, t.student],
        );
        return content;
      });
      await expect(
        review.source(t.teacherP, t.id, { snapshotPin: snapshot.snapshotPin }),
      ).rejects.toBeDefined();
      expect(returned).toBeDefined();
      expect(returned!.every((v) => v === 0)).toBe(true);
    });
    it('holds provider admission after caller cancellation until raw object promises settle and wipes late bytes', async () => {
      const t = await completed(0),
        snapshot = await review.snapshot(t.teacherP, t.id);
      const pending: Array<{
        resolve: (v: {
          bytes: Buffer;
          metadata: { name: string; mimeType: 'application/pdf' };
        }) => void;
        bytes: Buffer;
      }> = [];
      let seen!: () => void;
      const slow = new PostgresAssignmentReviewService(
        f.config('submission_reviewer'),
        f.kms,
        f.reader,
        {
          get: () =>
            new Promise((resolve) => {
              pending.push({ resolve, bytes: Buffer.from(f.body) });
              seen();
            }),
        },
      );
      try {
        for (let i = 0; i < 2; i++) {
          const entered = new Promise<void>((resolve) => {
              seen = resolve;
            }),
            controller = new AbortController();
          const result = slow.source(
            t.teacherP,
            t.id,
            { snapshotPin: snapshot.snapshotPin },
            { signal: controller.signal },
          );
          await entered;
          controller.abort();
          await expect(result).rejects.toMatchObject({ code: 'review_cancelled' });
        }
        await expect(slow.snapshot(t.teacherP, t.id)).rejects.toMatchObject({
          code: 'review_busy',
        });
        expect(pending).toHaveLength(2);
        for (const value of pending)
          value.resolve({
            bytes: value.bytes,
            metadata: { name: 'Synthetic', mimeType: 'application/pdf' },
          });
        await tick();
        await tick();
        for (const value of pending) expect(value.bytes.every((v) => v === 0)).toBe(true);
        expect(await slow.snapshot(t.teacherP, t.id)).toMatchObject({ submission: { id: t.id } });
      } finally {
        for (const value of pending)
          value.resolve({
            bytes: value.bytes,
            metadata: { name: 'Synthetic', mimeType: 'application/pdf' },
          });
        await slow.close();
      }
    });
    it('paginates actual peer captures and rechecks every retained row before releasing a page', async () => {
      const t = await completed(0);
      await f.assignments.reserveStudentWork(t.peerP, t.enrollment(t.peerP));
      const claim = (await f.worker.claimNext())!;
      await f.worker.completePrepared(claim, await f.worker.prepare(claim, f.reader, f.storage));
      const capturedPeer = await capture.capture(t.peerP, {
        requestId: randomUUID(),
        expectedCursor: 0,
      });
      if (capturedPeer.request.state !== 'captured') throw Error();
      const peerId = capturedPeer.request.submission.id;
      await new SubmissionMaterializationWorker(processor, f.reader, f.storage).runOne();
      const order = [t.id, peerId].sort();
      expect((await review.list(t.teacherP, {})).submissions.map((s) => s.id)).toEqual(order);
      expect(
        (await review.list(t.teacherP, { after: order[0] })).submissions.map((s) => s.id),
      ).toEqual([order[1]]);
      expect(await review.list(t.teacherP, { after: order[1] })).toEqual({
        submissions: [],
        nextCursor: null,
      });
      const unwrap = f.kms.unwrapKey.bind(f.kms);
      let calls = 0;
      vi.spyOn(f.kms, 'unwrapKey').mockImplementation(async (...args) => {
        if (++calls === 5)
          await f.admin.query(
            'UPDATE margin_lms.enrollments SET disabled_at=clock_timestamp() WHERE installation_id=$1 AND user_id=$2',
            [t.installation, order[0] === t.id ? t.student : t.peer],
          );
        return unwrap(...args);
      });
      await expect(review.list(t.teacherP, {})).rejects.toMatchObject({
        code: 'review_unavailable',
      });
    });
    it('pins current authorization transactions to READ COMMITTED under a different connection default', async () => {
      const t = await captured(0);
      const sql = new ReviewPool({
        ...f.config('submission_reviewer'),
        options: '-c default_transaction_isolation=repeatable\\ read',
      });
      try {
        expect(
          await sql.transaction(
            t.teacherP,
            async (c) =>
              (await c.query("SELECT current_setting('transaction_isolation') AS isolation"))
                .rows[0].isolation,
          ),
        ).toBe('read committed');
      } finally {
        await sql.close();
      }
    });
  },
);
