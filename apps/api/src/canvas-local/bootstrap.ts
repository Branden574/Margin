import { execFile } from 'node:child_process';
import {
  createHash,
  createPrivateKey,
  generateKeyPairSync,
  randomBytes,
  randomUUID,
  X509Certificate,
} from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readFile, readdir, realpath, rmdir } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { Client, type ClientConfig } from 'pg';
import { readProtectedFile } from './protected-files.js';
import { acquireCanvasMaintenance, assertCanvasDatabaseQuiet } from './maintenance.js';
import { createCanvasUpgradeBackup, type CanvasUpgradeBackup } from './upgrade-backup.js';
import {
  reviewedMigration013,
  upgradeObjects,
  assertUpgradeObjects,
  assertUpgradePolicies,
} from './upgrade-contract.js';

const execute = promisify(execFile);
export const CANVAS_MIGRATIONS = [
  '001-identity.sql',
  '002-document-sync.sql',
  '003-lms-installations.sql',
  '004-assignments.sql',
  '005-ingestion.sql',
  '006-assignment-work.sql',
  '007-assignment-work-runtime.sql',
  '008-authorization-plan-cache.sql',
  '009-submissions.sql',
  '010-submission-materialization.sql',
  '011-submission-outcomes.sql',
  '012-submission-review.sql',
  '013-teacher-source-intake.sql',
] as const;
export const CANVAS_DATABASE_ROLES = {
  identity: 'margin_identity_runtime',
  lms: 'margin_lms_runtime',
  assignments: 'margin_assignments_runtime',
  work: 'margin_assignment_work_runtime',
  ingestion: 'margin_ingestion_runtime',
  sourceReader: 'margin_ingestion_reader',
  capture: 'margin_submission_runtime',
  processor: 'margin_submission_processor',
  reviewer: 'margin_submission_reviewer',
  provisioner: 'margin_assignment_provisioner',
} as const;
export interface CanvasBootstrapOptions {
  rootDirectory: string;
  postgresPort: number;
  apiPort: number;
  applicationOrigin: string;
  apiTls: { keyFile: string; certFile: string };
}
export interface CanvasBootstrapReceipt {
  schema: 1;
  instanceId: string;
  rootDirectory: string;
  dataDirectory: string;
  postgresPort: number;
  configPath: string;
  systemIdentifier: string;
  files: Record<string, string>;
}
const sha = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
export class CanvasBootstrapError extends Error {
  readonly name = 'CanvasBootstrapError';
}
const fail = (message: string): never => {
  throw new CanvasBootstrapError(message);
};
function assertLocalEnvironment() {
  if (
    process.env.NODE_ENV === 'production' ||
    process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0' ||
    process.env.PGREPLICATION ||
    process.env.PGBINARY
  )
    fail(
      'Local Canvas setup requires a non-production environment with TLS verification enabled and ordinary PostgreSQL sessions.',
    );
  if (!process.getuid || !constants.O_NOFOLLOW || !constants.O_DIRECTORY)
    fail('Local Canvas setup requires POSIX ownership and no-follow filesystem support.');
}
const manifestDirectory = new URL('../../../../infra/migrations/', import.meta.url);
export async function migrationManifest(through: number = CANVAS_MIGRATIONS.length) {
  return Promise.all(
    CANVAS_MIGRATIONS.slice(0, through).map(async (name, index) => ({
      position: index + 1,
      name,
      sha256: sha(await readFile(new URL(name, manifestDirectory))),
    })),
  );
}
async function privateDirectory(path: string) {
  const stat = await lstat(path);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    stat.uid !== process.getuid?.() ||
    (stat.mode & 0o7777) !== 0o700
  )
    fail(
      'Canvas setup requires an owned private directory (0700), without symlinks. Existing files were preserved.',
    );
}
async function privateFile(path: string, max = 65536): Promise<Buffer> {
  return readProtectedFile(path, max);
}
async function save(path: string, value: string | Buffer) {
  const handle = await open(path, 'wx', 0o600);
  try {
    await handle.writeFile(value);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await syncDirectory(dirname(path));
}
async function syncDirectory(path: string) {
  const directory = await open(
    path,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}
async function command(name: string, args: string[]) {
  try {
    return await execute(name, args, { timeout: 60000, maxBuffer: 1024 * 1024 });
  } catch {
    fail(
      `Local Canvas ${name} command failed. Existing files and database contents were preserved; inspect the private setup or PostgreSQL log.`,
    );
  }
}
function port(value: number) {
  if (!Number.isSafeInteger(value) || value < 1024 || value > 65535 || value === 5432)
    fail('Configure a distinct non-5432 local port between 1024 and 65535.');
}
async function canonicalRoot(input: string, create: boolean) {
  if (!isAbsolute(input) || /[\u0000-\u001f\u007f\\]/.test(input))
    fail('Configure an absolute dedicated Canvas root directory.');
  const requested = resolve(input),
    parent = await realpath(dirname(requested));
  if (requested === dirname(requested))
    fail('Configure a dedicated Canvas root, not a filesystem root.');
  const path = join(parent, requested.slice(dirname(requested).length + 1));
  if (create) {
    try {
      await mkdir(path, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  }
  await privateDirectory(path);
  return path;
}
async function inspectApiTls(tls: { keyFile: string; certFile: string }) {
  if (!isAbsolute(tls.keyFile) || !isAbsolute(tls.certFile))
    fail('API TLS references must be absolute.');
  const key = await privateFile(tls.keyFile);
  let cert: Buffer | undefined;
  try {
    cert = await privateFile(tls.certFile);
    const parsed = new X509Certificate(cert);
    if (
      parsed.ca ||
      !parsed.checkIP('127.0.0.1') ||
      !parsed.checkPrivateKey(createPrivateKey(key)) ||
      !parsed.keyUsage?.includes('1.3.6.1.5.5.7.3.1') ||
      Date.parse(parsed.validFrom) > Date.now() ||
      Date.parse(parsed.validTo) <= Date.now()
    )
      fail(
        'Use a current matching API TLS server certificate for 127.0.0.1. Trust was not changed.',
      );
    return { key, cert };
  } catch (error) {
    key.fill(0);
    cert?.fill(0);
    throw error;
  }
}
function dbUrl(user: string, password: string, postgresPort: number) {
  return `postgresql://${user}:${password}@127.0.0.1:${postgresPort}/margin_canvas`;
}
async function operatorConfiguration(
  root: string,
  database = 'margin_canvas',
): Promise<ClientConfig> {
  const raw = await privateFile(join(root, 'operator', 'database.url'), 8192);
  const url = new URL(raw.toString().trim());
  raw.fill(0);
  const ca = await privateFile(join(root, 'postgres-tls', 'ca.pem'));
  const config: ClientConfig = {
    host: '127.0.0.1',
    port: Number(url.port),
    user: url.username,
    password: url.password,
    database,
    ssl: { ca, rejectUnauthorized: true },
    sslnegotiation: 'postgres',
    options: '-c search_path=pg_catalog',
    client_encoding: 'UTF8',
    connectionTimeoutMillis: 5000,
    query_timeout: 10000,
    application_name: 'margin-canvas-operator',
  };
  if (
    url.protocol !== 'postgresql:' ||
    url.hostname !== '127.0.0.1' ||
    url.search ||
    url.hash ||
    url.pathname !== '/margin_canvas' ||
    url.username !== 'margin_canvas_operator'
  )
    fail('The separate operator credential is invalid.');
  return config;
}
async function operator(root: string, database = 'margin_canvas'): Promise<Client> {
  const client = new Client(await operatorConfiguration(root, database));
  try {
    await client.connect();
    return client;
  } catch (error) {
    await client.end().catch(() => {});
    throw error;
  }
}
async function ledger(
  client: Client,
  instanceId: string,
  expected?: Awaited<ReturnType<typeof migrationManifest>>,
) {
  const actual = await client.query(
    'SELECT position,name,sha256 FROM margin_local.migrations ORDER BY position',
  );
  expected ??= await migrationManifest();
  if (JSON.stringify(actual.rows) !== JSON.stringify(expected))
    fail(
      'Migration history differs from the exact installed Canvas migrations. No migrations were reapplied.',
    );
  const instance = await client.query(
    'SELECT instance_id,schema_version FROM margin_local.installation WHERE id=1',
  );
  if (
    instance.rowCount !== 1 ||
    instance.rows[0].instance_id !== instanceId ||
    instance.rows[0].schema_version !== 1
  )
    fail('The database does not match this Canvas installation receipt.');
  const policies = await client.query(
    'SELECT table_name,name,roles,command,permissive,using_expression,check_expression FROM margin_local.policy_contract ORDER BY table_name,name',
  );
  if (JSON.stringify(policies.rows) !== JSON.stringify((await policySnapshot(client)).rows))
    fail(
      'Canvas row-level security policies differ from their installed contract. No policies were changed.',
    );
}
async function supportedLedger(client: Client, instanceId: string): Promise<12 | 13> {
  const count = (
    await client.query('SELECT count(*)::integer AS count FROM margin_local.migrations')
  ).rows[0]?.count;
  if (count !== 12 && count !== 13)
    fail('Only exact local Canvas migration versions 12 and 13 are supported.');
  await ledger(client, instanceId, await migrationManifest(count));
  return count;
}
const policyInventory = `SELECT n.nspname||'.'||t.relname AS table_name,p.polname AS name,
  ARRAY(SELECT r.rolname::text FROM pg_roles r WHERE r.oid=ANY(p.polroles) ORDER BY r.rolname) AS roles,
  p.polcmd::text AS command,p.polpermissive AS permissive,
  pg_get_expr(p.polqual,p.polrelid,false) AS using_expression,
  pg_get_expr(p.polwithcheck,p.polrelid,false) AS check_expression
  FROM pg_policy p JOIN pg_class t ON t.oid=p.polrelid JOIN pg_namespace n ON n.oid=t.relnamespace
  WHERE n.nspname=ANY($1) ORDER BY n.nspname,t.relname,p.polname`;
const policySchemas = [
  'margin_identity',
  'margin_sync',
  'margin_lms',
  'margin_assignments',
  'margin_ingestion',
  'margin_work',
  'margin_submissions',
  'margin_review',
];
function policySnapshot(client: Client) {
  return client.query(policyInventory, [policySchemas]);
}
async function serverIdentity(client: Client, dataDirectory: string, systemIdentifier?: string) {
  const r = await client.query(
    "SELECT current_setting('data_directory') AS directory, system_identifier::text AS system_identifier FROM pg_control_system()",
  );
  if (
    r.rows[0].directory !== dataDirectory ||
    (systemIdentifier && r.rows[0].system_identifier !== systemIdentifier)
  )
    fail('The connected PostgreSQL server is not this owned Canvas cluster.');
  const ssl = await client.query('SELECT ssl FROM pg_stat_ssl WHERE pid=pg_backend_pid()');
  if (ssl.rows[0]?.ssl !== true)
    fail('Canvas bootstrap requires certificate-verified PostgreSQL TLS.');
  return r.rows[0].system_identifier as string;
}
async function running(dataDirectory: string) {
  try {
    await execute('pg_ctl', ['-D', dataDirectory, 'status'], { timeout: 10000, maxBuffer: 65536 });
    return true;
  } catch (error) {
    if ((error as { code?: number }).code === 3) return false;
    throw error;
  }
}
async function start(receipt: Pick<CanvasBootstrapReceipt, 'rootDirectory' | 'dataDirectory'>) {
  if (await running(receipt.dataDirectory)) return false;
  await command('pg_ctl', [
    '-D',
    receipt.dataDirectory,
    '-l',
    join(receipt.rootDirectory, 'postgres.log'),
    '-w',
    '-t',
    '30',
    'start',
  ]);
  return true;
}
async function receipt(root: string) {
  const raw = await privateFile(join(root, 'bootstrap.json'));
  const value = JSON.parse(raw.toString()) as CanvasBootstrapReceipt;
  raw.fill(0);
  if (
    value.schema !== 1 ||
    value.rootDirectory !== root ||
    value.dataDirectory !== join(root, 'postgres') ||
    value.configPath !== join(root, 'config.json') ||
    !/^\d+$/.test(value.systemIdentifier) ||
    !/^[0-9a-f-]{36}$/.test(value.instanceId) ||
    !value.files ||
    typeof value.files !== 'object'
  )
    fail('This directory has no valid Canvas ownership receipt.');
  port(value.postgresPort);
  for (const [file, digest] of Object.entries(value.files)) {
    if (file.startsWith('/') || file.split('/').includes('..') || !/^[a-f0-9]{64}$/.test(digest))
      fail('Invalid Canvas file receipt.');
    const bytes = await privateFile(join(root, file));
    try {
      if (sha(bytes) !== digest)
        fail(
          'A protected Canvas setup file differs from its saved receipt. Existing files were preserved.',
        );
    } finally {
      bytes.fill(0);
    }
  }
  if (
    ![
      'ownership.json',
      'config.json',
      'operator/database.url',
      'postgres/postgresql.conf',
      'postgres/pg_hba.conf',
      'postgres-tls/ca.pem',
    ].every((file) => Object.hasOwn(value.files, file))
  )
    fail('Canvas setup receipt is incomplete.');
  return value;
}
async function locked<T>(root: string, work: () => Promise<T>) {
  const path = join(root, '.bootstrap-lock');
  try {
    await mkdir(path, { mode: 0o700 });
  } catch {
    fail(
      'Another Canvas setup may be running, or a prior setup was interrupted. Inspect the dedicated root before retrying.',
    );
  }
  try {
    return await work();
  } finally {
    await rmdir(path);
  }
}

/** Operator-only verification; this checks all saved protected-file hashes and reads no database. */
export async function readCanvasLocalInstallation(
  rootDirectory: string,
): Promise<CanvasBootstrapReceipt> {
  assertLocalEnvironment();
  return receipt(await canonicalRoot(rootDirectory, false));
}

export interface CanvasLocalMaintenanceContext {
  readonly root: string;
  readonly receipt: CanvasBootstrapReceipt;
  readonly client: Client;
  /** Current connection's admission; read again after an explicitly successful reconnect. */
  readonly signal: AbortSignal;
  /** Reconnect only to reconcile an uncertain operation, rechecking admission and installation. */
  reconnect(): Promise<Client>;
}
/** Additive operator tasks share the bootstrap lock and exclusive database admission. */
export async function withCanvasLocalMaintenance<T>(
  rootDirectory: string,
  work: (context: CanvasLocalMaintenanceContext) => Promise<T>,
): Promise<T> {
  assertLocalEnvironment();
  const root = await canonicalRoot(rootDirectory, false);
  return locked(root, async () => {
    const saved = await receipt(root);
    if (!(await running(saved.dataDirectory)))
      fail('Start the owned Canvas database before adding a local companion service.');
    let current: Client | undefined;
    let admission = new AbortController();
    const detach = new Map<Client, () => void>();
    const endCurrent = async () => {
      admission.abort(
        new CanvasBootstrapError(
          'Canvas maintenance admission ended or is reconnecting. Recheck the current admission before continuing.',
        ),
      );
      const prior = current;
      current = undefined;
      if (!prior) return;
      detach.get(prior)?.();
      detach.delete(prior);
      // Ending a failed pg connection must never turn a late error into an uncaught exception.
      prior.on('error', () => {});
      await prior.end().catch(() => {});
    };
    const reconnect = async (): Promise<Client> => {
      await endCurrent();
      const unchanged = await receipt(root);
      if (JSON.stringify(unchanged) !== JSON.stringify(saved))
        fail('The original Canvas installation changed before maintenance could reconnect.');
      const next = await operator(root);
      const connectionAdmission = new AbortController();
      const lost = () =>
        connectionAdmission.abort(
          new CanvasBootstrapError(
            'Canvas maintenance admission was lost. Preserve the companion journal and reconcile before continuing.',
          ),
        );
      next.on('error', lost);
      next.on('end', lost);
      detach.set(next, () => {
        next.off('error', lost);
        next.off('end', lost);
      });
      try {
        await serverIdentity(next, saved.dataDirectory, saved.systemIdentifier);
        await acquireCanvasMaintenance(next);
        if ((await supportedLedger(next, saved.instanceId)) !== 13)
          fail(
            'Upgrade the owned Canvas database to migration 13 before adding a companion service.',
          );
        connectionAdmission.signal.throwIfAborted();
        current = next;
        admission = connectionAdmission;
        return next;
      } catch (error) {
        await next.end().catch(() => {});
        detach.get(next)?.();
        detach.delete(next);
        throw error;
      }
    };
    try {
      await reconnect();
      const result = await work({
        root,
        receipt: saved,
        get client() {
          admission.signal.throwIfAborted();
          return current!;
        },
        get signal() {
          return admission.signal;
        },
        reconnect,
      });
      admission.signal.throwIfAborted();
      // Companion publication must preserve the original bootstrap, migration and policy contract.
      const unchanged = await receipt(root);
      if (JSON.stringify(unchanged) !== JSON.stringify(saved))
        fail('The original Canvas installation receipt changed during companion setup.');
      await ledger(current!, saved.instanceId);
      admission.signal.throwIfAborted();
      return result;
    } finally {
      await endCurrent();
    }
  });
}
export async function startCanvasLocal(rootDirectory: string) {
  assertLocalEnvironment();
  const root = await canonicalRoot(rootDirectory, false);
  return locked(root, async () => {
    const saved = await receipt(root);
    const alreadyRunning = await running(saved.dataDirectory);
    try {
      const started = await start(saved),
        client = await operator(root);
      try {
        await serverIdentity(client, saved.dataDirectory, saved.systemIdentifier);
        await supportedLedger(client, saved.instanceId);
      } finally {
        await client.end();
      }
      return { ...saved, started };
    } catch (reason) {
      if (!alreadyRunning) await stopAfterFailedStart(saved, reason);
      throw reason;
    }
  });
}
export async function stopCanvasLocal(rootDirectory: string) {
  assertLocalEnvironment();
  const root = await canonicalRoot(rootDirectory, false);
  return locked(root, async () => {
    const saved = await receipt(root);
    if (!(await running(saved.dataDirectory))) return false;
    const client = await operator(root);
    try {
      await serverIdentity(client, saved.dataDirectory, saved.systemIdentifier);
      await supportedLedger(client, saved.instanceId);
    } finally {
      await client.end();
    }
    await command('pg_ctl', ['-D', saved.dataDirectory, '-m', 'smart', '-w', '-t', '30', 'stop']);
    return true;
  });
}

/** Explicit additive maintenance only. Existing protected files and encrypted artifacts are never rewritten. */
export async function upgradeCanvasLocal(rootDirectory: string): Promise<{
  from: 12 | 13;
  to: 13;
  changed: boolean;
  reconciled: boolean;
  backup?: CanvasUpgradeBackup;
}> {
  assertLocalEnvironment();
  const root = await canonicalRoot(rootDirectory, false);
  return locked(root, async () => {
    const saved = await receipt(root);
    if (!(await running(saved.dataDirectory)))
      fail(
        'Start the owned Canvas PostgreSQL cluster, then stop the API and workers before upgrading.',
      );
    const migration = await reviewedMigration013();
    const expected = await migrationManifest();
    if (expected.length !== 13 || expected[12].sha256 !== migration.sha256)
      fail('The reviewed Canvas migration manifest is inconsistent.');
    let client = await operator(root);
    client.on('error', () => {});
    let backup: CanvasUpgradeBackup | undefined;
    try {
      await serverIdentity(client, saved.dataDirectory, saved.systemIdentifier);
      await acquireCanvasMaintenance(client);
      const version = await supportedLedger(client, saved.instanceId);
      if (version === 13) return { from: 13, to: 13, changed: false, reconciled: false };
      // A backup is accepted only after all legacy runtime sessions have stopped and the exact old baseline passed.
      backup = await createCanvasUpgradeBackup(
        root,
        await operatorConfiguration(root),
        saved,
        expected.slice(0, 12),
      );
      await assertCanvasDatabaseQuiet(client);
      let commitAttempted = false;
      const deadline = setTimeout(() => {
        void client.end().catch(() => {});
      }, 30000);
      deadline.unref();
      try {
        await client.query('BEGIN');
        await client.query(
          "SET LOCAL lock_timeout='2s'; SET LOCAL statement_timeout='8s'; SET LOCAL idle_in_transaction_session_timeout='10s'; SET LOCAL synchronous_commit='on'",
        );
        await client.query(
          'LOCK TABLE margin_local.migrations,margin_local.policy_contract IN EXCLUSIVE MODE',
        );
        await ledger(client, saved.instanceId, expected.slice(0, 12));
        const beforePolicies = (await policySnapshot(client)).rows;
        const beforeObjects = await upgradeObjects(client);
        await client.query(migration.sql);
        assertUpgradeObjects(beforeObjects, await upgradeObjects(client));
        assertUpgradePolicies(beforePolicies, (await policySnapshot(client)).rows);
        await client.query(
          'INSERT INTO margin_local.migrations(position,name,sha256) VALUES($1,$2,$3)',
          [migration.position, migration.name, migration.sha256],
        );
        // The old contract remains immutable unless the entire reviewed migration commits.
        await client.query('DELETE FROM margin_local.policy_contract');
        await client.query(
          'INSERT INTO margin_local.policy_contract(table_name,name,roles,command,permissive,using_expression,check_expression) ' +
            policyInventory,
          [policySchemas],
        );
        await ledger(client, saved.instanceId, expected);
        commitAttempted = true;
        await client.query('COMMIT');
      } catch (error) {
        if (!commitAttempted) {
          await client.query('ROLLBACK').catch(() => {});
          throw new CanvasBootstrapError(
            'Canvas upgrade was not committed. The private backup and original files were preserved.',
            { cause: error },
          );
        }
        // COMMIT can succeed while its acknowledgement is lost. Never replay DDL based on that exception.
        clearTimeout(deadline);
        await client.end().catch(() => {});
        client = await operator(root);
        client.on('error', () => {});
        try {
          await serverIdentity(client, saved.dataDirectory, saved.systemIdentifier);
          const actual = await supportedLedger(client, saved.instanceId);
          if (actual === 13) return { from: 12, to: 13, changed: true, reconciled: true, backup };
          fail(
            'Canvas upgrade did not commit; exact migration 12 and its policy contract remain intact. The private backup was preserved.',
          );
        } catch (reconciliation) {
          if (
            reconciliation instanceof CanvasBootstrapError &&
            reconciliation.message.startsWith('Canvas upgrade did not commit')
          )
            throw reconciliation;
          throw new CanvasBootstrapError(
            'Canvas upgrade commit outcome could not be verified. Do not replay or restore automatically; inspect the protected installation and backup.',
            { cause: reconciliation },
          );
        }
      } finally {
        clearTimeout(deadline);
      }
      return { from: 12, to: 13, changed: true, reconciled: false, backup };
    } finally {
      await client.end().catch(() => {});
    }
  });
}
async function stopAfterFailedStart(
  owned: Pick<CanvasBootstrapReceipt, 'rootDirectory' | 'dataDirectory'> & {
    systemIdentifier?: string;
  },
  reason: unknown,
) {
  // Preserve every file. An unverified server must never receive a stop command.
  try {
    if (await running(owned.dataDirectory)) {
      const probe = await operator(owned.rootDirectory, 'postgres');
      try {
        await serverIdentity(probe, owned.dataDirectory, owned.systemIdentifier);
      } finally {
        await probe.end();
      }
      await command('pg_ctl', ['-D', owned.dataDirectory, '-m', 'fast', '-w', '-t', '30', 'stop']);
    }
  } catch (cleanup) {
    throw new CanvasBootstrapError(
      'Canvas startup failed and its owned cluster shutdown could not be confirmed. Inspect the private cluster before retrying.',
      { cause: new AggregateError([reason, cleanup]) },
    );
  }
}
export async function bootCanvasLocal(
  options: CanvasBootstrapOptions,
  tests?: { installThrough: 12 },
) {
  assertLocalEnvironment();
  if (tests && (process.env.NODE_ENV !== 'test' || tests.installThrough !== 12))
    fail('Historical initialization is available only to disposable test fixtures.');
  port(options.postgresPort);
  port(options.apiPort);
  if (options.postgresPort === options.apiPort)
    fail('PostgreSQL and API require different local ports.');
  const origin = new URL(options.applicationOrigin);
  if (
    origin.protocol !== 'https:' ||
    origin.hostname !== '127.0.0.1' ||
    !origin.port ||
    Number(origin.port) < 1024 ||
    Number(origin.port) > 65535 ||
    origin.origin !== options.applicationOrigin ||
    origin.username ||
    origin.password
  )
    fail(
      'Use an exact HTTPS 127.0.0.1 application origin with an explicit port from 1024 to 65535.',
    );
  if (Number(origin.port) === options.apiPort || Number(origin.port) === options.postgresPort)
    fail('PostgreSQL, API, and web application require different local ports.');
  const apiTls = await inspectApiTls(options.apiTls);
  try {
    const root = await canonicalRoot(options.rootDirectory, true);
    const entries = await readdir(root);
    if (entries.includes('bootstrap.json')) {
      if (tests) fail('Historical test initialization requires a fresh disposable root.');
      const saved = await receipt(root),
        config = JSON.parse((await privateFile(saved.configPath)).toString());
      if (
        sha(apiTls.key) !== saved.files['api-tls/key.pem'] ||
        sha(apiTls.cert) !== saved.files['api-tls/cert.pem'] ||
        saved.postgresPort !== options.postgresPort ||
        config.listener.port !== options.apiPort ||
        config.applicationOrigin !== options.applicationOrigin
      )
        fail(
          'Existing Canvas configuration differs from the requested ports or origin. Nothing was changed.',
        );
      return await startCanvasLocal(root);
    }
    if (entries.length)
      fail(
        'The Canvas root is not empty and has no complete ownership receipt. Foreign or incomplete setup was preserved.',
      );
    return await locked(root, async () => {
      const instanceId = randomUUID(),
        dataDirectory = join(root, 'postgres'),
        configPath = join(root, 'config.json');
      const tracked = new Set<string>();
      const write = async (path: string, value: string | Buffer) => {
        await save(join(root, path), value);
        tracked.add(path);
      };
      for (const name of [
        'secrets',
        'databases',
        'operator',
        'postgres-tls',
        'api-tls',
        'artifacts',
        'data',
      ])
        await mkdir(join(root, name), { mode: 0o700 });
      await write(
        'ownership.json',
        JSON.stringify({
          schema: 1,
          instanceId,
          rootDirectory: root,
          dataDirectory,
          postgresPort: options.postgresPort,
        }) + '\n',
      );
      await write('api-tls/key.pem', apiTls.key);
      await write('api-tls/cert.pem', apiTls.cert);
      const pgTls = join(root, 'postgres-tls');
      await command('openssl', [
        'req',
        '-x509',
        '-newkey',
        'rsa:3072',
        '-nodes',
        '-sha256',
        '-keyout',
        join(pgTls, 'ca.key'),
        '-out',
        join(pgTls, 'ca.pem'),
        '-days',
        '365',
        '-subj',
        '/CN=Margin isolated local PostgreSQL CA',
        '-addext',
        'basicConstraints=critical,CA:TRUE,pathlen:0',
        '-addext',
        'keyUsage=critical,keyCertSign,cRLSign',
      ]);
      await command('openssl', [
        'req',
        '-new',
        '-newkey',
        'rsa:3072',
        '-nodes',
        '-sha256',
        '-keyout',
        join(pgTls, 'server.key'),
        '-out',
        join(pgTls, 'server.csr'),
        '-subj',
        '/CN=127.0.0.1',
      ]);
      await write(
        'postgres-tls/server.ext',
        'basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=IP:127.0.0.1\n',
      );
      await command('openssl', [
        'x509',
        '-req',
        '-in',
        join(pgTls, 'server.csr'),
        '-CA',
        join(pgTls, 'ca.pem'),
        '-CAkey',
        join(pgTls, 'ca.key'),
        '-set_serial',
        '0x' + randomBytes(16).toString('hex'),
        '-out',
        join(pgTls, 'server.pem'),
        '-days',
        '30',
        '-sha256',
        '-extfile',
        join(pgTls, 'server.ext'),
      ]);
      for (const name of ['ca.key', 'ca.pem', 'server.key', 'server.pem', 'server.csr']) {
        const handle = await open(join(pgTls, name), constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          await handle.chmod(0o600);
          await handle.sync();
        } finally {
          await handle.close();
        }
        tracked.add('postgres-tls/' + name);
      }
      await syncDirectory(pgTls);
      const secrets: Record<string, string> = {};
      for (const name of ['wrapping', 'session', 'identity', 'lms', 'resource']) {
        const path = 'secrets/' + name + '.key';
        await write(path, randomBytes(32).toString('base64') + '\n');
        secrets[name] = join(root, path);
      }
      const signing = generateKeyPairSync('rsa', { modulusLength: 3072 });
      await write(
        'secrets/tool-signing.pem',
        signing.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
      );
      const passwords: Record<string, string> = {};
      const databases: Record<string, string> = {};
      for (const name of Object.keys(CANVAS_DATABASE_ROLES)) {
        passwords[name] = randomBytes(32).toString('base64url');
        const path = 'databases/' + name + '.url';
        await write(
          path,
          dbUrl('margin_canvas_' + name.toLowerCase(), passwords[name], options.postgresPort) +
            '\n',
        );
        databases[name] = join(root, path);
      }
      const operatorPassword = randomBytes(32).toString('base64url');
      await write('operator/password', operatorPassword + '\n');
      await write(
        'operator/database.url',
        dbUrl('margin_canvas_operator', operatorPassword, options.postgresPort) + '\n',
      );
      await command('initdb', [
        '-D',
        dataDirectory,
        '-U',
        'margin_canvas_operator',
        '--pwfile=' + join(root, 'operator/password'),
        '--auth-local=scram-sha-256',
        '--auth-host=scram-sha-256',
        '--no-locale',
        '-E',
        'UTF8',
      ]);
      const quote = (value: string) => "'" + value.replaceAll("'", "''") + "'";
      // initdb-created configuration is owned by this new cluster only. Append explicit safe settings.
      for (const [name, content] of [
        [
          'postgresql.conf',
          `listen_addresses='127.0.0.1'\nport=${options.postgresPort}\nunix_socket_directories=''\nssl=on\nssl_cert_file=${quote(join(pgTls, 'server.pem'))}\nssl_key_file=${quote(join(pgTls, 'server.key'))}\nssl_min_protocol_version='TLSv1.2'\npassword_encryption='scram-sha-256'\nfsync=on\nsynchronous_commit=on\nfull_page_writes=on\nlog_statement='none'\n`,
        ],
        [
          'pg_hba.conf',
          `hostssl all all 127.0.0.1/32 scram-sha-256\nhost all all 0.0.0.0/0 reject\nhost all all ::/0 reject\nlocal all all reject\n`,
        ],
      ]) {
        const handle = await open(join(dataDirectory, name), 'w', 0o600);
        try {
          await handle.writeFile(content);
          await handle.sync();
        } finally {
          await handle.close();
        }
        tracked.add('postgres/' + name);
      }
      await write('postgres.log', '');
      tracked.delete('postgres.log');
      try {
        await start({ rootDirectory: root, dataDirectory });
        let client = await operator(root, 'postgres');
        try {
          await serverIdentity(client, dataDirectory);
          await client.query('CREATE DATABASE margin_canvas');
        } finally {
          await client.end();
        }
        client = await operator(root);
        let systemIdentifier: string;
        try {
          systemIdentifier = await serverIdentity(client, dataDirectory);
          await client.query(
            'REVOKE TEMPORARY ON DATABASE margin_canvas FROM PUBLIC; REVOKE ALL ON SCHEMA public FROM PUBLIC',
          );
          await client.query(
            "CREATE SCHEMA margin_local; REVOKE ALL ON SCHEMA margin_local FROM PUBLIC; CREATE TABLE margin_local.installation(id integer PRIMARY KEY CHECK(id=1),instance_id uuid NOT NULL,schema_version integer NOT NULL CHECK(schema_version=1)); CREATE TABLE margin_local.migrations(position integer PRIMARY KEY,name text UNIQUE NOT NULL,sha256 text NOT NULL CHECK(sha256 ~ '^[a-f0-9]{64}$'),applied_at timestamptz NOT NULL DEFAULT clock_timestamp()); REVOKE ALL ON ALL TABLES IN SCHEMA margin_local FROM PUBLIC",
          );
          await client.query('INSERT INTO margin_local.installation VALUES(1,$1,1)', [instanceId]);
          const installedManifest = await migrationManifest(tests?.installThrough);
          for (const migration of installedManifest) {
            const sql = await readFile(new URL(migration.name, manifestDirectory), 'utf8');
            if (
              (sql.match(/^BEGIN;\s*$/gm) || []).length !== 1 ||
              (sql.match(/^COMMIT;\s*$/gm) || []).length !== 1
            )
              fail('Migration transaction framing is unsupported.');
            await client.query('BEGIN');
            try {
              await client.query(sql.replace(/^BEGIN;\s*$/m, '').replace(/^COMMIT;\s*$/m, ''));
              await client.query(
                'INSERT INTO margin_local.migrations(position,name,sha256) VALUES($1,$2,$3)',
                [migration.position, migration.name, migration.sha256],
              );
              await client.query('COMMIT');
            } catch (error) {
              await client.query('ROLLBACK');
              throw error;
            }
          }
          await client.query(
            'CREATE TABLE margin_local.policy_contract(table_name text NOT NULL,name text NOT NULL,roles text[] NOT NULL,command text NOT NULL,permissive boolean NOT NULL,using_expression text,check_expression text,PRIMARY KEY(table_name,name)); REVOKE ALL ON TABLE margin_local.policy_contract FROM PUBLIC',
          );
          await client.query(
            'INSERT INTO margin_local.policy_contract(table_name,name,roles,command,permissive,using_expression,check_expression) ' +
              policyInventory,
            [policySchemas],
          );
          for (const [name, role] of Object.entries(CANVAS_DATABASE_ROLES)) {
            const login = 'margin_canvas_' + name.toLowerCase();
            await client.query(
              `CREATE ROLE ${login} LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '${passwords[name]}'; GRANT ${role} TO ${login}; GRANT USAGE ON SCHEMA margin_local TO ${role}; GRANT SELECT ON ALL TABLES IN SCHEMA margin_local TO ${role}`,
            );
          }
          await ledger(client, instanceId, installedManifest);
        } finally {
          await client.end();
        }
        await write(
          'config.json',
          JSON.stringify(
            {
              schema: 1,
              applicationOrigin: options.applicationOrigin,
              listener: { host: '127.0.0.1', port: options.apiPort },
              artifactDirectory: join(root, 'artifacts'),
              dataDirectory: join(root, 'data'),
              captureEnabled: true,
              secrets,
              wrappingKeyId: 'local-canvas-' + instanceId,
              toolSigning: {
                kid: 'local-canvas-tool-' + instanceId,
                privateKeyFile: join(root, 'secrets/tool-signing.pem'),
              },
              tls: {
                keyFile: join(root, 'api-tls/key.pem'),
                certFile: join(root, 'api-tls/cert.pem'),
              },
              databaseCaFile: join(pgTls, 'ca.pem'),
              databases,
            },
            null,
            2,
          ) + '\n',
        );
        const files: Record<string, string> = {};
        for (const path of tracked) {
          const bytes = await privateFile(join(root, path));
          files[path] = sha(bytes);
          bytes.fill(0);
        }
        const saved: CanvasBootstrapReceipt = {
          schema: 1,
          instanceId,
          rootDirectory: root,
          dataDirectory,
          postgresPort: options.postgresPort,
          configPath,
          systemIdentifier,
          files,
        };
        await save(join(root, 'bootstrap.json'), JSON.stringify(saved, null, 2) + '\n');
        return { ...saved, started: true };
      } catch (reason) {
        // This branch owns a freshly initialized cluster; stop it only after TLS and its
        // data-directory identity are verified. Preserve every file for operator inspection.
        await stopAfterFailedStart({ rootDirectory: root, dataDirectory }, reason);
        throw reason;
      }
    });
  } finally {
    apiTls.key.fill(0);
    apiTls.cert.fill(0);
  }
}
