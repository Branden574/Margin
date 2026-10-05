import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Pool, type PoolClient } from 'pg';
import { stopDisposablePostgres } from './helpers/postgres';
import { withTableOwnerMembership } from './helpers/owner-role';
import {
  withAssignmentProvisionerMembership,
  withAssignmentWorkRuntimeMembership,
} from './helpers/provisioner-role';
import { LocalKeyProvider } from '../apps/api/src/encryption';
import { PostgresIngestionRepository, type ArtifactReader } from '../apps/api/src/ingestion';
import { PostgresAssignmentRepository } from '../apps/api/src/assignments';
import { PostgresIdentityRepository } from '../apps/api/src/identity/postgres';
import { PostgresLmsRepository } from '../apps/api/src/lms/postgres';
import { SyncPool } from '../apps/api/src/sync/pool';
import {
  PostgresStudentWorkProvisioner,
  StudentWorkProvisioningWorker,
} from '../apps/api/src/assignments/provisioning';
import type { SessionPrincipal } from '../apps/api/src/identity/types';
import type { VerifiedLmsEnrollment } from '../apps/api/src/lms/types';
import type { ArtifactReceipt } from '../apps/api/src/cloud/types';
import { decrypt, unwrapKey } from '../apps/api/src/sync/encryption';
import { canonical } from '../apps/api/src/sync/validation';
const available = ['initdb', 'pg_ctl'].every((t) => {
  try {
    execFileSync(t, ['--version'], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
});
if (process.env.MARGIN_REQUIRE_POSTGRES_TESTS === '1' && !available)
  throw new Error('Required work PostgreSQL binaries unavailable.');
const hash = (v: string | Buffer) => createHash('sha256').update(v).digest('hex');
const kms = new LocalKeyProvider(randomBytes(32), 'synthetic-work-test');
const body = Buffer.from('%PDF synthetic authenticated source fixture, not a real scanner result');
const metadata = { name: 'Private synthetic worksheet.pdf', mimeType: 'application/pdf' as const };
let dir: string,
  socket: string,
  started = false,
  admin: Pool,
  sqlRuntime: Pool,
  sqlWorker: Pool,
  sqlSync: Pool;
let runtime: PostgresIngestionRepository,
  inspector: PostgresIngestionRepository,
  reader: PostgresIngestionRepository,
  assignments: PostgresAssignmentRepository,
  worker: PostgresStudentWorkProvisioner;
const config = (user: string) => ({ host: socket, port: 55496, user, database: 'postgres' });
const objects = new Map<string, ArtifactReceipt>();
const storage: ArtifactReader = {
  async get(identity, receipt) {
    if (canonical(objects.get(identity.artifactId)) !== canonical(receipt))
      throw new Error('Exact synthetic object unavailable');
    return { bytes: Buffer.from(body), metadata };
  },
};
/** Only static fixture seeds share a commit; runtime operations retain their real transactions. */
async function seedTransaction(run: (client: PoolClient) => Promise<void>) {
  const client = await admin.connect();
  try {
    await client.query('BEGIN');
    await run(client);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
async function rejectsMixedRole<T extends { close(): Promise<unknown> }>(
  pool: T,
  run: (pool: T) => Promise<unknown>,
  message: string,
) {
  try {
    await expect(run(pool)).rejects.toThrow(message);
  } finally {
    await pool.close();
  }
}
async function fixture(geometry = true) {
  const org = randomUUID(),
    teacher = randomUUID(),
    student = randomUUID(),
    peer = randomUUID(),
    installation = randomUUID(),
    course = randomUUID(),
    documentId = randomUUID(),
    versionId = randomUUID();
  const principals: SessionPrincipal[] = [];
  await seedTransaction(async (c) => {
    await c.query('INSERT INTO margin_identity.organizations(id) VALUES($1)', [org]);
    await c.query(
      "INSERT INTO margin_lms.installations(id,organization_id,issuer,client_id,deployment_id,version,enabled,configuration) VALUES($1,$2,'https://synthetic.canvas.test',$3,$3,1,true,'{}')",
      [installation, org, randomUUID()],
    );
    await c.query(
      'INSERT INTO margin_lms.courses(installation_id,organization_id,external_digest,course_id) VALUES($1,$2,$3,$4)',
      [installation, org, hash(course), course],
    );
    for (const [user, role] of [
      [teacher, 'teacher'],
      [student, 'student'],
      [peer, 'student'],
    ] as const) {
      await c.query('INSERT INTO margin_identity.users(id,identity_key) VALUES($1,$2)', [
        user,
        hash(user),
      ]);
      await c.query(
        'INSERT INTO margin_identity.memberships(organization_id,user_id,role) VALUES($1,$2,$3)',
        [org, user, role],
      );
      await c.query(
        'INSERT INTO margin_lms.user_links(installation_id,organization_id,subject_digest,user_id) VALUES($1,$2,$3,$4)',
        [installation, org, hash(user), user],
      );
      await c.query(
        'INSERT INTO margin_lms.enrollments(installation_id,organization_id,course_id,user_id,role) VALUES($1,$2,$3,$4,$5)',
        [installation, org, course, user, role],
      );
      const now = Date.now(),
        p: SessionPrincipal = {
          sessionId: randomUUID(),
          organizationId: org,
          userId: user,
          role,
          authenticationMethod: 'lti',
          mfa: false,
          createdAt: now,
          lastSeenAt: now,
          expiresAt: now + 3600000,
        };
      await c.query(
        "INSERT INTO margin_identity.sessions(id,session_hash,user_id,organization_id,mfa,authentication_method,created_at,expires_at,idle_expires_at,last_seen_at) VALUES($1,$2,$3,$4,false,'lti',$5,$6,$6,$5)",
        [p.sessionId, hash(randomUUID()), user, org, new Date(now), new Date(p.expiresAt)],
      );
      await c.query(
        'INSERT INTO margin_lms.session_bindings(session_id,installation_id,registration_version,organization_id,user_id,course_id,subject_digest,course_digest,role) VALUES($1,$2,1,$3,$4,$5,$6,$7,$8)',
        [p.sessionId, installation, org, user, course, hash(user), hash(course), role],
      );
      principals.push(p);
    }
    await c.query(
      "INSERT INTO margin_sync.documents(organization_id,id,owner_id,current_version_id,audience) VALUES($1,$2,$3,$4,'teachers')",
      [org, documentId, teacher, versionId],
    );
    await c.query(
      'INSERT INTO margin_sync.versions(organization_id,document_id,id) VALUES($1,$2,$3)',
      [org, documentId, versionId],
    );
    await c.query(
      "INSERT INTO margin_sync.grants(organization_id,document_id,user_id,permission) VALUES($1,$2,$3,'owner')",
      [org, documentId, teacher],
    );
  });
  const [teacherP, studentP, peerP] = principals;
  const enrollment = (p: SessionPrincipal): VerifiedLmsEnrollment => ({
    installationId: installation,
    registrationVersion: 1,
    organizationId: org,
    userId: p.userId,
    courseId: course,
    role: p.role as 'teacher' | 'student',
    subjectDigest: hash(p.userId),
    courseDigest: hash(course),
  });
  const source = await runtime.reserve(teacherP, {
    requestId: randomUUID(),
    documentId,
    versionId,
    metadata,
    plaintextBytes: body.length,
    plaintextSha256: hash(body),
  });
  const object = {
    objectVersionId: 'synthetic-' + randomUUID(),
    etag: 'synthetic',
    ciphertextSha256: hash('encrypted fixture'),
    storedBytes: body.length + 1000,
  };
  objects.set(source.identity.artifactId, object);
  await runtime.stageConfirmed(teacherP, source.identity.artifactId, object);
  const scan = (await inspector.claimNext())!;
  expect(scan.identity.artifactId).toBe(source.identity.artifactId);
  await inspector.complete(scan, {
    verdict: 'ready',
    plaintextBytes: body.length,
    plaintextSha256: hash(body),
    engine: 'synthetic',
    engineVersion: '1',
    definitionsVersion: 'test-only',
    pageCount: 2,
    reason: 'clean',
    ...(geometry
      ? {
          pageGeometry: [
            { index: 0, width: 612, height: 792 },
            { index: 1, width: 792, height: 612 },
          ],
        }
      : {}),
  });
  const manifest = (await runtime.readyForTeacher(teacherP, { documentId, versionId }))!;
  const assignment = await assignments.create(
    teacherP,
    enrollment(teacherP),
    {
      requestId: randomUUID(),
      documentId,
      versionId,
      title: 'Private worksheet title',
      instructions: 'Private teaching instructions',
      policy: {
        allowedTools: ['pen', 'text'],
        allowExport: false,
        allowCopyPaste: false,
        allowReadAloud: true,
        assessment: true,
      },
    },
    manifest.source,
  );
  await seedTransaction(async (c) => {
    await c.query(
      'UPDATE margin_assignments.assignments SET selected_at=clock_timestamp() WHERE id=$1',
      [assignment.id],
    );
    await c.query(
      'INSERT INTO margin_assignments.resource_links(installation_id,resource_digest,organization_id,course_id,assignment_id) VALUES($1,$2,$3,$4,$5)',
      [installation, hash(assignment.id), org, course, assignment.id],
    );
    for (const p of [studentP, peerP])
      await c.query(
        'INSERT INTO margin_assignments.launch_bindings(session_id,installation_id,resource_digest,assignment_id,user_id) VALUES($1,$2,$3,$4,$5)',
        [p.sessionId, installation, hash(assignment.id), assignment.id, p.userId],
      );
  });
  const reservation = await assignments.reserveStudentWork(studentP, enrollment(studentP));
  return {
    org,
    teacher,
    student,
    peer,
    installation,
    course,
    documentId,
    versionId,
    teacherP,
    studentP,
    peerP,
    enrollment,
    source,
    manifest,
    assignment,
    reservation,
  };
}
async function countTarget(doc: string) {
  return Number(
    (await admin.query('SELECT count(*) AS n FROM margin_sync.documents WHERE id=$1', [doc]))
      .rows[0].n,
  );
}
async function runtimeContext(
  p: SessionPrincipal,
  installation: string,
  course: string,
  run: (c: import('pg').PoolClient) => Promise<void>,
) {
  const c = await sqlRuntime.connect();
  try {
    await c.query('BEGIN');
    for (const [k, v] of [
      ['session_id', p.sessionId],
      ['organization_id', p.organizationId],
      ['user_id', p.userId],
      ['installation_id', installation],
      ['course_id', course],
    ])
      await c.query('SELECT set_config($1,$2,true)', ['margin_assignments.' + k, v]);
    await run(c);
  } finally {
    await c.query('ROLLBACK');
    c.release();
  }
}
// These scenarios perform several durable transactions, retries and recovery checks.
// Bound the whole scenario separately from unchanged SQL, lock, lease and ticket deadlines.
describe.skipIf(!available)(
  'Durable Canvas work provisioning with actual PostgreSQL and explicit synthetic cloud/scanner fixtures',
  { timeout: 20_000 },
  () => {
    beforeAll(async () => {
      dir = mkdtempSync(join(tmpdir(), 'margin-work-pg-'));
      socket = join(dir, 'socket');
      mkdirSync(socket, { mode: 0o700 });
      execFileSync(
        'initdb',
        [
          '-D',
          join(dir, 'data'),
          '-U',
          'postgres',
          '--auth-local=trust',
          '--auth-host=reject',
          '--no-locale',
          '-E',
          'UTF8',
        ],
        { stdio: 'pipe' },
      );
      execFileSync(
        'pg_ctl',
        [
          '-D',
          join(dir, 'data'),
          '-l',
          join(dir, 'pg.log'),
          '-o',
          `-k ${socket} -h '' -p 55496`,
          '-w',
          'start',
        ],
        { stdio: 'pipe' },
      );
      started = true;
      admin = new Pool(config('postgres'));
      for (const name of [
        '001-identity.sql',
        '002-document-sync.sql',
        '003-lms-installations.sql',
        '004-assignments.sql',
        '005-ingestion.sql',
        '006-assignment-work.sql',
        '007-assignment-work-runtime.sql',
      ])
        await admin.query(
          readFileSync(new URL('../infra/migrations/' + name, import.meta.url), 'utf8'),
        );
      for (const [login, group] of [
        ['work_runtime', 'margin_assignments_runtime'],
        ['work_worker', 'margin_assignment_provisioner'],
        ['work_sync', 'margin_sync_runtime'],
        ['work_ingest', 'margin_ingestion_runtime'],
        ['work_inspect', 'margin_ingestion_inspector'],
        ['work_read', 'margin_ingestion_reader'],
      ])
        await admin.query(
          `CREATE ROLE ${login} LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS; GRANT ${group} TO ${login}`,
        );
      sqlRuntime = new Pool(config('work_runtime'));
      sqlWorker = new Pool(config('work_worker'));
      sqlSync = new Pool(config('work_sync'));
      runtime = new PostgresIngestionRepository(config('work_ingest'), kms, 'runtime');
      inspector = new PostgresIngestionRepository(config('work_inspect'), kms, 'inspector');
      reader = new PostgresIngestionRepository(config('work_read'), kms, 'reader');
      assignments = new PostgresAssignmentRepository(config('work_runtime'), kms);
      worker = new PostgresStudentWorkProvisioner(config('work_worker'), kms);
    }, 30000);
    afterEach(async () => {
      await admin?.query(
        'UPDATE margin_identity.organizations SET disabled_at=clock_timestamp() WHERE disabled_at IS NULL',
      );
    });
    afterAll(async () => {
      const errors: unknown[] = [];
      const settled = await Promise.allSettled([
        admin?.end(),
        sqlRuntime?.end(),
        sqlWorker?.end(),
        sqlSync?.end(),
        runtime?.close(),
        inspector?.close(),
        reader?.close(),
        assignments?.close(),
        worker?.close(),
      ]);
      for (const result of settled) if (result.status === 'rejected') errors.push(result.reason);
      let stopped = !started;
      try {
        if (started) await stopDisposablePostgres(join(dir, 'data'));
        stopped = true;
      } catch (error) {
        errors.push(error);
      }
      // Keep diagnostics/data if shutdown is unconfirmed; never delete a running fixture.
      if (stopped && dir) {
        try {
          rmSync(dir, { recursive: true, force: true });
        } catch (error) {
          errors.push(error);
        }
      }
      if (errors.length) throw new AggregateError(errors, 'PostgreSQL fixture cleanup failed.');
    });
    it('pins verified launch provenance; atomically provisions independent pages/key/owner grant and encrypted shared-source receipt', async () => {
      const f = await fixture();
      const claim = (await worker.claimNext())!;
      expect(claim.workId).toBe(f.reservation.id);
      const pinned = (
        await admin.query(
          'SELECT registration_version,subject_digest,course_digest,provenance_session_id FROM margin_assignments.student_work WHERE id=$1',
          [claim.workId],
        )
      ).rows[0];
      expect(pinned).toEqual({
        registration_version: 1,
        subject_digest: hash(f.student),
        course_digest: hash(f.course),
        provenance_session_id: f.studentP.sessionId,
      });
      const prepared = await worker.prepare(claim, reader, storage);
      const completed = await worker.completePrepared(claim, prepared);
      expect(completed.status).toBe('provisioned');
      expect(await worker.receipt(claim)).toEqual({ ...completed, duplicate: true });
      expect(
        (await assignments.reserveStudentWork(f.studentP, f.enrollment(f.studentP))).status,
      ).toBe('provisioned');
      expect(
        (
          await admin.query('SELECT origin,owner_id FROM margin_sync.documents WHERE id=$1', [
            completed.documentId,
          ])
        ).rows[0],
      ).toEqual({ origin: 'assignment', owner_id: f.student });
      const pages = (
        await admin.query(
          'SELECT id,page_index,width,height FROM margin_sync.pages WHERE document_id=$1 ORDER BY page_index',
          [completed.documentId],
        )
      ).rows;
      expect(pages.map((p) => [p.page_index, p.width, p.height])).toEqual([
        [0, 612, 792],
        [1, 792, 612],
      ]);
      expect(new Set(pages.map((p) => p.id)).size).toBe(2);
      expect(
        (
          await admin.query(
            'SELECT user_id,permission FROM margin_sync.grants WHERE document_id=$1',
            [completed.documentId],
          )
        ).rows,
      ).toEqual([{ user_id: f.student, permission: 'owner' }]);
      expect(
        (
          await admin.query('SELECT user_id FROM margin_sync.grants WHERE document_id=$1', [
            f.documentId,
          ])
        ).rows,
      ).toEqual([{ user_id: f.teacher }]);
      const receipt = (
        await admin.query('SELECT * FROM margin_work.receipts WHERE work_id=$1', [claim.workId])
      ).rows[0];
      expect(receipt.ciphertext.toString()).not.toContain(f.manifest.source.artifactVersion);
      const aad = canonical([
        'margin-assignment-work-v1',
        f.reservation.id,
        f.org,
        f.installation,
        f.course,
        f.assignment.id,
        f.student,
        f.reservation.documentId,
        f.reservation.versionId,
        claim.claimId,
        claim.attempt,
      ]);
      const key = await unwrapKey(kms, receipt.wrapped_key, aad);
      const plain = decrypt(key, receipt, aad, 262144);
      try {
        const manifest = JSON.parse(plain.toString());
        expect(manifest.source).toEqual(f.manifest.source);
        expect(manifest.pages).toHaveLength(2);
        expect(manifest.storageReceipt).toEqual(objects.get(f.source.identity.artifactId));
      } finally {
        plain.fill(0);
        key.fill(0);
      }
      await expect(worker.completePrepared(claim, prepared)).rejects.toMatchObject({
        code: 'invalid_preparation',
      });
    });
    it('claims a reservation once under concurrency, returns same reservation on retry, and separates peer work', async () => {
      const f = await fixture();
      expect((await assignments.reserveStudentWork(f.studentP, f.enrollment(f.studentP))).id).toBe(
        f.reservation.id,
      );
      const claims = await Promise.all([
        worker.claimNext(),
        worker.claimNext(),
        worker.claimNext(),
      ]);
      expect(claims.filter(Boolean)).toHaveLength(1);
      const peer = await assignments.reserveStudentWork(f.peerP, f.enrollment(f.peerP));
      expect(peer.documentId).not.toBe(f.reservation.documentId);
      const peerClaim = (await worker.claimNext())!;
      expect(peerClaim.workId).toBe(peer.id);
      await expect(
        worker.prepare({ ...peerClaim, workId: f.reservation.id }, reader, storage),
      ).rejects.toMatchObject({ code: 'stale_claim' });
    });
    it('fails closed for old approvals without authenticated geometry and never treats object receipts as availability', async () => {
      const f = await fixture(false),
        claim = (await worker.claimNext())!;
      await expect(worker.prepare(claim, reader, storage)).rejects.toMatchObject({
        code: 'authenticated_geometry_required',
      });
      expect(await countTarget(f.reservation.documentId)).toBe(0);
      await admin.query(
        'UPDATE margin_identity.organizations SET disabled_at=clock_timestamp() WHERE id=$1',
        [f.org],
      );
      const next = await fixture(),
        second = (await worker.claimNext())!;
      objects.delete(next.source.identity.artifactId);
      await expect(worker.prepare(second, reader, storage)).rejects.toThrow('unavailable');
      expect(await countTarget(next.reservation.documentId)).toBe(0);
    });
    it('rejects substituted source bytes and cancellation without creating partial work', async () => {
      const f = await fixture(),
        claim = (await worker.claimNext())!;
      await expect(
        worker.prepare(claim, reader, {
          get: async () => ({ bytes: Buffer.from('different bytes'), metadata }),
        }),
      ).rejects.toMatchObject({ code: 'source_content_mismatch' });
      const controller = new AbortController();
      controller.abort();
      await expect(worker.prepare(claim, reader, storage, controller.signal)).rejects.toMatchObject(
        { code: 'preparation_cancelled' },
      );
      const ticket = await worker.prepare(claim, reader, storage);
      await expect(worker.completePrepared(claim, ticket, controller.signal)).rejects.toMatchObject(
        { code: 'invalid_preparation' },
      );
      expect(await countTarget(f.reservation.documentId)).toBe(0);
    });
    it.each([
      'membership',
      'enrollment',
      'subject',
      'course',
      'installation',
      'assignment',
      'teacher-grant',
      'artifact',
    ] as const)(
      'rechecks %s revocation after remote preparation, before atomic writes',
      async (kind) => {
        const f = await fixture(),
          claim = (await worker.claimNext())!,
          ticket = await worker.prepare(claim, reader, storage);
        const mutations = {
          membership: [
            'UPDATE margin_identity.memberships SET revoked_at=clock_timestamp() WHERE user_id=$1',
            [f.student],
          ],
          enrollment: [
            'UPDATE margin_lms.enrollments SET disabled_at=clock_timestamp() WHERE user_id=$1',
            [f.student],
          ],
          subject: [
            'UPDATE margin_lms.user_links SET disabled_at=clock_timestamp() WHERE user_id=$1',
            [f.student],
          ],
          course: [
            'UPDATE margin_lms.courses SET disabled_at=clock_timestamp() WHERE course_id=$1',
            [f.course],
          ],
          installation: [
            'UPDATE margin_lms.installations SET version=version+1 WHERE id=$1',
            [f.installation],
          ],
          assignment: [
            'UPDATE margin_assignments.assignments SET disabled_at=clock_timestamp() WHERE id=$1',
            [f.assignment.id],
          ],
          'teacher-grant': [
            'UPDATE margin_sync.grants SET revoked_at=clock_timestamp() WHERE document_id=$1',
            [f.documentId],
          ],
          artifact: [
            'UPDATE margin_ingestion.artifacts SET revoked_at=clock_timestamp() WHERE artifact_id=$1',
            [f.source.identity.artifactId],
          ],
        } satisfies Record<string, [string, string[]]>;
        const [sql, params] = mutations[kind];
        await admin.query(sql, params);
        await expect(worker.completePrepared(claim, ticket)).rejects.toThrow();
        expect(await countTarget(f.reservation.documentId)).toBe(0);
      },
    );
    it('rejects expired claim after lease reclamation and enforces bounded retry', async () => {
      const f = await fixture(),
        first = (await worker.claimNext())!,
        ticket = await worker.prepare(first, reader, storage);
      // Administrative fault injection simulates wall-clock lease expiry without waiting two minutes.
      await admin.query(
        'ALTER TABLE margin_assignments.provisioning_outbox DISABLE TRIGGER protect_work_job',
      );
      try {
        await admin.query(
          "UPDATE margin_assignments.provisioning_outbox SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE work_id=$1",
          [first.workId],
        );
      } finally {
        await admin.query(
          'ALTER TABLE margin_assignments.provisioning_outbox ENABLE TRIGGER protect_work_job',
        );
      }
      const second = (await worker.claimNext())!;
      expect(second.attempt).toBe(2);
      await expect(worker.completePrepared(first, ticket)).rejects.toMatchObject({
        code: 'stale_claim',
      });
      await expect(worker.retry(first, 0)).rejects.toMatchObject({ code: 'stale_claim' });
      await expect(worker.retry(second, 3601)).rejects.toMatchObject({ code: 'invalid_retry' });
      await worker.retry(second, 0);
      const third = (await worker.claimNext())!;
      expect(third.attempt).toBe(3);
      expect(await countTarget(f.reservation.documentId)).toBe(0);
    });
    it('rolls back all document rows when the final receipt fails, then succeeds with fresh preparation', async () => {
      const f = await fixture(),
        claim = (await worker.claimNext())!,
        ticket = await worker.prepare(claim, reader, storage);
      await admin.query(
        "CREATE FUNCTION margin_work.fixture_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic receipt failure'; END $$; CREATE TRIGGER fixture_fail BEFORE INSERT ON margin_work.receipts FOR EACH ROW EXECUTE FUNCTION margin_work.fixture_fail()",
      );
      try {
        await expect(worker.completePrepared(claim, ticket)).rejects.toThrow(
          'synthetic receipt failure',
        );
      } finally {
        await admin.query(
          'DROP TRIGGER fixture_fail ON margin_work.receipts; DROP FUNCTION margin_work.fixture_fail()',
        );
      }
      expect(await countTarget(f.reservation.documentId)).toBe(0);
      expect(await worker.receipt(claim)).toBeNull();
      expect(
        (await worker.completePrepared(claim, await worker.prepare(claim, reader, storage))).status,
      ).toBe('provisioned');
    });
    it('blocks generic OIDC sync even for the student owner and makes completed receipts immutable', async () => {
      const f = await fixture(),
        claim = (await worker.claimNext())!;
      await worker.completePrepared(claim, await worker.prepare(claim, reader, storage));
      await admin.query(
        "UPDATE margin_identity.sessions SET authentication_method='oidc' WHERE id=$1",
        [f.studentP.sessionId],
      );
      const c = await sqlSync.connect();
      try {
        await c.query('BEGIN');
        for (const [k, v] of [
          ['user_id', f.student],
          ['organization_id', f.org],
          ['session_id', f.studentP.sessionId],
          ['authentication_method', 'oidc'],
        ])
          await c.query('SELECT set_config($1,$2,true)', ['margin_sync.' + k, v]);
        expect(
          (
            await c.query('SELECT * FROM margin_sync.documents WHERE id=$1', [
              f.reservation.documentId,
            ])
          ).rows,
        ).toEqual([]);
        expect(
          (
            await c.query('SELECT * FROM margin_sync.pages WHERE document_id=$1', [
              f.reservation.documentId,
            ])
          ).rows,
        ).toEqual([]);
        expect(
          (
            await c.query('SELECT * FROM margin_sync.document_keys WHERE document_id=$1', [
              f.reservation.documentId,
            ])
          ).rows,
        ).toEqual([]);
      } finally {
        await c.query('ROLLBACK');
        c.release();
      }
      await expect(
        sqlWorker.query('UPDATE margin_work.receipts SET attempt=2 WHERE work_id=$1', [
          claim.workId,
        ]),
      ).rejects.toThrow('permission denied');
      await expect(
        admin.query(
          "UPDATE margin_assignments.provisioning_outbox SET state='pending',completed_at=NULL WHERE work_id=$1",
          [claim.workId],
        ),
      ).rejects.toThrow('immutable');
    });
    it('runtime cannot mark work complete, enqueue forged leases, or read another student/tenant reservation', async () => {
      const f = await fixture(),
        other = await fixture();
      await runtimeContext(f.peerP, f.installation, f.course, async (c) =>
        expect(
          (
            await c.query('SELECT * FROM margin_assignments.student_work WHERE id=$1', [
              f.reservation.id,
            ])
          ).rows,
        ).toEqual([]),
      );
      await runtimeContext(other.studentP, other.installation, other.course, async (c) =>
        expect(
          (
            await c.query('SELECT * FROM margin_assignments.student_work WHERE id=$1', [
              f.reservation.id,
            ])
          ).rows,
        ).toEqual([]),
      );
      await runtimeContext(f.studentP, f.installation, f.course, async (c) => {
        await expect(
          c.query(
            "UPDATE margin_assignments.student_work SET status='provisioned',provisioned_at=clock_timestamp() WHERE id=$1",
            [f.reservation.id],
          ),
        ).rejects.toThrow('permission denied');
      });
      await runtimeContext(f.studentP, f.installation, f.course, async (c) => {
        await expect(
          c.query(
            "INSERT INTO margin_assignments.provisioning_outbox(work_id,attempt,claim_id,token_digest,lease_expires_at) VALUES($1,1,$2,$3,clock_timestamp()+interval '1 minute')",
            [f.reservation.id, randomUUID(), hash('forged')],
          ),
        ).rejects.toThrow();
      });
    });
    it.each([true, false])(
      'rejects assignment runtime with worker membership inherited=%s',
      async (inherit) => {
        const f = await fixture();
        await withAssignmentProvisionerMembership(
          admin,
          config('work_runtime'),
          'margin_assignments_runtime',
          inherit,
          async (unsafe) => {
            const bad = new PostgresAssignmentRepository(unsafe, kms);
            try {
              await expect(
                bad.reserveStudentWork(f.studentP, f.enrollment(f.studentP)),
              ).rejects.toThrow('least-privilege');
            } finally {
              await bad.close();
            }
          },
        );
      },
    );
    it.each(
      [
        'margin_identity_runtime',
        'margin_lms_runtime',
        'margin_sync_runtime',
        'margin_sync_provisioner',
        'margin_assignments_runtime',
        'margin_ingestion_runtime',
        'margin_ingestion_inspector',
        'margin_ingestion_reader',
        'margin_assignment_provisioner',
      ].flatMap((group) => [true, false].map((inherit) => ({ group, inherit }))),
    )(
      'rejects assignment-work runtime membership on $group inherited=$inherit',
      async ({ group, inherit }) => {
        // This suite applies the real work-runtime migration, so the test exercises its grants.
        expect(
          (
            await admin.query(
              "SELECT 1 FROM pg_roles WHERE rolname='margin_assignment_work_runtime'",
            )
          ).rowCount,
        ).toBe(1);
        const f = [
          'margin_assignments_runtime',
          'margin_ingestion_runtime',
          'margin_ingestion_reader',
        ].includes(group)
          ? await fixture()
          : undefined;
        await withAssignmentWorkRuntimeMembership(
          admin,
          config('unused_fixture_login'),
          group,
          inherit,
          async (unsafe) => {
            if (group === 'margin_identity_runtime')
              await rejectsMixedRole(
                new PostgresIdentityRepository(unsafe),
                (pool) => pool.findIdentity(hash(randomUUID())),
                'mixed application role',
              );
            else if (group === 'margin_lms_runtime')
              await rejectsMixedRole(
                new PostgresLmsRepository(unsafe, randomBytes(32)),
                (pool) => pool.findById(randomUUID()),
                'must not',
              );
            else if (group === 'margin_sync_runtime' || group === 'margin_sync_provisioner') {
              const run = vi.fn(async () => undefined);
              await rejectsMixedRole(
                new SyncPool(unsafe, group === 'margin_sync_runtime' ? 'runtime' : 'provisioner'),
                (pool) => pool.transaction(undefined, run),
                'dedicated',
              );
              expect(run).not.toHaveBeenCalled();
            } else if (group === 'margin_assignments_runtime')
              await rejectsMixedRole(
                new PostgresAssignmentRepository(unsafe, kms),
                (pool) => pool.get(f!.teacherP, f!.enrollment(f!.teacherP), f!.assignment.id),
                'least-privilege',
              );
            else if (group === 'margin_ingestion_runtime')
              await rejectsMixedRole(
                new PostgresIngestionRepository(unsafe, kms, 'runtime'),
                (pool) => pool.get(f!.teacherP, f!.source.identity.artifactId),
                'least-privilege',
              );
            else if (group === 'margin_ingestion_inspector')
              await rejectsMixedRole(
                new PostgresIngestionRepository(unsafe, kms, 'inspector'),
                (pool) => pool.claimNext(),
                'least-privilege',
              );
            else if (group === 'margin_ingestion_reader')
              await rejectsMixedRole(
                new PostgresIngestionRepository(unsafe, kms, 'reader'),
                (pool) => pool.readySnapshot(f!.manifest.source),
                'least-privilege',
              );
            else
              await rejectsMixedRole(
                new PostgresStudentWorkProvisioner(unsafe, kms),
                (pool) => pool.claimNext(),
                'least-privilege',
              );
          },
        );
        if (f)
          expect(
            await assignments.get(f.teacherP, f.enrollment(f.teacherP), f.assignment.id),
          ).toMatchObject({
            id: f.assignment.id,
          });
      },
    );
    it.each([true, false])(
      'rejects worker table-owner membership inherited=%s',
      async (inherit) => {
        await withTableOwnerMembership(
          admin,
          config('work_worker'),
          'margin_work.receipts',
          'margin_assignment_provisioner',
          inherit,
          async (unsafe) => {
            const bad = new PostgresStudentWorkProvisioner(unsafe, kms);
            try {
              await expect(bad.claimNext()).rejects.toThrow('least-privilege');
            } finally {
              await bad.close();
            }
          },
        );
      },
    );
    it('serializes a concurrent enrollment revocation after the complete transaction without mutation privileges', async () => {
      const f = await fixture(),
        claim = (await worker.claimNext())!,
        ticket = await worker.prepare(claim, reader, storage);
      const gate = await admin.connect(),
        gateId = 739812;
      await gate.query('SELECT pg_advisory_lock($1)', [gateId]);
      await admin.query(
        `CREATE FUNCTION margin_work.fixture_gate() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_advisory_xact_lock(${gateId}); RETURN NEW; END $$; CREATE TRIGGER fixture_gate BEFORE INSERT ON margin_work.receipts FOR EACH ROW EXECUTE FUNCTION margin_work.fixture_gate()`,
      );
      const completing = worker.completePrepared(claim, ticket);
      completing.catch(() => {});
      const waitFor = async (sql: string) => {
        const deadline = Date.now() + 5000;
        while (Date.now() < deadline) {
          if ((await admin.query(sql)).rowCount) return;
          await new Promise((r) => setTimeout(r, 10));
        }
        throw new Error('Expected blocked PostgreSQL operation was not observed');
      };
      let revocation: Promise<unknown> | undefined;
      try {
        await waitFor(
          "SELECT 1 FROM pg_stat_activity WHERE usename='work_worker' AND wait_event='advisory'",
        );
        revocation = admin.query(
          'UPDATE margin_identity.memberships SET revoked_at=clock_timestamp() WHERE user_id=$1',
          [f.student],
        );
        revocation.catch(() => {});
        await waitFor(
          "SELECT 1 FROM pg_stat_activity WHERE query LIKE 'UPDATE margin_identity.memberships SET revoked_at%' AND wait_event_type='Lock'",
        );
        expect(await countTarget(f.reservation.documentId)).toBe(0);
        await gate.query('SELECT pg_advisory_unlock($1)', [gateId]);
        expect((await completing).status).toBe('provisioned');
        await revocation;
        await expect(worker.receipt(claim)).rejects.toMatchObject({ code: 'work_access_revoked' });
      } finally {
        await gate.query('SELECT pg_advisory_unlock($1)', [gateId]);
        gate.release();
        await Promise.allSettled([completing, revocation]);
        await admin.query(
          'DROP TRIGGER fixture_gate ON margin_work.receipts; DROP FUNCTION margin_work.fixture_gate()',
        );
      }
    });
    it('lock-only structural-column privileges cannot change authority or source rows', async () => {
      const f = await fixture();
      for (const [table, column] of [
        ['margin_identity.users', 'id'],
        ['margin_identity.organizations', 'id'],
        ['margin_identity.memberships', 'user_id'],
        ['margin_lms.installations', 'id'],
        ['margin_lms.user_links', 'user_id'],
        ['margin_lms.courses', 'course_id'],
        ['margin_lms.enrollments', 'user_id'],
        ['margin_assignments.assignments', 'id'],
        ['margin_assignments.resource_links', 'resource_digest'],
        ['margin_sync.documents', 'id'],
        ['margin_sync.versions', 'id'],
        ['margin_sync.grants', 'user_id'],
        ['margin_ingestion.artifacts', 'artifact_id'],
        ['margin_ingestion.storage_receipts', 'artifact_id'],
        ['margin_ingestion.inspection_jobs', 'artifact_id'],
        ['margin_ingestion.inspection_receipts', 'id'],
        ['margin_ingestion.page_geometry', 'scan_receipt_id'],
      ]) {
        expect(
          (await sqlWorker.query(`SELECT ${column} FROM ${table} LIMIT 1 FOR SHARE`)).rowCount,
        ).toBe(1);
        await expect(sqlWorker.query(`UPDATE ${table} SET ${column}=${column}`)).rejects.toThrow();
      }
      expect(await countTarget(f.reservation.documentId)).toBe(0);
    });
    it('pins resource mapping while permitting originating browser session retirement', async () => {
      const f = await fixture();
      await admin.query('DELETE FROM margin_assignments.launch_bindings WHERE session_id=$1', [
        f.studentP.sessionId,
      ]);
      await admin.query('DELETE FROM margin_lms.session_bindings WHERE session_id=$1', [
        f.studentP.sessionId,
      ]);
      await admin.query('DELETE FROM margin_identity.sessions WHERE id=$1', [f.studentP.sessionId]);
      const claim = (await worker.claimNext())!;
      expect(claim.workId).toBe(f.reservation.id);
      expect(
        (await worker.completePrepared(claim, await worker.prepare(claim, reader, storage))).status,
      ).toBe('provisioned');
      const other = await fixture(),
        second = (await worker.claimNext())!,
        ticket = await worker.prepare(second, reader, storage);
      await admin.query('DELETE FROM margin_assignments.launch_bindings WHERE assignment_id=$1', [
        other.assignment.id,
      ]);
      await admin.query('DELETE FROM margin_assignments.resource_links WHERE assignment_id=$1', [
        other.assignment.id,
      ]);
      await expect(worker.completePrepared(second, ticket)).rejects.toMatchObject({
        code: 'work_access_revoked',
      });
      expect(await countTarget(other.reservation.documentId)).toBe(0);
    });
    it('refuses legacy unpinned reservations, expired preparations and changed geometry', async () => {
      const f = await fixture(),
        claim = (await worker.claimNext())!,
        ticket = await worker.prepare(claim, reader, storage);
      const now = Date.now();
      const clock = vi.spyOn(Date, 'now').mockReturnValue(now + 11000);
      try {
        await expect(worker.completePrepared(claim, ticket)).rejects.toMatchObject({
          code: 'invalid_preparation',
        });
      } finally {
        clock.mockRestore();
      }
      const next = await worker.prepare(claim, reader, storage);
      await admin.query(
        'UPDATE margin_ingestion.page_geometry SET ciphertext=set_byte(ciphertext,0,get_byte(ciphertext,0)#1) WHERE scan_receipt_id=$1',
        [f.manifest.source.scanReceiptId],
      );
      await expect(worker.completePrepared(claim, next)).rejects.toMatchObject({
        code: 'source_access_changed',
      });
      await worker.retry(claim, 0);
      await admin.query(
        'ALTER TABLE margin_assignments.student_work DISABLE TRIGGER protect_reservation',
      );
      try {
        await admin.query(
          'UPDATE margin_assignments.student_work SET registration_version=NULL,subject_digest=NULL,course_digest=NULL,provenance_session_id=NULL,resource_digest=NULL WHERE id=$1',
          [f.reservation.id],
        );
      } finally {
        await admin.query(
          'ALTER TABLE margin_assignments.student_work ENABLE TRIGGER protect_reservation',
        );
      }
      expect(await worker.claimNext()).toBeNull();
      expect(await countTarget(f.reservation.documentId)).toBe(0);
    });
    it('rechecks student authority after receipt recovery waits for a concurrent revocation', async () => {
      const f = await fixture(),
        claim = (await worker.claimNext())!;
      await worker.completePrepared(claim, await worker.prepare(claim, reader, storage));
      const revoker = await admin.connect();
      let recovering: ReturnType<typeof worker.receipt> | undefined;
      try {
        await revoker.query('BEGIN');
        await revoker.query(
          'UPDATE margin_identity.memberships SET revoked_at=clock_timestamp() WHERE user_id=$1',
          [f.student],
        );
        // Uncommitted revocation remains invisible to the initial authorization reads.
        // Recovery must block on its authority lock and recheck after this commit.
        recovering = worker.receipt(claim);
        recovering.catch(() => {});
        const deadline = Date.now() + 5000;
        let blocked = false;
        while (Date.now() < deadline) {
          blocked = Boolean(
            (
              await admin.query(
                "SELECT 1 FROM pg_stat_activity WHERE usename='work_worker' AND query LIKE 'SELECT user_id FROM margin_identity.memberships%' AND wait_event_type='Lock'",
              )
            ).rowCount,
          );
          if (blocked) break;
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        expect(blocked).toBe(true);
        await revoker.query('COMMIT');
        await expect(recovering).rejects.toMatchObject({ code: 'completion_integrity' });
      } finally {
        await revoker.query('ROLLBACK');
        revoker.release();
        await Promise.allSettled([recovering]);
      }
    });
    it('authenticates completion receipts before recovery and keeps KMS outside database transactions', async () => {
      const f = await fixture(),
        claim = (await worker.claimNext())!;
      await worker.completePrepared(claim, await worker.prepare(claim, reader, storage));
      const testKms = {
        wrapKey: (key: Buffer, ctx: string) => kms.wrapKey(key, ctx),
        unwrapKey: async (wrapped: Parameters<typeof kms.unwrapKey>[0], ctx: string) => {
          expect(
            Number(
              (
                await admin.query(
                  "SELECT count(*) AS n FROM pg_stat_activity WHERE usename='work_worker' AND xact_start IS NOT NULL AND state<>'idle'",
                )
              ).rows[0].n,
            ),
          ).toBe(0);
          return kms.unwrapKey(wrapped, ctx);
        },
      };
      const recovery = new PostgresStudentWorkProvisioner(config('work_worker'), testKms);
      try {
        expect((await recovery.receipt(claim))?.duplicate).toBe(true);
      } finally {
        await recovery.close();
      }
      await admin.query(
        'UPDATE margin_work.receipts SET ciphertext=set_byte(ciphertext,0,get_byte(ciphertext,0)#1) WHERE work_id=$1',
        [claim.workId],
      );
      await expect(worker.receipt(claim)).rejects.toMatchObject({ code: 'completion_integrity' });
    });
    it.each(['deleted-document', 'revoked-owner'] as const)(
      'does not recover successful work against a target with %s',
      async (change) => {
        const f = await fixture(),
          claim = (await worker.claimNext())!;
        await worker.completePrepared(claim, await worker.prepare(claim, reader, storage));
        if (change === 'deleted-document')
          await admin.query(
            'UPDATE margin_sync.documents SET deleted_at=clock_timestamp() WHERE organization_id=$1 AND id=$2',
            [f.org, f.reservation.documentId],
          );
        else
          await admin.query(
            'UPDATE margin_sync.grants SET revoked_at=clock_timestamp() WHERE organization_id=$1 AND document_id=$2 AND user_id=$3',
            [f.org, f.reservation.documentId, f.student],
          );
        await expect(worker.receipt(claim)).rejects.toMatchObject({ code: 'completion_integrity' });
      },
    );
    it('exhausts bounded claims without fabricated completion and preserves pending state', async () => {
      const f = await fixture();
      for (let attempt = 1; attempt <= 10; attempt++) {
        const claim = (await worker.claimNext())!;
        expect(claim.attempt).toBe(attempt);
        await worker.retry(claim, 0);
      }
      expect(await worker.claimNext()).toBeNull();
      expect(await countTarget(f.reservation.documentId)).toBe(0);
      expect(
        (await assignments.reserveStudentWork(f.studentP, f.enrollment(f.studentP))).status,
      ).toBe('pending');
    });
    it('keeps abort-ignoring object readers bounded and clears their eventual plaintext', async () => {
      const f = await fixture(),
        claim = (await worker.claimNext())!;
      const release: Array<(value: { bytes: Buffer; metadata: typeof metadata }) => void> = [];
      const stalled: ArtifactReader = {
        get: () => new Promise((resolve) => release.push(resolve)),
      };
      for (let i = 0; i < 2; i++) {
        const controller = new AbortController();
        const preparing = worker.prepare(claim, reader, stalled, controller.signal);
        preparing.catch(() => {});
        const deadline = Date.now() + 5000;
        while (release.length <= i && Date.now() < deadline)
          await new Promise((r) => setTimeout(r, 5));
        expect(release.length).toBe(i + 1);
        controller.abort();
        await expect(preparing).rejects.toThrow('interrupted');
      }
      try {
        await expect(worker.prepare(claim, reader, storage)).rejects.toMatchObject({
          code: 'object_reader_busy',
        });
      } finally {
        const bytes = release.map(() => Buffer.from(body));
        release.forEach((resolve, i) => resolve({ bytes: bytes[i], metadata }));
        await new Promise((r) => setTimeout(r, 5));
        expect(bytes.every((b) => b.every((n) => n === 0))).toBe(true);
      }
      expect(await countTarget(f.reservation.documentId)).toBe(0);
    });
    it('denies a same-user wrong-course runtime context and new-worker table-owner escalation on runtime', async () => {
      const f = await fixture();
      await runtimeContext(f.studentP, f.installation, randomUUID(), async (c) =>
        expect(
          (
            await c.query('SELECT * FROM margin_assignments.student_work WHERE id=$1', [
              f.reservation.id,
            ])
          ).rows,
        ).toEqual([]),
      );
      await withTableOwnerMembership(
        admin,
        config('work_runtime'),
        'margin_work.receipts',
        'margin_assignments_runtime',
        false,
        async (unsafe) => {
          const bad = new PostgresAssignmentRepository(unsafe, kms);
          try {
            await expect(
              bad.reserveStudentWork(f.studentP, f.enrollment(f.studentP)),
            ).rejects.toThrow('least-privilege');
          } finally {
            await bad.close();
          }
        },
      );
    });
    it('worker reports backend success only after receipt and retries exact source failures', async () => {
      const f = await fixture();
      const engine = new StudentWorkProvisioningWorker(worker, reader, storage);
      objects.delete(f.source.identity.artifactId);
      await expect(engine.runOne()).rejects.toThrow('unavailable');
      expect(
        (
          await admin.query(
            'SELECT state,attempt,claim_id FROM margin_assignments.provisioning_outbox WHERE work_id=$1',
            [f.reservation.id],
          )
        ).rows[0],
      ).toEqual({ state: 'pending', attempt: 1, claim_id: null });
      expect(await countTarget(f.reservation.documentId)).toBe(0);
    });
  },
);
