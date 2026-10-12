import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, realpath, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { Client, type ClientConfig } from 'pg';
import { postgresTlsToolsAvailable } from './helpers/postgres-tools';
import {
  bootCanvasLocal,
  stopCanvasLocal,
  upgradeCanvasLocal,
  migrationManifest,
  type CanvasBootstrapReceipt,
} from '../apps/api/src/canvas-local/bootstrap';
import { loadCanvasLocalConfig } from '../apps/api/src/canvas-local/config';
import {
  acquireCanvasRuntimeAdmission,
  acquireCanvasMaintenance,
} from '../apps/api/src/canvas-local/maintenance';
import { EncryptedStore, LocalKeyProvider } from '../apps/api/src/encryption';
import { createCanvasUpgradeBackup } from '../apps/api/src/canvas-local/upgrade-backup';

const available = postgresTlsToolsAvailable('Canvas explicit upgrade');
if (available)
  for (const name of ['pg_dump', 'pg_restore'])
    execFileSync(name, ['--version'], { stdio: 'pipe' });
async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const value = (server.address() as { port: number }).port;
  await new Promise<void>((done) => server.close(() => done()));
  return [4101, 5174, 5432].includes(value) ? freePort() : value;
}
let base: string, root: string, saved: CanvasBootstrapReceipt;
let tls: { keyPath: string; certPath: string }, adminConfig: ClientConfig;
let loaded: Awaited<ReturnType<typeof loadCanvasLocalConfig>>;
async function admin(database = 'margin_canvas') {
  const client = new Client({ ...adminConfig, database });
  await client.connect();
  return client;
}
async function state() {
  const client = await admin();
  try {
    return {
      migrations: (
        await client.query(
          'SELECT position,name,sha256 FROM margin_local.migrations ORDER BY position',
        )
      ).rows,
      policies: (
        await client.query('SELECT * FROM margin_local.policy_contract ORDER BY table_name,name')
      ).rows,
      sourceTable: (
        await client.query(
          "SELECT to_regclass('margin_ingestion.upload_reservations')::text AS value",
        )
      ).rows[0].value,
    };
  } finally {
    await client.end();
  }
}
describe.skipIf(!available)(
  'explicit durable local Canvas 12 to 13 upgrade',
  { timeout: 30000 },
  () => {
    beforeAll(async () => {
      base = await realpath(await mkdtemp(join(tmpdir(), 'margin-upgrade-')));
      const { ensureLocalTls } = await import(
        new URL('../scripts/local-tls.mjs', import.meta.url).href
      );
      tls = ensureLocalTls(join(base, 'tls'));
    });
    beforeEach(async () => {
      root = join(await mkdtemp(join(base, 'case-')), 'canvas');
      saved = await bootCanvasLocal(
        {
          rootDirectory: root,
          postgresPort: await freePort(),
          apiPort: 4101,
          applicationOrigin: 'https://127.0.0.1:5174',
          apiTls: { keyFile: tls.keyPath, certFile: tls.certPath },
        },
        { installThrough: 12 },
      );
      loaded = await loadCanvasLocalConfig(saved.configPath);
      const url = new URL((await readFile(join(root, 'operator/database.url'), 'utf8')).trim());
      adminConfig = {
        host: '127.0.0.1',
        port: saved.postgresPort,
        user: url.username,
        password: url.password,
        ssl: { ca: await readFile(join(root, 'postgres-tls/ca.pem')), rejectUnauthorized: true },
        connectionTimeoutMillis: 3000,
      };
    }, 60000);
    afterEach(async () => {
      vi.restoreAllMocks();
      loaded?.dispose();
      if (saved) await stopCanvasLocal(root);
      await rm(join(root, '..'), { recursive: true, force: true });
    });
    afterAll(async () => {
      if (base) await rm(base, { recursive: true, force: true });
    });

    it('preserves all protected bytes, database content and encrypted files, with an actually restorable private backup', async () => {
      const old = await state();
      const protectedFiles = new Map(
        await Promise.all(
          [...Object.keys(saved.files), 'bootstrap.json'].map(
            async (path) => [path, await readFile(join(root, path))] as const,
          ),
        ),
      );
      const keys = new LocalKeyProvider(
        loaded.configuration.secrets.wrapping,
        loaded.configuration.wrappingKeyId,
      );
      const encrypted = new EncryptedStore(loaded.configuration.artifactDirectory, keys);
      const object = join(loaded.configuration.artifactDirectory, 'preserved.enc');
      await encrypted.writeJson(object, { text: 'Private saved assignment content' });
      const ciphertext = await readFile(object);
      const client = await admin();
      await client.query(
        'CREATE TABLE margin_local.test_preserved(id integer PRIMARY KEY,content bytea NOT NULL)',
      );
      await client.query('INSERT INTO margin_local.test_preserved VALUES(1,$1)', [ciphertext]);
      await client.end();
      const result = await upgradeCanvasLocal(root);
      expect(result).toMatchObject({ from: 12, to: 13, changed: true, reconciled: false });
      expect((await state()).migrations).toHaveLength(13);
      for (const [path, bytes] of protectedFiles)
        expect(await readFile(join(root, path))).toEqual(bytes);
      expect(await encrypted.readJson(object)).toEqual({
        text: 'Private saved assignment content',
      });
      expect(await readFile(object)).toEqual(ciphertext);
      keys.close();
      const backup = result.backup!;
      expect((await stat(backup.directory)).mode & 0o777).toBe(0o700);
      expect((await stat(backup.archive)).mode & 0o777).toBe(0o600);
      const manifest = JSON.parse(await readFile(join(backup.directory, 'manifest.json'), 'utf8'));
      expect(manifest).toMatchObject({
        from: 12,
        to: 13,
        instanceId: saved.instanceId,
        sha256: backup.sha256,
      });
      expect(manifest.migrations).toHaveLength(12);
      const operator = await admin();
      await operator.query('CREATE DATABASE canvas_upgrade_recovery');
      await operator.end();
      execFileSync(
        'pg_restore',
        [
          '--host',
          '127.0.0.1',
          '--port',
          String(saved.postgresPort),
          '--username',
          String(adminConfig.user),
          '--dbname',
          'canvas_upgrade_recovery',
          '--exit-on-error',
          '--no-password',
          backup.archive,
        ],
        {
          timeout: 20000,
          stdio: 'pipe',
          env: {
            PATH: process.env.PATH,
            PGPASSWORD: String(adminConfig.password),
            PGSSLMODE: 'verify-full',
            PGSSLROOTCERT: join(root, 'postgres-tls/ca.pem'),
          },
        },
      );
      const restored = await admin('canvas_upgrade_recovery');
      try {
        expect(
          (await restored.query('SELECT count(*)::integer AS n FROM margin_local.migrations'))
            .rows[0].n,
        ).toBe(12);
        expect(
          (await restored.query('SELECT content FROM margin_local.test_preserved')).rows[0].content,
        ).toEqual(ciphertext);
        expect(
          (
            await restored.query(
              "SELECT to_regclass('margin_ingestion.upload_reservations') AS object",
            )
          ).rows[0].object,
        ).toBeNull();
        expect(
          (
            await restored.query(
              'SELECT * FROM margin_local.policy_contract ORDER BY table_name,name',
            )
          ).rows,
        ).toEqual(old.policies);
      } finally {
        await restored.end();
      }
      const before = await state();
      expect(await upgradeCanvasLocal(root)).toEqual({
        from: 13,
        to: 13,
        changed: false,
        reconciled: false,
      });
      expect(await state()).toEqual(before);
      expect(await readdir(join(root, 'backups'))).toHaveLength(1);
    });

    it('bounds real pg_dump output while writing, terminates the child and never accepts a partial recovery point', async () => {
      const before = await state();
      await expect(
        createCanvasUpgradeBackup(root, adminConfig, saved, await migrationManifest(12), {
          maximumArchiveBytes: 64,
        }),
      ).rejects.toThrow('backup could not be verified');
      const backups = await readdir(join(root, 'backups'));
      expect(backups).toHaveLength(1);
      const directory = join(root, 'backups', backups[0]);
      expect((await stat(join(directory, 'database.dump'))).size).toBeLessThanOrEqual(64);
      await expect(stat(join(directory, 'manifest.json'))).rejects.toMatchObject({
        code: 'ENOENT',
      });
      expect(await state()).toEqual(before);
      const observer = await admin();
      try {
        expect(
          (
            await observer.query(
              "SELECT count(*)::integer AS n FROM pg_stat_activity WHERE application_name='margin-canvas-upgrade-backup' AND datname=current_database()",
            )
          ).rows[0].n,
        ).toBe(0);
      } finally {
        await observer.end();
      }
    });

    it('refuses active runtime leases and legacy sessions without creating a backup', async () => {
      const lease = await acquireCanvasRuntimeAdmission(loaded.configuration.databases.identity);
      try {
        await expect(upgradeCanvasLocal(root)).rejects.toThrow('Stop the Canvas API');
      } finally {
        await lease.close();
      }
      const legacy = new Client(loaded.configuration.databases.work);
      await legacy.connect();
      try {
        await expect(upgradeCanvasLocal(root)).rejects.toThrow('Other database clients');
      } finally {
        await legacy.end();
      }
      await expect(stat(join(root, 'backups'))).rejects.toMatchObject({ code: 'ENOENT' });
      expect((await state()).migrations).toHaveLength(12);
    });

    it('excludes new runtime admission during maintenance and exposes lease loss without false abort on close', async () => {
      const operator = await admin();
      await acquireCanvasMaintenance(operator);
      await expect(
        acquireCanvasRuntimeAdmission(loaded.configuration.databases.identity),
      ).rejects.toThrow('maintenance');
      await operator.end();
      const first = await acquireCanvasRuntimeAdmission(loaded.configuration.databases.identity);
      await first.close();
      await first.close();
      expect(first.signal.aborted).toBe(false);
      const second = await acquireCanvasRuntimeAdmission(loaded.configuration.databases.identity);
      const watcher = await admin();
      await watcher.query(
        "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=current_database() AND application_name='margin-canvas-runtime-admission'",
      );
      await watcher.end();
      await new Promise<void>((resolve) => {
        if (second.signal.aborted) resolve();
        else second.signal.addEventListener('abort', () => resolve(), { once: true });
      });
      expect(second.signal.aborted).toBe(true);
      await second.close();
    });

    it.each(['migration', 'policy'])(
      'refuses preexisting %s drift instead of accepting a new baseline',
      async (kind) => {
        const client = await admin();
        const old = await state();
        try {
          if (kind === 'migration')
            await client.query(
              "UPDATE margin_local.migrations SET sha256=repeat('0',64) WHERE position=1",
            );
          else
            await client.query(
              'ALTER POLICY identity_user_read ON margin_identity.users USING(true)',
            );
          await client.end();
          await expect(upgradeCanvasLocal(root)).rejects.toThrow(
            /Migration history|policies differ/,
          );
          await expect(stat(join(root, 'backups'))).rejects.toMatchObject({ code: 'ENOENT' });
        } finally {
          const repair = await admin();
          if (kind === 'migration')
            await repair.query('UPDATE margin_local.migrations SET sha256=$1 WHERE position=1', [
              old.migrations[0].sha256,
            ]);
          else {
            const row = old.policies.find((p) => p.name === 'identity_user_read');
            await repair.query(
              'ALTER POLICY identity_user_read ON margin_identity.users USING(' +
                row.using_expression +
                ')',
            );
          }
          await repair.end();
          await client.end().catch(() => {});
        }
      },
    );

    it.each(['ddl', 'ledger', 'policy'])(
      'rolls back %s failure with its exact old ledger and policy baseline',
      async (step) => {
        const before = await state();
        const original = Client.prototype.query;
        let injected = false;
        const spy = vi.spyOn(Client.prototype, 'query').mockImplementation(function (
          this: Client,
          ...args: unknown[]
        ) {
          const sql = String(args[0]);
          if (
            (step === 'ddl' && sql.includes('CREATE TABLE margin_ingestion.upload_reservations')) ||
            (step === 'ledger' && sql.startsWith('INSERT INTO margin_local.migrations')) ||
            (step === 'policy' && sql === 'DELETE FROM margin_local.policy_contract')
          ) {
            injected = true;
            return Promise.reject(new Error('injected private upgrade failure'));
          }
          return Reflect.apply(original, this, args);
        } as Client['query']);
        try {
          await expect(upgradeCanvasLocal(root)).rejects.toThrow('not committed');
        } finally {
          spy.mockRestore();
        }
        expect(injected).toBe(true);
        expect(await state()).toEqual(before);
        expect(await readdir(join(root, 'backups'))).toHaveLength(1);
      },
    );

    it.each([true, false])(
      'reconciles lost COMMIT acknowledgement when commit applied=%s',
      async (applied) => {
        const original = Client.prototype.query;
        let injected = false;
        const spy = vi.spyOn(Client.prototype, 'query').mockImplementation(async function (
          this: Client,
          ...args: unknown[]
        ) {
          if (args[0] === 'COMMIT' && !injected) {
            injected = true;
            if (applied) await Reflect.apply(original, this, args);
            throw new Error('lost commit acknowledgement');
          }
          return Reflect.apply(original, this, args);
        } as Client['query']);
        try {
          if (applied)
            expect(await upgradeCanvasLocal(root)).toMatchObject({
              changed: true,
              reconciled: true,
            });
          else await expect(upgradeCanvasLocal(root)).rejects.toThrow('exact migration 12');
        } finally {
          spy.mockRestore();
        }
        expect((await state()).migrations).toHaveLength(applied ? 13 : 12);
      },
    );
  },
);
