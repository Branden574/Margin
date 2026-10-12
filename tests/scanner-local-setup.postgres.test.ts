import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  readdir,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { Client, type ClientConfig } from 'pg';
import { postgresTlsToolsAvailable } from './helpers/postgres-tools';
import {
  bootCanvasLocal,
  stopCanvasLocal,
  type CanvasBootstrapReceipt,
} from '../apps/api/src/canvas-local/bootstrap';
import {
  acquireCanvasRuntimeAdmission,
  acquireCanvasMaintenance,
} from '../apps/api/src/canvas-local/maintenance';
import { startLocalScanner } from '../apps/api/src/scanner/local-runtime';
import { loadCanvasLocalConfig } from '../apps/api/src/canvas-local/config';
import { assertCanvasInspectorReady } from '../apps/api/src/canvas-local/preflight';
import {
  setupLocalScanner,
  type LocalScannerSetupOptions,
} from '../apps/api/src/scanner/local-setup';
import { INSPECTOR_LOGIN, loadLocalScannerConfig } from '../apps/api/src/scanner/local-config';

const engine = vi.hoisted(() => ({
  ready: vi.fn(),
  sandbox: vi.fn(),
  close: vi.fn(),
  definitions: vi.fn(),
}));
vi.mock('../apps/api/src/scanner/docker.js', () => ({
  createDockerScannerExecutor: async (options: { stateDirectory: string }) => {
    await mkdir(options.stateDirectory, { recursive: true, mode: 0o700 });
    return { ready: engine.ready, checkSandbox: engine.sandbox, close: engine.close };
  },
}));
vi.mock('../infra/scanner/clamav/definitions.mjs', () => ({
  readScannerDefinitions: engine.definitions,
}));
const publicationFault = vi.hoisted(() => ({ target: '', afterLink: false }));
vi.mock('node:fs/promises', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...original,
    link: async (existing: string, path: string) => {
      if (publicationFault.target && path.endsWith('/scanner/' + publicationFault.target)) {
        publicationFault.target = '';
        if (publicationFault.afterLink) await original.link(existing, path);
        throw Error('simulated publication interruption');
      }
      return original.link(existing, path);
    },
  };
});
const available = postgresTlsToolsAvailable('Canvas inspector companion');
async function freePort(excluded: number[] = []): Promise<number> {
  const server = createServer();
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((done) => server.close(() => done()));
  return [4101, 5174, 5432, ...excluded].includes(port) ? freePort(excluded) : port;
}
let base: string, root: string, saved: CanvasBootstrapReceipt;
let tls: { keyPath: string; certPath: string },
  adminConfig: ClientConfig,
  options: LocalScannerSetupOptions;
async function admin() {
  const client = new Client(adminConfig);
  await client.connect();
  return client;
}
async function query(sql: string, values?: unknown[]) {
  const client = await admin();
  try {
    return await client.query(sql, values);
  } finally {
    await client.end();
  }
}
async function roleExists() {
  return (await query('SELECT 1 FROM pg_roles WHERE rolname=$1', [INSPECTOR_LOGIN])).rowCount === 1;
}
const inspectorPath = () => join(root, 'scanner/inspector.json');
async function absentInstallation() {
  await expect(stat(join(root, 'scanner/installation.json'))).rejects.toMatchObject({
    code: 'ENOENT',
  });
}
function interceptQuery(
  handler: (client: Client, args: unknown[], run: () => Promise<unknown>) => Promise<unknown>,
) {
  const original = Client.prototype.query;
  return vi.spyOn(Client.prototype, 'query').mockImplementation(async function (
    this: Client,
    ...args: unknown[]
  ) {
    return handler(this, args, () => Reflect.apply(original, this, args));
  } as Client['query']);
}

