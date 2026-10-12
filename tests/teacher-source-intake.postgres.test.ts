import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Pool, type PoolClient } from 'pg';
import { LocalKeyProvider, type KeyManagementProvider } from '../apps/api/src/encryption';
import { PostgresIngestionRepository } from '../apps/api/src/ingestion/postgres';
import {
  SOURCE_UPLOAD_BYTE_LIMIT,
  SOURCE_UPLOAD_COUNT_LIMIT,
  type SourceUploadInput,
} from '../apps/api/src/ingestion/types';
import { SyncPool } from '../apps/api/src/sync/pool';
import type { SessionPrincipal } from '../apps/api/src/identity/types';
import { stopDisposablePostgres } from './helpers/postgres';

const available = ['initdb', 'pg_ctl'].every((tool) => {
  try {
    execFileSync(tool, ['--version'], { stdio: 'pipe', timeout: 5000 });
    return true;
  } catch {
    return false;
  }
});
if (!available && process.env.MARGIN_REQUIRE_POSTGRES_TESTS === '1')
  throw new Error('Required teacher source intake PostgreSQL binaries are unavailable.');
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const kms = new LocalKeyProvider(randomBytes(32), 'teacher-intake-test');
const input = (bytes = 128): SourceUploadInput => ({
  requestId: randomUUID(),
  metadata: { name: 'Teacher private worksheet.pdf', mimeType: 'application/pdf' },
  plaintextBytes: bytes,
  plaintextSha256: hash('synthetic source bytes'),
});
let dir: string,
  socket: string,
  started = false,
  admin: Pool,
  sql: Pool,
  runtime: PostgresIngestionRepository,
  sync: SyncPool;
let org: string, installation: string, course: string, course2: string;
let p: SessionPrincipal,
  peer: SessionPrincipal,
  student: SessionPrincipal,
  otherCourse: SessionPrincipal;
const config = (user: string) => ({ host: socket, port: 55496, user, database: 'postgres' });
const repository = (provider: KeyManagementProvider = kms) =>
  new PostgresIngestionRepository(config('teacher_intake_runtime'), provider, 'runtime');
