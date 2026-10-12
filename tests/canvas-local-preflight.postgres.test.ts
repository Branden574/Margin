import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from 'pg';
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
  CanvasDatabasePreflightError,
  type CanvasDatabases,
} from '../apps/api/src/canvas-local/preflight';

const available = ['initdb', 'pg_ctl', 'openssl'].every((name) => {
  try {
    execFileSync(name, ['--version'], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
});
if (!available && process.env.MARGIN_REQUIRE_POSTGRES_TESTS === '1')
  throw new Error('Required Canvas preflight PostgreSQL/TLS tooling is unavailable.');
async function freePort() {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return port;
}
let directory: string, saved: CanvasBootstrapReceipt, admin: Client, apiCa: Buffer;
let loaded: Awaited<ReturnType<typeof loadCanvasLocalConfig>>;
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
  for (let attempt = 0; attempt < 40; attempt++) {
    if ((await admin.query(`SHOW ${name}`)).rows[0][name] === (enabled ? 'on' : 'off')) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
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
        postgresPort: await freePort(),
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
      await serverSetting('ssl', false);
      try {
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

    it('rejects migration hash drift and recovers after operator repair', async () => {
      const original = (
        await admin.query('SELECT sha256 FROM margin_local.migrations WHERE position=12')
      ).rows[0].sha256;
      try {
        await admin.query(
          "UPDATE margin_local.migrations SET sha256=repeat('0',64) WHERE position=12",
        );
        await rejects(config(), 'identity', 'installation');
      } finally {
        await admin.query('UPDATE margin_local.migrations SET sha256=$1 WHERE position=12', [
          original,
        ]);
      }
      await expect(assertCanvasDatabaseReady(config())).resolves.toBeUndefined();
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
        await serverSetting(setting, false);
        try {
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
