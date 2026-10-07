import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Pool } from 'pg';
import { LocalKeyProvider } from '../apps/api/src/encryption';
import {
  PostgresIngestionRepository,
  IngestionAssignmentSourceCatalog,
} from '../apps/api/src/ingestion';
import type { SessionPrincipal } from '../apps/api/src/identity';
import { stopDisposablePostgres } from './helpers/postgres';

// Actual PostgreSQL/RLS/envelopes; synthetic inspection receipts, no object provider or live scanner.
const available = ['initdb', 'pg_ctl'].every((tool) => {
  try {
    execFileSync(tool, ['--version'], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
});
if (!available && process.env.MARGIN_REQUIRE_POSTGRES_TESTS === '1')
  throw new Error('Required catalog PostgreSQL binaries are unavailable.');
const hash = (v: string | Buffer) => createHash('sha256').update(v).digest('hex');
const keys = new LocalKeyProvider(randomBytes(32), 'catalog-synthetic-keys');
const body = Buffer.from('%PDF-1.7\nSynthetic approval only; no real malware inspection.\n%%EOF');
let directory: string,
  socket: string,
  started = false,
  admin: Pool;
let runtime: PostgresIngestionRepository, inspector: PostgresIngestionRepository;
let catalog: IngestionAssignmentSourceCatalog;
const database = (user: string) => ({ host: socket, port: 55504, database: 'postgres', user });
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function tenant() {
  const org = randomUUID(),
    installation = randomUUID(),
    course = randomUUID(),
    otherCourse = randomUUID();
  await admin.query('INSERT INTO margin_identity.organizations(id) VALUES($1)', [org]);
  await admin.query(
    "INSERT INTO margin_lms.installations(id,organization_id,issuer,client_id,deployment_id,version,enabled,configuration) VALUES($1,$2,$3,'synthetic-client','synthetic-deployment',1,true,'{}')",
    [installation, org, `https://${installation}.synthetic.test`],
  );
  for (const c of [course, otherCourse])
    await admin.query(
      'INSERT INTO margin_lms.courses(installation_id,organization_id,external_digest,course_id) VALUES($1,$2,$3,$4)',
      [installation, org, hash(c), c],
    );
  async function actor(role: 'teacher' | 'student', user = randomUUID(), c = course) {
    await admin.query(
      'INSERT INTO margin_identity.users(id,identity_key) VALUES($1,$2) ON CONFLICT DO NOTHING',
      [user, hash(user)],
    );
    await admin.query(
      'INSERT INTO margin_identity.memberships(organization_id,user_id,role) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',
      [org, user, role],
    );
    await admin.query(
      'INSERT INTO margin_lms.user_links(installation_id,organization_id,subject_digest,user_id) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',
      [installation, org, hash(user), user],
    );
    await admin.query(
      'INSERT INTO margin_lms.enrollments(installation_id,organization_id,course_id,user_id,role) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING',
      [installation, org, c, user, role],
    );
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
      [principal.sessionId, installation, org, user, c, hash(user), hash(c), role],
    );
    return principal;
  }
  return {
    org,
    installation,
    course,
    otherCourse,
    actor,
    teacher: await actor('teacher'),
    peer: await actor('teacher'),
    student: await actor('student'),
  };
}
let scope: Awaited<ReturnType<typeof tenant>>;
async function source(
  p = scope.teacher,
  status: 'ready' | 'pending' | 'quarantined' | 'rejected' | 'legacy' = 'ready',
) {
  const documentId = randomUUID(),
    versionId = randomUUID(),
    name = `Private worksheet ${documentId}.pdf`;
  const c = await admin.connect();
  let discard = false;
  try {
    await c.query('BEGIN');
    await c.query(
      "INSERT INTO margin_sync.documents(organization_id,id,owner_id,current_version_id,audience) VALUES($1,$2,$3,$4,'teachers')",
      [p.organizationId, documentId, p.userId, versionId],
    );
    await c.query(
      'INSERT INTO margin_sync.versions(organization_id,document_id,id) VALUES($1,$2,$3)',
      [p.organizationId, documentId, versionId],
    );
    await c.query(
      "INSERT INTO margin_sync.grants(organization_id,document_id,user_id,permission) VALUES($1,$2,$3,'owner')",
      [p.organizationId, documentId, p.userId],
    );
    await c.query('COMMIT');
  } catch (error) {
    try {
      await c.query('ROLLBACK');
    } catch (rollbackError) {
      discard = true;
      throw new AggregateError([error, rollbackError], 'Source fixture setup and rollback failed.');
    }
    throw error;
  } finally {
    c.release(discard);
  }
  const reservation = await runtime.reserve(p, {
    requestId: randomUUID(),
    documentId,
    versionId,
    metadata: { name, mimeType: 'application/pdf' },
    plaintextBytes: body.length,
    plaintextSha256: hash(body),
  });
  if (status !== 'pending') {
    await runtime.stageConfirmed(p, reservation.identity.artifactId, {
      objectVersionId: 'synthetic-exact-object-version',
      etag: '"synthetic-etag"',
      ciphertextSha256: hash('ciphertext'),
      storedBytes: body.length + 1000,
    });
    if (status !== 'quarantined') {
      const claim = (await inspector.claimNext())!;
      expect(claim.identity.artifactId).toBe(reservation.identity.artifactId);
      await inspector.complete(claim, {
        verdict: status === 'rejected' ? 'rejected' : 'ready',
        reason: status === 'rejected' ? 'malware' : 'clean',
        plaintextSha256: hash(body),
        plaintextBytes: body.length,
        engine: 'synthetic-fixture',
        engineVersion: '1',
        definitionsVersion: 'no-real-scanner',
        pageCount: 1,
        ...(status === 'legacy' ? {} : { pageGeometry: [{ index: 0, width: 612, height: 792 }] }),
      });
    }
  }
  return { documentId, versionId, name, artifactId: reservation.identity.artifactId };
}

describe.skipIf(!available)(
  'metadata-only inspected-source catalog with disposable PostgreSQL',
  { testTimeout: 20000 },
  () => {
    beforeAll(async () => {
      directory = mkdtempSync(join(tmpdir(), 'margin-source-catalog-pg-'));
      socket = join(directory, 'socket');
      mkdirSync(socket, { mode: 0o700 });
      execFileSync(
        'initdb',
        [
          '-D',
          join(directory, 'data'),
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
          join(directory, 'data'),
          '-l',
          join(directory, 'pg.log'),
          '-o',
          `-k ${socket} -h '' -p 55504`,
          '-w',
          'start',
        ],
        { stdio: 'pipe' },
      );
      started = true;
      admin = new Pool(database('postgres'));
      for (const name of [
        '001-identity.sql',
        '002-document-sync.sql',
        '003-lms-installations.sql',
        '004-assignments.sql',
        '005-ingestion.sql',
        '006-assignment-work.sql',
        '007-assignment-work-runtime.sql',
        '008-authorization-plan-cache.sql',
      ])
        await admin.query(
          readFileSync(new URL('../infra/migrations/' + name, import.meta.url), 'utf8'),
        );
      for (const purpose of ['runtime', 'inspector'])
        await admin.query(
          `CREATE ROLE catalog_${purpose} LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS; GRANT margin_ingestion_${purpose} TO catalog_${purpose}`,
        );
      runtime = new PostgresIngestionRepository(database('catalog_runtime'), keys, 'runtime');
      inspector = new PostgresIngestionRepository(database('catalog_inspector'), keys, 'inspector');
      catalog = new IngestionAssignmentSourceCatalog(runtime);
    }, 30000);
    beforeEach(async () => {
      scope = await tenant();
    });
    afterEach(async () => {
      vi.restoreAllMocks();
      if (admin)
        await admin.query(
          'UPDATE margin_ingestion.artifacts SET revoked_at=COALESCE(revoked_at,clock_timestamp())',
        );
    });
    afterAll(async () => {
      const errors: unknown[] = [];
      for (const result of await Promise.allSettled([
        runtime?.close(),
        inspector?.close(),
        admin?.end(),
      ]))
        if (result.status === 'rejected') errors.push(result.reason);
      let stopped = !started;
      try {
        if (started) await stopDisposablePostgres(join(directory, 'data'));
        stopped = true;
      } catch (error) {
        errors.push(error);
      }
      if (stopped && directory)
        try {
          rmSync(directory, { recursive: true, force: true });
        } catch (error) {
          errors.push(error);
        }
      if (errors.length) throw new AggregateError(errors, 'Catalog fixture cleanup failed.');
    }, 15000);
    it('returns only current teacher/course inspected metadata and never claims object availability', async () => {
      const own = await source();
      await source(scope.peer);
      const otherCourse = await scope.actor('teacher', scope.teacher.userId, scope.otherCourse);
      await source(otherCourse);
      const otherTenant = await tenant();
      await source(otherTenant.teacher);
      expect(await catalog.list(scope.teacher)).toEqual({
        sources: [
          {
            documentId: own.documentId,
            versionId: own.versionId,
            name: own.name,
            pageCount: 1,
            bytes: body.length,
            inspection: 'approved',
            availability: 'not-checked',
          },
        ],
        nextCursor: null,
      });
      const encoded = JSON.stringify(await catalog.list(scope.teacher));
      expect(encoded).not.toContain(own.artifactId);
      expect(encoded).not.toContain('synthetic-exact-object-version');
      expect(encoded).not.toContain(hash(body));
      expect(
        JSON.stringify(
          (
            await admin.query('SELECT * FROM margin_ingestion.artifacts WHERE artifact_id=$1', [
              own.artifactId,
            ])
          ).rows,
        ),
      ).not.toContain(own.name);
    });
    it('excludes pending, quarantined, rejected, legacy geometryless, and revoked approvals', async () => {
      const revoked = await source();
      await inspector.revoke(revoked.artifactId);
      await source(scope.teacher, 'rejected');
      await source(scope.teacher, 'legacy');
      await source(scope.teacher, 'pending');
      await source(scope.teacher, 'quarantined');
      const unwrap = vi.spyOn(keys, 'unwrapKey');
      expect(await catalog.list(scope.teacher)).toEqual({ sources: [], nextCursor: null });
      expect(unwrap).not.toHaveBeenCalled();
    });
    it('uses a fixed five-candidate keyset page and validates opaque cursors without granting scope', async () => {
      const all = [];
      for (let n = 0; n < 6; n++) all.push(await source());
      const first = await catalog.list(scope.teacher);
      expect(first.sources).toHaveLength(5);
      expect(first.nextCursor).toMatch(/^[A-Za-z0-9_-]{98}$/);
      const next = await catalog.list(scope.teacher, first.nextCursor!);
      expect(next.sources).toHaveLength(1);
      expect(next.nextCursor).toBeNull();
      expect([...first.sources, ...next.sources].map((s) => s.documentId)).toEqual(
        all.map((s) => s.documentId).sort(),
      );
      expect(await catalog.list(scope.peer, first.nextCursor!)).toEqual({
        sources: [],
        nextCursor: null,
      });
      for (const cursor of [
        '',
        'a'.repeat(129),
        'a=',
        Buffer.from('wrong:value').toString('base64url'),
      ])
        await expect(catalog.list(scope.teacher, cursor)).rejects.toMatchObject({
          code: 'invalid_source_cursor',
          status: 400,
        });
    });
    it.each(['student', 'oidc', 'session', 'enrollment', 'owner-grant', 'source'] as const)(
      'fails closed for current %s restrictions',
      async (kind) => {
        const own = await source();
        let p = scope.teacher;
        if (kind === 'student') p = scope.student;
        if (kind === 'oidc') p = { ...p, authenticationMethod: 'oidc' };
        if (kind === 'session')
          await admin.query('UPDATE margin_identity.sessions SET revoked_at=now() WHERE id=$1', [
            p.sessionId,
          ]);
        if (kind === 'enrollment')
          await admin.query(
            'UPDATE margin_lms.enrollments SET disabled_at=now() WHERE user_id=$1',
            [p.userId],
          );
        if (kind === 'owner-grant')
          await admin.query('UPDATE margin_sync.grants SET revoked_at=now() WHERE document_id=$1', [
            own.documentId,
          ]);
        if (kind === 'source') await inspector.revoke(own.artifactId);
        if (['owner-grant', 'source'].includes(kind))
          expect((await catalog.list(p)).sources).toEqual([]);
        else await expect(catalog.list(p)).rejects.toMatchObject({ status: 403 });
      },
    );
    it('authenticates encrypted metadata and geometry before exposing a name', async () => {
      const own = await source();
      await admin.query(
        "UPDATE margin_ingestion.page_geometry SET tag=decode(repeat('ff',16),'hex') WHERE artifact_id=$1",
        [own.artifactId],
      );
      await expect(catalog.list(scope.teacher)).rejects.toMatchObject({
        status: 503,
        code: 'source_catalog_unavailable',
      });
    });
    it.each(['session', 'source', 'grant', 'envelope'] as const)(
      'rechecks %s changes made during KMS waits before releasing candidates',
      async (kind) => {
        const own = await source(),
          entered = deferred(),
          release = deferred();
        const original = keys.unwrapKey.bind(keys);
        let paused = false;
        vi.spyOn(keys, 'unwrapKey').mockImplementation(async (...args) => {
          if (!paused) {
            paused = true;
            entered.resolve();
            await release.promise;
          }
          return original(...args);
        });
        const pending = catalog.list(scope.teacher);
        const rejected = expect(pending).rejects.toMatchObject({
          status: kind === 'session' ? 403 : 409,
        });
        await entered.promise;
        expect(
          (
            await admin.query(
              "SELECT count(*)::integer AS count FROM pg_stat_activity WHERE usename='catalog_runtime' AND state='idle in transaction'",
            )
          ).rows[0].count,
        ).toBe(0);
        if (kind === 'session')
          await admin.query('UPDATE margin_identity.sessions SET revoked_at=now() WHERE id=$1', [
            scope.teacher.sessionId,
          ]);
        if (kind === 'source') await inspector.revoke(own.artifactId);
        if (kind === 'grant')
          await admin.query('UPDATE margin_sync.grants SET revoked_at=now() WHERE document_id=$1', [
            own.documentId,
          ]);
        if (kind === 'envelope')
          await admin.query(
            "UPDATE margin_ingestion.artifacts SET tag=decode(repeat('fe',16),'hex') WHERE artifact_id=$1",
            [own.artifactId],
          );
        release.resolve();
        await rejected;
      },
    );
    it('does no key work inside a transaction and clears every unwrapped key after metadata validation', async () => {
      await source();
      const original = keys.unwrapKey.bind(keys),
        unwrapped: Buffer[] = [];
      vi.spyOn(keys, 'unwrapKey').mockImplementation(async (...args) => {
        expect(
          (
            await admin.query(
              "SELECT count(*)::integer AS count FROM pg_stat_activity WHERE usename='catalog_runtime' AND state='idle in transaction'",
            )
          ).rows[0].count,
        ).toBe(0);
        const key = await original(...args);
        unwrapped.push(key);
        return key;
      });
      expect((await catalog.list(scope.teacher)).sources).toHaveLength(1);
      expect(unwrapped).toHaveLength(4);
      expect(unwrapped.every((key) => key.every((byte) => byte === 0))).toBe(true);
    });
  },
);
