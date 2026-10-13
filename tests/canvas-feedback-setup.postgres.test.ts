import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { Client, type ClientConfig } from 'pg';
import { postgresTlsToolsAvailable } from './helpers/postgres-tools';
import {
  bootCanvasLocal,
  startCanvasLocal,
  stopCanvasLocal,
  migrationManifest,
  type CanvasBootstrapReceipt,
} from '../apps/api/src/canvas-local/bootstrap';
import { loadCanvasLocalConfig } from '../apps/api/src/canvas-local/config';
import {
  enableCanvasLocalFeedback,
  loadCanvasFeedbackDatabase,
} from '../apps/api/src/canvas-local/feedback-companion';
import {
  assertCanvasDatabaseReady,
  assertCanvasFeedbackReady,
} from '../apps/api/src/canvas-local/preflight';
import { acquireCanvasRuntimeAdmission } from '../apps/api/src/canvas-local/maintenance';
import { renewCanvasPostgresCertificate } from '../apps/api/src/canvas-local/certificate-maintenance';
const available = postgresTlsToolsAvailable('Canvas feedback companion');
async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return [4101, 5174, 5432].includes(port) ? freePort() : port;
}
let base: string, root: string, saved: CanvasBootstrapReceipt, operatorConfig: ClientConfig;
let tls: { keyPath: string; certPath: string };
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
async function admin() {
  const client = new Client(operatorConfig);
  await client.connect();
  return client;
}
async function facts() {
  const c = await admin();
  try {
    return {
      ledger: (
        await c.query('SELECT position,name,sha256 FROM margin_local.migrations ORDER BY position')
      ).rows,
      policies: (
        await c.query('SELECT * FROM margin_local.policy_contract ORDER BY table_name,name')
      ).rows,
      feedback: (await c.query("SELECT to_regnamespace('margin_feedback')::text AS name")).rows[0]
        .name,
      logins: (
        await c.query(
          'SELECT rolname,rolpassword FROM pg_authid WHERE rolcanlogin ORDER BY rolname',
        )
      ).rows,
    };
  } finally {
    await c.end();
  }
}
async function fingerprints() {
  return Object.fromEntries(
    await Promise.all(
      ['bootstrap.json', ...Object.keys(saved.files)].map(async (file) => [
        file,
        hash(await readFile(join(root, file))),
      ]),
    ),
  );
}
async function loaded() {
  return loadCanvasLocalConfig(saved.configPath);
}
describe.skipIf(!available)(
  'explicit isolated feedback companion with real verified PostgreSQL TLS',
  { timeout: 30000 },
  () => {
    beforeAll(async () => {
      base = await realpath(await mkdtemp(join(tmpdir(), 'margin-feedback-setup-')));
      const { ensureLocalTls } = await import(
        new URL('../scripts/local-tls.mjs', import.meta.url).href
      );
      tls = ensureLocalTls(join(base, 'tls'));
    });
    beforeEach(async () => {
      root = join(await mkdtemp(join(base, 'case-')), 'canvas');
      saved = await bootCanvasLocal({
        rootDirectory: root,
        postgresPort: await freePort(),
        apiPort: 4101,
        applicationOrigin: 'https://127.0.0.1:5174',
        apiTls: { keyFile: tls.keyPath, certFile: tls.certPath },
      });
      const url = new URL((await readFile(join(root, 'operator/database.url'), 'utf8')).trim());
      operatorConfig = {
        host: url.hostname,
        port: saved.postgresPort,
        user: url.username,
        password: url.password,
        database: 'margin_canvas',
        ssl: { ca: await readFile(join(root, 'postgres-tls/ca.pem')), rejectUnauthorized: true },
        connectionTimeoutMillis: 3000,
      };
    }, 60000);
    afterEach(async () => {
      vi.restoreAllMocks();
      if (saved)
        execFileSync('pg_ctl', ['-D', saved.dataDirectory, '-m', 'immediate', '-w', 'stop'], {
          stdio: 'pipe',
        });
    });
    afterAll(async () => {
      if (base) await rm(base, { recursive: true, force: true });
    });
    it('keeps legacy v13 available with feedback omitted until the explicit upgrade', async () => {
      const config = await loaded();
      try {
        expect(config.configuration.feedbackDatabase).toBeUndefined();
        await assertCanvasDatabaseReady(config.configuration.databases);
      } finally {
        config.dispose();
      }
      expect((await facts()).ledger).toEqual(await migrationManifest(13));
    });
    it('backs up v13, upgrades only additive objects, preserves all original protected bytes and logins, and preflights all eleven credentials', async () => {
      const before = await facts(),
        files = await fingerprints();
      const result = await enableCanvasLocalFeedback(root);
      expect(result).toMatchObject({ changed: true, reconciled: false });
      const after = await facts();
      expect(after.ledger).toEqual(await migrationManifest(14));
      expect(
        after.logins.filter((r: { rolname: string }) => r.rolname !== 'margin_canvas_feedback'),
      ).toEqual(before.logins);
      expect(await fingerprints()).toEqual(files);
      expect(
        after.policies.filter(
          (r: { roles: string[] }) => !r.roles.includes('margin_feedback_runtime'),
        ),
      ).toEqual(before.policies);
      const manifest = JSON.parse(
        await readFile(join(result.backup.directory, 'manifest.json'), 'utf8'),
      );
      expect(manifest).toMatchObject({
        from: 13,
        to: 14,
        sha256: result.backup.sha256,
        migrations: await migrationManifest(13),
      });
      expect(hash(await readFile(result.backup.archive))).toBe(result.backup.sha256);
      const config = await loaded();
      try {
        expect(config.configuration.feedbackDatabase?.user).toBe('margin_canvas_feedback');
        await assertCanvasDatabaseReady(config.configuration.databases);
        await assertCanvasFeedbackReady(config.configuration.feedbackDatabase!, {
          instanceId: saved.instanceId,
        });
        const feedback = new Client(config.configuration.feedbackDatabase);
        await feedback.connect();
        try {
          expect(
            (await feedback.query('SELECT ssl FROM pg_stat_ssl WHERE pid=pg_backend_pid()')).rows[0]
              .ssl,
          ).toBe(true);
          await expect(feedback.query('DELETE FROM margin_local.migrations')).rejects.toThrow();
        } finally {
          await feedback.end();
        }
      } finally {
        config.dispose();
      }
    });
    it('is idempotent without rotating credentials or creating another backup', async () => {
      const first = await enableCanvasLocalFeedback(root),
        files = await fingerprints();
      const original = await readFile(join(root, 'feedback/database.url'));
      expect(await enableCanvasLocalFeedback(root)).toEqual({
        changed: false,
        reconciled: false,
        backup: first.backup,
      });
      expect(await readFile(join(root, 'feedback/database.url'))).toEqual(original);
      expect(await fingerprints()).toEqual(files);
      expect(await readdir(join(root, 'backups'))).toHaveLength(1);
    });
    it('reconciles a lost successful COMMIT without rerunning DDL or replacing credentials', async () => {
      const query = Client.prototype.query;
      let lost = false;
      vi.spyOn(Client.prototype, 'query').mockImplementation(function (
        this: Client,
        ...args: unknown[]
      ) {
        const call = Reflect.apply(query, this, args);
        if (!lost && args[0] === 'COMMIT') {
          lost = true;
          return Promise.resolve(call).then(() => {
            throw new Error('simulated lost COMMIT acknowledgement');
          }) as never;
        }
        return call;
      } as typeof query);
      expect(await enableCanvasLocalFeedback(root)).toMatchObject({
        changed: true,
        reconciled: true,
      });
      expect(lost).toBe(true);
      expect((await facts()).ledger).toHaveLength(14);
    });
    it('rolls back a pre-COMMIT migration failure and retries from the same private journal/password', async () => {
      const before = await facts(),
        query = Client.prototype.query;
      vi.spyOn(Client.prototype, 'query').mockImplementation(function (
        this: Client,
        ...args: unknown[]
      ) {
        if (
          typeof args[0] === 'string' &&
          args[0].startsWith('CREATE ROLE margin_canvas_feedback ')
        )
          return Promise.reject(new Error('injected before role')) as never;
        return Reflect.apply(query, this, args);
      } as typeof query);
      await expect(enableCanvasLocalFeedback(root)).rejects.toThrow('Feedback setup is incomplete');
      vi.restoreAllMocks();
      expect(await facts()).toEqual(before);
      const pending = await readFile(join(root, 'feedback/database.url'));
      expect(await loadCanvasFeedbackDatabase(root)).toBeUndefined();
      const config = await loaded();
      try {
        await assertCanvasDatabaseReady(config.configuration.databases);
      } finally {
        config.dispose();
      }
      expect(await enableCanvasLocalFeedback(root)).toMatchObject({
        changed: true,
        reconciled: true,
      });
      expect(await readFile(join(root, 'feedback/database.url'))).toEqual(pending);
    });
    it('recovers a committed migration when credential verification was interrupted before final publication', async () => {
      const query = Client.prototype.query;
      let failed = false;
      vi.spyOn(Client.prototype, 'query').mockImplementation(function (
        this: Client,
        ...args: unknown[]
      ) {
        if (
          !failed &&
          this.user === 'margin_canvas_feedback' &&
          args[0] === 'SELECT ssl,version FROM pg_stat_ssl WHERE pid=pg_backend_pid()'
        ) {
          failed = true;
          return Promise.reject(new Error('verification interruption')) as never;
        }
        return Reflect.apply(query, this, args);
      } as typeof query);
      await expect(enableCanvasLocalFeedback(root)).rejects.toThrow();
      vi.restoreAllMocks();
      expect(failed).toBe(true);
      expect((await facts()).ledger).toHaveLength(14);
      expect(await loadCanvasFeedbackDatabase(root)).toBeUndefined();
      const original = await readFile(join(root, 'feedback/database.url'));
      expect(await enableCanvasLocalFeedback(root)).toMatchObject({
        changed: true,
        reconciled: true,
      });
      expect(await readFile(join(root, 'feedback/database.url'))).toEqual(original);
    });
    it('preserves an uncommitted COMMIT outcome and only retries after exact v13 reconciliation', async () => {
      const query = Client.prototype.query;
      vi.spyOn(Client.prototype, 'query').mockImplementation(function (
        this: Client,
        ...args: unknown[]
      ) {
        if (args[0] === 'COMMIT')
          return Promise.reject(new Error('connection lost before COMMIT was sent')) as never;
        return Reflect.apply(query, this, args);
      } as typeof query);
      await expect(enableCanvasLocalFeedback(root)).rejects.toThrow();
      vi.restoreAllMocks();
      expect((await facts()).ledger).toHaveLength(13);
      expect((await facts()).feedback).toBeNull();
      expect(await loadCanvasFeedbackDatabase(root)).toBeUndefined();
      expect(await enableCanvasLocalFeedback(root)).toMatchObject({
        changed: true,
        reconciled: true,
      });
    });
    it('refuses a changed backup on retry rather than publishing feedback or reapplying migration', async () => {
      const result = await enableCanvasLocalFeedback(root),
        before = await facts();
      await writeFile(result.backup.archive, 'changed private backup', { mode: 0o600 });
      await expect(enableCanvasLocalFeedback(root)).rejects.toThrow();
      expect(await facts()).toEqual(before);
    });
    it('refuses a foreign preexisting feedback login without changing it', async () => {
      const c = await admin();
      try {
        await c.query('CREATE ROLE margin_canvas_feedback NOLOGIN');
      } finally {
        await c.end();
      }
      const before = await facts();
      await expect(enableCanvasLocalFeedback(root)).rejects.toThrow();
      expect(await facts()).toEqual(before);
      expect(await readdir(join(root, 'feedback'))).toEqual([]);
    });
    it('refuses active runtime admission before mutation', async () => {
      const config = await loaded(),
        c = new Client(config.configuration.databases.identity);
      await c.connect();
      try {
        await acquireCanvasRuntimeAdmission(c);
        await expect(enableCanvasLocalFeedback(root)).rejects.toThrow();
        expect((await facts()).ledger).toHaveLength(13);
      } finally {
        await c.end();
        config.dispose();
      }
    });
    it('rejects a tampered companion credential while retaining base files', async () => {
      await enableCanvasLocalFeedback(root);
      const before = await fingerprints();
      await writeFile(
        join(root, 'feedback/database.url'),
        'postgresql://forged:secret@127.0.0.1:5432/other\n',
        { mode: 0o600 },
      );
      await expect(loaded()).rejects.toThrow('Protected Canvas configuration could not be loaded');
      await expect(enableCanvasLocalFeedback(root)).rejects.toThrow();
      expect(await fingerprints()).toEqual(before);
    });
    it('rejects mixed-purpose feedback memberships even when the additional group is NOINHERIT', async () => {
      await enableCanvasLocalFeedback(root);
      const config = await loaded(),
        c = await admin();
      try {
        await c.query('GRANT margin_submission_reviewer TO margin_canvas_feedback');
        await expect(
          assertCanvasFeedbackReady(config.configuration.feedbackDatabase!, {
            instanceId: saved.instanceId,
          }),
        ).rejects.toMatchObject({ check: 'role' });
        await c.query(
          'REVOKE margin_submission_reviewer FROM margin_canvas_feedback; GRANT margin_feedback_runtime TO margin_canvas_reviewer',
        );
        await expect(
          assertCanvasDatabaseReady(config.configuration.databases),
        ).rejects.toMatchObject({ purpose: 'reviewer', check: 'role' });
      } finally {
        await c.end();
        config.dispose();
      }
    });
    it('rejects changed cloned-policy expressions against the installed immutable contract', async () => {
      await enableCanvasLocalFeedback(root);
      const c = await admin();
      try {
        await c.query('ALTER POLICY feedback_lock_only ON margin_identity.users WITH CHECK(true)');
      } finally {
        await c.end();
      }
      const config = await loaded();
      try {
        await expect(
          assertCanvasFeedbackReady(config.configuration.feedbackDatabase!, {
            instanceId: saved.instanceId,
          }),
        ).rejects.toMatchObject({ check: 'schema' });
      } finally {
        config.dispose();
      }
      await expect(enableCanvasLocalFeedback(root)).rejects.toThrow();
    });
    it('supports stopping, starting and renewing the PostgreSQL leaf at v14 without rebinding feedback or replacing its credential', async () => {
      await enableCanvasLocalFeedback(root);
      const companion = Object.fromEntries(
        await Promise.all(
          ['database.url', 'setup-journal.json', 'installation.json'].map(async (f) => [
            f,
            hash(await readFile(join(root, 'feedback', f))),
          ]),
        ),
      );
      await stopCanvasLocal(root);
      await startCanvasLocal(root);
      expect(await renewCanvasPostgresCertificate(root)).toMatchObject({ wasRunning: true });
      for (const [file, digest] of Object.entries(companion))
        expect(hash(await readFile(join(root, 'feedback', file)))).toBe(digest);
      const config = await loaded();
      try {
        await assertCanvasFeedbackReady(config.configuration.feedbackDatabase!, {
          instanceId: saved.instanceId,
        });
      } finally {
        config.dispose();
      }
    });
  },
);
