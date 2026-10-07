import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { PostgresAssignmentSubmissionService } from '../apps/api/src/assignments/submissions';
import { submissionFixture as f } from './helpers/submission-fixture';
import { withTableOwnerMembership } from './helpers/owner-role';
import { withAssignmentRoleMembership } from './helpers/provisioner-role';
let service: PostgresAssignmentSubmissionService;
const request = (expectedCursor = 0) => ({ requestId: randomUUID(), expectedCursor });
async function blocked(user: string, query: string) {
  const until = Date.now() + 5000;
  while (Date.now() < until) {
    if (
      (
        await f.admin.query(
          "SELECT 1 FROM pg_stat_activity WHERE usename=$1 AND wait_event_type='Lock' AND query LIKE $2",
          [user, query],
        )
      ).rowCount
    )
      return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Expected bounded SQL lock wait was not observed');
}
async function answer(t: Awaited<ReturnType<typeof f.ready>>) {
  const m = await f.workApi.describe(t.studentP);
  if (m.work?.status !== 'provisioned') throw Error();
  return f.operation(t, m.work.document.pages[0].id);
}
describe.skipIf(!f.available)(
  'immutable submission capture on disposable PostgreSQL',
  { timeout: 20000 },
  () => {
    beforeAll(async () => {
      await f.boot();
      service = new PostgresAssignmentSubmissionService(f.config('submission_api'), f.kms, {
        captureEnabled: true,
      });
    }, 30000);
    afterEach(async () => {
      vi.restoreAllMocks();
      await f.admin.query(
        'UPDATE margin_identity.organizations SET disabled_at=clock_timestamp() WHERE disabled_at IS NULL',
      );
    });
    afterAll(async () => {
      const errors: unknown[] = [];
      try {
        await service?.close();
      } catch (error) {
        errors.push(error);
      }
      try {
        await f.stop();
      } catch (error) {
        errors.push(error);
      }
      if (errors.length) throw new AggregateError(errors, 'Submission fixture cleanup failed.');
    });
    it('requires explicit capture configuration for every operation', async () => {
      const t = await f.ready(),
        off = new PostgresAssignmentSubmissionService(f.config('submission_api'), f.kms);
      try {
        for (const action of [
          () => off.capture(t.studentP, request()),
          () => off.request(t.studentP, randomUUID()),
          () => off.list(t.studentP, {}),
        ])
          await expect(action()).rejects.toMatchObject({ code: 'submission_unconfigured' });
      } finally {
        await off.close();
      }
    });
    it('captures an encrypted processing-only prefix, atomically pins its source and outbox, and retries after draft advancement', async () => {
      const t = await f.ready(),
        op = await answer(t);
      await f.workApi.append(t.studentP, op);
      const r = request(1),
        one = await service.capture(t.studentP, r);
      expect(one).toMatchObject({
        duplicate: false,
        request: {
          ...r,
          state: 'captured',
          submission: {
            frozenCursor: 1,
            attempt: 1,
            phase: 'processing',
            confirmedAt: null,
            retryAllowed: false,
          },
        },
      });
      await f.workApi.append(t.studentP, {
        ...op,
        operationId: randomUUID(),
        baseRevision: 1,
        annotation: { ...op.annotation, text: 'Later draft' },
      });
      expect(await service.capture(t.studentP, r)).toEqual({ ...one, duplicate: true });
      expect(await service.request(t.studentP, r.requestId)).toEqual({ request: one.request });
      expect((await service.list(t.studentP, {})).submissions).toHaveLength(1);
      const rows = (
        await f.admin.query(
          'SELECT r.*,a.frozen_cursor,o.phase FROM margin_submissions.requests r JOIN margin_submissions.attempts a USING(work_id,request_id) JOIN margin_submissions.outbox o ON o.attempt_id=a.id WHERE r.work_id=$1',
          [t.reservation.id],
        )
      ).rows;
      expect(rows).toHaveLength(1);
      expect(rows[0].ciphertext.toString()).not.toContain('Private');
      expect(rows[0].frozen_cursor).toBe('1');
      await expect(service.capture(t.studentP, { ...r, expectedCursor: 2 })).rejects.toMatchObject({
        code: 'submission_request_conflict',
      });
    });
    it('durably fences cursor rejection even when later edits reach that cursor', async () => {
      const t = await f.ready(),
        r = request(1),
        first = await service.capture(t.studentP, r);
      expect(first.request).toEqual({ ...r, state: 'rejected', code: 'cursor_changed' });
      await f.workApi.append(t.studentP, await answer(t));
      expect(await service.capture(t.studentP, r)).toEqual({ ...first, duplicate: true });
      expect((await service.list(t.studentP, {})).submissions).toEqual([]);
      expect(await service.request(t.studentP, r.requestId)).toEqual({ request: first.request });
    });
    it('durably rejects a second attempt and serializes duplicate/new request races', async () => {
      const t = await f.ready(),
        r = request();
      const results = await Promise.all([
        service.capture(t.studentP, r),
        service.capture(t.studentP, r),
      ]);
      expect(results.map((v) => v.duplicate).sort()).toEqual([false, true]);
      expect(results[0].request).toEqual(results[1].request);
      const two = request();
      expect((await service.capture(t.studentP, two)).request).toEqual({
        ...two,
        state: 'rejected',
        code: 'attempt_exists',
      });
    });
    it('denies peers, teachers, OIDC identities, separate tenants and revoked sessions', async () => {
      const t = await f.ready(),
        other = await f.ready(),
        r = request();
      await service.capture(t.studentP, r);
      for (const p of [
        t.peerP,
        t.teacherP,
        { ...t.studentP, authenticationMethod: 'oidc' as const },
        other.studentP,
      ])
        await expect(service.request(p, r.requestId)).rejects.toBeDefined();
      await f.admin.query(
        'UPDATE margin_identity.sessions SET revoked_at=clock_timestamp() WHERE id=$1',
        [t.studentP.sessionId],
      );
      await expect(service.request(t.studentP, r.requestId)).rejects.toMatchObject({ status: 403 });
    });
    it('rejects corrupt encrypted receipts without releasing apparent success', async () => {
      const t = await f.ready(),
        r = request();
      await service.capture(t.studentP, r);
      await f.admin.query(
        "UPDATE margin_submissions.requests SET tag=decode(repeat('00',16),'hex') WHERE work_id=$1",
        [t.reservation.id],
      );
      await expect(service.request(t.studentP, r.requestId)).rejects.toMatchObject({
        code: 'submission_integrity',
      });
      await expect(service.list(t.studentP, {})).rejects.toMatchObject({
        code: 'submission_integrity',
      });
    });
    it('retains frozen operations/pages/keys and exact source receipts while permitting future append and source revocation', async () => {
      const t = await f.ready(),
        op = await answer(t);
      await f.workApi.append(t.studentP, op);
      await service.capture(t.studentP, request(1));
      for (const sql of [
        'DELETE FROM margin_sync.operations WHERE document_id=$1',
        'UPDATE margin_sync.operations SET tag=tag WHERE document_id=$1',
        'UPDATE margin_sync.pages SET width=width WHERE document_id=$1',
        'UPDATE margin_sync.document_keys SET wrapped_key=wrapped_key WHERE document_id=$1',
      ])
        await expect(f.admin.query(sql, [t.reservation.documentId])).rejects.toThrow('retention');
      await expect(
        f.admin.query('DELETE FROM margin_ingestion.storage_receipts WHERE artifact_id=$1', [
          t.source.identity.artifactId,
        ]),
      ).rejects.toThrow();
      await f.workApi.append(t.studentP, { ...op, operationId: randomUUID(), baseRevision: 1 });
      await f.admin.query(
        'UPDATE margin_ingestion.artifacts SET revoked_at=clock_timestamp() WHERE artifact_id=$1',
        [t.source.identity.artifactId],
      );
      await expect(service.list(t.studentP, {})).rejects.toBeDefined();
    });
    it('rolls back the ledger and retention pins if outbox creation fails', async () => {
      const t = await f.ready();
      await f.admin.query(
        "CREATE FUNCTION margin_submissions.fail_test() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic failure'; END $$; CREATE TRIGGER fail_test BEFORE INSERT ON margin_submissions.outbox FOR EACH ROW EXECUTE FUNCTION margin_submissions.fail_test()",
      );
      const r = request();
      try {
        await expect(service.capture(t.studentP, r)).rejects.toBeDefined();
        expect(
          (
            await f.admin.query(
              'SELECT count(*) FROM margin_submissions.requests WHERE work_id=$1',
              [t.reservation.id],
            )
          ).rows[0].count,
        ).toBe('0');
      } finally {
        await f.admin.query(
          'DROP TRIGGER fail_test ON margin_submissions.outbox; DROP FUNCTION margin_submissions.fail_test()',
        );
      }
      expect((await service.capture(t.studentP, r)).request.state).toBe('captured');
    });
    it('uses no key-provider operation inside a database transaction and withholds revoked access after a key wait', async () => {
      const t = await f.ready(),
        r = request();
      const original = f.kms.unwrapKey.bind(f.kms);
      let calls = 0;
      vi.spyOn(f.kms, 'unwrapKey').mockImplementation(async (...args) => {
        calls++;
        const active = (
          await f.admin.query(
            "SELECT count(*) FROM pg_stat_activity WHERE usename='submission_api' AND state='idle in transaction'",
          )
        ).rows[0].count;
        expect(active).toBe('0');
        if (calls === 3)
          await f.admin.query(
            'UPDATE margin_lms.enrollments SET disabled_at=clock_timestamp() WHERE user_id=$1',
            [t.student],
          );
        return original(...args);
      });
      await expect(service.capture(t.studentP, r)).rejects.toBeDefined();
      expect(
        (
          await f.admin.query('SELECT count(*) FROM margin_submissions.requests WHERE work_id=$1', [
            t.reservation.id,
          ])
        ).rows[0].count,
      ).toBe('0');
    });
    it('denies runtime annotation writes and mixed/table-owner credentials including SET ROLE-only membership', async () => {
      const t = await f.ready();
      const sql = new Pool(f.config('submission_api'));
      try {
        const c = await sql.connect();
        try {
          await c.query('BEGIN');
          for (const [name, value] of [
            ['organization_id', t.org],
            ['user_id', t.student],
            ['session_id', t.studentP.sessionId],
          ])
            await c.query('SELECT set_config($1,$2,true)', ['margin_work.' + name, value]);
          await expect(
            c.query('UPDATE margin_sync.documents SET cursor=cursor WHERE id=$1', [
              t.reservation.documentId,
            ]),
          ).rejects.toThrow();
        } finally {
          await c.query('ROLLBACK');
          c.release();
        }
        await expect(sql.query('DELETE FROM margin_submissions.requests')).rejects.toThrow();
      } finally {
        await sql.end();
      }
      for (const inherit of [true, false])
        await withTableOwnerMembership(
          f.admin,
          f.config('postgres'),
          'margin_submissions.requests',
          'margin_submission_runtime',
          inherit,
          async (config) => {
            const bad = new PostgresAssignmentSubmissionService(config, f.kms, {
              captureEnabled: true,
            });
            try {
              await expect(bad.list(t.studentP, {})).rejects.toThrow();
            } finally {
              await bad.close();
            }
          },
        );
    });
    it('bounds malformed input and cursor and does not create records', async () => {
      const t = await f.ready();
      for (const value of [
        { ...request(), studentId: randomUUID() },
        request(-1),
        request(100001),
        { requestId: 'oops', expectedCursor: 0 },
      ])
        await expect(service.capture(t.studentP, value)).rejects.toBeDefined();
      for (const after of ['bad', '=', Buffer.from('not-a-uuid').toString('base64url')])
        await expect(service.list(t.studentP, { after })).rejects.toMatchObject({ status: 400 });
    });
    it('rechecks revocation after waiting for an authority lock, before committing a capture', async () => {
      const t = await f.ready(),
        blocker = await f.admin.connect();
      try {
        await blocker.query('BEGIN');
        await blocker.query(
          'UPDATE margin_lms.enrollments SET disabled_at=clock_timestamp() WHERE user_id=$1',
          [t.student],
        );
        const promise = service.capture(t.studentP, request());
        const denied = expect(promise).rejects.toBeDefined();
        await blocked('submission_api', 'SELECT user_id FROM margin_lms.enrollments%');
        await blocker.query('COMMIT');
        await denied;
        expect(
          (
            await f.admin.query(
              'SELECT count(*) FROM margin_submissions.requests WHERE work_id=$1',
              [t.reservation.id],
            )
          ).rows[0].count,
        ).toBe('0');
      } finally {
        await blocker.query('ROLLBACK');
        blocker.release();
      }
    });
    it('serializes retained-prefix protection with capture, including an admin mutation already in flight', async () => {
      const t = await f.ready(),
        op = await answer(t);
      await f.workApi.append(t.studentP, op);
      const blocker = await f.admin.connect(),
        mutator = await f.admin.connect();
      await f.admin.query(
        'CREATE FUNCTION margin_submissions.pause_capture_test() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_advisory_xact_lock(55505001); RETURN NEW; END $$; CREATE TRIGGER pause_capture_test BEFORE INSERT ON margin_submissions.requests FOR EACH ROW EXECUTE FUNCTION margin_submissions.pause_capture_test()',
      );
      try {
        await blocker.query('BEGIN');
        await blocker.query('SELECT pg_advisory_xact_lock(55505001)');
        const capture = service.capture(t.studentP, request(1));
        await blocked('submission_api', 'INSERT INTO margin_submissions.requests%');
        const mutation = mutator.query(
          'UPDATE margin_sync.operations SET tag=tag WHERE document_id=$1',
          [t.reservation.documentId],
        );
        const retained = expect(mutation).rejects.toThrow('retention');
        await blocked('postgres', 'UPDATE margin_sync.operations%');
        await blocker.query('COMMIT');
        expect((await capture).request.state).toBe('captured');
        await retained;
      } finally {
        await blocker.query('ROLLBACK');
        blocker.release();
        mutator.release();
        await f.admin.query(
          'DROP TRIGGER pause_capture_test ON margin_submissions.requests; DROP FUNCTION margin_submissions.pause_capture_test()',
        );
      }
    });
    it('refuses new page geometry and insertion into holes in a frozen operation prefix', async () => {
      const t = await f.ready(),
        op = await answer(t);
      await f.workApi.append(t.studentP, op);
      await f.admin.query('DELETE FROM margin_sync.outbox WHERE document_id=$1', [
        t.reservation.documentId,
      ]);
      // A corrupt historical prefix is pinned for processing to reject; it is never marked delivered.
      const prior = (
        await f.admin.query('DELETE FROM margin_sync.operations WHERE document_id=$1 RETURNING *', [
          t.reservation.documentId,
        ])
      ).rows[0];
      await service.capture(t.studentP, request(1));
      await expect(
        f.admin.query(
          'INSERT INTO margin_sync.pages(organization_id,document_id,version_id,id,page_index,width,height) VALUES($1,$2,$3,$4,2,100,100)',
          [t.org, t.reservation.documentId, t.reservation.versionId, randomUUID()],
        ),
      ).rejects.toThrow('retention');
      const columns = Object.keys(prior);
      await expect(
        f.admin.query(
          `INSERT INTO margin_sync.operations(${columns.join(',')}) VALUES(${columns.map((_, i) => '$' + (i + 1)).join(',')})`,
          Object.values(prior),
        ),
      ).rejects.toThrow('retention');
    });
    it('aborts capture during provider work without a late ledger write', async () => {
      const t = await f.ready(),
        controller = new AbortController(),
        original = f.kms.wrapKey.bind(f.kms);
      vi.spyOn(f.kms, 'wrapKey').mockImplementation(async (...args) => {
        controller.abort();
        return original(...args);
      });
      await expect(
        service.capture(t.studentP, request(), { signal: controller.signal }),
      ).rejects.toBeDefined();
      // Wait for the bounded underlying call, not merely the abort-race result.
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(
        (
          await f.admin.query('SELECT count(*) FROM margin_submissions.requests WHERE work_id=$1', [
            t.reservation.id,
          ])
        ).rows[0].count,
      ).toBe('0');
    });
    it('refuses a compaction transaction whose old REPEATABLE READ snapshot cannot see the newly committed pin', async () => {
      const t = await f.ready(),
        op = await answer(t);
      await f.workApi.append(t.studentP, op);
      const compactor = await f.admin.connect();
      try {
        await compactor.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
        expect(
          (
            await compactor.query(
              'SELECT count(*) FROM margin_submissions.attempts WHERE work_id=$1',
              [t.reservation.id],
            )
          ).rows[0].count,
        ).toBe('0');
        await service.capture(t.studentP, request(1));
        expect(
          (
            await compactor.query(
              'SELECT count(*) FROM margin_submissions.attempts WHERE work_id=$1',
              [t.reservation.id],
            )
          ).rows[0].count,
        ).toBe('0');
        await expect(
          compactor.query('UPDATE margin_sync.operations SET tag=tag WHERE document_id=$1', [
            t.reservation.documentId,
          ]),
        ).rejects.toThrow('READ COMMITTED');
      } finally {
        await compactor.query('ROLLBACK');
        compactor.release();
      }
    });
    it('recovers under a fresh matching launch after the originating session is retired', async () => {
      const t = await f.ready(),
        r = request(),
        captured = await service.capture(t.studentP, r),
        newSession = randomUUID();
      const c = await f.admin.connect();
      let discard = false;
      try {
        await c.query('BEGIN');
        await c.query(
          'INSERT INTO margin_identity.sessions(id,session_hash,user_id,organization_id,mfa,authentication_method,created_at,expires_at,idle_expires_at,last_seen_at) SELECT $2,$3,user_id,organization_id,mfa,authentication_method,created_at,expires_at,idle_expires_at,last_seen_at FROM margin_identity.sessions WHERE id=$1',
          [t.studentP.sessionId, newSession, createHash('sha256').update(newSession).digest('hex')],
        );
        await c.query(
          'INSERT INTO margin_lms.session_bindings(session_id,installation_id,registration_version,organization_id,user_id,course_id,subject_digest,course_digest,role) SELECT $2,installation_id,registration_version,organization_id,user_id,course_id,subject_digest,course_digest,role FROM margin_lms.session_bindings WHERE session_id=$1',
          [t.studentP.sessionId, newSession],
        );
        await c.query(
          'INSERT INTO margin_assignments.launch_bindings(session_id,installation_id,resource_digest,assignment_id,user_id) SELECT $2,installation_id,resource_digest,assignment_id,user_id FROM margin_assignments.launch_bindings WHERE session_id=$1',
          [t.studentP.sessionId, newSession],
        );
        await c.query('DELETE FROM margin_assignments.launch_bindings WHERE session_id=$1', [
          t.studentP.sessionId,
        ]);
        await c.query('DELETE FROM margin_lms.session_bindings WHERE session_id=$1', [
          t.studentP.sessionId,
        ]);
        await c.query('DELETE FROM margin_identity.sessions WHERE id=$1', [t.studentP.sessionId]);
        await c.query('COMMIT');
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
      expect(await service.request({ ...t.studentP, sessionId: newSession }, r.requestId)).toEqual({
        request: captured.request,
      });
      await expect(service.request(t.studentP, r.requestId)).rejects.toBeDefined();
    });
    for (const role of [
      'margin_assignment_work_runtime',
      'margin_assignment_provisioner',
      'margin_submission_retention_guard',
    ] as const)
      for (const inherit of [true, false])
        it(`rejects submission runtime combined with ${role}, inherited=${inherit}`, async () => {
          const t = await f.ready();
          await withAssignmentRoleMembership(
            f.admin,
            f.config('postgres'),
            'margin_submission_runtime',
            role,
            inherit,
            async (config) => {
              const bad = new PostgresAssignmentSubmissionService(config, f.kms, {
                captureEnabled: true,
              });
              try {
                await expect(bad.list(t.studentP, {})).rejects.toMatchObject({
                  code: 'submission_unavailable',
                });
              } finally {
                await bad.close();
              }
            },
          );
        });
  },
);
