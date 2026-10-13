import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomUUID, X509Certificate } from 'node:crypto';
import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { Client, type ClientConfig } from 'pg';
import { postgresTlsToolsAvailable } from './helpers/postgres-tools';
import {
  bootCanvasLocal,
  canvasCertificateOwnership as owned,
  stopCanvasLocal,
  startCanvasLocal,
  type CanvasBootstrapReceipt,
} from '../apps/api/src/canvas-local/bootstrap';
import { renewCanvasPostgresCertificate } from '../apps/api/src/canvas-local/certificate-maintenance';
import { CANVAS_CERTIFICATE_MAINTENANCE_MARKER as markerName } from '../apps/api/src/canvas-local/certificate-barrier';
import { acquireCanvasRuntimeAdmission } from '../apps/api/src/canvas-local/maintenance';
import { loadCanvasLocalConfig } from '../apps/api/src/canvas-local/config';
import {
  loadLocalScannerConfig,
  LocalScannerConfigurationError,
} from '../apps/api/src/scanner/local-config';
import { setupLocalScanner } from '../apps/api/src/scanner/local-setup';

vi.mock('../apps/api/src/scanner/docker.js', () => ({
  createDockerScannerExecutor: async (options: { stateDirectory: string }) => {
    await mkdir(options.stateDirectory, { recursive: true, mode: 0o700 });
    return { ready: async () => {}, checkSandbox: async () => {}, close: async () => {} };
  },
}));
vi.mock('../infra/scanner/clamav/definitions.mjs', () => ({
  readScannerDefinitions: async () => ({ directory: '/mock-definition-snapshot' }),
}));
const fault = vi.hoisted(() => ({ link: '' }));
vi.mock('node:fs/promises', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...fs,
    link: async (source: string, target: string) => {
      await fs.link(source, target);
      if (fault.link && target.endsWith(fault.link)) {
        fault.link = '';
        throw Error('publication interrupted');
      }
    },
  };
});
const available = postgresTlsToolsAvailable('Canvas PostgreSQL certificate renewal');
if (available) execFileSync('pg_controldata', ['--version'], { stdio: 'pipe', timeout: 5000 });
const sha = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
const encode = (value: unknown) => JSON.stringify(value, null, 2) + '\n';
async function freePort(excluded: number[] = []): Promise<number> {
  const server = createServer();
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((done) => server.close(() => done()));
  return [4101, 5174, 5432, ...excluded].includes(port) ? freePort(excluded) : port;
}
let base: string, root: string, saved: CanvasBootstrapReceipt;
let tls: { keyPath: string; certPath: string }, adminConfig: ClientConfig;
async function admin() {
  const c = new Client(adminConfig);
  c.on('error', () => {});
  await c.connect();
  return c;
}
async function files() {
  return new Map(
    await Promise.all(
      [...Object.keys(saved.files), 'bootstrap.json'].map(
        async (path) => [path, await readFile(join(root, path))] as const,
      ),
    ),
  );
}
async function preserved(before: Map<string, Buffer>) {
  for (const [path, bytes] of before)
    if (!['bootstrap.json', 'postgres-tls/server.pem'].includes(path))
      expect(await readFile(join(root, path)), path).toEqual(bytes);
}
async function expired() {
  const path = join(root, 'postgres-tls/server.pem');
  // A correctly ordered historical validity interval, not a mocked clock or negative duration.
  const fixture = join(root, 'expired-fixture');
  await mkdir(fixture, { mode: 0o700 });
  await writeFile(join(fixture, 'index'), '', { mode: 0o600 });
  await writeFile(join(fixture, 'serial'), '1234567890\n', { mode: 0o600 });
  const configuration = join(fixture, 'ca.conf');
  await writeFile(
    configuration,
    `[ca]\ndefault_ca=fixture\n[fixture]\ndatabase=${fixture}/index\nserial=${fixture}/serial\nnew_certs_dir=${fixture}\ncertificate=${root}/postgres-tls/ca.pem\nprivate_key=${root}/postgres-tls/ca.key\ndefault_md=sha256\npolicy=policy\n[policy]\ncommonName=supplied\n`,
    { mode: 0o600 },
  );
  const timestamp = (daysAgo: number) =>
    new Date(Date.now() - daysAgo * 86400000)
      .toISOString()
      .replace(/[-:]/g, '')
      .replace('T', '')
      .slice(0, 14) + 'Z';
  execFileSync(
    'openssl',
    [
      'ca',
      '-batch',
      '-notext',
      '-config',
      configuration,
      '-in',
      join(root, 'postgres-tls/server.csr'),
      '-out',
      path,
      '-startdate',
      timestamp(2),
      '-enddate',
      timestamp(1),
      '-extfile',
      join(root, 'postgres-tls/server.ext'),
    ],
    { stdio: 'pipe', timeout: 10000 },
  );
  await chmod(path, 0o600);
  const bytes = await readFile(path);
  expect(Date.parse(new X509Certificate(bytes).validTo)).toBeLessThan(Date.now());
  saved = { ...saved, files: { ...saved.files, 'postgres-tls/server.pem': sha(bytes) } };
  const { started: _s, ...receipt } = saved as CanvasBootstrapReceipt & { started?: boolean };
  await writeFile(join(root, 'bootstrap.json'), encode(receipt), { mode: 0o600 });
}
async function interrupted(phase: string) {
  await expect(
    renewCanvasPostgresCertificate(root, {
      afterPhase: async (current) => {
        if (current === phase) throw Error('simulated interruption');
      },
    }),
  ).rejects.toMatchObject({ code: 'renewal_failed' });
  expect(await stat(join(root, markerName))).toBeDefined();
}
async function childPaused(phase: string) {
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', 'tests/helpers/certificate-renewal-child.mjs', root, phase],
    { env: { ...process.env, NODE_ENV: 'test' }, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let stderr = '',
    stdout = '',
    timedOut = false;
  child.stderr.on('data', (b) => {
    stderr += b.toString();
  });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, 30000);
    child.stdout.on('data', (b) => {
      stdout = (stdout + b.toString()).slice(-512);
      if (stdout.includes('RENEWAL_PAUSED')) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    // Wait for confirmed child exit before the test tears down its disposable database.
    child.once('close', () => {
      clearTimeout(timer);
      reject(
        Error(
          timedOut
            ? 'renewal child did not pause; status: ' + stdout.trim()
            : 'renewal child exited before pause: ' + stderr.slice(0, 2000),
        ),
      );
    });
  });
  return child;
}
async function killChild(child: ReturnType<typeof spawn>) {
  const closed = once(child, 'close');
  child.kill('SIGKILL');
  await closed;
}