async function session(
  user: string,
  role: 'teacher' | 'student',
  courseId = course,
): Promise<SessionPrincipal> {
  const now = Date.now();
  const principal: SessionPrincipal = {
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
    [
      principal.sessionId,
      hash(randomUUID()),
      user,
      org,
      new Date(now),
      new Date(principal.expiresAt),
    ],
  );
  await admin.query(
    'INSERT INTO margin_lms.session_bindings(session_id,installation_id,registration_version,organization_id,user_id,course_id,subject_digest,course_digest,role) VALUES($1,$2,1,$3,$4,$5,$6,$7,$8)',
    [principal.sessionId, installation, org, user, courseId, hash(user), hash(courseId), role],
  );
  return principal;
}
async function actor(role: 'teacher' | 'student') {
  const user = randomUUID();
  await admin.query('INSERT INTO margin_identity.users(id,identity_key) VALUES($1,$2)', [
    user,
    hash(user),
  ]);
  await admin.query(
    'INSERT INTO margin_identity.memberships(organization_id,user_id,role) VALUES($1,$2,$3)',
    [org, user, role],
  );
  await admin.query(
    'INSERT INTO margin_lms.user_links(installation_id,organization_id,subject_digest,user_id) VALUES($1,$2,$3,$4)',
    [installation, org, hash(user), user],
  );
  for (const cid of [course, course2])
    await admin.query(
      'INSERT INTO margin_lms.enrollments(installation_id,organization_id,course_id,user_id,role) VALUES($1,$2,$3,$4,$5)',
      [installation, org, cid, user, role],
    );
  return session(user, role);
}
async function asRuntime<T>(principal: SessionPrincipal, run: (c: PoolClient) => Promise<T>) {
  const c = await sql.connect();
  try {
    await beginRuntime(c, principal);
    return await run(c);
  } finally {
    await c.query('ROLLBACK');
    c.release();
  }
}
async function beginRuntime(
  c: PoolClient,
  principal: SessionPrincipal,
  isolation = 'READ COMMITTED',
) {
  await c.query(`BEGIN ISOLATION LEVEL ${isolation}`);
  for (const [key, value] of Object.entries({
    organization_id: principal.organizationId,
    user_id: principal.userId,
    session_id: principal.sessionId,
    installation_id: installation,
    course_id: course,
  }))
    await c.query('SELECT set_config($1,$2,true)', [`margin_ingestion.${key}`, value]);
}
/** Direct credential attack fixture: intentionally invalid encrypted metadata, never an approval. */
async function sqlSource(c: PoolClient, { artifact = true }: { artifact?: boolean } = {}) {
  const doc = randomUUID(),
    version = randomUUID(),
    id = randomUUID();
  await c.query(
    "INSERT INTO margin_sync.documents(organization_id,id,owner_id,current_version_id,audience,origin) VALUES($1,$2,$3,$4,'teachers','lms-source')",
    [org, doc, p.userId, version],
  );
  await c.query(
    'INSERT INTO margin_sync.versions(organization_id,document_id,id) VALUES($1,$2,$3)',
    [org, doc, version],
  );
  await c.query(
    "INSERT INTO margin_sync.grants(organization_id,document_id,user_id,permission) VALUES($1,$2,$3,'owner')",
    [org, doc, p.userId],
  );
  if (artifact)
    await c.query(
      'INSERT INTO margin_ingestion.artifacts(artifact_id,organization_id,document_id,version_id,owner_id,installation_id,course_id,registration_version,request_id,ciphertext,nonce,tag,wrapped_key) VALUES($1,$2,$3,$4,$5,$6,$7,1,$8,$9,$10,$11,$12)',
      [
        id,
        org,
        doc,
        version,
        p.userId,
        installation,
        course,
        randomUUID(),
        Buffer.from([1]),
        Buffer.alloc(12),
        Buffer.alloc(16),
        {},
      ],
    );
  return id;
}
const sqlAccounting = (c: PoolClient, artifact: string, bytes = 1) =>
  c.query(
    'INSERT INTO margin_ingestion.upload_reservations(artifact_id,organization_id,owner_id,installation_id,course_id,plaintext_bytes) VALUES($1,$2,$3,$4,$5,$6)',
    [artifact, org, p.userId, installation, course, bytes],
  );
async function counts() {
  return (
    await admin.query(
      'SELECT (SELECT count(*) FROM margin_sync.documents WHERE organization_id=$1) AS documents,(SELECT count(*) FROM margin_ingestion.artifacts WHERE organization_id=$1) AS artifacts,(SELECT count(*) FROM margin_ingestion.upload_reservations WHERE organization_id=$1) AS reservations',
      [org],
    )
  ).rows[0];
}

