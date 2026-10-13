import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { link, lstat, mkdir, open, readdir, unlink } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import type { PoolConfig } from 'pg';
import { strictJson } from '../strict-json.js';
import {
  canvasCompanionOwnership as owned,
  migrationManifest,
  readCanvasLocalInstallation,
  withCanvasLocalMaintenance,
  type CanvasBootstrapReceipt,
} from './bootstrap.js';
import { checkDedicatedDirectory, readProtectedFile, utf8 } from './protected-files.js';
import { assertCanvasDatabaseQuiet } from './maintenance.js';
import { assertCanvasDatabaseReady, assertCanvasFeedbackReady } from './preflight.js';
import { createCanvasUpgradeBackup, type CanvasUpgradeBackup } from './upgrade-backup.js';
import { upgradeObjects } from './upgrade-contract.js';
import {
  assertFeedbackObjects,
  assertFeedbackPolicies,
  feedbackPolicyAdditions,
  FEEDBACK_GROUP,
  FEEDBACK_LOGIN,
  reviewedMigration014,
} from './feedback-contract.js';

export class CanvasFeedbackSetupError extends Error {
  readonly name = 'CanvasFeedbackSetupError';
  constructor() {
    super(
      'Feedback setup is incomplete or differs from its saved installation. Preserve the private feedback journal, backup and original Canvas files; stop runtimes and retry enable-feedback only after checking the installation. No credentials were overwritten.',
    );
  }
}
function ensure(value: unknown): asserts value {
  if (!value) throw new CanvasFeedbackSetupError();
}
const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const json = (value: unknown) => JSON.stringify(value, null, 2) + '\n';
interface Binding {
  instanceId: string;
  systemIdentifier: string;
  canvasRoot: string;
  configSha256: string;
  ownershipSha256: string;
  caSha256: string;
  postgresPort: number;
}
interface Receipt extends Binding {
  schema: 1;
  operationId: string;
  login: typeof FEEDBACK_LOGIN;
  migrationSha256: string;
  databaseSha256: string;
  backup: CanvasUpgradeBackup;
  backupManifestSha256: string;
}
interface Journal extends Receipt {
  database: string;
}
const pendingName =
  /^\.(?:setup-journal\.json|installation\.json|database\.url)\.[a-f0-9-]{36}\.[a-f0-9-]{36}\.pending$/;
