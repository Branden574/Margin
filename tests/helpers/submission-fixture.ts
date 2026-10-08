import { PostgresAssignmentWorkService } from '../../apps/api/src/assignments/work';
import type { AssignmentPolicy } from '../../apps/api/src/assignments/types';
import { expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Pool, type PoolClient } from 'pg';
import { stopDisposablePostgres } from './postgres';
import { LocalKeyProvider } from '../../apps/api/src/encryption';
import { PostgresIngestionRepository, type ArtifactReader } from '../../apps/api/src/ingestion';
import { PostgresAssignmentRepository } from '../../apps/api/src/assignments';
import { PostgresStudentWorkProvisioner } from '../../apps/api/src/assignments/provisioning';
import type { SessionPrincipal } from '../../apps/api/src/identity/types';
import type { VerifiedLmsEnrollment } from '../../apps/api/src/lms/types';
import type { ArtifactReceipt } from '../../apps/api/src/cloud/types';
import { canonical } from '../../apps/api/src/sync/validation';
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
const config = (user: string) => ({ host: socket, port: 55505, user, database: 'postgres' });
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
  let discard = false;
  try {
    await client.query('BEGIN');
    await run(client);
    await client.query('COMMIT');
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackError) {
      discard = true;
      throw new AggregateError([error, rollbackError], 'Fixture rollback failed');
    }
    throw error;
  } finally {
    client.release(discard);
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

async function boot(
  options: { materialization?: boolean; processingStatus?: boolean; review?: boolean } = {},
) {
  if (!available) throw new Error('Required PostgreSQL binaries unavailable');
  dir = mkdtempSync(join(tmpdir(), 'margin-submission-pg-'));
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
      `-k ${socket} -h '' -p 55505`,
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
    '008-authorization-plan-cache.sql',
    '009-submissions.sql',
    ...(options.materialization || options.processingStatus || options.review
      ? ['010-submission-materialization.sql']
      : []),
    ...(options.processingStatus || options.review ? ['011-submission-outcomes.sql'] : []),
    ...(options.review ? ['012-submission-review.sql'] : []),
  ]) {
    await admin.query(
      readFileSync(new URL('../../infra/migrations/' + name, import.meta.url), 'utf8'),
    );
  }
  for (const [login, group] of [
    ['work_api', 'margin_assignment_work_runtime'],
    ['submission_api', 'margin_submission_runtime'],
    ['work_runtime', 'margin_assignments_runtime'],
    ['work_worker', 'margin_assignment_provisioner'],
    ['work_sync', 'margin_sync_runtime'],
    ['work_ingest', 'margin_ingestion_runtime'],
    ['work_inspect', 'margin_ingestion_inspector'],
    ['work_read', 'margin_ingestion_reader'],
    ...(options.materialization || options.processingStatus || options.review
      ? [['submission_processor', 'margin_submission_processor']]
      : []),
    ...(options.review ? [['submission_reviewer', 'margin_submission_reviewer']] : []),
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
}
async function stop() {
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
}
export const submissionFixture = {
  available,
  boot,
  stop,
  ready,
  fixture,
  operation,
  config,
  kms,
  storage,
  body,
  objects,
  get admin() {
    return admin;
  },
  get workApi() {
    return workApi;
  },
  get runtime() {
    return runtime;
  },
  get inspector() {
    return inspector;
  },
  get reader() {
    return reader;
  },
  get assignments() {
    return assignments;
  },
  get sqlApi() {
    return sqlApi;
  },
  get worker() {
    return worker;
  },
};
