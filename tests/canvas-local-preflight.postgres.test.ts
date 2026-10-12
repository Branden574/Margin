import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { Client, type PoolConfig } from 'pg';
import { postgresTlsToolsAvailable } from './helpers/postgres-tools';
import {
  bootCanvasLocal,
  stopCanvasLocal,
  type CanvasBootstrapReceipt,
} from '../apps/api/src/canvas-local/bootstrap';
import {
  CANVAS_DATABASE_PURPOSES,
  loadCanvasLocalConfig,
} from '../apps/api/src/canvas-local/config';
import {
  assertCanvasDatabaseReady,
  assertCanvasInspectorReady,
  CanvasDatabasePreflightError,
  type CanvasDatabases,
} from '../apps/api/src/canvas-local/preflight';

const available = postgresTlsToolsAvailable('Canvas preflight');
async function freePort(excluded: number[] = []) {
  for (let attempt = 0; attempt < 10; attempt++) {
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    if (![5174, 5432, ...excluded].includes(port)) return port;
  }
  throw new Error('Could not select separate loopback ports for the disposable fixture.');
}
let directory: string, saved: CanvasBootstrapReceipt, admin: Client, apiCa: Buffer;
let loaded: Awaited<ReturnType<typeof loadCanvasLocalConfig>>;
const inspectorPassword = randomBytes(32).toString('hex');
function inspector(): PoolConfig {
  return {
    ...loaded.configuration.databases.ingestion,
    user: 'margin_canvas_inspector_probe',
    password: inspectorPassword,
  };
}
async function inspectorRejects(check: string, database = inspector()) {
  let failure: unknown;
  try {
    await assertCanvasInspectorReady(database, { instanceId: saved.instanceId });
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(CanvasDatabasePreflightError);
  expect(failure).toMatchObject({ code: 'canvas_database_not_ready', purpose: 'inspector', check });
  const visible = String(failure) + JSON.stringify(failure);
  expect(visible).not.toContain(inspectorPassword);
  if (typeof database.password === 'string') expect(visible).not.toContain(database.password);
  expect(visible).not.toContain(String(database.user));
  expect(failure).not.toHaveProperty('cause');
}
function config(): CanvasDatabases {
  return Object.fromEntries(
    CANVAS_DATABASE_PURPOSES.map((purpose) => [
      purpose,
      { ...loaded.configuration.databases[purpose] },
    ]),
  ) as CanvasDatabases;
}
async function rejects(databases: CanvasDatabases, purpose: string, check: string) {
  let failure: unknown;
  try {
    await assertCanvasDatabaseReady(databases);
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(CanvasDatabasePreflightError);
  expect(failure).toMatchObject({ code: 'canvas_database_not_ready', purpose, check });
  // Both the public message and serializable properties exclude credentials and server errors.
  const visible = String(failure) + JSON.stringify(failure);
  for (const database of Object.values(databases)) {
    if (typeof database.password === 'string') expect(visible).not.toContain(database.password);
    if (database.user) expect(visible).not.toContain(database.user);
  }
  expect(failure).not.toHaveProperty('cause');
}
async function altered(sql: string, restore: string, test: () => Promise<void>) {
  await admin.query(sql);
  try {
    await test();
  } finally {
    await admin.query(restore);
  }
}
async function serverSetting(name: 'ssl' | 'fsync' | 'full_page_writes', enabled: boolean) {
  await admin.query(enabled ? `ALTER SYSTEM RESET ${name}` : `ALTER SYSTEM SET ${name}='off'`);
  await admin.query('SELECT pg_reload_conf()');
  const deadline = performance.now() + 5000;
  do {
    if ((await admin.query(`SHOW ${name}`)).rows[0][name] === (enabled ? 'on' : 'off')) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  } while (performance.now() < deadline);
  throw new Error('Disposable PostgreSQL did not reload its test setting.');
}
describe.skipIf(!available)(
  'Canvas startup readiness on an isolated certificate-verified TLS PostgreSQL cluster',
  { timeout: 30000 },
  () => {
    beforeAll(async () => {
      directory = await realpath(await mkdtemp(join(tmpdir(), 'margin-canvas-preflight-')));
      const { ensureLocalTls } = await import(
        new URL('../scripts/local-tls.mjs', import.meta.url).href
      );
      const tls = ensureLocalTls(join(directory, 'api-tls'));
      apiCa = await readFile(tls.certPath);
      saved = await bootCanvasLocal({
        rootDirectory: join(directory, 'canvas'),
        postgresPort: await freePort([4101]),
        apiPort: 4101,
        applicationOrigin: 'https://127.0.0.1:5174',
        apiTls: { keyFile: tls.keyPath, certFile: tls.certPath },
      });
      loaded = await loadCanvasLocalConfig(saved.configPath);
      const url = new URL(
        (await readFile(join(saved.rootDirectory, 'operator/database.url'), 'utf8')).trim(),
      );
      admin = new Client({
        host: url.hostname,
        port: Number(url.port),
        user: url.username,
        password: url.password,
        database: url.pathname.slice(1),
        ssl: {
          ca: await readFile(join(saved.rootDirectory, 'postgres-tls/ca.pem')),
          rejectUnauthorized: true,
        },
      });
      await admin.connect();
      await admin.query(
        `CREATE ROLE margin_canvas_inspector_probe LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '${inspectorPassword}'; GRANT margin_ingestion_inspector TO margin_canvas_inspector_probe; GRANT CONNECT ON DATABASE margin_canvas TO margin_canvas_inspector_probe; GRANT USAGE ON SCHEMA margin_local TO margin_ingestion_inspector; GRANT SELECT ON margin_local.installation,margin_local.migrations,margin_local.policy_contract TO margin_ingestion_inspector`,
      );
    }, 60000);
    afterAll(async () => {
      loaded?.dispose();
      await admin?.end();
      if (saved) await stopCanvasLocal(saved.rootDirectory);
      if (directory) await rm(directory, { recursive: true, force: true });
    });

    it('accepts all ten actual restricted logins over verified TLS without writing application data', async () => {
      await expect(assertCanvasDatabaseReady(config())).resolves.toBeUndefined();
      expect(new Set(Object.values(config()).map((c) => c.user)).size).toBe(10);
      expect((await admin.query('SELECT count(*) FROM margin_identity.users')).rows[0].count).toBe(
        '0',
      );
      expect(
        (await admin.query('SELECT count(*) FROM margin_lms.installations')).rows[0].count,
      ).toBe('0');
      expect(
        (
          await admin.query(
            "SELECT count(*) FROM pg_stat_activity WHERE application_name='margin-canvas-preflight'",
          )
        ).rows[0].count,
      ).toBe('0');
    });

    it('independently accepts an inspector login without granting operator control or supplying the ten API credentials', async () => {
      // PostgreSQL versions differ in the PUBLIC default for this catalog
      // function. Prove readiness does not depend on it even when revoked.
      const publicExecute = (
        await admin.query(
          "SELECT EXISTS(SELECT 1 FROM pg_proc p CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) a WHERE p.oid='pg_control_system()'::regprocedure AND a.grantee=0 AND a.privilege_type='EXECUTE') AS allowed",
        )
      ).rows[0].allowed as boolean;
      await admin.query('REVOKE EXECUTE ON FUNCTION pg_catalog.pg_control_system() FROM PUBLIC');
      try {
        await expect(
          assertCanvasInspectorReady(inspector(), {
            instanceId: saved.instanceId,
            systemIdentifier: saved.systemIdentifier,
          }),
        ).resolves.toBeUndefined();
        const client = new Client(inspector());
        await client.connect();
        try {
          const row = (
            await client.query(
              "SELECT current_user AS login,has_function_privilege(current_user,'pg_control_system()','EXECUTE') AS control",
            )
          ).rows[0];
          expect(row).toEqual({ login: 'margin_canvas_inspector_probe', control: false });
          await expect(client.query('SELECT * FROM pg_control_system()')).rejects.toMatchObject({
            code: '42501',
          });
        } finally {
          await client.end();
        }
      } finally {
        if (publicExecute)
          await admin.query('GRANT EXECUTE ON FUNCTION pg_catalog.pg_control_system() TO PUBLIC');
      }
      expect(
        (await admin.query('SELECT count(*) FROM margin_ingestion.artifacts')).rows[0].count,
      ).toBe('0');
    });

    it('requires the exact operator-created installation instance for the inspector', async () => {
      await expect(
        assertCanvasInspectorReady(inspector(), { instanceId: randomUUID() }),
      ).rejects.toMatchObject({ purpose: 'inspector', check: 'installation' });
      for (const options of [
        { instanceId: '' },
        { instanceId: saved.instanceId, systemIdentifier: 'bad-secret-system-id' },
        { instanceId: saved.instanceId, timeoutMs: 0 },
      ]) {
        await expect(assertCanvasInspectorReady(inspector(), options)).rejects.toMatchObject({
          purpose: 'inspector',
          check: 'configuration',
        });
      }
      await expect(
        assertCanvasInspectorReady(inspector(), { instanceId: saved.instanceId }),
      ).resolves.toBeUndefined();
    });

    it('applies exact TLS and pg configuration rules to the separate inspector', async () => {
      await inspectorRejects('configuration', {
        ...inspector(),
        ssl: { ca: apiCa, rejectUnauthorized: false },
      });
      await inspectorRejects('configuration', {
        ...inspector(),
        connectionString: 'postgresql://fixture.invalid/override',
      });
      await inspectorRejects('connection', {
        ...inspector(),
        ssl: { ca: apiCa, rejectUnauthorized: true },
      });
      await inspectorRejects('connection', {
        ...inspector(),
        password: 'never-publish-inspector-failed-password',
      });
    });

    it('rejects an existing intake login even though it uses the same verified endpoint', async () => {
      await inspectorRejects('role', config().ingestion);
    });

    it.each(['SUPERUSER', 'BYPASSRLS', 'CREATEROLE'])(
      'rejects inspector privilege escalation to %s',
      async (privilege) => {
        await altered(
          `ALTER ROLE margin_canvas_inspector_probe ${privilege}`,
          `ALTER ROLE margin_canvas_inspector_probe NO${privilege}`,
          () => inspectorRejects('role'),
        );
      },
    );

    it('rejects inspector memberships reachable through SET ROLE', async () => {
      await altered(
        'CREATE ROLE margin_inspector_extra NOLOGIN NOINHERIT; GRANT margin_identity_provisioner TO margin_inspector_extra; GRANT margin_inspector_extra TO margin_canvas_inspector_probe',
        'REVOKE margin_inspector_extra FROM margin_canvas_inspector_probe; REVOKE margin_identity_provisioner FROM margin_inspector_extra; DROP ROLE margin_inspector_extra',
        () => inspectorRejects('role'),
      );
    });

    it('rejects writable inspector readiness metadata', async () => {
      await altered(
        'GRANT UPDATE ON margin_local.policy_contract TO margin_ingestion_inspector',
        'REVOKE UPDATE ON margin_local.policy_contract FROM margin_ingestion_inspector',
        () => inspectorRejects('role'),
      );
    });

    it('does not accept missing inspector access to the immutable ledger', async () => {
      await altered(
        'REVOKE SELECT ON margin_local.migrations FROM margin_ingestion_inspector',
        'GRANT SELECT ON margin_local.migrations TO margin_ingestion_inspector',
        () => inspectorRejects('installation'),
      );
    });

    it('checks migration ledger and forced RLS through the independent inspector path', async () => {
      await altered(
        "INSERT INTO margin_local.migrations(position,name,sha256) VALUES(14,'014-unexpected-inspector.sql',repeat('0',64))",
        'DELETE FROM margin_local.migrations WHERE position=14',
        () => inspectorRejects('installation'),
      );
      await altered(
        'ALTER TABLE margin_ingestion.artifacts NO FORCE ROW LEVEL SECURITY',
        'ALTER TABLE margin_ingestion.artifacts FORCE ROW LEVEL SECURITY',
        () => inspectorRejects('schema'),
      );
    });

    it('compares policy predicates for the inspector instead of trusting the migration ledger alone', async () => {
      await altered(
        'ALTER POLICY identity_membership_read ON margin_identity.memberships USING(true)',
        'ALTER POLICY identity_membership_read ON margin_identity.memberships USING(user_id=margin_identity.context_user())',
        () => inspectorRejects('schema'),
      );
    });

    it('requires durable commit configuration for the inspector', async () => {
      await altered(
        "ALTER ROLE margin_canvas_inspector_probe SET synchronous_commit='off'",
        'ALTER ROLE margin_canvas_inspector_probe RESET synchronous_commit',
        () => inspectorRejects('durability'),
      );
    });

    it.each(['deadline', 'cancelled'] as const)(
      'bounds inspector %s and releases its blocked read-only session',
      async (check) => {
        await admin.query('BEGIN');
        await admin.query('LOCK TABLE margin_local.migrations IN ACCESS EXCLUSIVE MODE');
        const controller = new AbortController();
        const timer = check === 'cancelled' ? setTimeout(() => controller.abort(), 150) : undefined;
        const started = Date.now();
        try {
          await expect(
            assertCanvasInspectorReady(inspector(), {
              instanceId: saved.instanceId,
              signal: controller.signal,
              timeoutMs: check === 'deadline' ? 150 : 5000,
            }),
          ).rejects.toMatchObject({ purpose: 'inspector', check });
          expect(Date.now() - started).toBeLessThan(1500);
        } finally {
          clearTimeout(timer);
          await admin.query('ROLLBACK');
        }
        // After TCP destruction, PostgreSQL observes the close once its blocked
        // query resumes. Wait for that bounded server-side teardown to finish.
        await expect
          .poll(
            async () =>
              (
                await admin.query(
                  "SELECT count(*) FROM pg_stat_activity WHERE application_name='margin-canvas-preflight'",
                )
              ).rows[0].count,
            { timeout: 1500 },
          )
          .toBe('0');
      },
    );

    it('rejects disabled certificate validation, plaintext and custom TLS callbacks even in tests', async () => {
      for (const ssl of [
        false,
        { ca: apiCa, rejectUnauthorized: false },
        { ca: apiCa, rejectUnauthorized: true, checkServerIdentity: () => undefined },
      ]) {
        const databases = config();
        databases.identity.ssl = ssl;
        await rejects(databases, 'identity', 'configuration');
      }
    });

    it('rejects a genuinely untrusted certificate and scrubs the TLS error', async () => {
      const databases = config();
      databases.identity.ssl = { ca: apiCa, rejectUnauthorized: true };
      await rejects(databases, 'identity', 'connection');
    });

    it('refuses a real PostgreSQL server with TLS disabled instead of downgrading to plaintext', async () => {
      try {
        await serverSetting('ssl', false);
        await rejects(config(), 'identity', 'connection');
      } finally {
        await serverSetting('ssl', true);
      }
    });

    it('rejects authentication failure without exposing the password or login', async () => {
      const databases = config();
      databases.identity.password = 'preflight-regression-never-log-this-password';
      await rejects(databases, 'identity', 'connection');
    });

    it('checks the last purpose too and closes prior connections after a later login failure', async () => {
      const databases = config();
      databases.provisioner.password = 'last-purpose-secret';
      await rejects(databases, 'provisioner', 'connection');
      expect(
        (
          await admin.query(
            "SELECT count(*) FROM pg_stat_activity WHERE application_name='margin-canvas-preflight'",
          )
        ).rows[0].count,
      ).toBe('0');
    });

    it('rejects duplicate identities and mismatched database endpoints before connecting', async () => {
      for (const change of [
        { user: config().identity.user },
        { database: 'different_database' },
        { port: saved.postgresPort + 1 },
        { host: 'localhost' },
      ]) {
        const databases = config();
        Object.assign(databases.reviewer, change);
        await rejects(databases, 'reviewer', 'configuration');
      }
    });

    it('does not allow connection-string or PostgreSQL option overrides', async () => {
      for (const change of [
        { connectionString: 'postgresql://override.invalid/other' },
        { options: '-c row_security=off' },
        { sslnegotiation: 'direct' },
        { host: '/tmp' },
      ]) {
        const databases = config();
        Object.assign(databases.identity, change);
        await rejects(databases, 'identity', 'configuration');
      }
    });

    it('refuses global TLS bypass instead of inheriting test environment exceptions', async () => {
      vi.stubEnv('NODE_TLS_REJECT_UNAUTHORIZED', '0');
      try {
        await rejects(config(), 'identity', 'configuration');
      } finally {
        vi.unstubAllEnvs();
      }
    });

    it.each(['SUPERUSER', 'BYPASSRLS', 'CREATEDB', 'CREATEROLE', 'REPLICATION'])(
      'rejects runtime privilege escalation to %s',
      async (privilege) => {
        await altered(
          `ALTER ROLE margin_canvas_identity ${privilege}`,
          `ALTER ROLE margin_canvas_identity NO${privilege}`,
          () => rejects(config(), 'identity', 'role'),
        );
      },
    );

    it('rejects a wrong exclusive runtime role despite valid credentials', async () => {
      await altered(
        'REVOKE margin_identity_runtime FROM margin_canvas_identity; GRANT margin_lms_runtime TO margin_canvas_identity',
        'REVOKE margin_lms_runtime FROM margin_canvas_identity; GRANT margin_identity_runtime TO margin_canvas_identity',
        () => rejects(config(), 'identity', 'role'),
      );
    });

    it('rejects non-inherited nested membership that can be reached with SET ROLE', async () => {
      await altered(
        'CREATE ROLE margin_preflight_extra NOLOGIN NOINHERIT; GRANT margin_submission_processor TO margin_preflight_extra; GRANT margin_preflight_extra TO margin_canvas_identity',
        'REVOKE margin_preflight_extra FROM margin_canvas_identity; REVOKE margin_submission_processor FROM margin_preflight_extra; DROP ROLE margin_preflight_extra',
        () => rejects(config(), 'identity', 'role'),
      );
    });

    it('rejects role administration rights', async () => {
      await altered(
        'GRANT margin_identity_runtime TO margin_canvas_identity WITH ADMIN OPTION',
        'REVOKE ADMIN OPTION FOR margin_identity_runtime FROM margin_canvas_identity',
        () => rejects(config(), 'identity', 'role'),
      );
    });

    it.each(['CREATE', 'TEMPORARY'])('rejects database %s privileges', async (privilege) => {
      await altered(
        `GRANT ${privilege} ON DATABASE margin_canvas TO margin_canvas_identity`,
        `REVOKE ${privilege} ON DATABASE margin_canvas FROM margin_canvas_identity`,
        () => rejects(config(), 'identity', 'role'),
      );
    });

    it('rejects direct grants beyond the service role', async () => {
      await altered(
        'GRANT INSERT ON margin_identity.users TO margin_canvas_identity',
        'REVOKE INSERT ON margin_identity.users FROM margin_canvas_identity',
        () => rejects(config(), 'identity', 'role'),
      );
    });

    it.each(['margin_identity_runtime', 'PUBLIC'])(
      'rejects RLS-bypassing TRUNCATE granted to %s',
      async (grantee) => {
        await altered(
          `GRANT TRUNCATE ON margin_identity.sessions TO ${grantee}`,
          `REVOKE TRUNCATE ON margin_identity.sessions FROM ${grantee}`,
          () => rejects(config(), 'identity', 'role'),
        );
      },
    );

    it('rejects grant options inherited through the intended runtime group', async () => {
      await altered(
        'GRANT SELECT ON margin_identity.users TO margin_identity_runtime WITH GRANT OPTION',
        'REVOKE GRANT OPTION FOR SELECT ON margin_identity.users FROM margin_identity_runtime',
        () => rejects(config(), 'identity', 'role'),
      );
    });

    it('rejects column grant options inherited through the intended runtime group', async () => {
      await altered(
        'GRANT UPDATE(revoked_at) ON margin_identity.sessions TO margin_identity_runtime WITH GRANT OPTION',
        'REVOKE GRANT OPTION FOR UPDATE(revoked_at) ON margin_identity.sessions FROM margin_identity_runtime',
        () => rejects(config(), 'identity', 'role'),
      );
    });

    it('rejects table ownership by a runtime login', async () => {
      await altered(
        'ALTER TABLE margin_local.migrations OWNER TO margin_canvas_identity',
        'ALTER TABLE margin_local.migrations OWNER TO margin_canvas_operator',
        () => rejects(config(), 'identity', 'role'),
      );
    });

    it('rejects writable migration metadata', async () => {
      await altered(
        'GRANT UPDATE ON margin_local.migrations TO margin_identity_runtime',
        'REVOKE UPDATE ON margin_local.migrations FROM margin_identity_runtime',
        () => rejects(config(), 'identity', 'role'),
      );
    });

    it.each([12, 13])(
      'rejects migration %i hash drift and recovers after operator repair',
      async (position) => {
        const original = (
          await admin.query('SELECT sha256 FROM margin_local.migrations WHERE position=$1', [
            position,
          ])
        ).rows[0].sha256;
        try {
          await admin.query(
            "UPDATE margin_local.migrations SET sha256=repeat('0',64) WHERE position=$1",
            [position],
          );
          await rejects(config(), 'identity', 'installation');
        } finally {
          await admin.query('UPDATE margin_local.migrations SET sha256=$1 WHERE position=$2', [
            original,
            position,
          ]);
        }
        await expect(assertCanvasDatabaseReady(config())).resolves.toBeUndefined();
      },
    );

    it('rejects an appended migration beyond the complete expected manifest', async () => {
      await altered(
        "INSERT INTO margin_local.migrations(position,name,sha256) VALUES(14,'014-unexpected.sql',repeat('0',64))",
        'DELETE FROM margin_local.migrations WHERE position=14',
        () => rejects(config(), 'identity', 'installation'),
      );
    });

    it('rejects missing forced row security on a critical table', async () => {
      await altered(
        'ALTER TABLE margin_identity.sessions NO FORCE ROW LEVEL SECURITY',
        'ALTER TABLE margin_identity.sessions FORCE ROW LEVEL SECURITY',
        () => rejects(config(), 'identity', 'schema'),
      );
    });

    it('rejects a missing table even when the migration ledger is intact', async () => {
      await altered(
        'ALTER TABLE margin_identity.login_attempts RENAME TO hidden_login_attempts',
        'ALTER TABLE margin_identity.hidden_login_attempts RENAME TO login_attempts',
        () => rejects(config(), 'identity', 'schema'),
      );
    });

    it('rejects disabled retention triggers', async () => {
      await altered(
        'ALTER TABLE margin_sync.operations DISABLE TRIGGER retain_submission_operations',
        'ALTER TABLE margin_sync.operations ENABLE TRIGGER retain_submission_operations',
        () => rejects(config(), 'identity', 'schema'),
      );
    });

    it.each([
      ['margin_ingestion.upload_reservations', 'protect_upload_capacity'],
      ['margin_sync.documents', 'enforce_upload_accounting'],
    ])('rejects disabled source intake trigger %s.%s', async (table, name) => {
      await altered(
        `ALTER TABLE ${table} DISABLE TRIGGER ${name}`,
        `ALTER TABLE ${table} ENABLE TRIGGER ${name}`,
        () => rejects(config(), 'identity', 'schema'),
      );
    });

    it.each([
      'CREATE TRIGGER enforce_upload_accounting AFTER INSERT ON margin_sync.documents FOR EACH ROW EXECUTE FUNCTION margin_ingestion.enforce_upload_accounting()',
      'CREATE CONSTRAINT TRIGGER enforce_upload_accounting AFTER INSERT ON margin_sync.documents DEFERRABLE INITIALLY IMMEDIATE FOR EACH ROW EXECUTE FUNCTION margin_ingestion.enforce_upload_accounting()',
      'CREATE CONSTRAINT TRIGGER enforce_upload_accounting AFTER INSERT ON margin_sync.documents NOT DEFERRABLE FOR EACH ROW EXECUTE FUNCTION margin_ingestion.enforce_upload_accounting()',
    ])('rejects accounting timing/constraint drift %#', async (replacement) => {
      const remove = 'DROP TRIGGER enforce_upload_accounting ON margin_sync.documents; ';
      await altered(
        remove + replacement,
        remove +
          'CREATE CONSTRAINT TRIGGER enforce_upload_accounting AFTER INSERT ON margin_sync.documents DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION margin_ingestion.enforce_upload_accounting()',
        () => rejects(config(), 'identity', 'schema'),
      );
    });

    it.each(['RESET lock_timeout', "SET lock_timeout='0'"])(
      'rejects weakening the database quota lock bound with %s',
      async (change) => {
        await altered(
          `ALTER FUNCTION margin_ingestion.protect_upload_capacity() ${change}`,
          "ALTER FUNCTION margin_ingestion.protect_upload_capacity() SET lock_timeout='2s'",
          () => rejects(config(), 'identity', 'schema'),
        );
      },
    );

    it('rejects altered source capacity logic even with unchanged function properties', async () => {
      const original = (
        await admin.query(
          "SELECT pg_get_functiondef('margin_ingestion.protect_upload_capacity()'::regprocedure) AS definition",
        )
      ).rows[0].definition as string;
      await altered(
        "CREATE OR REPLACE FUNCTION margin_ingestion.protect_upload_capacity() RETURNS trigger LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path=pg_catalog SET lock_timeout='2s' AS $$ BEGIN RETURN NEW; END $$",
        original,
        () => rejects(config(), 'identity', 'schema'),
      );
    });

    it('requires forced RLS on source capacity accounting', async () => {
      await altered(
        'ALTER TABLE margin_ingestion.upload_reservations NO FORCE ROW LEVEL SECURITY',
        'ALTER TABLE margin_ingestion.upload_reservations FORCE ROW LEVEL SECURITY',
        () => rejects(config(), 'identity', 'schema'),
      );
    });

    it('rejects authority function privilege drift', async () => {
      await altered(
        'ALTER FUNCTION margin_identity.context_user() SECURITY DEFINER',
        'ALTER FUNCTION margin_identity.context_user() SECURITY INVOKER',
        () => rejects(config(), 'identity', 'schema'),
      );
    });

    it('rejects a policy changed to public access', async () => {
      await altered(
        'ALTER POLICY identity_user_read ON margin_identity.users TO PUBLIC',
        'ALTER POLICY identity_user_read ON margin_identity.users TO margin_identity_runtime',
        () => rejects(config(), 'identity', 'schema'),
      );
    });

    it('rejects an extra permissive policy targeting an otherwise approved runtime group', async () => {
      await altered(
        'CREATE POLICY preflight_open_access ON margin_identity.sessions FOR ALL TO margin_identity_runtime USING(true) WITH CHECK(true)',
        'DROP POLICY preflight_open_access ON margin_identity.sessions',
        () => rejects(config(), 'identity', 'schema'),
      );
    });

    it('rejects altered policy predicates without relying on changed names or roles', async () => {
      await altered(
        'ALTER POLICY identity_membership_read ON margin_identity.memberships USING(true)',
        'ALTER POLICY identity_membership_read ON margin_identity.memberships USING(user_id=margin_identity.context_user())',
        () => rejects(config(), 'identity', 'schema'),
      );
    });

    it('rejects runtime write access to the installation policy contract', async () => {
      await altered(
        'GRANT UPDATE ON margin_local.policy_contract TO margin_identity_runtime',
        'REVOKE UPDATE ON margin_local.policy_contract FROM margin_identity_runtime',
        () => rejects(config(), 'identity', 'role'),
      );
    });

    it('bounds a blocked readiness query and destroys its read-only connection', async () => {
      await admin.query('BEGIN');
      await admin.query('LOCK TABLE margin_local.migrations IN ACCESS EXCLUSIVE MODE');
      const started = Date.now();
      try {
        await expect(assertCanvasDatabaseReady(config(), { timeoutMs: 150 })).rejects.toMatchObject(
          { code: 'canvas_database_not_ready', check: 'deadline' },
        );
        expect(Date.now() - started).toBeLessThan(1500);
      } finally {
        await admin.query('ROLLBACK');
      }
    });

    it('supports cancellation of a blocked readiness query', async () => {
      await admin.query('BEGIN');
      await admin.query('LOCK TABLE margin_local.migrations IN ACCESS EXCLUSIVE MODE');
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 150);
      try {
        await expect(
          assertCanvasDatabaseReady(config(), { signal: controller.signal }),
        ).rejects.toMatchObject({ code: 'canvas_database_not_ready', check: 'cancelled' });
      } finally {
        clearTimeout(timer);
        await admin.query('ROLLBACK');
      }
    });

    it('rejects asynchronous commit configured on a real runtime role', async () => {
      await altered(
        "ALTER ROLE margin_canvas_work SET synchronous_commit='off'",
        'ALTER ROLE margin_canvas_work RESET synchronous_commit',
        () => rejects(config(), 'work', 'durability'),
      );
    });

    it.each(['fsync', 'full_page_writes'] as const)(
      'rejects a real PostgreSQL server with %s disabled',
      async (setting) => {
        try {
          await serverSetting(setting, false);
          await rejects(config(), 'identity', 'durability');
        } finally {
          await serverSetting(setting, true);
        }
      },
    );

    it('rejects a replica-style or read-only session configuration', async () => {
      await altered(
        "ALTER ROLE margin_canvas_identity SET default_transaction_read_only='on'",
        'ALTER ROLE margin_canvas_identity RESET default_transaction_read_only',
        () => rejects(config(), 'identity', 'durability'),
      );
    });

    it('accepts the repaired cluster without leaked sessions after failure cases', async () => {
      await expect(assertCanvasDatabaseReady(config())).resolves.toBeUndefined();
      expect(
        (
          await admin.query(
            "SELECT count(*) FROM pg_stat_activity WHERE application_name='margin-canvas-preflight'",
          )
        ).rows[0].count,
      ).toBe('0');
    });
  },
);