describe.skipIf(!available)(
  'Teacher source intake on real disposable PostgreSQL (private Unix socket)',
  () => {
    beforeAll(async () => {
      dir = mkdtempSync(join(tmpdir(), 'margin-teacher-intake-'));
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
      const migrations = new URL('../infra/migrations/', import.meta.url);
      for (const name of readdirSync(migrations)
        .filter((name) => /^0(?:0[1-9]|1[0-3])-.*\.sql$/.test(name))
        .sort())
        await admin.query(readFileSync(new URL(name, migrations), 'utf8'));
      await admin.query(
        'CREATE ROLE teacher_intake_runtime LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS; GRANT margin_ingestion_runtime TO teacher_intake_runtime; CREATE ROLE teacher_intake_sync LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS; GRANT margin_sync_runtime TO teacher_intake_sync',
      );
      sql = new Pool(config('teacher_intake_runtime'));
      runtime = repository();
      sync = new SyncPool(config('teacher_intake_sync'), 'runtime');
    }, 30000);
    beforeEach(async () => {
      org = randomUUID();
      installation = randomUUID();
      course = randomUUID();
      course2 = randomUUID();
      await admin.query('INSERT INTO margin_identity.organizations(id) VALUES($1)', [org]);
      await admin.query(
        "INSERT INTO margin_lms.installations(id,organization_id,issuer,client_id,deployment_id,version,enabled,configuration) VALUES($1,$2,'https://canvas.test',$3,$3,1,true,'{}')",
        [installation, org, installation],
      );
      for (const cid of [course, course2])
        await admin.query(
          'INSERT INTO margin_lms.courses(installation_id,organization_id,external_digest,course_id) VALUES($1,$2,$3,$4)',
          [installation, org, hash(cid), cid],
        );
      p = await actor('teacher');
      peer = await actor('teacher');
      student = await actor('student');
      otherCourse = await session(p.userId, 'teacher', course2);
    });
    afterAll(async () => {
      const failures: unknown[] = [];
      for (const result of await Promise.allSettled([
        runtime?.close(),
        sync?.close(),
        sql?.end(),
        admin?.end(),
      ]))
        if (result.status === 'rejected') failures.push(result.reason);
      let stopped = !started;
      try {
        if (started) await stopDisposablePostgres(join(dir, 'data'));
        stopped = true;
      } catch (error) {
        failures.push(error);
      }
      if (stopped && dir) rmSync(dir, { recursive: true, force: true });
      kms.close();
      if (failures.length)
        throw new AggregateError(failures, 'Teacher intake fixture cleanup failed.');
    }, 20000);

    it('atomically creates a private owned immutable source shell, with authenticated server-only details', async () => {
      const requested = input(),
        reserved = await runtime.reserveUpload(p, requested);
      expect(reserved).toMatchObject({
        status: 'pending',
        duplicate: false,
        identity: { organizationId: org, kind: 'source-pdf' },
      });
      expect(
        new Set([
          reserved.identity.documentId,
          reserved.identity.versionId,
          reserved.identity.artifactId,
          requested.requestId,
        ]).size,
      ).toBe(4);
      expect(await runtime.uploadDetails(p, reserved.identity.artifactId)).toEqual({
        identity: reserved.identity,
        status: 'pending',
        expected: requested,
      });
      expect(await counts()).toEqual({ documents: '1', artifacts: '1', reservations: '1' });
      const doc = (
        await admin.query(
          'SELECT owner_id,origin,current_version_id,audience,cursor,operation_bytes FROM margin_sync.documents WHERE organization_id=$1',
          [org],
        )
      ).rows[0];
      expect(doc).toEqual({
        owner_id: p.userId,
        origin: 'lms-source',
        current_version_id: reserved.identity.versionId,
        audience: 'teachers',
        cursor: '0',
        operation_bytes: '0',
      });
      expect(
        (
          await admin.query(
            'SELECT user_id,permission FROM margin_sync.grants WHERE organization_id=$1',
            [org],
          )
        ).rows,
      ).toEqual([{ user_id: p.userId, permission: 'owner' }]);
      expect(
        (await admin.query('SELECT * FROM margin_sync.pages WHERE organization_id=$1', [org]))
          .rowCount,
      ).toBe(0);
      const cipher = (
        await admin.query(
          'SELECT ciphertext FROM margin_ingestion.artifacts WHERE artifact_id=$1',
          [reserved.identity.artifactId],
        )
      ).rows[0].ciphertext as Buffer;
      expect(cipher.includes(Buffer.from(requested.metadata.name))).toBe(false);
    });

    it('serializes concurrent exact retries and authenticates the same request after repository restart', async () => {
      const requested = input();
      const responses = await Promise.all(
        Array.from({ length: 4 }, () => runtime.reserveUpload(p, requested)),
      );
      expect(responses.filter((value) => !value.duplicate)).toHaveLength(1);
      expect(new Set(responses.map((value) => value.identity.artifactId)).size).toBe(1);
      const fresh = repository();
      try {
        expect(await fresh.reserveUpload(p, requested)).toEqual({
          ...responses[0],
          duplicate: true,
        });
      } finally {
        await fresh.close();
      }
      for (const changed of [
        { ...requested, plaintextBytes: requested.plaintextBytes + 1 },
        { ...requested, plaintextSha256: hash('other') },
        { ...requested, metadata: { ...requested.metadata, name: 'Other.pdf' } },
      ])
        await expect(runtime.reserveUpload(p, changed)).rejects.toMatchObject({
          code: 'idempotency_conflict',
        });
      expect(await counts()).toEqual({ documents: '1', artifacts: '1', reservations: '1' });
    });

    it('allows only one conflicting payload to claim a concurrent request ID', async () => {
      const first = input(),
        second = { ...first, plaintextSha256: hash('conflicting bytes') };
      const results = await Promise.allSettled([
        runtime.reserveUpload(p, first),
        runtime.reserveUpload(p, second),
      ]);
      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      expect(results.find((result) => result.status === 'rejected')).toMatchObject({
        reason: { code: 'idempotency_conflict' },
      });
      const accepted = results[0].status === 'fulfilled' ? first : second;
      const result = results.find((result) => result.status === 'fulfilled');
      if (result?.status !== 'fulfilled') throw new Error('Expected exactly one reservation');
      expect((await runtime.uploadDetails(p, result.value.identity.artifactId))?.expected).toEqual(
        accepted,
      );
      expect(await counts()).toEqual({ documents: '1', artifacts: '1', reservations: '1' });
    });

    it('rejects unexpected authority, receipt, geometry, and identity fields before any writes', async () => {
      const requested = input();
      const invalid: unknown[] = [
        null,
        [],
        {},
        ...[
          'ownerId',
          'organizationId',
          'courseId',
          'documentId',
          'versionId',
          'receipt',
          'pageGeometry',
          'status',
        ].map((key) => ({ ...requested, [key]: randomUUID() })),
        { ...requested, metadata: { ...requested.metadata, pages: [] } },
        { ...requested, metadata: { ...requested.metadata, name: '   ' } },
        { ...requested, plaintextBytes: 0 },
        { ...requested, plaintextBytes: 100 * 1024 * 1024 + 1 },
        { ...requested, plaintextSha256: 'UPPERCASE' },
      ];
      for (const value of invalid)
        await expect(runtime.reserveUpload(p, value as SourceUploadInput)).rejects.toMatchObject({
          code: 'invalid_ingestion',
        });
      expect(await counts()).toEqual({ documents: '0', artifacts: '0', reservations: '0' });
    });

    it('denies students, peer teachers, other courses and another organization', async () => {
      const requested = input(),
        reserved = await runtime.reserveUpload(p, requested);
      await expect(runtime.reserveUpload(student, input())).rejects.toMatchObject({
        code: 'ingestion_access',
      });
      for (const unauthorized of [peer, otherCourse]) {
        expect(await runtime.uploadDetails(unauthorized, reserved.identity.artifactId)).toBeNull();
        await expect(
          runtime.stageConfirmed(unauthorized, reserved.identity.artifactId, {
            objectVersionId: 'test-only',
            etag: 'test-only',
            ciphertextSha256: hash('cipher'),
            storedBytes: 500,
          }),
        ).rejects.toMatchObject({ code: 'source_unavailable' });
      }
      await expect(runtime.reserveUpload(otherCourse, requested)).rejects.toMatchObject({
        status: 409,
      });
      await expect(
        runtime.uploadDetails({ ...p, organizationId: randomUUID() }, reserved.identity.artifactId),
      ).rejects.toMatchObject({ status: 403 });
      expect(await counts()).toEqual({ documents: '1', artifacts: '1', reservations: '1' });
    });

    it.each([
      'session',
      'enrollment',
      'membership',
      'installation',
      'course',
      'user-link',
    ] as const)('rechecks current %s authority for reservations and details', async (kind) => {
      const reserved = await runtime.reserveUpload(p, input());
      const change: Record<typeof kind, [string, string[]]> = {
        session: [
          'UPDATE margin_identity.sessions SET revoked_at=clock_timestamp() WHERE id=$1',
          [p.sessionId],
        ],
        enrollment: [
          'UPDATE margin_lms.enrollments SET disabled_at=clock_timestamp() WHERE user_id=$1 AND course_id=$2',
          [p.userId, course],
        ],
        membership: [
          'UPDATE margin_identity.memberships SET revoked_at=clock_timestamp() WHERE user_id=$1',
          [p.userId],
        ],
        installation: [
          'UPDATE margin_lms.installations SET version=version+1 WHERE id=$1',
          [installation],
        ],
        course: [
          'UPDATE margin_lms.courses SET disabled_at=clock_timestamp() WHERE course_id=$1',
          [course],
        ],
        'user-link': [
          'UPDATE margin_lms.user_links SET disabled_at=clock_timestamp() WHERE user_id=$1',
          [p.userId],
        ],
      };
      await admin.query(...change[kind]);
      await expect(runtime.reserveUpload(p, input())).rejects.toMatchObject({ status: 403 });
      await expect(runtime.uploadDetails(p, reserved.identity.artifactId)).rejects.toMatchObject({
        status: 403,
      });
      expect(await counts()).toEqual({ documents: '1', artifacts: '1', reservations: '1' });
    });

    it('does not release details when authority is revoked during decryption', async () => {
      const reserved = await runtime.reserveUpload(p, input());
      const delayed = repository({
        wrapKey: kms.wrapKey.bind(kms),
        async unwrapKey(key, context) {
          await admin.query(
            'UPDATE margin_identity.sessions SET revoked_at=clock_timestamp() WHERE id=$1',
            [p.sessionId],
          );
          return kms.unwrapKey(key, context);
        },
      });
      try {
        await expect(delayed.uploadDetails(p, reserved.identity.artifactId)).rejects.toMatchObject({
          status: 403,
        });
      } finally {
        await delayed.close();
      }
    });

    it('excludes sources from generic sync even for their owner and limits direct ingestion writes', async () => {
      const reserved = await runtime.reserveUpload(p, input()),
        doc = reserved.identity.documentId;
      await sync.transaction(p, async (c) => {
        expect(
          (await c.query('SELECT * FROM margin_sync.documents WHERE id=$1', [doc])).rows,
        ).toEqual([]);
        expect(
          (await c.query('SELECT * FROM margin_sync.versions WHERE document_id=$1', [doc])).rows,
        ).toEqual([]);
        expect(
          (await c.query('UPDATE margin_sync.documents SET cursor=cursor+1 WHERE id=$1', [doc]))
            .rowCount,
        ).toBe(0);
      });
      await expect(
        asRuntime(p, (c) =>
          c.query(
            'INSERT INTO margin_sync.versions(organization_id,document_id,id) VALUES($1,$2,$3)',
            [org, doc, randomUUID()],
          ),
        ),
      ).rejects.toMatchObject({ code: '42501' });
      await expect(
        asRuntime(p, (c) =>
          c.query(
            "INSERT INTO margin_sync.grants(organization_id,document_id,user_id,permission) VALUES($1,$2,$3,'viewer')",
            [org, doc, peer.userId],
          ),
        ),
      ).rejects.toMatchObject({ code: '42501' });
      await expect(
        asRuntime(p, (c) =>
          c.query(
            "INSERT INTO margin_sync.documents(organization_id,id,owner_id,current_version_id,audience,origin) VALUES($1,$2,$3,$4,'teachers','general')",
            [org, randomUUID(), p.userId, randomUUID()],
          ),
        ),
      ).rejects.toMatchObject({ code: '42501' });
      await expect(
        asRuntime(p, (c) => c.query('DELETE FROM margin_ingestion.upload_reservations')),
      ).rejects.toMatchObject({ code: '42501' });
      await expect(
        asRuntime(p, (c) =>
          c.query('UPDATE margin_ingestion.upload_reservations SET plaintext_bytes=1'),
        ),
      ).rejects.toMatchObject({ code: '42501' });
    });

    it('enforces durable byte capacity across revocation and restart while keeping course/owner scopes separate', async () => {
      const requests = Array.from({ length: 5 }, () => input(100 * 1024 * 1024));
      requests.push(input(SOURCE_UPLOAD_BYTE_LIMIT - 500 * 1024 * 1024));
      for (const value of requests) await runtime.reserveUpload(p, value);
      await admin.query(
        'UPDATE margin_ingestion.artifacts SET revoked_at=clock_timestamp() WHERE organization_id=$1',
        [org],
      );
      const fresh = repository();
      try {
        await expect(fresh.reserveUpload(p, input(1))).rejects.toMatchObject({
          code: 'ingestion_limit',
        });
      } finally {
        await fresh.close();
      }
      expect((await runtime.reserveUpload(otherCourse, input(1))).status).toBe('pending');
      expect((await runtime.reserveUpload(peer, input(1))).status).toBe('pending');
      const rows = (
        await admin.query(
          'SELECT sum(plaintext_bytes) AS bytes,count(*) FROM margin_ingestion.upload_reservations WHERE owner_id=$1 AND course_id=$2',
          [p.userId, course],
        )
      ).rows[0];
      expect(rows).toEqual({ bytes: String(SOURCE_UPLOAD_BYTE_LIMIT), count: '6' });
    }, 20000);

    it('serializes the final capacity slot, accepts exact retries at the count limit, and persists the limit', async () => {
      for (let index = 0; index < SOURCE_UPLOAD_COUNT_LIMIT - 1; index++)
        await runtime.reserveUpload(p, input(1));
      const a = input(1),
        b = input(1),
        results = await Promise.allSettled([
          runtime.reserveUpload(p, a),
          runtime.reserveUpload(p, b),
        ]);
      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      expect(results.find((result) => result.status === 'rejected')).toMatchObject({
        reason: { code: 'ingestion_limit' },
      });
      const accepted = results[0].status === 'fulfilled' ? a : b;
      const fresh = repository();
      try {
        expect((await fresh.reserveUpload(p, accepted)).duplicate).toBe(true);
        await expect(fresh.reserveUpload(p, input(1))).rejects.toMatchObject({
          code: 'ingestion_limit',
        });
      } finally {
        await fresh.close();
      }
      expect(await counts()).toEqual({ documents: '100', artifacts: '100', reservations: '100' });
    }, 60000);

    it('keeps staged uploads quarantined and absent from the catalog without a real inspection approval', async () => {
      const requested = input(),
        reserved = await runtime.reserveUpload(p, requested);
      expect((await runtime.inspectedCatalogPage(p)).sources).toEqual([]);
      const staged = await runtime.stageConfirmed(p, reserved.identity.artifactId, {
        objectVersionId: 'explicit-synthetic-storage-receipt',
        etag: 'test-receipt',
        ciphertextSha256: hash('cipher'),
        storedBytes: 1024,
      });
      expect(staged.status).toBe('quarantined');
      expect((await runtime.uploadDetails(p, reserved.identity.artifactId))?.status).toBe(
        'quarantined',
      );
      expect((await runtime.reserveUpload(p, requested)).status).toBe('quarantined');
      expect((await runtime.inspectedCatalogPage(p)).sources).toEqual([]);
      expect(
        await runtime.readyForTeacher(p, {
          documentId: reserved.identity.documentId,
          versionId: reserved.identity.versionId,
        }),
      ).toBeNull();
      await expect(
        asRuntime(p, (c) =>
          c.query(
            "UPDATE margin_ingestion.inspection_jobs SET status='ready' WHERE artifact_id=$1",
            [reserved.identity.artifactId],
          ),
        ),
      ).rejects.toMatchObject({ code: '42501' });
      expect(
        (await admin.query('SELECT count(*) FROM margin_ingestion.inspection_receipts')).rows[0]
          .count,
      ).toBe('0');
    });

    it('authenticates durable expected bytes and encrypted fingerprint on every retry/details lookup', async () => {
      const requested = input(),
        reserved = await runtime.reserveUpload(p, requested);
      await admin.query(
        'UPDATE margin_ingestion.upload_reservations SET plaintext_bytes=plaintext_bytes+1 WHERE artifact_id=$1',
        [reserved.identity.artifactId],
      );
      await expect(runtime.uploadDetails(p, reserved.identity.artifactId)).rejects.toMatchObject({
        code: 'ingestion_integrity',
      });
      await expect(runtime.reserveUpload(p, requested)).rejects.toMatchObject({
        code: 'ingestion_integrity',
      });
      await admin.query(
        'UPDATE margin_ingestion.upload_reservations SET plaintext_bytes=$2 WHERE artifact_id=$1',
        [reserved.identity.artifactId, requested.plaintextBytes],
      );
      await admin.query(
        'UPDATE margin_ingestion.artifacts SET ciphertext=set_byte(ciphertext,0,get_byte(ciphertext,0)#1) WHERE artifact_id=$1',
        [reserved.identity.artifactId],
      );
      await expect(runtime.uploadDetails(p, reserved.identity.artifactId)).rejects.toMatchObject({
        code: 'ingestion_integrity',
      });
    });

    it('cannot reuse a new upload request through the legacy document-ID reservation path', async () => {
      const requested = input(),
        reserved = await runtime.reserveUpload(p, requested);
      await expect(
        runtime.reserve(p, {
          ...requested,
          documentId: reserved.identity.documentId,
          versionId: reserved.identity.versionId,
        }),
      ).rejects.toMatchObject({ code: 'idempotency_conflict' });
      expect((await runtime.reserveUpload(p, requested)).duplicate).toBe(true);
    });

    it('rolls back all identity rows when encryption fails or cancellation arrives before insertion', async () => {
      const failed = repository({
        async wrapKey() {
          throw new Error('test KMS failure');
        },
        unwrapKey: kms.unwrapKey.bind(kms),
      });
      try {
        await expect(failed.reserveUpload(p, input())).rejects.toThrow('test KMS failure');
      } finally {
        await failed.close();
      }
      const controller = new AbortController();
      const cancelled = repository({
        async wrapKey(key, context) {
          controller.abort();
          return kms.wrapKey(key, context);
        },
        unwrapKey: kms.unwrapKey.bind(kms),
      });
      try {
        await expect(
          cancelled.reserveUpload(p, input(), { signal: controller.signal }),
        ).rejects.toMatchObject({ code: 'ingestion_cancelled' });
      } finally {
        await cancelled.close();
      }
      expect(await counts()).toEqual({ documents: '0', artifacts: '0', reservations: '0' });
    });

    it('rolls back document, version and ownership rows if the final accounting insert fails', async () => {
      // Explicit operator fault injection in this disposable fixture, after every identity insert.
      await admin.query(
        'ALTER TABLE margin_ingestion.upload_reservations ADD CONSTRAINT intake_test_reject CHECK (plaintext_bytes<>173) NOT VALID',
      );
      try {
        await expect(runtime.reserveUpload(p, input(173))).rejects.toMatchObject({ code: '23514' });
      } finally {
        await admin.query(
          'ALTER TABLE margin_ingestion.upload_reservations DROP CONSTRAINT intake_test_reject',
        );
      }
      expect(await counts()).toEqual({ documents: '0', artifacts: '0', reservations: '0' });
      expect(
        (
          await admin.query('SELECT count(*) FROM margin_sync.versions WHERE organization_id=$1', [
            org,
          ])
        ).rows[0].count,
      ).toBe('0');
      expect(
        (
          await admin.query('SELECT count(*) FROM margin_sync.grants WHERE organization_id=$1', [
            org,
          ])
        ).rows[0].count,
      ).toBe('0');
    });

    it.each([false, true])(
      'rejects direct SQL commit of an unaccounted source shell (artifact=%s)',
      async (artifact) => {
        await expect(
          asRuntime(p, async (c) => {
            await sqlSource(c, { artifact });
            await c.query('COMMIT');
          }),
        ).rejects.toMatchObject({ code: '23514', constraint: 'upload_document_accounting' });
        expect(await counts()).toEqual({ documents: '0', artifacts: '0', reservations: '0' });
      },
    );

    it.each(['general', 'assignment'])(
      'does not impose ingestion accounting on %s documents created by a non-ingestion provisioner',
      async (origin) => {
        const c = await admin.connect(),
          doc = randomUUID(),
          version = randomUUID();
        try {
          await c.query('BEGIN');
          await c.query('SET LOCAL ROLE margin_sync_provisioner');
          await c.query(
            'INSERT INTO margin_sync.documents(organization_id,id,owner_id,current_version_id,audience,origin) VALUES($1,$2,$3,$4,$5,$6)',
            [org, doc, p.userId, version, 'teachers', origin],
          );
          await c.query(
            'INSERT INTO margin_sync.versions(organization_id,document_id,id) VALUES($1,$2,$3)',
            [org, doc, version],
          );
          await c.query(
            "INSERT INTO margin_sync.grants(organization_id,document_id,user_id,permission) VALUES($1,$2,$3,'owner')",
            [org, doc, p.userId],
          );
          await c.query('COMMIT');
        } finally {
          await c.query('ROLLBACK');
          c.release();
        }
        expect(await counts()).toEqual({ documents: '1', artifacts: '0', reservations: '0' });
        if (origin === 'general') {
          const requested = input();
          expect(
            (await runtime.reserve(p, { ...requested, documentId: doc, versionId: version }))
              .status,
          ).toBe('pending');
          expect(
            (
              await admin.query(
                'SELECT count(*) FROM margin_ingestion.upload_reservations WHERE organization_id=$1',
                [org],
              )
            ).rows[0].count,
          ).toBe('0');
        }
      },
    );

    it('enforces declared byte capacity for direct SQL, without trusting the repository quota check', async () => {
      await asRuntime(p, async (c) => {
        for (const bytes of [100, 100, 100, 100, 100, 12])
          await sqlAccounting(c, await sqlSource(c), bytes * 1024 * 1024);
        await c.query('COMMIT');
      });
      await expect(
        asRuntime(p, async (c) => {
          await sqlAccounting(c, await sqlSource(c), 1);
          await c.query('COMMIT');
        }),
      ).rejects.toMatchObject({ code: '23514', constraint: 'upload_reservation_capacity_limit' });
      expect(await counts()).toEqual({ documents: '6', artifacts: '6', reservations: '6' });
      const artifact = (
        await admin.query(
          'SELECT artifact_id FROM margin_ingestion.artifacts WHERE organization_id=$1 LIMIT 1',
          [org],
        )
      ).rows[0].artifact_id as string;
      // SQL enforces declared bytes; deliberately forged encrypted metadata cannot enter storage.
      await expect(runtime.uploadDetails(p, artifact)).rejects.toMatchObject({
        code: 'ingestion_integrity',
      });
    });

    it('serializes the final count slot across direct SQL transactions through actual commit', async () => {
      await asRuntime(p, async (c) => {
        for (let index = 0; index < 99; index++) await sqlAccounting(c, await sqlSource(c));
        await c.query('COMMIT');
      });
      const first = await sql.connect(),
        second = await sql.connect();
      try {
        await beginRuntime(first, p);
        await beginRuntime(second, p);
        const one = await sqlSource(first),
          two = await sqlSource(second);
        await sqlAccounting(first, one);
        const waiting = expect(sqlAccounting(second, two)).rejects.toMatchObject({
          code: '23514',
          constraint: 'upload_reservation_capacity_limit',
        });
        await first.query('COMMIT');
        await waiting;
      } finally {
        await Promise.all([first.query('ROLLBACK'), second.query('ROLLBACK')]);
        first.release();
        second.release();
      }
      expect(await counts()).toEqual({ documents: '100', artifacts: '100', reservations: '100' });
    }, 20000);

    it.each(['REPEATABLE READ', 'SERIALIZABLE'])(
      'rejects %s snapshots that could hide a preceding capacity commit',
      async (isolation) => {
        const c = await sql.connect();
        try {
          await beginRuntime(c, p, isolation);
          const artifact = await sqlSource(c);
          await expect(sqlAccounting(c, artifact)).rejects.toMatchObject({ code: '25001' });
        } finally {
          await c.query('ROLLBACK');
          c.release();
        }
        expect(await counts()).toEqual({ documents: '0', artifacts: '0', reservations: '0' });
      },
    );

    it('bounds a direct SQL capacity lock even when the caller disables lock_timeout', async () => {
      const first = await sql.connect(),
        second = await sql.connect();
      try {
        await beginRuntime(first, p);
        await beginRuntime(second, p);
        await sqlAccounting(first, await sqlSource(first));
        const artifact = await sqlSource(second);
        await second.query("SET LOCAL lock_timeout='0'");
        await expect(sqlAccounting(second, artifact)).rejects.toMatchObject({ code: '55P03' });
      } finally {
        await Promise.all([first.query('ROLLBACK'), second.query('ROLLBACK')]);
        first.release();
        second.release();
      }
      expect(await counts()).toEqual({ documents: '0', artifacts: '0', reservations: '0' });
    });
  },
);