async function installInspector() {
  const socket = join(root, 'test-socket');
  await writeFile(socket, 'mock endpoint', { mode: 0o600 });
  const options = {
    canvasRoot: root,
    parserImage: 'sha256:' + 'a'.repeat(64),
    antivirusImage: 'sha256:' + 'b'.repeat(64),
    definitionsDirectory: '/mock-definition-snapshot',
    dockerExecutable: process.execPath,
    dockerSocketPath: socket,
  };
  await setupLocalScanner(options);
  return options;
}

describe.skipIf(!available)(
  'CA-preserving PostgreSQL leaf renewal over actual TLS',
  { timeout: 45000 },
  () => {
    beforeAll(async () => {
      base = await realpath(await mkdtemp(join(tmpdir(), 'margin-certificate-')));
      const { ensureLocalTls } = await import(
        new URL('../scripts/local-tls.mjs', import.meta.url).href
      );
      tls = ensureLocalTls(join(base, 'tls'));
    });
    beforeEach(async () => {
      fault.link = '';
      root = join(await mkdtemp(join(base, 'case-')), 'canvas');
      const port = await freePort();
      const boot = await bootCanvasLocal({
        rootDirectory: root,
        postgresPort: port,
        apiPort: await freePort([port]),
        applicationOrigin: 'https://127.0.0.1:5174',
        apiTls: { keyFile: tls.keyPath, certFile: tls.certPath },
      });
      saved = JSON.parse(await readFile(join(root, 'bootstrap.json'), 'utf8'));
      expect(boot.instanceId).toBe(saved.instanceId);
      adminConfig = await owned.configuration(root);
    }, 60000);
    afterEach(async () => {
      vi.restoreAllMocks();
      fault.link = '';
      if (saved && (await owned.running(saved.dataDirectory))) await owned.stop(saved);
      if (root) await rm(join(root, '..'), { recursive: true, force: true });
    });
    afterAll(async () => {
      if (base) await rm(base, { recursive: true, force: true });
    });

    it('renews and proves the presented leaf while preserving secrets, data and initially running state', async () => {
      const before = await files(),
        c = await admin();
      await c.query('CREATE TABLE public.renewal_preservation(value text)');
      await c.query("INSERT INTO public.renewal_preservation VALUES ('existing data')");
      await c.end();
      await writeFile(join(root, 'artifacts/preserved.enc'), 'opaque encrypted bytes', {
        mode: 0o600,
      });
      const result = await renewCanvasPostgresCertificate(root);
      expect(result).toMatchObject({ changed: true, resumed: false, wasRunning: true });
      await preserved(before);
      expect(await readFile(join(root, 'postgres-tls/server.pem'))).not.toEqual(
        before.get('postgres-tls/server.pem'),
      );
      expect(await readFile(join(root, 'artifacts/preserved.enc'), 'utf8')).toBe(
        'opaque encrypted bytes',
      );
      expect(await owned.running(saved.dataDirectory)).toBe(true);
      const after = await admin();
      expect((await after.query('SELECT value FROM public.renewal_preservation')).rows).toEqual([
        { value: 'existing data' },
      ]);
      await after.end();
      const config = await loadCanvasLocalConfig(join(root, 'config.json'));
      config.dispose();
      await expect(stat(join(root, markerName))).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(stat(join(root, '.bootstrap-lock'))).rejects.toMatchObject({ code: 'ENOENT' });
    });
    it('renews a genuinely expired stopped leaf without disabling TLS and restores stopped state', async () => {
      await stopCanvasLocal(root);
      await expired();
      await owned.start(saved);
      const rejected = new Client(adminConfig);
      rejected.on('error', () => {});
      try {
        await expect(rejected.connect()).rejects.toMatchObject({ code: 'CERT_HAS_EXPIRED' });
      } finally {
        await rejected.end();
      }
      await owned.stop(saved);
      const before = await files();
      const result = await renewCanvasPostgresCertificate(root);
      expect(result.wasRunning).toBe(false);
      expect(await owned.running(saved.dataDirectory)).toBe(false);
      await preserved(before);
      await startCanvasLocal(root);
      const c = await admin();
      expect(
        (await c.query('SELECT ssl FROM pg_stat_ssl WHERE pid=pg_backend_pid()')).rows[0].ssl,
      ).toBe(true);
      await c.end();
    });
    it('refuses an expired running installation with scoped shutdown guidance and no replacement', async () => {
      await stopCanvasLocal(root);
      await expired();
      await owned.start(saved);
      const before = await files();
      await expect(renewCanvasPostgresCertificate(root)).rejects.toMatchObject({
        code: 'running_expired',
        message: expect.stringContaining('smart shutdown'),
      });
      for (const [path, bytes] of before) expect(await readFile(join(root, path))).toEqual(bytes);
      expect(await owned.running(saved.dataDirectory)).toBe(true);
    });
    it('refuses live runtime admission before writing the pending marker', async () => {
      const admission = await acquireCanvasRuntimeAdmission(adminConfig);
      try {
        await expect(renewCanvasPostgresCertificate(root)).rejects.toMatchObject({
          code: 'renewal_failed',
        });
      } finally {
        await admission.close();
      }
      await expect(stat(join(root, markerName))).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await owned.running(saved.dataDirectory)).toBe(true);
    });
    it('rejects a different still-valid leaf served by the same owned cluster and CA', async () => {
      const previous = await readFile(join(root, 'postgres-tls/server.pem'));
      const start = owned.start.bind(owned);
      vi.spyOn(owned, 'start').mockImplementation(async (receipt) => {
        const path = join(root, 'postgres-tls/server.pem');
        const expected = await readFile(path);
        try {
          await writeFile(path, previous, { mode: 0o600 });
          return await start(receipt);
        } finally {
          await writeFile(path, expected, { mode: 0o600 });
        }
      });
      await expect(renewCanvasPostgresCertificate(root)).rejects.toMatchObject({
        code: 'renewal_failed',
      });
      expect(await stat(join(root, markerName))).toBeDefined();
      vi.restoreAllMocks();
      await owned.stop(saved);
      await renewCanvasPostgresCertificate(root);
    });
    it('rebinds the installed inspector without changing its credential, operation or database grants', async () => {
      const options = await installInspector();
      const password = await readFile(join(root, 'scanner/database.url'));
      const journal = JSON.parse(await readFile(join(root, 'scanner/setup-journal.json'), 'utf8'));
      await renewCanvasPostgresCertificate(root);
      expect(await readFile(join(root, 'scanner/database.url'))).toEqual(password);
      const next = JSON.parse(await readFile(join(root, 'scanner/setup-journal.json'), 'utf8'));
      expect(next.operationId).toBe(journal.operationId);
      expect(next.bootstrapSha256).toBe(sha(await readFile(join(root, 'bootstrap.json'))));
      const loaded = await loadLocalScannerConfig(join(root, 'scanner/inspector.json'));
      loaded.dispose();
      expect((await setupLocalScanner(options)).changed).toBe(false);
    });
    it('recovers a process killed between companion file replacements with its original credential', async () => {
      const options = await installInspector();
      const password = await readFile(join(root, 'scanner/database.url'));
      const child = await childPaused('published:scanner/inspector.json');
      await killChild(child);
      expect(await stat(join(root, markerName))).toBeDefined();
      await expect(
        loadLocalScannerConfig(join(root, 'scanner/inspector.json')),
      ).rejects.toBeInstanceOf(LocalScannerConfigurationError);
      await renewCanvasPostgresCertificate(root);
      expect(await readFile(join(root, 'scanner/database.url'))).toEqual(password);
      const loaded = await loadLocalScannerConfig(join(root, 'scanner/inspector.json'));
      loaded.dispose();
      expect((await setupLocalScanner(options)).changed).toBe(false);
    });
    it.each([
      'marker',
      'published:postgres-tls/server.pem',
      'published:bootstrap.json',
      'verified',
      'restored',
      'completion',
    ])('recovers exactly journaled publication after interruption at %s', async (phase) => {
      const before = await files();
      await interrupted(phase);
      await expect(loadCanvasLocalConfig(join(root, 'config.json'))).rejects.toMatchObject({
        code: 'certificate_maintenance_pending',
      });
      await expect(startCanvasLocal(root)).rejects.toMatchObject({
        code: 'certificate_maintenance_pending',
      });
      const result = await renewCanvasPostgresCertificate(root);
      expect(result.resumed).toBe(true);
      expect(await owned.running(saved.dataDirectory)).toBe(true);
      await preserved(before);
    });
    it.each([markerName, 'verified-complete.json'])(
      'reconciles the exact hard-link publication window for %s',
      async (target) => {
        fault.link = target;
        await expect(renewCanvasPostgresCertificate(root)).rejects.toMatchObject({
          code: 'renewal_failed',
        });
        const result = await renewCanvasPostgresCertificate(root);
        expect(result.resumed).toBe(true);
        await expect(stat(join(root, markerName))).rejects.toMatchObject({ code: 'ENOENT' });
      },
    );
    it.each(['published:postgres-tls/server.pem', 'barrier-cleared'])(
      'recovers actual process death at %s using only an ESRCH-proven owned lock',
      async (phase) => {
        const before = await files(),
          child = await childPaused(phase);
        await killChild(child);
        const owner = join(root, '.bootstrap-lock/renewal-owner-0000.json');
        if (phase.startsWith('published:'))
          await link(
            owner,
            join(root, '.bootstrap-lock', '.renewal-owner-0000.json.' + randomUUID() + '.pending'),
          );
        const result = await renewCanvasPostgresCertificate(root);
        expect(result.resumed).toBe(true);
        expect(result.changed).toBe(phase !== 'barrier-cleared');
        expect(result.completedPreviously).toBe(phase === 'barrier-cleared');
        await preserved(before);
        expect(await owned.running(saved.dataDirectory)).toBe(true);
        await expect(stat(join(root, '.bootstrap-lock'))).rejects.toMatchObject({ code: 'ENOENT' });
      },
    );
    it('continues an actual dead-owner chain and refuses a concurrent recovery owner', async () => {
      const first = await childPaused('marker');
      await killChild(first);
      const second = await childPaused('marker');
      try {
        await expect(renewCanvasPostgresCertificate(root)).rejects.toMatchObject({
          code: 'owner_unavailable',
        });
        const owner = JSON.parse(
          await readFile(join(root, '.bootstrap-lock/renewal-owner-0001.json'), 'utf8'),
        );
        expect(owner.pid).toBe(second.pid);
        expect(owner.sequence).toBe(1);
      } finally {
        await killChild(second);
      }
      const result = await renewCanvasPostgresCertificate(root);
      expect(result.resumed).toBe(true);
      await expect(stat(join(root, '.bootstrap-lock'))).rejects.toMatchObject({ code: 'ENOENT' });
    });
    it('restores an originally stopped database after process death during its temporary verification start', async () => {
      await stopCanvasLocal(root);
      const child = await childPaused('verified');
      expect(await owned.running(saved.dataDirectory)).toBe(true);
      await killChild(child);
      const result = await renewCanvasPostgresCertificate(root);
      expect(result).toMatchObject({
        resumed: true,
        wasRunning: false,
        completedPreviously: false,
      });
      expect(await owned.running(saved.dataDirectory)).toBe(false);
    });
    it('retires an already-completed dead lock without disrupting a runtime that resumed', async () => {
      const child = await childPaused('barrier-cleared');
      await killChild(child);
      const admission = await acquireCanvasRuntimeAdmission(adminConfig);
      try {
        const result = await renewCanvasPostgresCertificate(root);
        expect(result).toMatchObject({ resumed: true, changed: false, completedPreviously: true });
        expect(admission.signal.aborted).toBe(false);
      } finally {
        await admission.close();
      }
    });
    it('refuses a live owner and an EPERM-ambiguous dead-owner probe, without advancing its chain', async () => {
      const child = await childPaused('marker');
      try {
        await expect(renewCanvasPostgresCertificate(root)).rejects.toMatchObject({
          code: 'owner_unavailable',
        });
      } finally {
        await killChild(child);
      }
      const kill = process.kill.bind(process);
      vi.spyOn(process, 'kill').mockImplementation(((
        pid: number,
        signal: NodeJS.Signals | number,
      ) => {
        if (pid === child.pid && signal === 0)
          throw Object.assign(Error('probe denied'), { code: 'EPERM' });
        return kill(pid, signal);
      }) as typeof process.kill);
      await expect(renewCanvasPostgresCertificate(root)).rejects.toMatchObject({
        code: 'owner_unavailable',
      });
      expect(
        (await readdir(join(root, '.bootstrap-lock'))).filter((name) => name.endsWith('.json')),
      ).toHaveLength(1);
      vi.restoreAllMocks();
      await renewCanvasPostgresCertificate(root);
    });
    it('refuses unknown lock contents without adopting, deleting or signaling them', async () => {
      await mkdir(join(root, '.bootstrap-lock'), { mode: 0o700 });
      await writeFile(join(root, '.bootstrap-lock/unowned'), 'foreign operation', { mode: 0o600 });
      await expect(renewCanvasPostgresCertificate(root)).rejects.toMatchObject({
        code: 'foreign_lock',
      });
      expect(await readFile(join(root, '.bootstrap-lock/unowned'), 'utf8')).toBe(
        'foreign operation',
      );
    });
    it('refuses tampered protected files during recovery and preserves the pending barrier', async () => {
      await interrupted('published:postgres-tls/server.pem');
      await writeFile(join(root, 'api-tls/cert.pem'), 'foreign certificate', { mode: 0o600 });
      await expect(renewCanvasPostgresCertificate(root)).rejects.toMatchObject({
        code: 'protected_file_changed',
      });
      expect(await stat(join(root, markerName))).toBeDefined();
    });
  },
);
