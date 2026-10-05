import { PostgresAssignmentWorkService } from '../apps/api/src/assignments/work';
import type { AssignmentPolicy } from '../apps/api/src/assignments/types';
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
let workApi: PostgresAssignmentWorkService, sqlApi: Pool;
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
const config = (user: string) => ({ host: socket, port: 55497, user, database: 'postgres' });
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
async function fixture(policy: Partial<AssignmentPolicy> = {}, geometry = true) {
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
        allowedTools: ['pen', 'text', 'eraser'],
        allowExport: true,
        allowCopyPaste: true,
        allowReadAloud: true,
        assessment: false,
        ...policy,
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

async function ready(policy: Partial<AssignmentPolicy> = {}) {
  const f = await fixture(policy);
  const claim = (await worker.claimNext())!;
  await worker.completePrepared(claim, await worker.prepare(claim, reader, storage));
  return f;
}
const operation = (f: Awaited<ReturnType<typeof fixture>>, page: string) => ({
  documentId: f.reservation.documentId,
  versionId: f.reservation.versionId,
  pageId: page,
  annotationId: randomUUID(),
  operationId: randomUUID(),
  baseRevision: 0,
  kind: 'put' as const,
  annotation: {
    type: 'text',
    x: 10,
    y: 20,
    width: 100,
    height: 24,
    text: 'Private student answer',
    color: '#123456',
    strokeWidth: 2,
    opacity: 1,
    rotation: 0,
  },
});
async function apiContext(p: SessionPrincipal, run: (c: PoolClient) => Promise<void>) {
  const c = await sqlApi.connect();
  try {
    await c.query('BEGIN');
    for (const [k, v] of [
      ['user_id', p.userId],
      ['organization_id', p.organizationId],
      ['session_id', p.sessionId],
    ])
      await c.query('SELECT set_config($1,$2,true)', ['margin_work.' + k, v]);
    await run(c);
  } finally {
    await c.query('ROLLBACK');
    c.release();
  }
}
// Each scenario composes ingestion, provisioning and runtime transactions before its assertion.
// Allow slower Linux CI hosts that aggregate work; SQL, lock and provider deadlines remain unchanged.
describe.skipIf(!available)(
  'Current-launch student work runtime on real PostgreSQL',
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
          `-k ${socket} -h '' -p 55497`,
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
        ['work_api', 'margin_assignment_work_runtime'],
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
      workApi = new PostgresAssignmentWorkService(config('work_api'), kms, storage);
      sqlApi = new Pool(config('work_api'));
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
        workApi?.close(),
        sqlApi?.end(),
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
    it('distinguishes pending work, authenticates source and durably appends/catches up without exposing teacher identities', async () => {
      const f = await fixture();
      expect((await workApi.describe(f.studentP)).work).toEqual({
        id: f.reservation.id,
        status: 'pending',
      });
      await expect(workApi.source(f.studentP)).rejects.toMatchObject({ code: 'work_pending' });
      const claim = (await worker.claimNext())!;
      await worker.completePrepared(claim, await worker.prepare(claim, reader, storage));
      const view = await workApi.describe(f.studentP);
      expect(view.work?.status).toBe('provisioned');
      expect(JSON.stringify(view)).not.toContain(f.teacher);
      expect(JSON.stringify(view)).not.toContain(f.documentId);
      expect(JSON.stringify(view)).not.toContain(f.source.identity.artifactId);
      const bytes = await workApi.source(f.studentP);
      expect(bytes.equals(body)).toBe(true);
      bytes.fill(0);
      if (view.work?.status !== 'provisioned') throw new Error('Expected work');
      const input = operation(f, view.work.document.pages[0].id),
        receipt = await workApi.append(f.studentP, input);
      expect(receipt).toMatchObject({ cursor: 1, annotationRevision: 1, duplicate: false });
      expect(await workApi.append(f.studentP, input)).toEqual({ ...receipt, duplicate: true });
      const log = await workApi.catchUp(f.studentP, {});
      expect(log.operations[0]).toMatchObject({ ...input, cursor: 1 });
      expect(log.currentCursor).toBe(1);
      expect(
        Number(
          (
            await admin.query('SELECT count(*) n FROM margin_sync.outbox WHERE document_id=$1', [
              f.reservation.documentId,
            ])
          ).rows[0].n,
        ),
      ).toBe(1);
      expect(
        (
          await admin.query('SELECT ciphertext FROM margin_sync.operations WHERE document_id=$1', [
            f.reservation.documentId,
          ])
        ).rows[0].ciphertext.toString(),
      ).not.toContain('Private student answer');
    });
    it('denies OIDC, teacher, peer, tenant and unbound sessions', async () => {
      const f = await ready(),
        other = await ready();
      await expect(
        workApi.describe({ ...f.studentP, authenticationMethod: 'oidc' }),
      ).rejects.toMatchObject({ code: 'student_launch_required' });
      await expect(workApi.describe(f.teacherP)).rejects.toMatchObject({
        code: 'student_launch_required',
      });
      expect((await workApi.describe(f.peerP)).work).toBeNull();
      const view = await workApi.describe(f.studentP);
      if (view.work?.status !== 'provisioned') throw new Error('Missing');
      await expect(
        workApi.append(other.studentP, operation(f, view.work.document.pages[0].id)),
      ).rejects.toMatchObject({ code: 'work_unavailable' });
      await admin.query('DELETE FROM margin_assignments.launch_bindings WHERE session_id=$1', [
        f.studentP.sessionId,
      ]);
      await expect(workApi.describe(f.studentP)).rejects.toMatchObject({
        code: 'work_unavailable',
      });
    });
    it.each([
      { assessment: true },
      { allowExport: false },
      { allowCopyPaste: false },
      { allowReadAloud: false },
    ])('fails closed original delivery for restricted policy %j', async (policy) => {
      const f = await ready(policy);
      await expect(workApi.source(f.studentP)).rejects.toMatchObject({
        code: 'restricted_delivery_unavailable',
      });
      expect((await workApi.describe(f.studentP)).assignment.policy).toMatchObject(policy);
    });
    it('enforces tools and eraser policy, detects conflicts and persists deletes', async () => {
      const f = await ready({ allowedTools: ['text'] });
      const v = await workApi.describe(f.studentP);
      if (v.work?.status !== 'provisioned') throw new Error('Missing');
      const input = operation(f, v.work.document.pages[0].id);
      await workApi.append(f.studentP, input);
      await expect(
        workApi.append(f.studentP, {
          ...input,
          annotation: { ...input.annotation, type: 'rectangle' },
        }),
      ).rejects.toMatchObject({ code: 'assignment_tool_disabled' });
      await expect(
        workApi.append(f.studentP, {
          ...input,
          annotation: { ...input.annotation, text: 'changed' },
        }),
      ).rejects.toMatchObject({ code: 'idempotency_conflict' });
      await expect(
        workApi.append(f.studentP, { ...input, operationId: randomUUID() }),
      ).rejects.toMatchObject({ code: 'annotation_conflict' });
      const { annotation: _, ...base } = input;
      await expect(
        workApi.append(f.studentP, {
          ...base,
          kind: 'delete',
          operationId: randomUUID(),
          baseRevision: 1,
        }),
      ).rejects.toMatchObject({ code: 'assignment_tool_disabled' });
      const g = await ready();
      const gv = await workApi.describe(g.studentP);
      if (gv.work?.status !== 'provisioned') throw new Error('Missing');
      const put = operation(g, gv.work.document.pages[0].id);
      await workApi.append(g.studentP, put);
      const { annotation: __, ...del } = put;
      expect(
        await workApi.append(g.studentP, {
          ...del,
          kind: 'delete',
          operationId: randomUUID(),
          baseRevision: 1,
        }),
      ).toMatchObject({ cursor: 2, annotationRevision: 2 });
    });
    it('allows a fresh verified launch after the originating session is retired', async () => {
      const f = await ready(),
        fresh = { ...f.studentP, sessionId: randomUUID() };
      await admin.query(
        'INSERT INTO margin_identity.sessions(id,session_hash,user_id,organization_id,mfa,created_at,expires_at,idle_expires_at,last_seen_at,revoked_at,authentication_method) SELECT $1,$2,user_id,organization_id,mfa,created_at,expires_at,idle_expires_at,last_seen_at,revoked_at,authentication_method FROM margin_identity.sessions WHERE id=$3',
        [fresh.sessionId, hash(randomUUID()), f.studentP.sessionId],
      );
      await admin.query(
        'INSERT INTO margin_lms.session_bindings SELECT $1,installation_id,registration_version,organization_id,user_id,course_id,subject_digest,course_digest,role,created_at FROM margin_lms.session_bindings WHERE session_id=$2',
        [fresh.sessionId, f.studentP.sessionId],
      );
      await admin.query(
        'INSERT INTO margin_assignments.launch_bindings SELECT $1,installation_id,resource_digest,assignment_id,user_id FROM margin_assignments.launch_bindings WHERE session_id=$2',
        [fresh.sessionId, f.studentP.sessionId],
      );
      await admin.query('DELETE FROM margin_assignments.launch_bindings WHERE session_id=$1', [
        f.studentP.sessionId,
      ]);
      await admin.query('DELETE FROM margin_lms.session_bindings WHERE session_id=$1', [
        f.studentP.sessionId,
      ]);
      await admin.query('DELETE FROM margin_identity.sessions WHERE id=$1', [f.studentP.sessionId]);
      expect((await workApi.describe(fresh)).work?.status).toBe('provisioned');
      await expect(workApi.describe(f.studentP)).rejects.toMatchObject({
        code: 'work_access_denied',
      });
    });
    it.each([
      'source',
      'target',
      'grant',
      'session',
      'student',
      'teacher',
      'installation',
      'resource',
      'receipt',
      'geometry',
    ] as const)('denies current %s revocation or corruption', async (kind) => {
      const f = await ready();
      if (kind === 'source')
        await admin.query(
          'UPDATE margin_ingestion.artifacts SET revoked_at=clock_timestamp() WHERE artifact_id=$1',
          [f.source.identity.artifactId],
        );
      if (kind === 'target')
        await admin.query(
          'UPDATE margin_sync.documents SET deleted_at=clock_timestamp() WHERE id=$1',
          [f.reservation.documentId],
        );
      if (kind === 'grant')
        await admin.query(
          'UPDATE margin_sync.grants SET revoked_at=clock_timestamp() WHERE document_id=$1',
          [f.reservation.documentId],
        );
      if (kind === 'session')
        await admin.query(
          'UPDATE margin_identity.sessions SET revoked_at=clock_timestamp() WHERE id=$1',
          [f.studentP.sessionId],
        );
      if (kind === 'student' || kind === 'teacher')
        await admin.query(
          'UPDATE margin_identity.memberships SET revoked_at=clock_timestamp() WHERE user_id=$1',
          [kind === 'student' ? f.student : f.teacher],
        );
      if (kind === 'installation')
        await admin.query(
          'UPDATE margin_lms.installations SET enabled=false,version=version+1 WHERE id=$1',
          [f.installation],
        );
      if (kind === 'resource') {
        await admin.query('DELETE FROM margin_assignments.launch_bindings WHERE assignment_id=$1', [
          f.assignment.id,
        ]);
        await admin.query('DELETE FROM margin_assignments.resource_links WHERE assignment_id=$1', [
          f.assignment.id,
        ]);
      }
      if (kind === 'receipt')
        await admin.query(
          'UPDATE margin_work.receipts SET ciphertext=set_byte(ciphertext,0,get_byte(ciphertext,0)#1) WHERE work_id=$1',
          [f.reservation.id],
        );
      if (kind === 'geometry')
        await admin.query(
          'UPDATE margin_ingestion.page_geometry SET ciphertext=set_byte(ciphertext,0,get_byte(ciphertext,0)#1) WHERE artifact_id=$1',
          [f.source.identity.artifactId],
        );
      await expect(workApi.describe(f.studentP)).rejects.toThrow();
      await expect(workApi.source(f.studentP)).rejects.toThrow();
      await expect(workApi.catchUp(f.studentP, {})).rejects.toThrow();
    });
    it('keeps KMS and source reads outside transactions and denies revocation during retrieval before releasing bytes', async () => {
      const f = await ready();
      let returned: Buffer | undefined;
      const verifying = {
        wrapKey: (k: Buffer, c: string) => kms.wrapKey(k, c),
        unwrapKey: async (w: Parameters<typeof kms.unwrapKey>[0], c: string) => {
          expect(
            Number(
              (
                await admin.query(
                  "SELECT count(*) n FROM pg_stat_activity WHERE usename='work_api' AND xact_start IS NOT NULL",
                )
              ).rows[0].n,
            ),
          ).toBe(0);
          return kms.unwrapKey(w, c);
        },
      };
      const source: ArtifactReader = {
        async get(identity, receipt) {
          expect(
            Number(
              (
                await admin.query(
                  "SELECT count(*) n FROM pg_stat_activity WHERE usename='work_api' AND xact_start IS NOT NULL",
                )
              ).rows[0].n,
            ),
          ).toBe(0);
          const value = await storage.get(identity, receipt);
          returned = value.bytes;
          await admin.query(
            'UPDATE margin_ingestion.artifacts SET revoked_at=clock_timestamp() WHERE artifact_id=$1',
            [f.source.identity.artifactId],
          );
          return value;
        },
      };
      const service = new PostgresAssignmentWorkService(config('work_api'), verifying, source);
      try {
        await expect(service.source(f.studentP)).rejects.toThrow();
        expect(returned?.every((v) => v === 0)).toBe(true);
      } finally {
        await service.close();
      }
    });
    it.each(['student', 'source'] as const)(
      'does not commit after waiting on concurrent %s revocation',
      async (kind) => {
        const f = await ready(),
          view = await workApi.describe(f.studentP);
        if (view.work?.status !== 'provisioned') throw new Error('Missing');
        const input = operation(f, view.work.document.pages[0].id);
        const revoker = await admin.connect();
        let append: ReturnType<typeof workApi.append> | undefined;
        try {
          await revoker.query('BEGIN');
          await revoker.query(
            kind === 'student'
              ? 'UPDATE margin_identity.memberships SET revoked_at=clock_timestamp() WHERE user_id=$1'
              : 'UPDATE margin_ingestion.artifacts SET revoked_at=clock_timestamp() WHERE artifact_id=$1',
            [kind === 'student' ? f.student : f.source.identity.artifactId],
          );
          append = workApi.append(f.studentP, input);
          append.catch(() => {});
          let blocked = false;
          // Observe arrival independently of the service's unchanged operation/lock timeout.
          const deadline = Date.now() + 5000;
          while (Date.now() < deadline) {
            blocked = Boolean(
              (
                await admin.query(
                  "SELECT 1 FROM pg_stat_activity WHERE usename='work_api' AND wait_event_type='Lock'",
                )
              ).rowCount,
            );
            if (blocked) break;
            await new Promise((r) => setTimeout(r, 10));
          }
          expect(blocked).toBe(true);
          await revoker.query('COMMIT');
          await expect(append).rejects.toThrow();
          expect(
            Number(
              (
                await admin.query(
                  'SELECT count(*) n FROM margin_sync.operations WHERE document_id=$1',
                  [f.reservation.documentId],
                )
              ).rows[0].n,
            ),
          ).toBe(0);
        } finally {
          await revoker.query('ROLLBACK');
          revoker.release();
          await Promise.allSettled([append]);
        }
      },
    );
    it('rolls back all operation effects if outbox insert fails and supports exact retry', async () => {
      const f = await ready(),
        view = await workApi.describe(f.studentP);
      if (view.work?.status !== 'provisioned') throw new Error('Missing');
      const input = operation(f, view.work.document.pages[0].id);
      await admin.query(
        "CREATE FUNCTION margin_work.fixture_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Synthetic outbox failure'; END $$;CREATE TRIGGER fixture_fail BEFORE INSERT ON margin_sync.outbox FOR EACH ROW EXECUTE FUNCTION margin_work.fixture_fail()",
      );
      try {
        await expect(workApi.append(f.studentP, input)).rejects.toThrow('Synthetic outbox failure');
        expect((await workApi.catchUp(f.studentP, {})).currentCursor).toBe(0);
      } finally {
        await admin.query(
          'DROP TRIGGER fixture_fail ON margin_sync.outbox;DROP FUNCTION margin_work.fixture_fail()',
        );
      }
      expect(await workApi.append(f.studentP, input)).toMatchObject({
        cursor: 1,
        duplicate: false,
      });
    });
    it('RLS denies peer keys/content, teacher keys, role writes and structural mutations', async () => {
      const f = await ready(),
        other = await ready();
      await apiContext(f.studentP, async (c) => {
        expect(
          (
            await c.query('SELECT * FROM margin_work.receipts WHERE work_id=$1', [
              other.reservation.id,
            ])
          ).rows,
        ).toEqual([]);
        expect(
          (
            await c.query(
              'SELECT * FROM margin_sync.document_keys WHERE document_id=ANY($1::uuid[])',
              [[f.documentId, other.reservation.documentId]],
            )
          ).rows,
        ).toEqual([]);
        expect(
          (
            await c.query('SELECT * FROM margin_sync.operations WHERE document_id=$1', [
              other.reservation.documentId,
            ])
          ).rows,
        ).toEqual([]);
        await expect(
          c.query('UPDATE margin_sync.documents SET id=$1 WHERE id=$2', [
            randomUUID(),
            f.reservation.documentId,
          ]),
        ).rejects.toThrow('permission denied');
      });
      await apiContext(f.studentP, async (c) => {
        await expect(
          c.query("UPDATE margin_assignments.student_work SET status='provisioned' WHERE id=$1", [
            f.reservation.id,
          ]),
        ).rejects.toThrow('permission denied');
      });
      await apiContext(f.peerP, async (c) => {
        expect(
          (
            await c.query('SELECT * FROM margin_sync.document_keys WHERE document_id=$1', [
              f.reservation.documentId,
            ])
          ).rows,
        ).toEqual([]);
      });
    });
    it('keeps saved annotations available during an object outage without claiming content delivery', async () => {
      const f = await ready(),
        view = await workApi.describe(f.studentP);
      if (view.work?.status !== 'provisioned') throw new Error('Missing');
      const input = operation(f, view.work.document.pages[0].id);
      await workApi.append(f.studentP, input);
      objects.delete(f.source.identity.artifactId);
      await expect(workApi.source(f.studentP)).rejects.toThrow('unavailable');
      expect((await workApi.catchUp(f.studentP, {})).operations).toHaveLength(1);
    });
    it.each([true, false])(
      'rejects owner and provisioner membership inherited=%s',
      async (inherit) => {
        const f = await ready();
        await withTableOwnerMembership(
          admin,
          config('work_api'),
          'margin_work.receipts',
          'margin_assignment_work_runtime',
          inherit,
          async (unsafe) => {
            const service = new PostgresAssignmentWorkService(unsafe, kms, storage);
            try {
              await expect(service.describe(f.studentP)).rejects.toThrow('least-privilege');
            } finally {
              await service.close();
            }
          },
        );
        await withAssignmentProvisionerMembership(
          admin,
          config('work_api'),
          'margin_assignment_work_runtime',
          inherit,
          async (unsafe) => {
            const service = new PostgresAssignmentWorkService(unsafe, kms, storage);
            try {
              await expect(service.describe(f.studentP)).rejects.toThrow('least-privilege');
            } finally {
              await service.close();
            }
          },
        );
      },
    );
    it.each(['wrong-hash', 'wrong-type'] as const)(
      'rejects and clears %s source results',
      async (kind) => {
        const f = await ready();
        const bytes = Buffer.from(kind === 'wrong-hash' ? 'wrong' : body);
        const source: ArtifactReader = {
          async get() {
            return {
              bytes,
              metadata: {
                name: 'ignored.pdf',
                mimeType: kind === 'wrong-type' ? 'text/plain' : 'application/pdf',
              },
            };
          },
        };
        const service = new PostgresAssignmentWorkService(config('work_api'), kms, source);
        try {
          await expect(service.source(f.studentP)).rejects.toMatchObject({
            code: 'work_integrity',
          });
          expect(bytes.every((v) => v === 0)).toBe(true);
        } finally {
          await service.close();
        }
      },
    );
    it('rejects wrapped receipt key corruption and source binding tampering', async () => {
      const f = await ready(),
        g = await ready();
      await admin.query(
        'UPDATE margin_work.receipts SET wrapped_key=(SELECT wrapped_key FROM margin_work.receipts WHERE work_id=$1) WHERE work_id=$2',
        [g.reservation.id, f.reservation.id],
      );
      await expect(workApi.describe(f.studentP)).rejects.toMatchObject({ code: 'work_integrity' });
      await admin.query('UPDATE margin_work.receipts SET source_artifact_id=$1 WHERE work_id=$2', [
        f.source.identity.artifactId,
        g.reservation.id,
      ]);
      await expect(workApi.source(g.studentP)).rejects.toMatchObject({ code: 'work_integrity' });
    });
    it('rechecks current authority after slow key unwrapping before committing any operation', async () => {
      const f = await ready(),
        view = await workApi.describe(f.studentP);
      if (view.work?.status !== 'provisioned') throw new Error('Missing');
      const input = operation(f, view.work.document.pages[0].id);
      const revoking = {
        wrapKey: (k: Buffer, c: string) => kms.wrapKey(k, c),
        unwrapKey: async (w: Parameters<typeof kms.unwrapKey>[0], c: string) => {
          const key = await kms.unwrapKey(w, c);
          if (c.startsWith('margin-sync-document-v1:'))
            await admin.query(
              'UPDATE margin_identity.sessions SET revoked_at=clock_timestamp() WHERE id=$1',
              [f.studentP.sessionId],
            );
          return key;
        },
      };
      const service = new PostgresAssignmentWorkService(config('work_api'), revoking, storage);
      try {
        await expect(service.append(f.studentP, input)).rejects.toThrow();
        expect(
          Number(
            (
              await admin.query(
                'SELECT count(*) n FROM margin_sync.operations WHERE document_id=$1',
                [f.reservation.documentId],
              )
            ).rows[0].n,
          ),
        ).toBe(0);
      } finally {
        await service.close();
      }
    });
    it('bounds abort-ignoring source readers and clears late results', async () => {
      const f = await ready(),
        release: Array<(value: { bytes: Buffer; metadata: typeof metadata }) => void> = [];
      const stalled: ArtifactReader = {
        get: () => new Promise((resolve) => release.push(resolve)),
      };
      const service = new PostgresAssignmentWorkService(config('work_api'), kms, stalled);
      try {
        for (let i = 0; i < 2; i++) {
          const controller = new AbortController();
          const request = service.source(f.studentP, { signal: controller.signal });
          request.catch(() => {});
          // Observe arrival independently of the service's unchanged operation/lock timeout.
          const deadline = Date.now() + 5000;
          while (release.length <= i && Date.now() < deadline)
            await new Promise((r) => setTimeout(r, 5));
          expect(release.length).toBe(i + 1);
          controller.abort();
          await expect(request).rejects.toThrow('interrupted');
        }
        await expect(service.source(f.studentP)).rejects.toMatchObject({
          code: 'source_reader_busy',
        });
      } finally {
        const bytes = release.map(() => Buffer.from(body));
        release.forEach((r, i) => r({ bytes: bytes[i], metadata }));
        await new Promise((r) => setTimeout(r, 10));
        expect(bytes.every((b) => b.every((v) => v === 0))).toBe(true);
        await service.close();
      }
    });
  },
);
