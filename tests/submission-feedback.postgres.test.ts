import { beforeAll, afterAll, afterEach, describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { submissionFixture as f } from './helpers/submission-fixture';
import { PostgresAssignmentSubmissionService } from '../apps/api/src/assignments/submissions/service';
import { PostgresSubmissionProcessor } from '../apps/api/src/assignments/submissions/processing/postgres';
import { SubmissionMaterializationWorker } from '../apps/api/src/assignments/submissions/processing/worker';
import { PostgresAssignmentFeedbackService } from '../apps/api/src/assignments/feedback/service';
import { FeedbackPool } from '../apps/api/src/assignments/feedback/pool';
import type { FeedbackContent } from '../apps/api/src/assignments/feedback/types';
let capture: PostgresAssignmentSubmissionService,
  processor: PostgresSubmissionProcessor,
  feedback: PostgresAssignmentFeedbackService;
let preexisting: Awaited<ReturnType<typeof ready>>, preexistingRows: unknown;
const hash = (v: string) => createHash('sha256').update(v).digest('hex');
async function ready(materialize = true) {
  const t = await f.ready();
  await f.admin.query(
    'INSERT INTO margin_assignments.launch_bindings(session_id,installation_id,resource_digest,assignment_id,user_id) VALUES($1,$2,$3,$4,$5)',
    [t.teacherP.sessionId, t.installation, hash(t.assignment.id), t.assignment.id, t.teacher],
  );
  const d = await f.workApi.describe(t.studentP);
  if (d.work?.status !== 'provisioned') throw Error('missing work');
  await f.workApi.append(t.studentP, f.operation(t, d.work.document.pages[0].id));
  const result = await capture.capture(t.studentP, { requestId: randomUUID(), expectedCursor: 1 });
  if (result.request.state !== 'captured') throw Error('missing capture');
  const id = result.request.submission.id;
  if (materialize)
    expect(
      (await new SubmissionMaterializationWorker(processor, f.reader, f.storage).runOne())
        ?.submissionId,
    ).toBe(id);
  return { ...t, id, pages: d.work.document.pages };
}
const content = (comment = 'Explain the evidence in the final sentence.'): FeedbackContent => ({
  comment,
  annotations: [
    {
      id: randomUUID(),
      pageIndex: 0,
      type: 'comment',
      x: 25,
      y: 40,
      width: 150,
      height: 50,
      text: 'What makes this convincing?',
      color: '#7367c8',
      strokeWidth: 2,
      opacity: 1,
      createdAt: Date.now(),
      author: 'Teacher',
    },
    {
      id: randomUUID(),
      pageIndex: 1,
      type: 'stamp',
      x: 25,
      y: 40,
      width: 140,
      height: 35,
      text: 'Thoughtful work',
      color: '#24785c',
      strokeWidth: 2,
      opacity: 1,
      createdAt: Date.now(),
      author: 'Teacher',
    },
  ],
});
async function save(t: Awaited<ReturnType<typeof ready>>, body = content(), revision = 0) {
  const state = await feedback.teacher(t.teacherP, t.id);
  const input = {
    requestId: randomUUID(),
    snapshotPin: state.capture.snapshotPin,
    expectedRevision: revision,
    content: body,
  };
  const outcome = await feedback.save(t.teacherP, t.id, input);
  return { state, input, outcome };
}
describe.skipIf(!f.available)(
  'private drafts and explicitly returned teacher feedback with real PostgreSQL',
  { timeout: 30000 },
  () => {
    beforeAll(async () => {
      await f.boot({ review: true });
      await f.admin.query(
        readFileSync(
          new URL('../infra/migrations/013-teacher-source-intake.sql', import.meta.url),
          'utf8',
        ),
      );
      capture = new PostgresAssignmentSubmissionService(f.config('submission_api'), f.kms, {
        captureEnabled: true,
      });
      processor = new PostgresSubmissionProcessor(f.config('submission_processor'), f.kms);
      preexisting = await ready();
      preexistingRows = (
        await f.admin.query(
          'SELECT row_to_json(a) AS attempt,row_to_json(r) AS receipt FROM margin_submissions.attempts a JOIN margin_submissions.materialization_receipts r ON r.submission_id=a.id WHERE a.id=$1',
          [preexisting.id],
        )
      ).rows;
      await f.admin.query(
        readFileSync(
          new URL('../infra/migrations/014-submission-feedback.sql', import.meta.url),
          'utf8',
        ),
      );
      await f.admin.query(
        'CREATE ROLE margin_canvas_feedback LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS; GRANT margin_feedback_runtime TO margin_canvas_feedback',
      );
      feedback = new PostgresAssignmentFeedbackService(
        f.config('margin_canvas_feedback'),
        f.kms,
        f.reader,
      );
    }, 30000);
    afterEach(async () => {
      vi.restoreAllMocks();
      await f.admin.query(
        'UPDATE margin_identity.organizations SET disabled_at=clock_timestamp() WHERE disabled_at IS NULL',
      );
    });
    afterAll(async () => {
      await Promise.allSettled([feedback?.close(), capture?.close(), processor?.close()]);
      await f.stop();
    }, 30000);
    it('authenticates a preexisting v1 capture after migration using the real local login prefix', async () => {
      expect(
        (await feedback.teacher(preexisting.teacherP, preexisting.id)).capture.frozenCursor,
      ).toBe(1);
      expect(
        (
          await f.admin.query(
            'SELECT row_to_json(a) AS attempt,row_to_json(r) AS receipt FROM margin_submissions.attempts a JOIN margin_submissions.materialization_receipts r ON r.submission_id=a.id WHERE a.id=$1',
            [preexisting.id],
          )
        ).rows,
      ).toEqual(preexistingRows);
    });
    it('saves private feedback, returns exact revision, and keeps later draft edits private', async () => {
      const t = await ready(),
        first = await save(t);
      expect(first.outcome).toMatchObject({
        state: 'accepted',
        revision: 1,
        action: 'save',
        releasedAt: null,
      });
      expect((await feedback.student(t.studentP, t.id)).released).toBeNull();
      expect((await feedback.teacher(t.teacherP, t.id)).content).toEqual(first.input.content);
      const request = {
        requestId: randomUUID(),
        snapshotPin: first.state.capture.snapshotPin,
        expectedRevision: 1,
      };
      const released = await feedback.release(t.teacherP, t.id, request);
      expect(released).toMatchObject({ state: 'accepted', revision: 1, action: 'release' });
      expect(released.releasedAt).not.toBeNull();
      const visible = await feedback.student(t.studentP, t.id);
      expect(visible.released).toEqual({
        revision: 1,
        releasedAt: released.releasedAt,
        content: first.input.content,
      });
      const second = await save(t, content('Private revision, not yet returned.'), 1);
      expect(second.outcome.revision).toBe(2);
      expect((await feedback.student(t.studentP, t.id)).released).toEqual(visible.released);
      expect((await feedback.teacher(t.teacherP, t.id)).released).toEqual(visible.released);
      await feedback.release(t.teacherP, t.id, {
        ...request,
        requestId: randomUUID(),
        expectedRevision: 2,
      });
      expect((await feedback.student(t.studentP, t.id)).released?.content).toEqual(
        second.input.content,
      );
    });
    it('recovers lost save/return acknowledgements through exact commands without new revisions', async () => {
      const t = await ready(),
        s = await save(t);
      expect(await feedback.command(t.teacherP, t.id, s.input.requestId)).toEqual(s.outcome);
      expect(await feedback.save(t.teacherP, t.id, s.input)).toEqual(s.outcome);
      const input = {
        requestId: randomUUID(),
        snapshotPin: s.state.capture.snapshotPin,
        expectedRevision: 1,
      };
      const r = await feedback.release(t.teacherP, t.id, input);
      expect(await feedback.command(t.teacherP, t.id, input.requestId)).toEqual(r);
      expect(await feedback.release(t.teacherP, t.id, input)).toEqual(r);
      expect(
        (await feedback.release(t.teacherP, t.id, { ...input, requestId: randomUUID() }))
          .releasedAt,
      ).toBe(r.releasedAt);
      await expect(
        feedback.save(t.teacherP, t.id, { ...s.input, content: content('different') }),
      ).rejects.toMatchObject({ code: 'feedback_request_conflict' });
      expect(
        (
          await f.admin.query(
            'SELECT revision FROM margin_feedback.drafts WHERE submission_id=$1',
            [t.id],
          )
        ).rows,
      ).toEqual([{ revision: 1 }]);
      expect(
        (
          await f.admin.query(
            'SELECT count(*)::int AS n FROM margin_feedback.releases WHERE submission_id=$1',
            [t.id],
          )
        ).rows[0].n,
      ).toBe(1);
    });
    it('serializes concurrent writers, preserving accepted and rejected exact outcomes', async () => {
      const t = await ready(),
        s = await feedback.teacher(t.teacherP, t.id);
      const a = {
        requestId: randomUUID(),
        snapshotPin: s.capture.snapshotPin,
        expectedRevision: 0,
        content: content('First tab'),
      };
      const b = { ...a, requestId: randomUUID(), content: content('Second tab') };
      const outcomes = await Promise.all([
        feedback.save(t.teacherP, t.id, a),
        feedback.save(t.teacherP, t.id, b),
      ]);
      expect(outcomes.map((o) => o.state).sort()).toEqual(['accepted', 'rejected']);
      const rejected = outcomes.find((o) => o.state === 'rejected')!;
      expect(rejected).toMatchObject({ revision: 1, code: 'revision_changed' });
      expect(await feedback.command(t.teacherP, t.id, rejected.requestId)).toEqual(rejected);
      expect(
        await feedback.save(t.teacherP, t.id, rejected.requestId === a.requestId ? a : b),
      ).toEqual(rejected);
    });
    it('does not poison a future command and refuses returning an unsaved draft', async () => {
      const t = await ready(),
        s = await feedback.teacher(t.teacherP, t.id),
        requestId = randomUUID();
      await expect(
        feedback.save(t.teacherP, t.id, {
          requestId,
          snapshotPin: s.capture.snapshotPin,
          expectedRevision: 1,
          content: content(),
        }),
      ).rejects.toMatchObject({ code: 'feedback_revision_future' });
      await expect(feedback.command(t.teacherP, t.id, requestId)).rejects.toMatchObject({
        code: 'feedback_command_not_found',
      });
      expect(
        await feedback.release(t.teacherP, t.id, {
          requestId,
          snapshotPin: s.capture.snapshotPin,
          expectedRevision: 0,
        }),
      ).toMatchObject({ state: 'rejected', code: 'draft_required', revision: 0 });
    });
    it('preserves v1 capture bytes and later student edits while pinning returned feedback to the capture', async () => {
      const t = await ready();
      const captured = async () =>
        (
          await f.admin.query(
            'SELECT row_to_json(a) AS attempt,row_to_json(q) AS request,row_to_json(r) AS receipt FROM margin_submissions.attempts a JOIN margin_submissions.requests q ON q.work_id=a.work_id AND q.request_id=a.request_id JOIN margin_submissions.materialization_receipts r ON r.submission_id=a.id WHERE a.id=$1',
            [t.id],
          )
        ).rows;
      const before = await captured();
      const saved = await save(t);
      const op = f.operation(t, t.pages[0].id);
      op.annotation.text = 'A later student draft answer';
      await f.workApi.append(t.studentP, op);
      await feedback.release(t.teacherP, t.id, {
        requestId: randomUUID(),
        snapshotPin: saved.state.capture.snapshotPin,
        expectedRevision: 1,
      });
      expect(await captured()).toEqual(before);
      const received = await feedback.student(t.studentP, t.id);
      expect(received.capture.frozenCursor).toBe(1);
      expect(received.capture.snapshotPin).toBe(saved.state.capture.snapshotPin);
      expect(JSON.stringify(received)).not.toContain('later student draft');
      const d = await f.workApi.describe(t.studentP);
      expect(d.work?.status === 'provisioned' && d.work.document.cursor).toBe(2);
    });
    it('rejects peer student, another teacher/organization, local roles and mismatched snapshot pins', async () => {
      const t = await ready(),
        other = await ready(),
        s = await save(t);
      await expect(feedback.student(t.peerP, t.id)).rejects.toBeInstanceOf(Error);
      await expect(feedback.teacher(other.teacherP, t.id)).rejects.toBeInstanceOf(Error);
      // A real same-course teacher membership and resource launch still cannot replace
      // the assignment author's grant; this is stronger than a client-only role toggle.
      await f.admin.query(
        "UPDATE margin_identity.memberships SET role='teacher' WHERE user_id=$1",
        [t.peer],
      );
      await f.admin.query("UPDATE margin_lms.enrollments SET role='teacher' WHERE user_id=$1", [
        t.peer,
      ]);
      await f.admin.query(
        "UPDATE margin_lms.session_bindings SET role='teacher' WHERE user_id=$1",
        [t.peer],
      );
      await expect(feedback.teacher({ ...t.peerP, role: 'teacher' }, t.id)).rejects.toBeInstanceOf(
        Error,
      );
      await expect(
        feedback.teacher({ ...t.studentP, role: 'teacher' }, t.id),
      ).rejects.toBeInstanceOf(Error);
      await expect(
        feedback.student({ ...t.teacherP, role: 'student' }, t.id),
      ).rejects.toBeInstanceOf(Error);
      await expect(
        feedback.teacher({ ...t.teacherP, authenticationMethod: 'oidc' }, t.id),
      ).rejects.toBeInstanceOf(Error);
      await expect(
        feedback.release(t.teacherP, t.id, {
          requestId: randomUUID(),
          snapshotPin: '0'.repeat(64),
          expectedRevision: 1,
        }),
      ).rejects.toMatchObject({ code: 'feedback_snapshot_changed' });
      expect((await feedback.teacher(t.teacherP, t.id)).revision).toBe(s.outcome.revision);
    });
    it.each(['student', 'teacher', 'installation', 'source', 'session'])(
      'revokes %s authority before reading or returning feedback',
      async (kind) => {
        const t = await ready(),
          s = await save(t);
        if (kind === 'student' || kind === 'teacher')
          await f.admin.query(
            'UPDATE margin_lms.enrollments SET disabled_at=clock_timestamp() WHERE user_id=$1',
            [kind === 'student' ? t.student : t.teacher],
          );
        if (kind === 'installation')
          await f.admin.query(
            'UPDATE margin_lms.installations SET enabled=false,version=version+1 WHERE id=$1',
            [t.installation],
          );
        if (kind === 'source')
          await f.admin.query(
            'UPDATE margin_sync.grants SET revoked_at=clock_timestamp() WHERE document_id=$1',
            [t.documentId],
          );
        if (kind === 'session')
          await f.admin.query(
            'UPDATE margin_identity.sessions SET revoked_at=clock_timestamp() WHERE id=$1',
            [t.teacherP.sessionId],
          );
        await expect(
          feedback.release(t.teacherP, t.id, {
            requestId: randomUUID(),
            snapshotPin: s.state.capture.snapshotPin,
            expectedRevision: 1,
          }),
        ).rejects.toBeInstanceOf(Error);
        if (kind !== 'session')
          await expect(feedback.student(t.studentP, t.id)).rejects.toBeInstanceOf(Error);
        expect(
          (
            await f.admin.query(
              'SELECT count(*)::int AS n FROM margin_feedback.releases WHERE submission_id=$1',
              [t.id],
            )
          ).rows[0].n,
        ).toBe(0);
      },
    );
    it('checks revocation again after key-provider work and before any mutation', async () => {
      const t = await ready(),
        state = await feedback.teacher(t.teacherP, t.id);
      const unwrap = f.kms.unwrapKey.bind(f.kms);
      let revoked = false;
      vi.spyOn(f.kms, 'unwrapKey').mockImplementation(async (...args) => {
        const result = await unwrap(...args);
        if (!revoked && args[1].includes('margin-feedback-v1')) {
          revoked = true;
          await f.admin.query(
            'UPDATE margin_lms.enrollments SET disabled_at=clock_timestamp() WHERE user_id=$1',
            [t.teacher],
          );
        }
        return result;
      });
      await expect(
        feedback.save(t.teacherP, t.id, {
          requestId: randomUUID(),
          snapshotPin: state.capture.snapshotPin,
          expectedRevision: 0,
          content: content(),
        }),
      ).rejects.toBeInstanceOf(Error);
      expect(revoked).toBe(true);
      expect(
        (
          await f.admin.query(
            'SELECT count(*)::int AS n FROM margin_feedback.drafts WHERE submission_id=$1',
            [t.id],
          )
        ).rows[0].n,
      ).toBe(0);
    });
    it.each(['drafts', 'releases', 'commands'])('rejects tampered encrypted %s', async (table) => {
      const t = await ready(),
        s = await save(t);
      await feedback.release(t.teacherP, t.id, {
        requestId: randomUUID(),
        snapshotPin: s.state.capture.snapshotPin,
        expectedRevision: 1,
      });
      // Owner mutation is an explicit corruption fixture, never an application capability.
      if (table === 'drafts')
        await f.admin.query(
          'ALTER TABLE margin_feedback.drafts DISABLE TRIGGER protect_feedback_draft',
        );
      try {
        await f.admin.query(
          `UPDATE margin_feedback.${table} SET ciphertext=set_byte(ciphertext,0,get_byte(ciphertext,0)#1) WHERE submission_id=$1`,
          [t.id],
        );
      } finally {
        if (table === 'drafts')
          await f.admin.query(
            'ALTER TABLE margin_feedback.drafts ENABLE TRIGGER protect_feedback_draft',
          );
      }
      const request =
        table === 'commands'
          ? feedback.command(t.teacherP, t.id, s.input.requestId)
          : table === 'releases'
            ? feedback.student(t.studentP, t.id)
            : feedback.teacher(t.teacherP, t.id);
      await expect(request).rejects.toMatchObject({ code: 'feedback_integrity' });
      if (table === 'drafts') {
        await expect(
          feedback.save(t.teacherP, t.id, {
            ...s.input,
            requestId: randomUUID(),
            expectedRevision: 1,
            content: content('Do not overwrite corrupted evidence.'),
          }),
        ).rejects.toMatchObject({ code: 'feedback_integrity' });
        expect(
          (
            await f.admin.query(
              'SELECT revision FROM margin_feedback.drafts WHERE submission_id=$1',
              [t.id],
            )
          ).rows,
        ).toEqual([{ revision: 1 }]);
      }
    });
    it('refuses feedback when the retained student materialization chunk seal has changed', async () => {
      const t = await ready(),
        s = await save(t);
      await f.admin.query(
        'UPDATE margin_submissions.materialization_chunks SET tag=set_byte(tag,0,get_byte(tag,0)#1) WHERE submission_id=$1',
        [t.id],
      );
      await expect(
        feedback.release(t.teacherP, t.id, {
          requestId: randomUUID(),
          snapshotPin: s.state.capture.snapshotPin,
          expectedRevision: 1,
        }),
      ).rejects.toMatchObject({ code: 'feedback_integrity' });
      expect(
        (
          await f.admin.query(
            'SELECT count(*)::int AS n FROM margin_feedback.releases WHERE submission_id=$1',
            [t.id],
          )
        ).rows[0].n,
      ).toBe(0);
    });
    it('encrypts content and command digests and refuses unprepared captures', async () => {
      const t = await ready(),
        s = await save(t, content('Secret feedback phrase'));
      const rows = (
        await f.admin.query(
          'SELECT row_to_json(d)::text AS text FROM margin_feedback.drafts d WHERE submission_id=$1 UNION ALL SELECT row_to_json(c)::text FROM margin_feedback.commands c WHERE submission_id=$1',
          [t.id],
        )
      ).rows;
      expect(
        rows.every(
          (r) => !r.text.includes('Secret feedback phrase') && !r.text.includes('What makes this'),
        ),
      ).toBe(true);
      const pending = await ready(false);
      await expect(feedback.teacher(pending.teacherP, pending.id)).rejects.toMatchObject({
        code: 'feedback_not_ready',
      });
      await expect(
        feedback.save(t.teacherP, t.id, {
          ...s.input,
          requestId: randomUUID(),
          expectedRevision: 1,
          content: { comment: '', annotations: [{ ...s.input.content.annotations[0], x: 9999 }] },
        }),
      ).rejects.toMatchObject({ code: 'invalid_feedback' });
    });
    it('keeps dedicated SQL credentials read-only outside feedback and student drafts invisible', async () => {
      const t = await ready(),
        s = await save(t);
      await feedback.release(t.teacherP, t.id, {
        requestId: randomUUID(),
        snapshotPin: s.state.capture.snapshotPin,
        expectedRevision: 1,
      });
      const pool = new FeedbackPool(f.config('margin_canvas_feedback'));
      try {
        await pool.transaction(t.studentP, async (c) => {
          for (const ns of ['margin_feedback', 'margin_review'])
            await c.query('SELECT set_config($1,$2,true)', [ns + '.submission_id', t.id]);
          await c.query("SELECT set_config('margin_work.source_owner_id',$1,true)", [t.teacher]);
          expect((await c.query('SELECT * FROM margin_feedback.drafts')).rowCount).toBe(0);
          expect((await c.query('SELECT * FROM margin_feedback.commands')).rowCount).toBe(0);
          expect((await c.query('SELECT * FROM margin_feedback.releases')).rowCount).toBe(1);
        });
        for (const query of [
          'UPDATE margin_submissions.attempts SET id=id',
          'UPDATE margin_feedback.releases SET ciphertext=ciphertext',
          'UPDATE margin_feedback.commands SET ciphertext=ciphertext',
          'SELECT * FROM margin_sync.operations',
        ])
          await expect(
            pool.transaction(t.teacherP, async (c) => {
              for (const ns of ['margin_feedback', 'margin_review'])
                await c.query('SELECT set_config($1,$2,true)', [ns + '.submission_id', t.id]);
              await c.query(query);
            }),
          ).rejects.toBeInstanceOf(Error);
      } finally {
        await pool.close();
      }
      const sql = new Pool(f.config('margin_canvas_feedback'));
      try {
        expect(
          (
            await sql.query(
              "SELECT has_column_privilege(current_user,'margin_submissions.outbox','token_digest','SELECT') AS unsafe",
            )
          ).rows[0].unsafe,
        ).toBe(false);
      } finally {
        await sql.end();
      }
    });
  },
);
