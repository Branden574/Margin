import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { withTableOwnerMembership } from './helpers/owner-role';
import { withAssignmentProvisionerMembership } from './helpers/provisioner-role';
import { recheckReadyManifest } from '../apps/api/src/ingestion/postgres';
import { PostgresIdentityRepository } from '../apps/api/src/identity/postgres';
import { PostgresLmsRepository } from '../apps/api/src/lms/postgres';
import { SyncPool } from '../apps/api/src/sync/pool';
import { stopDisposablePostgres } from './helpers/postgres';
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Pool } from 'pg';
import { LocalKeyProvider, type KeyManagementProvider } from '../apps/api/src/encryption';
import {
  PostgresIngestionRepository,
  IngestionAssignmentSourceGateway,
  SourceInspectionWorker,
  type ArtifactReader,
  type SourceReservationInput,
  type InspectionReport,
} from '../apps/api/src/ingestion/index';
import type { SessionPrincipal } from '../apps/api/src/identity/types';
import type { ArtifactReceipt } from '../apps/api/src/cloud/types';
const available = ['initdb', 'pg_ctl'].every((t) => {
  try {
    execFileSync(t, ['--version'], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
});
if (process.env.MARGIN_REQUIRE_POSTGRES_TESTS === '1' && !available)
  throw new Error('Required ingestion PostgreSQL binaries are unavailable.');
const hash = (v: string | Buffer) => createHash('sha256').update(v).digest('hex');
const org = randomUUID(),
  teacher = randomUUID(),
  peer = randomUUID(),
  student = randomUUID(),
  installation = randomUUID(),
  course = randomUUID(),
  course2 = randomUUID();
const body = Buffer.from(
  '%PDF-1.7\nExplicit synthetic inspection fixture. This is not a real scanner fixture.\n%%EOF',
);
const metadata = {
  name: 'Private synthetic biology worksheet.pdf',
  mimeType: 'application/pdf' as const,
};
const kms = new LocalKeyProvider(randomBytes(32), 'ingestion-synthetic-fixture');
let dir: string,
  socket: string,
  started = false,
  admin: Pool,
  sqlRuntime: Pool,
  sqlWorker: Pool,
  sqlReader: Pool,
  runtime: PostgresIngestionRepository,
  inspector: PostgresIngestionRepository,
  reader: PostgresIngestionRepository,
  p: SessionPrincipal,
  peerP: SessionPrincipal,
  studentP: SessionPrincipal,
  otherCourseP: SessionPrincipal;
const config = (user: string) => ({ host: socket, port: 55494, user, database: 'postgres' });
const receipt = (): ArtifactReceipt => ({
  objectVersionId: 'synthetic-version-' + randomUUID(),
  etag: '"synthetic-etag"',
  ciphertextSha256: hash('synthetic-ciphertext'),
  storedBytes: body.length + 1000,
});
const goodReport = (): InspectionReport => ({
  verdict: 'ready',
  plaintextBytes: body.length,
  plaintextSha256: hash(body),
  engine: 'synthetic-test-double',
  engineVersion: '1',
  definitionsVersion: 'fixture-only',
  pageCount: 1,
  reason: 'clean',
});
const objects = new Map<string, ArtifactReceipt>();
const syntheticStorage: ArtifactReader = {
  async get(identity, receipt) {
    if (JSON.stringify(objects.get(identity.artifactId)) !== JSON.stringify(receipt))
      throw new Error('Exact synthetic object version unavailable');
    return { bytes: Buffer.from(body), metadata };
  },
};
async function session(
  user: string,
  role: 'teacher' | 'student',
  courseId = course,
): Promise<SessionPrincipal> {
  const now = Date.now(),
    s: SessionPrincipal = {
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
  await admin.query(
    "INSERT INTO margin_identity.sessions(id,session_hash,user_id,organization_id,mfa,authentication_method,created_at,expires_at,idle_expires_at,last_seen_at) VALUES($1,$2,$3,$4,false,'lti',$5,$6,$6,$5)",
    [s.sessionId, hash(randomUUID()), user, org, new Date(now), new Date(s.expiresAt)],
  );
  await admin.query(
    'INSERT INTO margin_lms.session_bindings(session_id,installation_id,registration_version,organization_id,user_id,course_id,subject_digest,course_digest,role) VALUES($1,$2,1,$3,$4,$5,$6,$7,$8)',
    [s.sessionId, installation, org, user, courseId, hash(user), hash(courseId), role],
  );
  return s;
}
async function source(actor = p) {
  const doc = randomUUID(),
    version = randomUUID(),
    c = await admin.connect();
  try {
    await c.query('BEGIN');
    await c.query(
      "INSERT INTO margin_sync.documents(organization_id,id,owner_id,current_version_id,audience) VALUES($1,$2,$3,$4,'teachers')",
      [actor.organizationId, doc, actor.userId, version],
    );
    await c.query(
      'INSERT INTO margin_sync.versions(organization_id,document_id,id) VALUES($1,$2,$3)',
      [actor.organizationId, doc, version],
    );
    await c.query(
      "INSERT INTO margin_sync.grants(organization_id,document_id,user_id,permission) VALUES($1,$2,$3,'owner')",
      [actor.organizationId, doc, actor.userId],
    );
    await c.query('COMMIT');
  } finally {
    c.release();
  }
  const input: SourceReservationInput = {
    requestId: randomUUID(),
    documentId: doc,
    versionId: version,
    metadata,
    plaintextBytes: body.length,
    plaintextSha256: hash(body),
  };
  return { input, reserved: await runtime.reserve(actor, input) };
}
async function staged() {
  const s = await source();
  const object = receipt();
  objects.set(s.reserved.identity.artifactId, object);
  await runtime.stageConfirmed(p, s.reserved.identity.artifactId, object);
  return { ...s, object };
}
async function approved() {
  const s = await staged(),
    claim = (await inspector.claimNext())!;
  expect(claim.identity.artifactId).toBe(s.reserved.identity.artifactId);
  const inspected = await inspector.complete(claim, goodReport()),
    manifest = (await runtime.readyForTeacher(p, s.input))!;
  return { ...s, claim, inspected, manifest };
}
const gateway = () => new IngestionAssignmentSourceGateway(runtime, reader, syntheticStorage);
describe.skipIf(!available)(
  'Durable ingestion with real PostgreSQL and explicit synthetic storage/scanner providers',
  () => {
    beforeAll(async () => {
      dir = mkdtempSync(join(tmpdir(), 'margin-ingestion-pg-'));
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
          `-k ${socket} -h '' -p 55494`,
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
        '005-ingestion.sql',
      ])
        await admin.query(
          readFileSync(new URL('../infra/migrations/' + name, import.meta.url), 'utf8'),
        );
      for (const purpose of ['runtime', 'inspector', 'reader'])
        await admin.query(
          `CREATE ROLE ingestion_${purpose}_test LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS; GRANT margin_ingestion_${purpose} TO ingestion_${purpose}_test`,
        );
      sqlRuntime = new Pool(config('ingestion_runtime_test'));
      sqlWorker = new Pool(config('ingestion_inspector_test'));
      sqlReader = new Pool(config('ingestion_reader_test'));
      runtime = new PostgresIngestionRepository(config('ingestion_runtime_test'), kms, 'runtime');
      inspector = new PostgresIngestionRepository(
        config('ingestion_inspector_test'),
        kms,
        'inspector',
      );
      reader = new PostgresIngestionRepository(config('ingestion_reader_test'), kms, 'reader');
      await admin.query('INSERT INTO margin_identity.organizations(id) VALUES($1)', [org]);
      for (const [user, role] of [
        [teacher, 'teacher'],
        [peer, 'teacher'],
        [student, 'student'],
      ]) {
        await admin.query('INSERT INTO margin_identity.users(id,identity_key) VALUES($1,$2)', [
          user,
          hash(user),
        ]);
        await admin.query(
          'INSERT INTO margin_identity.memberships(organization_id,user_id,role) VALUES($1,$2,$3)',
          [org, user, role],
        );
      }
      await admin.query(
        "INSERT INTO margin_lms.installations(id,organization_id,issuer,client_id,deployment_id,version,enabled,configuration) VALUES($1,$2,'https://canvas.test','synthetic-client','synthetic-deployment',1,true,'{}')",
        [installation, org],
      );
      for (const cid of [course, course2])
        await admin.query(
          'INSERT INTO margin_lms.courses(installation_id,organization_id,external_digest,course_id) VALUES($1,$2,$3,$4)',
          [installation, org, hash(cid), cid],
        );
      for (const [user, role] of [
        [teacher, 'teacher'],
        [peer, 'teacher'],
        [student, 'student'],
      ]) {
        await admin.query(
          'INSERT INTO margin_lms.user_links(installation_id,organization_id,subject_digest,user_id) VALUES($1,$2,$3,$4)',
          [installation, org, hash(user), user],
        );
        for (const cid of [course, course2])
          await admin.query(
            'INSERT INTO margin_lms.enrollments(installation_id,organization_id,course_id,user_id,role) VALUES($1,$2,$3,$4,$5)',
            [installation, org, cid, user, role],
          );
      }
      p = await session(teacher, 'teacher');
      peerP = await session(peer, 'teacher');
      studentP = await session(student, 'student');
      otherCourseP = await session(teacher, 'teacher', course2);
    }, 30000);
    afterEach(async () => {
      if (admin)
        await admin.query(
          'UPDATE margin_ingestion.artifacts SET revoked_at=COALESCE(revoked_at,clock_timestamp())',
        );
      objects.clear();
    });
    afterAll(async () => {
      const errors: unknown[] = [];

      const closed = await Promise.allSettled([
        runtime?.close(),
        inspector?.close(),
        reader?.close(),
        sqlRuntime?.end(),
        sqlWorker?.end(),
        sqlReader?.end(),
        admin?.end(),
      ]);
      for (const result of closed) if (result.status === 'rejected') errors.push(result.reason);
      let stopped = !started;
      try {
        if (started) await stopDisposablePostgres(join(dir, 'data'));
        stopped = true;
      } catch (error) {
        errors.push(error);
      }
      // Keep diagnostics/data if shutdown could not be confirmed; never delete a running fixture.
      if (stopped && dir) {
        try {
          rmSync(dir, { recursive: true, force: true });
        } catch (error) {
          errors.push(error);
        }
      }
      if (errors.length) throw new AggregateError(errors, 'PostgreSQL fixture cleanup failed.');
    }, 15000);
    it('reserves stable immutable IDs, deduplicates concurrent requests and encrypts private metadata', async () => {
      const s = await source();
      const copies = await Promise.all([runtime.reserve(p, s.input), runtime.reserve(p, s.input)]);
      expect(
        copies.every(
          (v) => v.duplicate && v.identity.artifactId === s.reserved.identity.artifactId,
        ),
      ).toBe(true);
      expect(s.reserved.status).toBe('pending');
      await expect(
        runtime.reserve(p, {
          ...s.input,
          metadata: { ...metadata, name: 'Other private name.pdf' },
        }),
      ).rejects.toMatchObject({ code: 'idempotency_conflict' });
      const raw = (
        await admin.query(
          'SELECT row_to_json(a)::text AS value FROM margin_ingestion.artifacts a WHERE artifact_id=$1',
          [s.reserved.identity.artifactId],
        )
      ).rows[0].value;
      expect(raw).not.toContain(metadata.name);
      expect(raw).not.toContain(hash(body));
      expect(raw).not.toContain('application/pdf');
      expect(await gateway().resolveForTeacher(p, s.input)).toBeNull();
      expect(await inspector.claimNext()).toBeNull();
    });
    it('stages only a complete exact receipt and atomically queues quarantine once', async () => {
      const s = await source(),
        object = receipt();
      await expect(
        runtime.stageConfirmed(p, s.reserved.identity.artifactId, {
          ...object,
          objectVersionId: 'null',
        }),
      ).rejects.toMatchObject({ code: 'unconfirmed_artifact' });
      expect((await admin.query('SELECT * FROM margin_ingestion.inspection_jobs')).rowCount).toBe(
        0,
      );
      const out = await Promise.all([
        runtime.stageConfirmed(p, s.reserved.identity.artifactId, object),
        runtime.stageConfirmed(p, s.reserved.identity.artifactId, object),
      ]);
      expect(out.map((v) => v.duplicate).sort()).toEqual([false, true]);
      expect(out[0].status).toBe('quarantined');
      await expect(
        runtime.stageConfirmed(p, s.reserved.identity.artifactId, receipt()),
      ).rejects.toMatchObject({ code: 'receipt_conflict' });
      expect(
        (
          await admin.query('SELECT * FROM margin_ingestion.inspection_jobs WHERE artifact_id=$1', [
            s.reserved.identity.artifactId,
          ])
        ).rowCount,
      ).toBe(1);
      expect(await gateway().resolveForTeacher(p, s.input)).toBeNull();
    });
    it('keeps uncertain uploads pending and rolls back storage receipt when atomic queue insertion fails', async () => {
      const s = await source();
      const failKms: KeyManagementProvider = {
        wrapKey: async () => {
          throw new Error('synthetic KMS unavailable');
        },
        unwrapKey: (e, c) => kms.unwrapKey(e, c),
      };
      const broken = new PostgresIngestionRepository(
        config('ingestion_runtime_test'),
        failKms,
        'runtime',
      );
      try {
        await expect(
          broken.stageConfirmed(p, s.reserved.identity.artifactId, receipt()),
        ).rejects.toThrow('synthetic KMS unavailable');
      } finally {
        await broken.close();
      }
      expect((await runtime.get(p, s.reserved.identity.artifactId))?.status).toBe('pending');
      await admin.query(
        "CREATE FUNCTION margin_ingestion.fixture_fail_queue() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic queue failure'; END $$; CREATE TRIGGER fixture_fail_queue BEFORE INSERT ON margin_ingestion.inspection_jobs FOR EACH ROW EXECUTE FUNCTION margin_ingestion.fixture_fail_queue()",
      );
      try {
        await expect(
          runtime.stageConfirmed(p, s.reserved.identity.artifactId, receipt()),
        ).rejects.toThrow('synthetic queue failure');
        expect(
          (
            await admin.query(
              'SELECT * FROM margin_ingestion.storage_receipts WHERE artifact_id=$1',
              [s.reserved.identity.artifactId],
            )
          ).rowCount,
        ).toBe(0);
      } finally {
        await admin.query(
          'DROP TRIGGER fixture_fail_queue ON margin_ingestion.inspection_jobs; DROP FUNCTION margin_ingestion.fixture_fail_queue()',
        );
      }
    });
    it('denies peer, other-course, forged tenant, student, absent session and revoked owner-grant access', async () => {
      const s = await source();
      expect(await runtime.get(peerP, s.reserved.identity.artifactId)).toBeNull();
      expect(await runtime.get(otherCourseP, s.reserved.identity.artifactId)).toBeNull();
      await expect(
        runtime.stageConfirmed(peerP, s.reserved.identity.artifactId, receipt()),
      ).rejects.toMatchObject({ code: 'source_unavailable' });
      await expect(
        runtime.reserve(peerP, { ...s.input, requestId: randomUUID() }),
      ).rejects.toMatchObject({ code: 'source_ownership' });
      await expect(runtime.reserve(studentP, s.input)).rejects.toMatchObject({
        code: 'ingestion_access',
      });
      await expect(
        runtime.get({ ...p, organizationId: randomUUID() }, s.reserved.identity.artifactId),
      ).rejects.toMatchObject({ code: 'ingestion_access' });
      await expect(
        runtime.get({ ...p, sessionId: randomUUID() }, s.reserved.identity.artifactId),
      ).rejects.toMatchObject({ code: 'ingestion_access' });
      await admin.query('UPDATE margin_sync.grants SET revoked_at=now() WHERE document_id=$1', [
        s.input.documentId,
      ]);
      expect(await runtime.get(p, s.reserved.identity.artifactId)).toBeNull();
    });
    it('enforces separate credentials and forced RLS; runtime cannot approve, forge scan receipts or replace manifests', async () => {
      const s = await staged();
      for (const table of [
        'artifacts',
        'storage_receipts',
        'inspection_jobs',
        'inspection_receipts',
      ]) {
        expect((await sqlRuntime.query(`SELECT * FROM margin_ingestion.${table}`)).rowCount).toBe(
          0,
        );
        expect((await sqlReader.query(`SELECT * FROM margin_ingestion.${table}`)).rowCount).toBe(0);
      }
      await expect(
        sqlRuntime.query("UPDATE margin_ingestion.inspection_jobs SET status='ready'"),
      ).rejects.toMatchObject({ code: '42501' });
      await expect(
        sqlRuntime.query('UPDATE margin_ingestion.storage_receipts SET ciphertext=$1', [
          Buffer.from('fake'),
        ]),
      ).rejects.toMatchObject({ code: '42501' });
      await expect(
        sqlRuntime.query('INSERT INTO margin_ingestion.inspection_receipts(id) VALUES($1)', [
          randomUUID(),
        ]),
      ).rejects.toMatchObject({ code: '42501' });
      await expect(runtime.claimNext()).rejects.toMatchObject({ code: 'ingestion_role' });
      const unsafe = new PostgresIngestionRepository(config('postgres'), kms, 'inspector');
      try {
        await expect(unsafe.claimNext()).rejects.toThrow('least-privilege');
      } finally {
        await unsafe.close();
      }
      const flags = await admin.query(
        "SELECT relrowsecurity,relforcerowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='margin_ingestion' AND c.relkind='r'",
      );
      expect(flags.rows.every((v) => v.relrowsecurity && v.relforcerowsecurity)).toBe(true);
      await admin.query('GRANT margin_ingestion_inspector TO ingestion_runtime_test');
      try {
        await expect(runtime.get(p, s.reserved.identity.artifactId)).rejects.toThrow(
          'least-privilege',
        );
      } finally {
        await admin.query('REVOKE margin_ingestion_inspector FROM ingestion_runtime_test');
      }
    });
    it('claims once under concurrency and binds the result to exact content, version, attempt and lease', async () => {
      const s = await staged(),
        claims = await Promise.all([inspector.claimNext(), inspector.claimNext()]),
        claim = claims.find(Boolean)!;
      expect(claims.filter(Boolean)).toHaveLength(1);
      await expect(
        inspector.complete({ ...claim, token: 'a'.repeat(64) }, goodReport()),
      ).rejects.toMatchObject({ code: 'stale_inspection' });
      await expect(
        inspector.complete(claim, { ...goodReport(), plaintextSha256: hash('wrong') }),
      ).rejects.toMatchObject({ code: 'inspection_content_mismatch' });
      await expect(
        inspector.complete(
          { ...claim, receipt: { ...claim.receipt, objectVersionId: 'another-version' } },
          goodReport(),
        ),
      ).rejects.toMatchObject({ code: 'inspection_content_mismatch' });
      expect(
        (
          await admin.query(
            'SELECT * FROM margin_ingestion.inspection_receipts WHERE artifact_id=$1',
            [s.reserved.identity.artifactId],
          )
        ).rowCount,
      ).toBe(0);
      const done = await inspector.complete(claim, goodReport());
      expect(done.status).toBe('ready');
      expect(await inspector.complete(claim, goodReport())).toMatchObject({
        id: done.id,
        duplicate: true,
      });
      await expect(
        inspector.complete(claim, { ...goodReport(), pageCount: 2 }),
      ).rejects.toMatchObject({ code: 'inspection_conflict' });
    });
    it('reclaims expired leases, rejects stale completion, bounds retries, and leaves exhaustion quarantined', async () => {
      const s = await staged(),
        old = (await inspector.claimNext())!;
      // Migration-owner-only fixture clock manipulation, never a runtime/worker capability.
      await admin.query('ALTER TABLE margin_ingestion.inspection_jobs DISABLE TRIGGER protect_job');
      try {
        await admin.query(
          "UPDATE margin_ingestion.inspection_jobs SET lease_expires_at=now()-interval '1 second' WHERE artifact_id=$1",
          [s.reserved.identity.artifactId],
        );
      } finally {
        await admin.query(
          'ALTER TABLE margin_ingestion.inspection_jobs ENABLE TRIGGER protect_job',
        );
      }
      const next = (await inspector.claimNext())!;
      expect(next.attempt).toBe(2);
      await expect(inspector.complete(old, goodReport())).rejects.toMatchObject({
        code: 'stale_inspection',
      });
      await expect(inspector.retry(next, 0)).rejects.toMatchObject({ code: 'invalid_retry' });
      await inspector.retry(next, 1);
      expect(await inspector.claimNext()).toBeNull();
      await admin.query('ALTER TABLE margin_ingestion.inspection_jobs DISABLE TRIGGER protect_job');
      try {
        await admin.query(
          "UPDATE margin_ingestion.inspection_jobs SET attempt=10,next_attempt_at=now()-interval '1 second' WHERE artifact_id=$1",
          [s.reserved.identity.artifactId],
        );
      } finally {
        await admin.query(
          'ALTER TABLE margin_ingestion.inspection_jobs ENABLE TRIGGER protect_job',
        );
      }
      expect(await inspector.claimNext()).toBeNull();
      expect((await runtime.get(p, s.reserved.identity.artifactId))?.status).toBe('quarantined');
    });
    it('resolves only approved owned exact versions and checks actual object bytes on every availability lookup', async () => {
      const s = await approved(),
        g = gateway();
      expect(await g.resolveForTeacher(p, s.input)).toEqual(s.manifest.source);
      expect(await g.stillAvailable(s.manifest.source)).toBe(true);
      expect(await g.resolveForTeacher(peerP, s.input)).toBeNull();
      expect(await g.resolveForTeacher(otherCourseP, s.input)).toBeNull();
      expect(
        await g.stillAvailable({ ...s.manifest.source, artifactVersion: 'another-version' }),
      ).toBe(false);
      expect(await g.stillAvailable({ ...s.manifest.source, organizationId: randomUUID() })).toBe(
        false,
      );
      objects.delete(s.reserved.identity.artifactId);
      expect(await g.stillAvailable(s.manifest.source)).toBe(false);
      expect(await g.resolveForTeacher(p, s.input)).toBeNull();
    });
    it('does not trust a ready snapshot after source/course/owner revocation or object mutation', async () => {
      const s = await approved(),
        g = gateway();
      let returned: Buffer | undefined;
      const corrupt = new IngestionAssignmentSourceGateway(runtime, reader, {
        async get() {
          returned = Buffer.from('modified object');
          return { bytes: returned, metadata };
        },
      });
      expect(await corrupt.stillAvailable(s.manifest.source)).toBe(false);
      expect(returned?.every((v) => v === 0)).toBe(true);
      await admin.query(
        'UPDATE margin_lms.enrollments SET disabled_at=now() WHERE user_id=$1 AND course_id=$2',
        [teacher, course],
      );
      try {
        expect(await g.stillAvailable(s.manifest.source)).toBe(false);
        await expect(g.resolveForTeacher(p, s.input)).rejects.toMatchObject({
          code: 'ingestion_revoked',
        });
      } finally {
        await admin.query(
          'UPDATE margin_lms.enrollments SET disabled_at=NULL WHERE user_id=$1 AND course_id=$2',
          [teacher, course],
        );
      }
      await inspector.revoke(s.reserved.identity.artifactId);
      expect(await g.stillAvailable(s.manifest.source)).toBe(false);
    });
    it('rechecks revocation after storage I/O and current sessions after they expire/revoke', async () => {
      const s = await approved();
      const g = new IngestionAssignmentSourceGateway(runtime, reader, {
        async get(i, r) {
          await inspector.revoke(i.artifactId);
          return syntheticStorage.get(i, r);
        },
      });
      expect(await g.stillAvailable(s.manifest.source)).toBe(false);
      const fresh = await session(teacher, 'teacher');
      await admin.query('UPDATE margin_identity.sessions SET revoked_at=now() WHERE id=$1', [
        fresh.sessionId,
      ]);
      await expect(runtime.get(fresh, s.reserved.identity.artifactId)).rejects.toMatchObject({
        code: 'ingestion_revoked',
      });
    });
    it('detects encrypted receipt/inspection tampering and prevents inspection rollback', async () => {
      const s = await approved();
      await expect(
        sqlWorker.query(
          "UPDATE margin_ingestion.inspection_jobs SET status='quarantined',scan_receipt_id=NULL,completed_at=NULL WHERE artifact_id=$1",
          [s.reserved.identity.artifactId],
        ),
      ).rejects.toThrow('immutable');
      await admin.query(
        'UPDATE margin_ingestion.inspection_receipts SET ciphertext=set_byte(ciphertext,0,get_byte(ciphertext,0)#1) WHERE id=$1',
        [s.inspected.id],
      );
      await expect(gateway().stillAvailable(s.manifest.source)).rejects.toMatchObject({
        code: 'ingestion_integrity',
      });
    });
    it('commits readiness and encrypted inspection receipt atomically and recovers after transaction failure', async () => {
      const s = await staged(),
        claim = (await inspector.claimNext())!;
      await admin.query(
        "CREATE FUNCTION margin_ingestion.fixture_fail_decision() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic decision failure'; END $$; CREATE TRIGGER fixture_fail_decision BEFORE UPDATE ON margin_ingestion.inspection_jobs FOR EACH ROW WHEN (NEW.status='ready') EXECUTE FUNCTION margin_ingestion.fixture_fail_decision()",
      );
      try {
        await expect(inspector.complete(claim, goodReport())).rejects.toThrow(
          'synthetic decision failure',
        );
        expect(
          (
            await admin.query(
              'SELECT * FROM margin_ingestion.inspection_receipts WHERE artifact_id=$1',
              [s.reserved.identity.artifactId],
            )
          ).rowCount,
        ).toBe(0);
        expect((await runtime.get(p, s.reserved.identity.artifactId))?.status).toBe('quarantined');
      } finally {
        await admin.query(
          'DROP TRIGGER fixture_fail_decision ON margin_ingestion.inspection_jobs; DROP FUNCTION margin_ingestion.fixture_fail_decision()',
        );
      }
      expect((await inspector.complete(claim, goodReport())).status).toBe('ready');
      const fresh = new PostgresIngestionRepository(config('ingestion_reader_test'), kms, 'reader');
      try {
        const manifest = (await runtime.readyForTeacher(p, s.input))!;
        expect((await fresh.readySnapshot(manifest.source))?.receipt).toEqual(s.object);
      } finally {
        await fresh.close();
      }
    });
    it('runs a bounded worker flow with an explicitly synthetic clean scanner and clears plaintext', async () => {
      const s = await staged();
      let captured: Uint8Array | undefined;
      const worker = new SourceInspectionWorker(inspector, syntheticStorage, {
        async inspect(bytes) {
          captured = bytes;
          return goodReport();
        },
      });
      const result = await worker.runOne();
      expect(result?.status).toBe('ready');
      expect(captured?.every((v) => v === 0)).toBe(true);
      expect(await gateway().resolveForTeacher(p, s.input)).not.toBeNull();
    });
    it('rejects bytes that differ from reservation before scanning and never promotes failed/unknown scans', async () => {
      const s = await staged();
      let called = false;
      const worker = new SourceInspectionWorker(
        inspector,
        {
          async get() {
            return { bytes: Buffer.from('wrong bytes'), metadata };
          },
        },
        {
          async inspect() {
            called = true;
            return goodReport();
          },
        },
      );
      expect((await worker.runOne())?.status).toBe('rejected');
      expect(called).toBe(false);
      expect(await gateway().resolveForTeacher(p, s.input)).toBeNull();
      const other = await staged();
      const failing = new SourceInspectionWorker(inspector, syntheticStorage, {
        async inspect() {
          throw new Error('synthetic scanner outage');
        },
      });
      await expect(failing.runOne()).rejects.toThrow('synthetic scanner outage');
      expect((await runtime.get(p, other.reserved.identity.artifactId))?.status).toBe(
        'quarantined',
      );
      expect(await gateway().resolveForTeacher(p, other.input)).toBeNull();
    });
    it('keeps a separately enrolled tenant isolated from an approved source', async () => {
      const s = await approved(),
        foreignOrg = randomUUID(),
        foreignUser = randomUUID(),
        foreignInstall = randomUUID(),
        foreignCourse = randomUUID(),
        now = Date.now();
      await admin.query('INSERT INTO margin_identity.organizations(id) VALUES($1)', [foreignOrg]);
      await admin.query('INSERT INTO margin_identity.users(id,identity_key) VALUES($1,$2)', [
        foreignUser,
        hash(foreignUser),
      ]);
      await admin.query(
        "INSERT INTO margin_identity.memberships(organization_id,user_id,role) VALUES($1,$2,'teacher')",
        [foreignOrg, foreignUser],
      );
      await admin.query(
        "INSERT INTO margin_lms.installations(id,organization_id,issuer,client_id,deployment_id,version,enabled,configuration) VALUES($1,$2,'https://foreign-canvas.test','foreign-client','foreign-deployment',1,true,'{}')",
        [foreignInstall, foreignOrg],
      );
      await admin.query(
        'INSERT INTO margin_lms.courses(installation_id,organization_id,external_digest,course_id) VALUES($1,$2,$3,$4)',
        [foreignInstall, foreignOrg, hash(foreignCourse), foreignCourse],
      );
      await admin.query(
        'INSERT INTO margin_lms.user_links(installation_id,organization_id,subject_digest,user_id) VALUES($1,$2,$3,$4)',
        [foreignInstall, foreignOrg, hash(foreignUser), foreignUser],
      );
      await admin.query(
        "INSERT INTO margin_lms.enrollments(installation_id,organization_id,course_id,user_id,role) VALUES($1,$2,$3,$4,'teacher')",
        [foreignInstall, foreignOrg, foreignCourse, foreignUser],
      );
      const foreign: SessionPrincipal = {
        ...p,
        sessionId: randomUUID(),
        organizationId: foreignOrg,
        userId: foreignUser,
        createdAt: now,
        lastSeenAt: now,
        expiresAt: now + 3600000,
      };
      await admin.query(
        "INSERT INTO margin_identity.sessions(id,session_hash,user_id,organization_id,mfa,authentication_method,created_at,expires_at,idle_expires_at,last_seen_at) VALUES($1,$2,$3,$4,false,'lti',$5,$6,$6,$5)",
        [
          foreign.sessionId,
          hash(randomUUID()),
          foreignUser,
          foreignOrg,
          new Date(now),
          new Date(foreign.expiresAt),
        ],
      );
      await admin.query(
        "INSERT INTO margin_lms.session_bindings(session_id,installation_id,registration_version,organization_id,user_id,course_id,subject_digest,course_digest,role) VALUES($1,$2,1,$3,$4,$5,$6,$7,'teacher')",
        [
          foreign.sessionId,
          foreignInstall,
          foreignOrg,
          foreignUser,
          foreignCourse,
          hash(foreignUser),
          hash(foreignCourse),
        ],
      );
      expect(await runtime.get(foreign, s.reserved.identity.artifactId)).toBeNull();
      expect(await gateway().resolveForTeacher(foreign, s.input)).toBeNull();
      await expect(
        runtime.reserve(foreign, { ...s.input, requestId: randomUUID() }),
      ).rejects.toMatchObject({ code: 'source_ownership' });
      expect(
        await gateway().stillAvailable({
          ...s.manifest.source,
          organizationId: foreignOrg,
          ownerId: foreignUser,
        }),
      ).toBe(false);
    });
    it('fails closed for storage-receipt tampering, source deletion, and revoked owner accounts', async () => {
      const s = await approved();
      await admin.query('UPDATE margin_identity.users SET disabled_at=now() WHERE id=$1', [
        teacher,
      ]);
      try {
        expect(await gateway().stillAvailable(s.manifest.source)).toBe(false);
      } finally {
        await admin.query('UPDATE margin_identity.users SET disabled_at=NULL WHERE id=$1', [
          teacher,
        ]);
      }
      await admin.query('UPDATE margin_sync.documents SET deleted_at=now() WHERE id=$1', [
        s.input.documentId,
      ]);
      expect(await gateway().stillAvailable(s.manifest.source)).toBe(false);
      await admin.query('UPDATE margin_sync.documents SET deleted_at=NULL WHERE id=$1', [
        s.input.documentId,
      ]);
      await admin.query(
        'UPDATE margin_ingestion.storage_receipts SET ciphertext=set_byte(ciphertext,0,get_byte(ciphertext,0)#1) WHERE artifact_id=$1',
        [s.reserved.identity.artifactId],
      );
      await expect(gateway().stillAvailable(s.manifest.source)).rejects.toMatchObject({
        code: 'ingestion_integrity',
      });
    });
    it('rejects assignment-provisioner membership for every ingestion purpose, including SET ROLE only', async () => {
      for (const purpose of ['runtime', 'inspector', 'reader'] as const)
        for (const inherit of [true, false])
          await withAssignmentProvisionerMembership(
            admin,
            config(`ingestion_${purpose}_test`),
            `margin_ingestion_${purpose}`,
            inherit,
            async (unsafeConfig) => {
              const unsafe = new PostgresIngestionRepository(unsafeConfig, kms, purpose);
              try {
                if (purpose === 'runtime')
                  await expect(unsafe.get(p, randomUUID())).rejects.toThrow('least-privilege');
                else if (purpose === 'inspector')
                  await expect(unsafe.claimNext()).rejects.toThrow('least-privilege');
                else {
                  const source = (await approved()).manifest.source;
                  await expect(unsafe.readySnapshot(source)).rejects.toThrow('least-privilege');
                }
              } finally {
                await unsafe.close();
              }
            },
          );
    });
    it('rejects inherited and SET-ROLE-only memberships in a database table owner role', async () => {
      for (const inherit of [true, false])
        await withTableOwnerMembership(
          admin,
          config('ingestion_runtime_test'),
          'margin_ingestion.artifacts',
          'margin_ingestion_runtime',
          inherit,
          async (unsafeConfig) => {
            const unsafe = new PostgresIngestionRepository(unsafeConfig, kms, 'runtime');
            try {
              await expect(unsafe.get(p, randomUUID())).rejects.toThrow('least-privilege');
            } finally {
              await unsafe.close();
            }
          },
        );
    });
    it('prepares exact one-use availability outside a transaction and rechecks without storage or KMS', async () => {
      const s = await approved();
      let reads = 0,
        unwraps = 0,
        permitKeys = true;
      const countedKeys: KeyManagementProvider = {
        wrapKey: (k, c) => kms.wrapKey(k, c),
        unwrapKey: (e, c) => {
          unwraps++;
          if (!permitKeys) throw new Error('KMS must not run in prepared recheck');
          return kms.unwrapKey(e, c);
        },
      };
      const countedReader = new PostgresIngestionRepository(
        config('ingestion_reader_test'),
        countedKeys,
        'reader',
      );
      const g = new IngestionAssignmentSourceGateway(runtime, countedReader, {
        get: async (i, r, signal) => {
          reads++;
          return syntheticStorage.get(i, r, signal);
        },
      });
      try {
        const check = (await g.prepareAvailability(s.manifest.source))!;
        expect(reads).toBe(1);
        const previousUnwraps = unwraps;
        permitKeys = false;
        expect(await check(s.manifest.source)).toBe(true);
        expect(await check(s.manifest.source)).toBe(false);
        expect(reads).toBe(1);
        expect(unwraps).toBe(previousUnwraps);
        permitKeys = true;
        const revoked = (await g.prepareAvailability(s.manifest.source))!;
        await inspector.revoke(s.reserved.identity.artifactId);
        expect(await revoked(s.manifest.source)).toBe(false);
      } finally {
        await countedReader.close();
      }
    });
    it('expires prepared checks and binds them to the exact source and authenticated state', async () => {
      const s = await approved(),
        g = gateway();
      const wrong = (await g.prepareAvailability(s.manifest.source))!;
      expect(await wrong({ ...s.manifest.source, artifactVersion: 'changed-version' })).toBe(false);
      expect(await wrong(s.manifest.source)).toBe(false);
      const expired = (await g.prepareAvailability(s.manifest.source))!,
        now = Date.now();
      const clock = vi.spyOn(Date, 'now').mockReturnValue(now + 10001);
      try {
        expect(await expired(s.manifest.source)).toBe(false);
      } finally {
        clock.mockRestore();
      }
      const tampered = (await g.prepareAvailability(s.manifest.source))!;
      await admin.query(
        'UPDATE margin_ingestion.inspection_receipts SET ciphertext=set_byte(ciphertext,0,get_byte(ciphertext,0)#1) WHERE id=$1',
        [s.inspected.id],
      );
      expect(await tampered(s.manifest.source)).toBe(false);
    });
    it('rejects unsafe transport, invalid metadata and overlong scanner reports without approval', async () => {
      expect(
        () =>
          new PostgresIngestionRepository({ host: 'database.test', ssl: false }, kms, 'runtime'),
      ).toThrow('TLS');
      const s = await staged(),
        claim = (await inspector.claimNext())!;
      await expect(
        inspector.complete(claim, { ...goodReport(), engine: 'contains private text\n' }),
      ).rejects.toMatchObject({ code: 'invalid_ingestion' });
      await expect(
        inspector.complete(claim, { ...goodReport(), pageCount: 2001 }),
      ).rejects.toMatchObject({ code: 'invalid_inspection' });
      expect((await runtime.get(p, s.reserved.identity.artifactId))?.status).toBe('quarantined');
    });
    describe('authenticated geometry after migration 006', () => {
      let legacy: Awaited<ReturnType<typeof approved>>;
      const pageGeometry = () => [{ index: 0, width: 612.125, height: 792.25 }];
      async function withGeometry(pages = pageGeometry()) {
        const source = await staged();
        const claim = (await inspector.claimNext())!;
        expect(claim.identity.artifactId).toBe(source.reserved.identity.artifactId);
        const decision = { ...goodReport(), pageCount: pages.length, pageGeometry: pages };
        const inspected = await inspector.complete(claim, decision);
        const manifest = (await runtime.readyForTeacher(p, source.input))!;
        return { ...source, claim, decision, inspected, manifest };
      }
      beforeAll(async () => {
        legacy = await approved();
        for (const name of ['004-assignments.sql', '006-assignment-work.sql'])
          await admin.query(
            readFileSync(new URL('../infra/migrations/' + name, import.meta.url), 'utf8'),
          );
      });
      it('keeps pre-migration geometryless approvals readable without inventing dimensions', async () => {
        const current = (await reader.readySnapshot(legacy.manifest.source))!;
        expect(current.pageGeometry).toBeUndefined();
        expect(current.stateToken).toBe(legacy.manifest.stateToken);
        expect(await reader.recheckApproval(current.source, current.stateToken)).toBe(true);
      });
      it('encrypts a complete 2000-page geometry report separately while preserving full-result idempotency', async () => {
        const pages = Array.from({ length: 2000 }, (_, index) => ({
          index,
          width: 612.123456789,
          height: 792.987654321,
        }));
        const source = await withGeometry(pages);
        expect(source.manifest.pageGeometry).toEqual(pages);
        const raw = (
          await admin.query(
            'SELECT g.*,octet_length(r.ciphertext) AS report_bytes,r.has_geometry,row_to_json(g)::text AS encoded FROM margin_ingestion.page_geometry g JOIN margin_ingestion.inspection_receipts r ON r.id=g.scan_receipt_id WHERE g.scan_receipt_id=$1',
            [source.inspected.id],
          )
        ).rows[0];
        expect(raw.ciphertext.length).toBeGreaterThan(65536);
        expect(raw.ciphertext.length).toBeLessThanOrEqual(262144);
        expect(raw.report_bytes).toBeLessThan(16384);
        expect(raw.has_geometry).toBe(true);
        expect(raw.encoded).not.toContain('612.123456789');
        expect(raw.encoded).not.toContain('width');
        expect(await inspector.complete(source.claim, source.decision)).toMatchObject({
          duplicate: true,
          id: source.inspected.id,
        });
        const changed = structuredClone(source.decision);
        changed.pageGeometry[1999].height += 1;
        await expect(inspector.complete(source.claim, changed)).rejects.toMatchObject({
          code: 'inspection_conflict',
        });
        expect((await reader.readySnapshot(source.manifest.source))?.pageGeometry).toEqual(pages);
      });
      it('rechecks exact source and geometry envelopes in the caller transaction without KMS calls', async () => {
        const source = await withGeometry();
        const client = await sqlReader.connect();
        const keys = vi
          .spyOn(kms, 'unwrapKey')
          .mockRejectedValue(new Error('No KMS in the final transaction'));
        try {
          await client.query('BEGIN');
          expect(
            await recheckReadyManifest(client, source.manifest.source, source.manifest.stateToken),
          ).toBe(true);
          for (const changed of [
            { ...source.manifest.source, artifactVersion: 'other-exact-version' },
            { ...source.manifest.source, sha256: hash('other-content') },
            { ...source.manifest.source, pageCount: 2 },
          ])
            expect(await recheckReadyManifest(client, changed, source.manifest.stateToken)).toBe(
              false,
            );
          expect(keys).not.toHaveBeenCalled();
          await client.query('ROLLBACK');
        } finally {
          keys.mockRestore();
          client.release();
        }
        await admin.query(
          'UPDATE margin_ingestion.page_geometry SET ciphertext=set_byte(ciphertext,0,get_byte(ciphertext,0)#1) WHERE scan_receipt_id=$1',
          [source.inspected.id],
        );
        expect(
          await reader.recheckApproval(source.manifest.source, source.manifest.stateToken),
        ).toBe(false);
        await expect(reader.readySnapshot(source.manifest.source)).rejects.toMatchObject({
          code: 'ingestion_integrity',
        });
      });
      it('keeps all readiness key waits outside transactions even beyond the database idle deadline', async () => {
        const source = await withGeometry();
        let calls = 0;
        const slowKeys: KeyManagementProvider = {
          wrapKey: (key, context) => kms.wrapKey(key, context),
          unwrapKey: async (wrapped, context) => {
            expect(
              (
                await admin.query(
                  "SELECT 1 FROM pg_stat_activity WHERE usename='ingestion_reader_test' AND xact_start IS NOT NULL",
                )
              ).rowCount,
            ).toBe(0);
            calls++;
            await new Promise((resolve) => setTimeout(resolve, 1300));
            return kms.unwrapKey(wrapped, context);
          },
        };
        const slow = new PostgresIngestionRepository(
          config('ingestion_reader_test'),
          slowKeys,
          'reader',
        );
        try {
          expect((await slow.readySnapshot(source.manifest.source))?.pageGeometry).toEqual(
            pageGeometry(),
          );
          expect(calls).toBe(4);
        } finally {
          await slow.close();
        }
      }, 10000);
      it('rechecks source and teacher authority after key I/O finishes', async () => {
        const source = await withGeometry();
        let revokeSource = true,
          changed = false;
        const racingKeys: KeyManagementProvider = {
          wrapKey: (key, context) => kms.wrapKey(key, context),
          unwrapKey: async (wrapped, context) => {
            if (!changed) {
              changed = true;
              if (revokeSource) await inspector.revoke(source.reserved.identity.artifactId);
              else
                await admin.query(
                  'UPDATE margin_identity.sessions SET revoked_at=now() WHERE id=$1',
                  [p.sessionId],
                );
            }
            return kms.unwrapKey(wrapped, context);
          },
        };
        const reading = new PostgresIngestionRepository(
          config('ingestion_reader_test'),
          racingKeys,
          'reader',
        );
        const teacherReading = new PostgresIngestionRepository(
          config('ingestion_runtime_test'),
          racingKeys,
          'runtime',
        );
        try {
          expect(await reading.readySnapshot(source.manifest.source)).toBeNull();
          await admin.query(
            'UPDATE margin_ingestion.artifacts SET revoked_at=NULL WHERE artifact_id=$1',
            [source.reserved.identity.artifactId],
          );
          revokeSource = false;
          changed = false;
          await expect(teacherReading.readyForTeacher(p, source.input)).rejects.toMatchObject({
            code: 'ingestion_revoked',
          });
        } finally {
          await admin.query('UPDATE margin_identity.sessions SET revoked_at=NULL WHERE id=$1', [
            p.sessionId,
          ]);
          await Promise.all([reading.close(), teacherReading.close()]);
        }
      });
      it('rejects geometry substitution between receipts and missing or downgraded geometry evidence', async () => {
        const first = await withGeometry();
        const second = await withGeometry([{ index: 0, width: 400, height: 500 }]);
        await admin.query(
          'UPDATE margin_ingestion.page_geometry g SET ciphertext=o.ciphertext,nonce=o.nonce,tag=o.tag,wrapped_key=o.wrapped_key FROM margin_ingestion.page_geometry o WHERE g.scan_receipt_id=$1 AND o.scan_receipt_id=$2',
          [first.inspected.id, second.inspected.id],
        );
        await expect(reader.readySnapshot(first.manifest.source)).rejects.toMatchObject({
          code: 'ingestion_integrity',
        });
        expect(await reader.recheckApproval(first.manifest.source, first.manifest.stateToken)).toBe(
          false,
        );
        await admin.query(
          'UPDATE margin_ingestion.inspection_receipts SET has_geometry=false WHERE id=$1',
          [second.inspected.id],
        );
        await expect(reader.readySnapshot(second.manifest.source)).rejects.toMatchObject({
          code: 'ingestion_integrity',
        });
        expect(
          await reader.recheckApproval(second.manifest.source, second.manifest.stateToken),
        ).toBe(false);
        await admin.query(
          'UPDATE margin_ingestion.inspection_receipts SET has_geometry=true WHERE id=$1',
          [second.inspected.id],
        );
        await admin.query('DELETE FROM margin_ingestion.page_geometry WHERE scan_receipt_id=$1', [
          second.inspected.id,
        ]);
        await expect(reader.readySnapshot(second.manifest.source)).rejects.toMatchObject({
          code: 'ingestion_integrity',
        });
        expect(
          await reader.recheckApproval(second.manifest.source, second.manifest.stateToken),
        ).toBe(false);
      });
      it('rolls back the inspection receipt and approval if geometry persistence fails, then retries atomically', async () => {
        const source = await staged(),
          claim = (await inspector.claimNext())!;
        const decision = { ...goodReport(), pageGeometry: pageGeometry() };
        await admin.query(
          `CREATE FUNCTION margin_ingestion.synthetic_geometry_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic geometry commit failure'; END; $$; CREATE TRIGGER synthetic_geometry_failure BEFORE INSERT ON margin_ingestion.page_geometry FOR EACH ROW EXECUTE FUNCTION margin_ingestion.synthetic_geometry_failure()`,
        );
        try {
          await expect(inspector.complete(claim, decision)).rejects.toThrow(
            'synthetic geometry commit failure',
          );
          expect(
            (
              await admin.query(
                'SELECT 1 FROM margin_ingestion.inspection_receipts WHERE artifact_id=$1',
                [source.reserved.identity.artifactId],
              )
            ).rowCount,
          ).toBe(0);
          expect((await runtime.get(p, source.reserved.identity.artifactId))?.status).toBe(
            'quarantined',
          );
        } finally {
          await admin.query(
            'DROP TRIGGER synthetic_geometry_failure ON margin_ingestion.page_geometry; DROP FUNCTION margin_ingestion.synthetic_geometry_failure()',
          );
        }
        expect(await inspector.complete(claim, decision)).toMatchObject({
          status: 'ready',
          duplicate: false,
        });
        expect((await runtime.readyForTeacher(p, source.input))?.pageGeometry).toEqual(
          pageGeometry(),
        );
      });
      it('rejects work-receipt owner credentials across identity, LMS, sync and ingestion runtimes', async () => {
        for (const inherit of [true, false]) {
          for (const purpose of ['identity', 'lms', 'sync', 'ingestion'] as const) {
            await withTableOwnerMembership(
              admin,
              config('postgres'),
              'margin_work.receipts',
              `margin_${purpose}_runtime`,
              inherit,
              async (unsafeConfig) => {
                if (purpose === 'identity') {
                  const unsafe = new PostgresIdentityRepository(unsafeConfig);
                  try {
                    await expect(unsafe.findIdentity(hash('synthetic-identity'))).rejects.toThrow(
                      'table owner',
                    );
                  } finally {
                    await unsafe.close();
                  }
                } else if (purpose === 'lms') {
                  const unsafe = new PostgresLmsRepository(unsafeConfig, Buffer.alloc(32, 79));
                  try {
                    await expect(unsafe.findById(installation)).rejects.toThrow('must not');
                  } finally {
                    await unsafe.close();
                  }
                } else if (purpose === 'sync') {
                  const unsafe = new SyncPool(unsafeConfig, 'runtime');
                  try {
                    await expect(unsafe.transaction(undefined, async () => true)).rejects.toThrow(
                      'dedicated',
                    );
                  } finally {
                    await unsafe.close();
                  }
                } else {
                  const unsafe = new PostgresIngestionRepository(unsafeConfig, kms, 'runtime');
                  try {
                    await expect(unsafe.get(p, randomUUID())).rejects.toThrow('least-privilege');
                  } finally {
                    await unsafe.close();
                  }
                }
              },
            );
          }
        }
      });
      it('enforces scoped geometry reads and denies runtime or inspector geometry rewrites', async () => {
        const source = await withGeometry();
        expect(
          (await sqlRuntime.query('SELECT * FROM margin_ingestion.page_geometry')).rowCount,
        ).toBe(0);
        expect(
          (await sqlReader.query('SELECT * FROM margin_ingestion.page_geometry')).rowCount,
        ).toBe(0);
        expect(await runtime.readyForTeacher(peerP, source.input)).toBeNull();
        await expect(
          sqlRuntime.query('DELETE FROM margin_ingestion.page_geometry'),
        ).rejects.toMatchObject({ code: '42501' });
        await expect(
          sqlWorker.query(
            'UPDATE margin_ingestion.page_geometry SET artifact_id=$1 WHERE scan_receipt_id=$2',
            [randomUUID(), source.inspected.id],
          ),
        ).rejects.toMatchObject({ code: '42501' });
        await inspector.revoke(source.reserved.identity.artifactId);
        expect(
          await reader.recheckApproval(source.manifest.source, source.manifest.stateToken),
        ).toBe(false);
      });
      it('leaves malformed or incomplete geometry quarantined instead of fabricating page sizes', async () => {
        const source = await staged(),
          claim = (await inspector.claimNext())!;
        for (const pages of [
          [],
          [{ index: 1, width: 612, height: 792 }],
          [{ index: 0, width: Infinity, height: 792 }],
          [{ index: 0, width: 0, height: 792 }],
        ])
          await expect(
            inspector.complete(claim, { ...goodReport(), pageGeometry: pages }),
          ).rejects.toMatchObject({ code: 'invalid_geometry' });
        expect((await runtime.get(p, source.reserved.identity.artifactId))?.status).toBe(
          'quarantined',
        );
        expect(await runtime.readyForTeacher(p, source.input)).toBeNull();
      });
    });
  },
);