describe.skipIf(!available)(
  'preserving local scanner companion setup over real PostgreSQL TLS',
  { timeout: 30000 },
  () => {
    beforeAll(async () => {
      base = await realpath(await mkdtemp(join(tmpdir(), 'margin-inspector-')));
      const { ensureLocalTls } = await import(
        new URL('../scripts/local-tls.mjs', import.meta.url).href
      );
      tls = ensureLocalTls(join(base, 'tls'));
    });
    beforeEach(async () => {
      publicationFault.target = '';
      publicationFault.afterLink = false;
      engine.ready.mockReset().mockResolvedValue(undefined);
      engine.sandbox.mockReset().mockResolvedValue(undefined);
      engine.close.mockReset().mockResolvedValue(undefined);
      engine.definitions
        .mockReset()
        .mockResolvedValue({ directory: join(base, 'definition-fixture') });
      root = join(await mkdtemp(join(base, 'case-')), 'canvas');
      const postgresPort = await freePort();
      saved = await bootCanvasLocal({
        rootDirectory: root,
        postgresPort,
        apiPort: await freePort([postgresPort]),
        applicationOrigin: 'https://127.0.0.1:5174',
        apiTls: { keyFile: tls.keyPath, certFile: tls.certPath },
      });
      const url = new URL((await readFile(join(root, 'operator/database.url'), 'utf8')).trim());
      adminConfig = {
        host: '127.0.0.1',
        port: postgresPort,
        database: 'margin_canvas',
        user: url.username,
        password: url.password,
        ssl: { ca: await readFile(join(root, 'postgres-tls/ca.pem')), rejectUnauthorized: true },
        connectionTimeoutMillis: 3000,
      };
      // Engine tests independently exercise Docker. This suite isolates actual DB/file admission.
      const socket = join(root, 'test-socket');
      await writeFile(socket, 'mock executor endpoint', { mode: 0o600 });
      options = {
        canvasRoot: root,
        parserImage: 'sha256:' + 'a'.repeat(64),
        antivirusImage: 'sha256:' + 'b'.repeat(64),
        definitionsDirectory: join(base, 'definition-fixture'),
        dockerExecutable: process.execPath,
        dockerSocketPath: socket,
      };
    }, 60000);
    afterEach(async () => {
      vi.restoreAllMocks();
      if (saved) await stopCanvasLocal(root);
      if (root) await rm(join(root, '..'), { recursive: true, force: true });
    });
    afterAll(async () => {
      if (base) await rm(base, { recursive: true, force: true });
    });

    it('adds a least-privilege inspector, retains every original byte, and reruns without rotating credentials', async () => {
      const before = new Map(
        await Promise.all(
          [...Object.keys(saved.files), 'bootstrap.json'].map(
            async (name) => [name, await readFile(join(root, name))] as const,
          ),
        ),
      );
      await writeFile(
        join(root, 'artifacts/preserved.enc'),
        Buffer.from('existing opaque encrypted artifact'),
        { mode: 0o600 },
      );
      const first = await setupLocalScanner(options);
      expect(first).toEqual({ configPath: inspectorPath(), changed: true, reconciled: false });
      for (const [name, bytes] of before) expect(await readFile(join(root, name))).toEqual(bytes);
      expect(await readFile(join(root, 'artifacts/preserved.enc'), 'utf8')).toBe(
        'existing opaque encrypted artifact',
      );
      const role = (
        await query(
          'SELECT rolcanlogin,rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls,rolconnlimit FROM pg_roles WHERE rolname=$1',
          [INSPECTOR_LOGIN],
        )
      ).rows[0];
      expect(role).toEqual({
        rolcanlogin: true,
        rolsuper: false,
        rolcreatedb: false,
        rolcreaterole: false,
        rolreplication: false,
        rolbypassrls: false,
        rolconnlimit: 6,
      });
      expect(
        (
          await query(
            'SELECT r.rolname FROM pg_auth_members m JOIN pg_roles r ON r.oid=m.roleid JOIN pg_roles u ON u.oid=m.member WHERE u.rolname=$1 ORDER BY r.rolname',
            [INSPECTOR_LOGIN],
          )
        ).rows,
      ).toEqual([{ rolname: 'margin_ingestion_inspector' }]);
      const loaded = await loadLocalScannerConfig(first.configPath);
      await assertCanvasInspectorReady(loaded.configuration.database, {
        instanceId: saved.instanceId,
        systemIdentifier: saved.systemIdentifier,
      });
      const inspector = new Client(loaded.configuration.database);
      await inspector.connect();
      try {
        expect(
          (await inspector.query('SELECT ssl FROM pg_stat_ssl WHERE pid=pg_backend_pid()')).rows[0]
            .ssl,
        ).toBe(true);
        await expect(inspector.query('SELECT * FROM margin_identity.users')).rejects.toThrow();
        await expect(
          inspector.query('UPDATE margin_local.migrations SET sha256=sha256'),
        ).rejects.toThrow();
      } finally {
        await inspector.end();
      }
      const key = loaded.configuration.wrappingKey;
      loaded.dispose();
      expect(key.every((byte) => byte === 0)).toBe(true);
      const sidecarFiles = [
        'database.url',
        'inspector.json',
        'setup-journal.json',
        'installation.json',
      ];
      const companionBefore = new Map(
        await Promise.all(
          sidecarFiles.map(
            async (name) => [name, await readFile(join(root, 'scanner', name))] as const,
          ),
        ),
      );
      expect(await setupLocalScanner(options)).toEqual({
        configPath: first.configPath,
        changed: false,
        reconciled: false,
      });
      for (const [name, bytes] of companionBefore) {
        expect(await readFile(join(root, 'scanner', name))).toEqual(bytes);
        expect((await stat(join(root, 'scanner', name))).mode & 0o777).toBe(0o600);
      }
      for (const [name, bytes] of before) expect(await readFile(join(root, name))).toEqual(bytes);
    });

    it('reconnects after an idle inspector pool backend is terminated without losing runtime admission', async () => {
      await setupLocalScanner(options);
      const events: string[] = [];
      const runtime = await startLocalScanner(inspectorPath(), {
        intervalMs: 1000,
        onEvent: (event) => events.push(event),
      });
      try {
        // Match the worker's bounded 15-second database claim phase rather than
        // expect.poll's one-second default on a busy development host.
        await expect.poll(() => events, { timeout: 15_000 }).toContain('idle');
        const before = events.filter((event) => event === 'idle').length;
        const idle = (
          await query(
            "SELECT pid FROM pg_stat_activity WHERE application_name='margin-canvas-inspector' AND usename=$1 AND state='idle'",
            [INSPECTOR_LOGIN],
          )
        ).rows;
        expect(idle).toHaveLength(1);
        const pid = idle[0].pid as number;
        expect(
          (await query('SELECT pg_terminate_backend($1) AS terminated', [pid])).rows[0].terminated,
        ).toBe(true);
        // pg.Pool emits an asynchronous error for this idle TLS connection. An
        // unhandled event would fail this test/process before the next real claim.
        await expect
          .poll(() => events.filter((event) => event === 'idle').length, { timeout: 5000 })
          .toBeGreaterThan(before);
        expect(runtime.signal.aborted).toBe(false);
        const reconnected = (
          await query(
            "SELECT pid FROM pg_stat_activity WHERE application_name='margin-canvas-inspector' AND usename=$1 AND state='idle'",
            [INSPECTOR_LOGIN],
          )
        ).rows;
        expect(reconnected).toHaveLength(1);
        expect(reconnected[0].pid).not.toBe(pid);
      } finally {
        await runtime.close();
      }
      expect(
        (await query('SELECT count(*) FROM pg_stat_activity WHERE usename=$1', [INSPECTOR_LOGIN]))
          .rows[0].count,
      ).toBe('0');
    });

    it('runs the real idle inspection claim loop, excludes maintenance, and drains after admission loss', async () => {
      await setupLocalScanner(options);
      const events: string[] = [];
      const runtime = await startLocalScanner(inspectorPath(), {
        intervalMs: 100,
        onEvent: (event) => events.push(event),
      });
      try {
        // The first real claim has a 15-second phase budget.
        await expect.poll(() => events, { timeout: 15_000 }).toContain('idle');
        const operator = await admin();
        try {
          await expect(acquireCanvasMaintenance(operator)).rejects.toThrow(
            'Stop the Canvas API and workers',
          );
        } finally {
          await operator.end();
        }
        await query(
          "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name='margin-canvas-runtime-admission' AND usename=$1",
          [INSPECTOR_LOGIN],
        );
        await expect.poll(() => runtime.signal.aborted, { timeout: 5000 }).toBe(true);
      } finally {
        await runtime.close();
      }
      expect(
        (
          await query('SELECT count(*)::integer AS count FROM pg_stat_activity WHERE usename=$1', [
            INSPECTOR_LOGIN,
          ])
        ).rows[0].count,
      ).toBe(0);
      const operator = await admin();
      try {
        await acquireCanvasMaintenance(operator);
      } finally {
        await operator.end();
      }
    });

    it('loads the inspector without reading original operator/API/session/signing secrets', async () => {
      await setupLocalScanner(options);
      const selected = Object.keys(saved.files).filter(
        (name) =>
          name.startsWith('operator/') ||
          name.startsWith('databases/') ||
          name.startsWith('api-tls/') ||
          (name.startsWith('secrets/') && name !== 'secrets/wrapping.key'),
      );
      expect(selected.length).toBeGreaterThan(15);
      try {
        for (const name of selected) await chmod(join(root, name), 0o000);
        const loaded = await loadLocalScannerConfig(inspectorPath());
        expect(loaded.configuration.database.user).toBe(INSPECTOR_LOGIN);
        expect(loaded.configuration.database.ssl).toMatchObject({ rejectUnauthorized: true });
        loaded.dispose();
      } finally {
        for (const name of selected) await chmod(join(root, name), 0o600);
      }
    });

    it('rejects unavailable engines before creating any login or setup credential', async () => {
      engine.sandbox.mockRejectedValue(new Error('private engine diagnostic'));
      await expect(setupLocalScanner(options)).rejects.toThrow(
        'private local scanner configuration',
      );
      expect(await roleExists()).toBe(false);
      expect(await readdir(join(root, 'scanner'))).toEqual(['executor']);
      expect(engine.close).toHaveBeenCalledOnce();
    });

    it('never adopts an existing unknown inspector login', async () => {
      await query(`CREATE ROLE ${INSPECTOR_LOGIN} LOGIN PASSWORD 'foreign-credential'`);
      await expect(setupLocalScanner(options)).rejects.toThrow(
        'private local scanner configuration',
      );
      expect(
        (
          await query(
            "SELECT shobj_description(oid,'pg_authid') AS marker FROM pg_roles WHERE rolname=$1",
            [INSPECTOR_LOGIN],
          )
        ).rows[0].marker,
      ).toBeNull();
      await absentInstallation();
      await expect(stat(join(root, 'scanner/database.url'))).rejects.toMatchObject({
        code: 'ENOENT',
      });
    });

    it('refuses active shared runtime admission without creating an inspector login', async () => {
      const loaded = await loadCanvasLocalConfig(saved.configPath);
      const admission = await acquireCanvasRuntimeAdmission(
        loaded.configuration.databases.assignments,
      );
      try {
        await expect(setupLocalScanner(options)).rejects.toThrow(
          'private local scanner configuration',
        );
      } finally {
        await admission.close();
        loaded.dispose();
      }
      expect(await roleExists()).toBe(false);
      await absentInstallation();
    });

    it('preserves the journal and exact credential after transactional failure, then retries only its own setup', async () => {
      let injected = false;
      const spy = interceptQuery(async (_client, args, run) => {
        if (typeof args[0] === 'string' && args[0].startsWith('COMMENT ON ROLE') && !injected) {
          injected = true;
          throw Error('secret SQL must never escape');
        }
        return run();
      });
      await expect(setupLocalScanner(options)).rejects.toThrow(
        'private local scanner configuration',
      );
      spy.mockRestore();
      expect(injected).toBe(true);
      expect(await roleExists()).toBe(false);
      await absentInstallation();
      const credential = await readFile(join(root, 'scanner/database.url'));
      const journal = await readFile(join(root, 'scanner/setup-journal.json'));
      expect(await setupLocalScanner(options)).toMatchObject({ changed: true, reconciled: true });
      expect(await readFile(join(root, 'scanner/database.url'))).toEqual(credential);
      expect(await readFile(join(root, 'scanner/setup-journal.json'))).toEqual(journal);
    });

    it.each([true, false])(
      'reconciles an uncertain COMMIT (applied=%s) without rotating or adopting a login',
      async (applied) => {
        let injected = false;
        const spy = interceptQuery(async (_client, args, run) => {
          if (args[0] === 'COMMIT' && !injected) {
            injected = true;
            if (applied) await run();
            throw Error('lost commit acknowledgement');
          }
          return run();
        });
        if (applied)
          expect(await setupLocalScanner(options)).toMatchObject({
            changed: true,
            reconciled: true,
          });
        else
          await expect(setupLocalScanner(options)).rejects.toThrow(
            'private local scanner configuration',
          );
        spy.mockRestore();
        expect(injected).toBe(true);
        const credential = await readFile(join(root, 'scanner/database.url'));
        expect(await roleExists()).toBe(applied);
        if (!applied) {
          await absentInstallation();
          expect(await setupLocalScanner(options)).toMatchObject({
            changed: true,
            reconciled: true,
          });
        }
        expect(await readFile(join(root, 'scanner/database.url'))).toEqual(credential);
      },
    );

    it('reconnects after actual operator connection termination following committed role creation', async () => {
      let injected = false;
      const spy = interceptQuery(async (client, args, run) => {
        if (args[0] === 'COMMIT' && !injected) {
          injected = true;
          await run();
          const pid = (await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
          const ended = new Promise<void>((done) => client.once('end', done));
          await query('SELECT pg_terminate_backend($1)', [pid]);
          await ended;
          throw Error('terminated after commit');
        }
        return run();
      });
      expect(await setupLocalScanner(options)).toMatchObject({ changed: true, reconciled: true });
      spy.mockRestore();
      expect(injected).toBe(true);
      const loaded = await loadLocalScannerConfig(inspectorPath());
      await assertCanvasInspectorReady(loaded.configuration.database, {
        instanceId: saved.instanceId,
      });
      loaded.dispose();
    });

    it('stops publication when the real maintenance connection is lost during inspector preflight', async () => {
      let injected = false;
      const spy = interceptQuery(async (_client, args, run) => {
        if (typeof args[0] === 'string' && args[0].startsWith('SELECT ssl,version') && !injected) {
          injected = true;
          await query(
            "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name='margin-canvas-operator' AND pid<>pg_backend_pid()",
          );
          await new Promise((done) => setTimeout(done, 20));
        }
        return run();
      });
      await expect(setupLocalScanner(options)).rejects.toThrow(
        'private local scanner configuration',
      );
      spy.mockRestore();
      expect(injected).toBe(true);
      await absentInstallation();
      expect(await roleExists()).toBe(true);
      expect(await setupLocalScanner(options)).toMatchObject({ changed: true, reconciled: true });
    });

    it('keeps generated credentials out of PostgreSQL statement diagnostics on a real CREATE failure', async () => {
      let injected = false;
      let nativeErrorCode: unknown;
      const spy = interceptQuery(async (_client, args, run) => {
        if (
          typeof args[0] === 'string' &&
          args[0].startsWith(`CREATE ROLE ${INSPECTOR_LOGIN} `) &&
          !injected
        ) {
          injected = true;
          args[0] += ' INVALID_MARGIN_TEST';
        }
        try {
          return await run();
        } catch (error) {
          if (injected && typeof args[0] === 'string' && args[0].includes('INVALID_MARGIN_TEST'))
            nativeErrorCode = (error as { code?: unknown }).code;
          throw error;
        }
      });
      await expect(setupLocalScanner(options)).rejects.toThrow(
        'private local scanner configuration',
      );
      spy.mockRestore();
      expect(injected).toBe(true);
      expect(await roleExists()).toBe(false);
      const journal = JSON.parse(await readFile(join(root, 'scanner/setup-journal.json'), 'utf8'));
      const password = new URL(journal.database.trim()).password;
      const log = await readFile(join(root, 'postgres.log'), 'utf8');
      expect(nativeErrorCode).toBe('42601');
      expect(log.toLowerCase().includes('invalid_margin_test')).toBe(true);
      // Boolean comparisons keep even synthetic credentials out of failure output.
      expect(log.includes(password)).toBe(false);
      expect(log.includes('PASSWORD')).toBe(false);
      expect(await setupLocalScanner(options)).toMatchObject({ changed: true, reconciled: true });
    });

    it.each(
      ['setup-journal.json', 'database.url', 'inspector.json', 'installation.json'].flatMap(
        (target) => [false, true].map((afterLink) => ({ target, afterLink })),
      ),
    )(
      'recovers publication interruption at $target afterLink=$afterLink',
      async ({ target, afterLink }) => {
        publicationFault.target = target;
        publicationFault.afterLink = afterLink;
        await expect(setupLocalScanner(options)).rejects.toThrow(
          'private local scanner configuration',
        );
        expect(await roleExists()).toBe(target === 'installation.json');
        const entries = await readdir(join(root, 'scanner'));
        const pending = entries.find((name) => name.startsWith('.' + target + '.'))!;
        expect(pending).toBeTruthy();
        const savedJournal = await readFile(join(root, 'scanner/setup-journal.json'), 'utf8').catch(
          () => undefined,
        );
        const savedCredential = savedJournal ? JSON.parse(savedJournal).database : undefined;
        if (!afterLink) {
          // A torn unpublished temporary file must never be adopted or rewritten.
          await writeFile(join(root, 'scanner', pending), 'partial private publication');
        }
        expect(await setupLocalScanner(options)).toMatchObject({
          changed: !(target === 'installation.json' && afterLink),
        });
        if (savedCredential)
          expect(await readFile(join(root, 'scanner/database.url'), 'utf8')).toBe(savedCredential);
        if (afterLink)
          await expect(stat(join(root, 'scanner', pending))).rejects.toMatchObject({
            code: 'ENOENT',
          });
        else
          expect(await readFile(join(root, 'scanner', pending), 'utf8')).toBe(
            'partial private publication',
          );
        const loaded = await loadLocalScannerConfig(inspectorPath());
        await assertCanvasInspectorReady(loaded.configuration.database, {
          instanceId: saved.instanceId,
        });
        loaded.dispose();
      },
    );

    it('rejects privilege drift and preserves the original credential on an installed rerun', async () => {
      await setupLocalScanner(options);
      const credential = await readFile(join(root, 'scanner/database.url'));
      await query(`ALTER ROLE ${INSPECTOR_LOGIN} BYPASSRLS`);
      await expect(setupLocalScanner(options)).rejects.toThrow(
        'private local scanner configuration',
      );
      expect(await readFile(join(root, 'scanner/database.url'))).toEqual(credential);
      await query(`ALTER ROLE ${INSPECTOR_LOGIN} NOBYPASSRLS`);
      expect(await setupLocalScanner(options)).toMatchObject({ changed: false });
    });

    it('rejects changed binding, linked or public credentials, and altered saved configuration', async () => {
      await setupLocalScanner(options);
      const path = join(root, 'scanner/database.url'),
        bytes = await readFile(path);
      await chmod(path, 0o644);
      await expect(loadLocalScannerConfig(inspectorPath())).rejects.toThrow(
        'private local scanner configuration',
      );
      await chmod(path, 0o600);
      const linked = join(root, 'linked-credential');
      await link(path, linked);
      await expect(loadLocalScannerConfig(inspectorPath())).rejects.toThrow(
        'private local scanner configuration',
      );
      await rm(linked);
      await writeFile(path, Buffer.concat([bytes, Buffer.from('changed')]));
      await expect(loadLocalScannerConfig(inspectorPath())).rejects.toThrow(
        'private local scanner configuration',
      );
      await writeFile(path, bytes);
      const configuration = await readFile(inspectorPath());
      await writeFile(
        inspectorPath(),
        configuration.toString().replace('"schema": 1', '"schema": 1,"schema": 1'),
      );
      await expect(loadLocalScannerConfig(inspectorPath())).rejects.toThrow(
        'private local scanner configuration',
      );
      await writeFile(inspectorPath(), configuration);
      const keyPath = join(root, 'secrets/wrapping.key'),
        key = await readFile(keyPath);
      try {
        await writeFile(keyPath, Buffer.alloc(32, 42).toString('base64') + '\n');
        await expect(loadLocalScannerConfig(inspectorPath())).rejects.toThrow(
          'private local scanner configuration',
        );
      } finally {
        await writeFile(keyPath, key);
      }
      (await loadLocalScannerConfig(inspectorPath())).dispose();
    });
  },
);