async function exists(path: string) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}
async function sync(path: string) {
  const h = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    await h.sync();
  } finally {
    await h.close();
  }
}
async function save(path: string, value: string, operationId: string) {
  const temporary = join(
    dirname(path),
    `.${basename(path)}.${operationId}.${randomUUID()}.pending`,
  );
  const h = await open(
    temporary,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await h.writeFile(value);
    await h.sync();
  } finally {
    await h.close();
  }
  await link(temporary, path);
  await sync(dirname(path));
  await unlink(temporary);
  await sync(dirname(path));
}
async function recoverLink(path: string, operationId: string) {
  const metadata = await lstat(path);
  if (metadata.nlink === 1) return;
  ensure(metadata.nlink === 2);
  let matching: string | undefined;
  for (const name of await readdir(dirname(path))) {
    if (!name.startsWith(`.${basename(path)}.${operationId}.`) || !pendingName.test(name)) continue;
    const candidate = join(dirname(path), name),
      other = await lstat(candidate);
    if (other.dev === metadata.dev && other.ino === metadata.ino) {
      ensure(
        !matching &&
          other.nlink === 2 &&
          other.isFile() &&
          other.uid === process.getuid?.() &&
          (other.mode & 0o7777) === 0o600,
      );
      matching = candidate;
    }
  }
  ensure(matching);
  await unlink(matching);
  await sync(dirname(path));
}
async function read(path: string, maximum = 65536, allowPublicationLink = false) {
  const bytes = await readProtectedFile(path, maximum);
  try {
    const count = (await lstat(path)).nlink;
    ensure(count === 1 || (allowPublicationLink && count === 2));
    return bytes;
  } catch (error) {
    bytes.fill(0);
    throw error;
  }
}
async function fileSha(path: string) {
  const bytes = await read(path);
  try {
    return sha(bytes);
  } finally {
    bytes.fill(0);
  }
}
async function binding(saved: CanvasBootstrapReceipt): Promise<Binding> {
  return {
    instanceId: saved.instanceId,
    systemIdentifier: saved.systemIdentifier,
    canvasRoot: saved.rootDirectory,
    configSha256: await fileSha(saved.configPath),
    ownershipSha256: await fileSha(join(saved.rootDirectory, 'ownership.json')),
    caSha256: await fileSha(join(saved.rootDirectory, 'postgres-tls/ca.pem')),
    postgresPort: saved.postgresPort,
  };
}
function publication(journal: Journal): Receipt {
  const { database: _database, ...receipt } = journal;
  return receipt;
}
function checkBinding(value: Receipt, expected: Binding) {
  for (const key of Object.keys(expected) as Array<keyof Binding>)
    ensure(value[key] === expected[key]);
}
async function readJournal(path: string, expected: Binding, prepared: boolean): Promise<Journal> {
  const raw = await read(path, 65536, true);
  try {
    const value = strictJson(utf8(raw)) as Journal;
    const names = [
      'schema',
      'operationId',
      'login',
      'migrationSha256',
      'databaseSha256',
      'backup',
      'backupManifestSha256',
      ...Object.keys(expected),
      ...(prepared ? ['database'] : []),
    ];
    ensure(
      value &&
        typeof value === 'object' &&
        Object.keys(value).length === names.length &&
        names.every((key) => Object.hasOwn(value, key)),
    );
    ensure(
      value.schema === 1 &&
        value.login === FEEDBACK_LOGIN &&
        /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value.operationId),
    );
    checkBinding(value, expected);
    for (const key of ['migrationSha256', 'databaseSha256', 'backupManifestSha256'] as const)
      ensure(/^[a-f0-9]{64}$/.test(value[key]));
    const b = value.backup;
    ensure(
      b &&
        Object.keys(b).sort().join(',') === 'archive,bytes,directory,sha256' &&
        b.directory.startsWith(join(expected.canvasRoot, 'backups', 'before-014-')) &&
        dirname(b.directory) === join(expected.canvasRoot, 'backups') &&
        b.archive === join(b.directory, 'database.dump') &&
        /^[a-f0-9]{64}$/.test(b.sha256) &&
        Number.isSafeInteger(b.bytes) &&
        b.bytes > 0 &&
        b.bytes <= 2 * 1024 ** 3,
    );
    if (prepared) {
      ensure(
        typeof value.database === 'string' &&
          value.database.length < 8192 &&
          sha(value.database) === value.databaseSha256,
      );
      const url = new URL(value.database.trim());
      ensure(
        /^[A-Za-z0-9_-]{43}$/.test(url.password) &&
          value.database ===
            `postgresql://${FEEDBACK_LOGIN}:${url.password}@127.0.0.1:${expected.postgresPort}/margin_canvas\n`,
      );
    }
    return value;
  } finally {
    raw.fill(0);
  }
}
async function ensureFile(path: string, value: string, operationId: string) {
  if (!(await exists(path))) await save(path, value, operationId);
  const bytes = await read(path, 65536, true);
  try {
    ensure(sha(bytes) === sha(value));
    await recoverLink(path, operationId);
  } finally {
    bytes.fill(0);
  }
}
async function verifyBackup(journal: Journal) {
  ensure(
    (await fileSha(join(journal.backup.directory, 'manifest.json'))) ===
      journal.backupManifestSha256,
  );
  await checkDedicatedDirectory(journal.backup.directory);
  const h = await open(
    journal.backup.archive,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  const buffer = Buffer.alloc(1024 * 1024);
  try {
    const before = await h.stat();
    ensure(
      before.isFile() &&
        before.uid === process.getuid?.() &&
        (before.mode & 0o7777) === 0o600 &&
        before.nlink === 1 &&
        before.size === journal.backup.bytes,
    );
    const hash = createHash('sha256');
    let offset = 0;
    while (offset < before.size) {
      const r = await h.read(buffer, 0, Math.min(buffer.length, before.size - offset), offset);
      ensure(r.bytesRead > 0);
      hash.update(buffer.subarray(0, r.bytesRead));
      offset += r.bytesRead;
    }
    const after = await h.stat();
    ensure(
      before.size === after.size &&
        before.mtimeMs === after.mtimeMs &&
        before.ctimeMs === after.ctimeMs &&
        hash.digest('hex') === journal.backup.sha256,
    );
  } finally {
    buffer.fill(0);
    await h.close();
  }
}
function database(journal: Pick<Journal, 'database' | 'postgresPort'>, ca: string): PoolConfig {
  const url = new URL(journal.database.trim());
  ensure(
    journal.database ===
      `postgresql://${FEEDBACK_LOGIN}:${url.password}@127.0.0.1:${journal.postgresPort}/margin_canvas\n` &&
      /^[A-Za-z0-9_-]{43}$/.test(url.password),
  );
  return {
    host: '127.0.0.1',
    port: journal.postgresPort,
    user: FEEDBACK_LOGIN,
    password: url.password,
    database: 'margin_canvas',
    ssl: { ca, rejectUnauthorized: true },
    sslnegotiation: 'postgres',
    options: '-c search_path=pg_catalog',
    client_encoding: 'UTF8',
    connectionTimeoutMillis: 5000,
    application_name: 'margin-canvas-feedback',
  };
}

/** Caller first enforces the certificate barrier. Partial setup has no published credential,
 * so feedback stays unavailable while the original application can continue safely. */
export async function loadCanvasFeedbackDatabase(root: string): Promise<PoolConfig | undefined> {
  const sidecar = join(root, 'feedback'),
    installedPath = join(sidecar, 'installation.json');
  if (!(await exists(sidecar))) return undefined;
  try {
    await checkDedicatedDirectory(sidecar);
    if (!(await exists(installedPath))) return undefined;
    const raw = await read(join(root, 'bootstrap.json'));
    let saved: CanvasBootstrapReceipt;
    try {
      saved = strictJson(utf8(raw)) as CanvasBootstrapReceipt;
    } finally {
      raw.fill(0);
    }
    ensure(
      saved.schema === 1 &&
        saved.rootDirectory === root &&
        saved.configPath === join(root, 'config.json'),
    );
    const expected = await binding(saved),
      installed = await readJournal(installedPath, expected, false);
    ensure(
      (await lstat(installedPath)).nlink === 1 &&
        installed.migrationSha256 === (await reviewedMigration014()).sha256,
    );
    const bytes = await read(join(sidecar, 'database.url'), 8192),
      ca = await read(join(root, 'postgres-tls/ca.pem'));
    try {
      ensure(sha(bytes) === installed.databaseSha256);
      return database({ database: utf8(bytes), postgresPort: saved.postgresPort }, utf8(ca));
    } finally {
      bytes.fill(0);
      ca.fill(0);
    }
  } catch {
    throw new CanvasFeedbackSetupError();
  }
}

/** Explicit 13→14 maintenance. The migration and new login commit together; all original
 * credentials, configuration, bootstrap receipt and captures remain byte-for-byte unchanged. */
export async function enableCanvasLocalFeedback(
  rootDirectory: string,
): Promise<{ changed: boolean; reconciled: boolean; backup: CanvasUpgradeBackup }> {
  try {
    const saved = await readCanvasLocalInstallation(rootDirectory),
      root = saved.rootDirectory;
    const migration = await reviewedMigration014();
    return await withCanvasLocalMaintenance(root, async (context) => {
      const expected = await binding(context.receipt),
        sidecar = join(root, 'feedback');
      await checkDedicatedDirectory(sidecar);
      if (!(await exists(sidecar))) {
        await mkdir(sidecar, { mode: 0o700 });
        await sync(root);
      }
      await checkDedicatedDirectory(sidecar);
      const entries = await readdir(sidecar);
      ensure(
        entries.length <= 64 &&
          entries.every(
            (name) =>
              ['setup-journal.json', 'installation.json', 'database.url'].includes(name) ||
              pendingName.test(name),
          ),
      );
      const journalPath = join(sidecar, 'setup-journal.json'),
        installedPath = join(sidecar, 'installation.json');
      const hadJournal = await exists(journalPath),
        hadInstallation = await exists(installedPath);
      const priorRole = async () =>
        (
          await context.client.query<{ marker: string | null }>(
            "SELECT shobj_description(oid,'pg_authid') AS marker FROM pg_roles WHERE rolname=$1",
            [FEEDBACK_LOGIN],
          )
        ).rows[0];
      let journal: Journal;
      if (hadJournal) {
        journal = await readJournal(journalPath, expected, true);
        ensure(journal.migrationSha256 === migration.sha256);
        await recoverLink(journalPath, journal.operationId);
      } else {
        ensure(
          !hadInstallation &&
            !(await exists(join(sidecar, 'database.url'))) &&
            !(await priorRole()) &&
            (await owned.ledger(context.client, saved.instanceId)) === 13,
        );
        ensure(
          !(await context.client.query('SELECT 1 FROM pg_roles WHERE rolname=$1', [FEEDBACK_GROUP]))
            .rowCount,
        );
        const { loadCanvasLocalConfig } = await import('./config.js');
        const baseline = await loadCanvasLocalConfig(saved.configPath);
        try {
          await assertCanvasDatabaseReady(baseline.configuration.databases, {
            signal: context.signal,
          });
        } finally {
          baseline.dispose();
        }
        await assertCanvasDatabaseQuiet(context.client);
        const backup = await createCanvasUpgradeBackup(
          root,
          await owned.configuration(root),
          saved,
          await migrationManifest(13),
        );
        context.signal.throwIfAborted();
        const secret = randomBytes(32).toString('base64url'),
          url = `postgresql://${FEEDBACK_LOGIN}:${secret}@127.0.0.1:${saved.postgresPort}/margin_canvas\n`;
        journal = {
          schema: 1,
          ...expected,
          operationId: randomUUID(),
          login: FEEDBACK_LOGIN,
          migrationSha256: migration.sha256,
          databaseSha256: sha(url),
          backup,
          backupManifestSha256: await fileSha(join(backup.directory, 'manifest.json')),
          database: url,
        };
        await save(journalPath, json(journal), journal.operationId);
      }
      context.signal.throwIfAborted();
      await verifyBackup(journal);
      await ensureFile(join(sidecar, 'database.url'), journal.database, journal.operationId);
      const marker = `margin-local-feedback:${saved.instanceId}:${journal.operationId}`;
      let version = await owned.ledger(context.client, saved.instanceId),
        role = await priorRole(),
        reconciled = hadJournal;
      if (version === 14) ensure(role?.marker === marker);
      else {
        ensure(version === 13 && !role && !hadInstallation);
        ensure(
          !(await context.client.query('SELECT 1 FROM pg_roles WHERE rolname=$1', [FEEDBACK_GROUP]))
            .rowCount,
        );
        await assertCanvasDatabaseQuiet(context.client);
        let commitAttempted = false;
        const transactionClient = context.client;
        const deadline = setTimeout(() => {
          void transactionClient.end().catch(() => {});
        }, 30000);
        deadline.unref();
        try {
          await transactionClient.query('BEGIN');
          await transactionClient.query(
            "SET LOCAL lock_timeout='2s'; SET LOCAL statement_timeout='8s'; SET LOCAL idle_in_transaction_session_timeout='10s'; SET LOCAL synchronous_commit='on'; SET LOCAL log_statement='none'; SET LOCAL log_min_error_statement='panic'",
          );
          await transactionClient.query(
            'LOCK TABLE margin_local.migrations,margin_local.policy_contract IN EXCLUSIVE MODE',
          );
          ensure((await owned.ledger(transactionClient, saved.instanceId)) === 13);
          const beforeObjects = await upgradeObjects(transactionClient),
            beforePolicies = (await owned.policies(transactionClient)).rows,
            expectedPolicies = await feedbackPolicyAdditions(transactionClient);
          await transactionClient.query(migration.sql);
          assertFeedbackObjects(beforeObjects, await upgradeObjects(transactionClient));
          assertFeedbackPolicies(
            beforePolicies,
            (await owned.policies(transactionClient)).rows,
            expectedPolicies,
          );
          const password = new URL(journal.database.trim()).password;
          await transactionClient.query(
            `CREATE ROLE ${FEEDBACK_LOGIN} LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 6 PASSWORD '${password}'`,
          );
          await transactionClient.query(
            `COMMENT ON ROLE ${FEEDBACK_LOGIN} IS '${marker}'; GRANT ${FEEDBACK_GROUP} TO ${FEEDBACK_LOGIN}; GRANT CONNECT ON DATABASE margin_canvas TO ${FEEDBACK_LOGIN}; GRANT USAGE ON SCHEMA margin_local TO ${FEEDBACK_GROUP}; GRANT SELECT ON margin_local.installation,margin_local.migrations,margin_local.policy_contract TO ${FEEDBACK_GROUP}`,
          );
          await transactionClient.query(
            'INSERT INTO margin_local.migrations(position,name,sha256) VALUES($1,$2,$3)',
            [14, migration.name, migration.sha256],
          );
          await owned.recordPolicies(transactionClient);
          ensure((await owned.ledger(transactionClient, saved.instanceId)) === 14);
          context.signal.throwIfAborted();
          commitAttempted = true;
          await transactionClient.query('COMMIT');
        } catch (error) {
          if (!commitAttempted) {
            await transactionClient.query('ROLLBACK').catch(() => {});
            throw error;
          }
          clearTimeout(deadline);
          await context.reconnect();
          version = await owned.ledger(context.client, saved.instanceId);
          role = await priorRole();
          ensure(version === 14 && role?.marker === marker);
          reconciled = true;
        } finally {
          clearTimeout(deadline);
        }
      }
      context.signal.throwIfAborted();
      const ca = await read(join(root, 'postgres-tls/ca.pem'));
      try {
        await assertCanvasFeedbackReady(database(journal, utf8(ca)), {
          instanceId: saved.instanceId,
          signal: context.signal,
        });
      } finally {
        ca.fill(0);
      }
      context.signal.throwIfAborted();
      await ensureFile(installedPath, json(publication(journal)), journal.operationId);
      ensure(await loadCanvasFeedbackDatabase(root));
      return {
        changed: !hadInstallation,
        reconciled: !hadInstallation && reconciled,
        backup: journal.backup,
      };
    });
  } catch {
    throw new CanvasFeedbackSetupError();
  }
}
