import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { X509Certificate } from 'node:crypto';
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';
import { loadCanvasLocalConfig } from '../apps/api/src/canvas-local/config';
import {
  bootCanvasLocal,
  startCanvasLocal,
  stopCanvasLocal,
  CANVAS_DATABASE_ROLES,
  migrationManifest,
  type CanvasBootstrapOptions,
  type CanvasBootstrapReceipt,
} from '../apps/api/src/canvas-local/bootstrap';

const available = ['initdb', 'pg_ctl', 'openssl'].every((name) => {
  try {
    execFileSync(name, ['--version'], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
});
if (!available && process.env.MARGIN_REQUIRE_POSTGRES_TESTS === '1')
  throw new Error('Required Canvas bootstrap PostgreSQL/TLS tooling is unavailable.');
async function freePort() {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return port;
}
let directory: string, options: CanvasBootstrapOptions, saved: CanvasBootstrapReceipt;
async function connection(role = 'operator', tls = true) {
  const path =
    role === 'operator'
      ? join(saved.rootDirectory, 'operator/database.url')
      : join(saved.rootDirectory, 'databases', role + '.url');
  const url = new URL((await readFile(path, 'utf8')).trim());
  const client = new Client({
    host: url.hostname,
    port: Number(url.port),
    user: url.username,
    password: url.password,
    database: url.pathname.slice(1),
    ssl: tls
      ? {
          ca: await readFile(join(saved.rootDirectory, 'postgres-tls/ca.pem')),
          rejectUnauthorized: true,
        }
      : false,
    connectionTimeoutMillis: 3000,
  });
  try {
    await client.connect();
    return client;
  } catch (error) {
    await client.end().catch(() => {});
    throw error;
  }
}
describe.skipIf(!available)(
  'isolated Canvas operator bootstrap with certificate-verified PostgreSQL TLS',
  { timeout: 30000 },
  () => {
    beforeAll(async () => {
      directory = await realpath(await mkdtemp(join(tmpdir(), 'margin-canvas-bootstrap-')));
      const helper = new URL('../scripts/local-tls.mjs', import.meta.url);
      const { ensureLocalTls } = await import(helper.href);
      const tls = ensureLocalTls(join(directory, 'api-tls'));
      options = {
        rootDirectory: join(directory, 'canvas'),
        postgresPort: await freePort(),
        apiPort: 4101,
        applicationOrigin: 'https://127.0.0.1:5174',
        apiTls: { keyFile: tls.keyPath, certFile: tls.certPath },
      };
      saved = await bootCanvasLocal(options);
    }, 60000);
    afterAll(async () => {
      if (saved) {
        await stopCanvasLocal(saved.rootDirectory);
        await rm(directory, { recursive: true, force: true });
      }
    });
    it('creates a dedicated durable TLS cluster and ten separate least-privilege logins without seed content', async () => {
      const config = JSON.parse(await readFile(saved.configPath, 'utf8'));
      const loaded = await loadCanvasLocalConfig(saved.configPath);
      try {
        expect(loaded.configuration.databases.identity).toMatchObject({
          host: '127.0.0.1',
          port: saved.postgresPort,
          ssl: { rejectUnauthorized: true },
        });
      } finally {
        loaded.dispose();
      }
      expect(config.listener).toEqual({ host: '127.0.0.1', port: 4101 });
      expect(config.applicationOrigin).toBe(options.applicationOrigin);
      expect(config).not.toHaveProperty('operator');
      expect(await readFile(config.tls.certFile)).toEqual(await readFile(options.apiTls.certFile));
      const ca = new X509Certificate(await readFile(config.databaseCaFile));
      expect(ca.ca).toBe(true);
      const client = await connection();
      try {
        expect(
          (
            await client.query(
              'SELECT position,name,sha256 FROM margin_local.migrations ORDER BY position',
            )
          ).rows,
        ).toEqual(await migrationManifest());
        expect(
          (await client.query('SELECT ssl FROM pg_stat_ssl WHERE pid=pg_backend_pid()')).rows[0]
            .ssl,
        ).toBe(true);
        expect(
          (
            await client.query(
              "SELECT current_setting('listen_addresses') host,current_setting('fsync') fsync,current_setting('synchronous_commit') synchronous,current_setting('full_page_writes') pages,current_setting('unix_socket_directories') sockets",
            )
          ).rows[0],
        ).toEqual({ host: '127.0.0.1', fsync: 'on', synchronous: 'on', pages: 'on', sockets: '' });
        for (const table of [
          'margin_identity.users',
          'margin_identity.organizations',
          'margin_lms.installations',
          'margin_ingestion.artifacts',
        ])
          expect((await client.query('SELECT count(*) FROM ' + table)).rows[0].count).toBe('0');
      } finally {
        await client.end();
      }
      const users = new Set<string>(),
        passwords = new Set<string>();
      for (const [name, role] of Object.entries(CANVAS_DATABASE_ROLES)) {
        const url = new URL((await readFile(config.databases[name], 'utf8')).trim());
        users.add(url.username);
        passwords.add(url.password);
        const db = await connection(name);
        try {
          const actual = (
            await db.query(
              "SELECT current_user name,pg_has_role(current_user,$1,'MEMBER') member,has_database_privilege(current_database(),'TEMP') temporary,has_schema_privilege('margin_local','CREATE') creates,has_table_privilege('margin_local.migrations','INSERT,UPDATE,DELETE') writes,has_table_privilege('margin_local.policy_contract','INSERT,UPDATE,DELETE') policy_writes",
              [role],
            )
          ).rows[0];
          expect(actual).toEqual({
            name: url.username,
            member: true,
            temporary: false,
            creates: false,
            writes: false,
            policy_writes: false,
          });
          expect(
            (await db.query('SELECT count(*) FROM margin_local.migrations')).rows[0].count,
          ).toBe('12');
          expect(
            Number(
              (await db.query('SELECT count(*) FROM margin_local.policy_contract')).rows[0].count,
            ),
          ).toBeGreaterThan(0);
        } finally {
          await db.end();
        }
      }
      expect(users.size).toBe(10);
      expect(passwords.size).toBe(10);
      const secrets = await Promise.all(
        Object.values(config.secrets).map(async (path) =>
          Buffer.from((await readFile(path as string, 'utf8')).trim(), 'base64'),
        ),
      );
      expect(secrets.every((value) => value.length === 32)).toBe(true);
      expect(new Set(secrets.map((value) => value.toString('hex'))).size).toBe(5);
      secrets.forEach((value) => value.fill(0));
      for (const file of Object.keys(saved.files)) {
        const s = await stat(join(saved.rootDirectory, file));
        expect(s.mode & 0o777).toBe(0o600);
        expect(s.uid).toBe(process.getuid!());
      }
      for (const path of [
        '',
        'secrets',
        'operator',
        'databases',
        'postgres-tls',
        'postgres',
        'api-tls',
        'artifacts',
        'data',
      ])
        expect((await stat(join(saved.rootDirectory, path))).mode & 0o777).toBe(0o700);
    });
    it('reuses exact keys and migration receipts, and explicitly stops/restarts without resetting data', async () => {
      const before = await readFile(join(saved.rootDirectory, 'bootstrap.json'));
      const own = await connection();
      try {
        await own.query(
          "CREATE TABLE margin_local.test_preserved(value text);INSERT INTO margin_local.test_preserved VALUES('retained')",
        );
      } finally {
        await own.end();
      }
      expect(await bootCanvasLocal(options)).toMatchObject({
        instanceId: saved.instanceId,
        started: false,
      });
      expect(await readFile(join(saved.rootDirectory, 'bootstrap.json'))).toEqual(before);
      expect(await stopCanvasLocal(saved.rootDirectory)).toBe(true);
      expect(await stopCanvasLocal(saved.rootDirectory)).toBe(false);
      expect(await startCanvasLocal(saved.rootDirectory)).toMatchObject({
        instanceId: saved.instanceId,
        systemIdentifier: saved.systemIdentifier,
        started: true,
      });
      const again = await connection();
      try {
        expect((await again.query('SELECT value FROM margin_local.test_preserved')).rows).toEqual([
          { value: 'retained' },
        ]);
      } finally {
        await again.end();
      }
    });
    it('rejects plaintext PostgreSQL and a TLS connection with the unrelated API certificate', async () => {
      await expect(connection('identity', false)).rejects.toBeDefined();
      const url = new URL(
        (await readFile(join(saved.rootDirectory, 'databases/identity.url'), 'utf8')).trim(),
      );
      const db = new Client({
        host: '127.0.0.1',
        port: saved.postgresPort,
        user: url.username,
        password: url.password,
        database: 'margin_canvas',
        ssl: { ca: await readFile(options.apiTls.certFile), rejectUnauthorized: true },
        connectionTimeoutMillis: 3000,
      });
      try {
        await expect(db.connect()).rejects.toBeDefined();
      } finally {
        await db.end().catch(() => {});
      }
    });
    it('refuses changed migration hashes without replaying migrations or changing credentials', async () => {
      const db = await connection();
      const old = (await migrationManifest())[0].sha256;
      try {
        await db.query("UPDATE margin_local.migrations SET sha256=repeat('0',64) WHERE position=1");
        await expect(bootCanvasLocal(options)).rejects.toThrow('Migration history differs');
      } finally {
        await db.query('UPDATE margin_local.migrations SET sha256=$1 WHERE position=1', [old]);
        await db.end();
      }
    });
    it('refuses policy predicate drift or additional policies without rewriting the installed contract', async () => {
      const db = await connection();
      const before = (
        await db.query('SELECT * FROM margin_local.policy_contract ORDER BY table_name,name')
      ).rows;
      try {
        await db.query('ALTER POLICY identity_user_read ON margin_identity.users USING(true)');
        try {
          await expect(startCanvasLocal(saved.rootDirectory)).rejects.toThrow('policies differ');
        } finally {
          await db.query(
            "ALTER POLICY identity_user_read ON margin_identity.users USING(id=margin_identity.context_user() OR identity_key=margin_identity.context_value('identity_key'))",
          );
        }
        await db.query(
          'CREATE POLICY injected_policy ON margin_identity.users FOR SELECT USING(true)',
        );
        try {
          await expect(startCanvasLocal(saved.rootDirectory)).rejects.toThrow('policies differ');
          expect(
            (await db.query('SELECT * FROM margin_local.policy_contract ORDER BY table_name,name'))
              .rows,
          ).toEqual(before);
        } finally {
          await db.query('DROP POLICY injected_policy ON margin_identity.users');
        }
      } finally {
        await db.end();
      }
    });
    it('refuses changed protected files and changed requested ports without rewriting them', async () => {
      const path = join(saved.rootDirectory, 'secrets/session.key'),
        old = await readFile(path);
      try {
        await writeFile(path, Buffer.alloc(32).toString('base64') + '\n');
        await expect(bootCanvasLocal(options)).rejects.toThrow('differs from its saved receipt');
      } finally {
        await writeFile(path, old);
        old.fill(0);
      }
      await expect(bootCanvasLocal({ ...options, postgresPort: await freePort() })).rejects.toThrow(
        'differs from the requested',
      );
    });
    it('preserves and refuses a foreign nonempty root, incomplete setup, and symlink root', async () => {
      const foreign = join(directory, 'foreign');
      await mkdir(foreign, { mode: 0o700 });
      await writeFile(join(foreign, 'keep'), 'existing unrelated data', { mode: 0o600 });
      await expect(bootCanvasLocal({ ...options, rootDirectory: foreign })).rejects.toThrow(
        'Foreign or incomplete',
      );
      expect(await readdir(foreign)).toEqual(['keep']);
      expect(await readFile(join(foreign, 'keep'), 'utf8')).toBe('existing unrelated data');
      const alias = join(directory, 'alias');
      await symlink(saved.rootDirectory, alias);
      await expect(bootCanvasLocal({ ...options, rootDirectory: alias })).rejects.toThrow(
        'private directory',
      );
    });
    it('rejects the existing default PostgreSQL port before creating any root', async () => {
      const untouched = join(directory, 'not-created');
      await expect(
        bootCanvasLocal({ ...options, rootDirectory: untouched, postgresPort: 5432 }),
      ).rejects.toThrow('non-5432');
      await expect(stat(untouched)).rejects.toMatchObject({ code: 'ENOENT' });
    });
    it('rejects incomplete web origins and conflicting listener ports before creating any root', async () => {
      const untouched = join(directory, 'invalid-listener-not-created');
      for (const applicationOrigin of [
        'https://127.0.0.1',
        'https://127.0.0.1:443',
        'https://127.0.0.1:1000',
        `https://127.0.0.1:${options.apiPort}`,
        `https://127.0.0.1:${options.postgresPort}`,
      ])
        await expect(
          bootCanvasLocal({ ...options, rootDirectory: untouched, applicationOrigin }),
        ).rejects.toThrow(/explicit port|different local ports/);
      await expect(stat(untouched)).rejects.toMatchObject({ code: 'ENOENT' });
    });
    it('does not echo unknown native error details or supplied secret-like values from the CLI', async () => {
      const untouched = join(directory, 'cli-error-not-created');
      let failure: { status?: number; stderr?: Buffer; stdout?: Buffer } | undefined;
      try {
        execFileSync(
          process.execPath,
          [
            '--import',
            'tsx',
            fileURLToPath(new URL('../scripts/setup-canvas-local.mjs', import.meta.url)),
            'setup',
            '--root',
            untouched,
            '--application-origin',
            'private-secret-probe',
          ],
          { stdio: 'pipe' },
        );
      } catch (error) {
        failure = error as typeof failure;
      }
      expect(failure?.status).toBe(1);
      expect(failure?.stderr?.toString()).toContain('The local setup operation failed.');
      expect(failure?.stderr?.toString()).not.toContain('private-secret-probe');
      expect(failure?.stdout?.length).toBe(0);
      await expect(stat(untouched)).rejects.toMatchObject({ code: 'ENOENT' });
    });
    it('refuses unsafe runtime environments before creating files, starting, or stopping a database', async () => {
      const untouched = join(directory, 'unsafe-environment-not-created');
      for (const [name, value] of [
        ['NODE_ENV', 'production'],
        ['NODE_TLS_REJECT_UNAUTHORIZED', '0'],
        ['PGREPLICATION', 'database'],
        ['PGBINARY', '1'],
      ]) {
        vi.stubEnv(name, value);
        try {
          await expect(bootCanvasLocal({ ...options, rootDirectory: untouched })).rejects.toThrow(
            'non-production environment',
          );
          await expect(startCanvasLocal(saved.rootDirectory)).rejects.toThrow(
            'non-production environment',
          );
          await expect(stopCanvasLocal(saved.rootDirectory)).rejects.toThrow(
            'non-production environment',
          );
        } finally {
          vi.unstubAllEnvs();
        }
      }
      await expect(stat(untouched)).rejects.toMatchObject({ code: 'ENOENT' });
      const unaffected = await connection();
      await unaffected.end();
    });
    it('pins operator session settings instead of inheriting PostgreSQL environment overrides', async () => {
      vi.stubEnv('PGOPTIONS', '-c search_path=public');
      vi.stubEnv('PGCLIENT_ENCODING', 'SQL_ASCII');
      vi.stubEnv('PGSSLNEGOTIATION', 'invalid-test-override');
      const original = Client.prototype.query;
      let observed = false;
      const spy = vi.spyOn(Client.prototype, 'query').mockImplementation(async function (
        this: Client,
        ...args: unknown[]
      ) {
        if (
          typeof args[0] === 'string' &&
          args[0].startsWith("SELECT current_setting('data_directory')")
        ) {
          const actual = await Reflect.apply(original, this, [
            "SELECT current_setting('search_path') path,current_setting('client_encoding') encoding",
          ]);
          expect(actual.rows).toEqual([{ path: 'pg_catalog', encoding: 'UTF8' }]);
          observed = true;
        }
        return Reflect.apply(original, this, args);
      } as Client['query']);
      try {
        await expect(startCanvasLocal(saved.rootDirectory)).resolves.toMatchObject({
          started: false,
        });
        expect(observed).toBe(true);
      } finally {
        spy.mockRestore();
        vi.unstubAllEnvs();
      }
    });
    it('stops only the cluster it starts when restart validation fails', async () => {
      await stopCanvasLocal(saved.rootDirectory);
      const original = Client.prototype.query;
      const spy = vi.spyOn(Client.prototype, 'query').mockImplementation(function (
        this: Client,
        ...args: unknown[]
      ) {
        if (
          args[0] === 'SELECT position,name,sha256 FROM margin_local.migrations ORDER BY position'
        )
          return Promise.reject(new Error('synthetic restart validation failure'));
        return Reflect.apply(original, this, args);
      } as Client['query']);
      try {
        await expect(startCanvasLocal(saved.rootDirectory)).rejects.toThrow(
          'synthetic restart validation failure',
        );
        let status = 0;
        try {
          execFileSync('pg_ctl', ['-D', saved.dataDirectory, 'status'], { stdio: 'pipe' });
        } catch (error) {
          status = (error as { status: number }).status;
        }
        expect(status).toBe(3);
      } finally {
        spy.mockRestore();
        await startCanvasLocal(saved.rootDirectory);
      }
    });
    it('binds the operator receipt to exact server identity before stopping', async () => {
      const path = join(saved.rootDirectory, 'bootstrap.json'),
        old = await readFile(path);
      const changed = JSON.parse(old.toString());
      changed.systemIdentifier = '1';
      try {
        await writeFile(path, JSON.stringify(changed));
        await expect(stopCanvasLocal(saved.rootDirectory)).rejects.toThrow(
          'not this owned Canvas cluster',
        );
        const db = await connection();
        await db.end();
      } finally {
        await writeFile(path, old);
      }
    });
    it('stops its freshly started cluster after setup failure and preserves the incomplete root', async () => {
      const rootDirectory = join(directory, 'failed-setup');
      const original = Client.prototype.query;
      const spy = vi.spyOn(Client.prototype, 'query').mockImplementation(function (
        this: Client,
        ...args: unknown[]
      ) {
        if (args[0] === 'CREATE DATABASE margin_canvas')
          return Promise.reject(new Error('synthetic setup interruption'));
        return Reflect.apply(original, this, args);
      } as Client['query']);
      try {
        await expect(
          bootCanvasLocal({ ...options, rootDirectory, postgresPort: await freePort() }),
        ).rejects.toThrow('synthetic setup interruption');
      } finally {
        spy.mockRestore();
      }
      let status = 0;
      try {
        execFileSync('pg_ctl', ['-D', join(rootDirectory, 'postgres'), 'status'], {
          stdio: 'pipe',
        });
      } catch (error) {
        status = (error as { status: number }).status;
      }
      expect(status).toBe(3);
      const unaffected = await connection();
      try {
        expect(
          (await unaffected.query('SELECT value FROM margin_local.test_preserved')).rows,
        ).toEqual([{ value: 'retained' }]);
      } finally {
        await unaffected.end();
      }
      expect(await readFile(join(rootDirectory, 'ownership.json'), 'utf8')).toContain('instanceId');
      await expect(stat(join(rootDirectory, 'bootstrap.json'))).rejects.toMatchObject({
        code: 'ENOENT',
      });
      await expect(bootCanvasLocal({ ...options, rootDirectory })).rejects.toThrow(
        'Foreign or incomplete',
      );
    });
  },
);
