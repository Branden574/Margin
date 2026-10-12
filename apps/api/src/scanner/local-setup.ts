import { constants } from 'node:fs';
import { link, lstat, mkdir, open, readdir, realpath, unlink } from 'node:fs/promises';
import { randomBytes, randomUUID } from 'node:crypto';
import { basename, dirname, join } from 'node:path';
import { readScannerDefinitions } from '../../../../infra/scanner/clamav/definitions.mjs';
import {
  readCanvasLocalInstallation,
  withCanvasLocalMaintenance,
} from '../canvas-local/bootstrap.js';
import { assertCanvasInspectorReady } from '../canvas-local/preflight.js';
import {
  absolutePath,
  checkDedicatedDirectory,
  readProtectedFile,
  utf8,
} from '../canvas-local/protected-files.js';
import { strictJson } from '../strict-json.js';
import { createDockerScannerExecutor } from './docker.js';
import {
  INSPECTOR_LOGIN,
  LocalScannerConfigurationError,
  loadLocalScannerConfig,
  readScannerBinding,
  scannerAssert,
  scannerDigest,
  scannerObject,
  scannerRead,
  scannerReferences,
  type LocalScannerReferences,
} from './local-config.js';

export interface LocalScannerSetupOptions {
  canvasRoot: string;
  parserImage: string;
  antivirusImage: string;
  definitionsDirectory: string;
  dockerExecutable: string;
  dockerSocketPath: string;
}
interface SetupReceipt {
  schema: 1;
  operationId: string;
  instanceId: string;
  systemIdentifier: string;
  bootstrapSha256: string;
  configSha256: string;
  databaseSha256: string;
  login: typeof INSPECTOR_LOGIN;
}
interface SetupJournal extends SetupReceipt {
  configuration: LocalScannerReferences;
  database: string;
}
const pendingName =
  /^\.(?:setup-journal\.json|installation\.json|inspector\.json|database\.url)\.[a-f0-9-]{36}\.[a-f0-9-]{36}\.pending$/;
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
/** Fsync bytes before atomic no-clobber publication. An interrupted temporary
 * file is preserved; only a matching published inode can lose its extra link. */
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
async function recoverPublishedLink(path: string, operationId: string) {
  const metadata = await lstat(path);
  if (metadata.nlink === 1) return;
  scannerAssert(metadata.nlink === 2);
  const prefix = `.${basename(path)}.${operationId}.`;
  const candidates = (await readdir(dirname(path))).filter(
    (name) => name.startsWith(prefix) && pendingName.test(name),
  );
  let matching: string | undefined;
  for (const name of candidates) {
    const candidate = join(dirname(path), name),
      other = await lstat(candidate);
    if (other.dev === metadata.dev && other.ino === metadata.ino && other.nlink === 2) {
      scannerAssert(
        !matching &&
          other.isFile() &&
          other.uid === process.getuid?.() &&
          (other.mode & 0o7777) === 0o600,
      );
      matching = candidate;
    }
  }
  scannerAssert(matching);
  await unlink(matching);
  await sync(dirname(path));
}
async function ensureDerivedFile(path: string, value: string, journal: SetupReceipt) {
  if (!(await exists(path))) await save(path, value, journal.operationId);
  const bytes = await readProtectedFile(path, 16384);
  try {
    scannerAssert(scannerDigest(bytes) === scannerDigest(value));
    await recoverPublishedLink(path, journal.operationId);
  } finally {
    bytes.fill(0);
  }
}
const json = (value: unknown) => JSON.stringify(value, null, 2) + '\n';
function referencesEqual(a: LocalScannerReferences, b: LocalScannerReferences) {
  scannerAssert(JSON.stringify(a) === JSON.stringify(b));
}
async function readJournal(path: string, prepared = true): Promise<SetupJournal> {
  // The hash/body is validated before a known publication's interrupted hard link
  // is reconciled. Arbitrary additional links remain forbidden at runtime.
  const raw = await readProtectedFile(path, 16384);
  try {
    const value = scannerObject(strictJson(utf8(raw)), [
      'schema',
      'operationId',
      'instanceId',
      'systemIdentifier',
      'bootstrapSha256',
      'configSha256',
      'databaseSha256',
      'login',
      ...(prepared ? ['configuration', 'database'] : []),
    ]);
    scannerAssert(
      value.schema === 1 &&
        value.login === INSPECTOR_LOGIN &&
        typeof value.operationId === 'string' &&
        /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value.operationId),
    );
    for (const name of ['bootstrapSha256', 'configSha256', 'databaseSha256'])
      scannerAssert(typeof value[name] === 'string' && /^[a-f0-9]{64}$/.test(value[name]));
    if (prepared) {
      scannerAssert(
        typeof value.database === 'string' &&
          value.database.length < 8192 &&
          scannerDigest(value.database) === value.databaseSha256,
      );
      scannerAssert(scannerDigest(json(value.configuration)) === value.configSha256);
    }
    return value as unknown as SetupJournal;
  } finally {
    raw.fill(0);
  }
}
function publicationReceipt(journal: SetupJournal): SetupReceipt {
  const { configuration: _configuration, database: _database, ...receipt } = journal;
  return receipt;
}

/** Additive operator setup. It does not start an inspector or rewrite original Canvas files. */
export async function setupLocalScanner(
  input: LocalScannerSetupOptions,
): Promise<{ configPath: string; changed: boolean; reconciled: boolean }> {
  try {
    const saved = await readCanvasLocalInstallation(input.canvasRoot);
    const root = saved.rootDirectory,
      sidecar = join(root, 'scanner'),
      configPath = join(sidecar, 'inspector.json');
    await checkDedicatedDirectory(sidecar);
    try {
      await mkdir(sidecar, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    await checkDedicatedDirectory(sidecar);
    await sync(root);
    const binding = await readScannerBinding(root);
    const expected: LocalScannerReferences = {
      schema: 1,
      canvasRoot: root,
      instanceId: saved.instanceId,
      systemIdentifier: saved.systemIdentifier,
      bootstrapSha256: binding.bootstrapSha256,
      databaseFile: join(sidecar, 'database.url'),
      databaseCaFile: binding.databaseCaFile,
      artifactDirectory: binding.artifactDirectory,
      wrappingKeyFile: binding.wrappingKeyFile,
      wrappingKeyId: binding.wrappingKeyId,
      parserImage: input.parserImage,
      antivirusImage: input.antivirusImage,
      definitionsDirectory: absolutePath(input.definitionsDirectory),
      docker: {
        executable: await realpath(absolutePath(input.dockerExecutable)),
        socketPath: await realpath(absolutePath(input.dockerSocketPath)),
        stateDirectory: join(sidecar, 'executor'),
      },
      uid: process.getuid!(),
      gid: process.getgid!(),
    };
    scannerReferences(expected, root);
    // Resolve all engine readiness before any database role mutation. This
    // executor never receives document bytes and closes its own admission lock.
    const definitions = await readScannerDefinitions(expected.definitionsDirectory);
    const executor = await createDockerScannerExecutor(expected.docker);
    try {
      const signal = AbortSignal.timeout(30000);
      await executor.ready(signal);
      await executor.checkSandbox(
        { kind: 'parser', imageId: expected.parserImage, uid: expected.uid, gid: expected.gid },
        signal,
      );
      await executor.checkSandbox(
        {
          kind: 'antivirus',
          imageId: expected.antivirusImage,
          uid: expected.uid,
          gid: expected.gid,
          definitionsDirectory: definitions.directory,
        },
        signal,
      );
    } finally {
      await executor.close();
    }
    return await withCanvasLocalMaintenance(root, async (context) => {
      context.signal.throwIfAborted();
      const currentBinding = await readScannerBinding(root);
      scannerAssert(
        currentBinding.bootstrapSha256 === binding.bootstrapSha256 &&
          context.receipt.instanceId === expected.instanceId &&
          context.receipt.systemIdentifier === expected.systemIdentifier,
      );
      const allowed = [
        'executor',
        'inspector.json',
        'database.url',
        'setup-journal.json',
        'installation.json',
      ];
      const sidecarEntries = await readdir(sidecar);
      scannerAssert(
        sidecarEntries.length <= 64 &&
          sidecarEntries.every((name) => allowed.includes(name) || pendingName.test(name)),
      );
      const journalPath = join(sidecar, 'setup-journal.json'),
        installedPath = join(sidecar, 'installation.json');
      const priorRole = async () =>
        (
          await context.client.query<{ marker: string | null }>(
            "SELECT shobj_description(oid,'pg_authid') AS marker FROM pg_roles WHERE rolname=$1",
            [INSPECTOR_LOGIN],
          )
        ).rows[0];
      let journal: SetupJournal;
      const hadJournal = await exists(journalPath),
        hadInstallation = await exists(installedPath);
      if (hadJournal) {
        journal = await readJournal(journalPath);
        scannerAssert(
          journal.instanceId === expected.instanceId &&
            journal.systemIdentifier === expected.systemIdentifier &&
            journal.bootstrapSha256 === expected.bootstrapSha256,
        );
        referencesEqual(scannerReferences(journal.configuration, root), expected);
        const url = new URL(journal.database.trim());
        scannerAssert(
          journal.database ===
            `postgresql://${INSPECTOR_LOGIN}:${url.password}@127.0.0.1:${saved.postgresPort}/margin_canvas\n` &&
            /^[A-Za-z0-9_-]{43}$/.test(url.password),
        );
        await recoverPublishedLink(journalPath, journal.operationId);
      } else {
        scannerAssert(
          !hadInstallation &&
            !(await exists(configPath)) &&
            !(await exists(expected.databaseFile)) &&
            !(await priorRole()),
        );
        const password = randomBytes(32).toString('base64url');
        const database = `postgresql://${INSPECTOR_LOGIN}:${password}@127.0.0.1:${saved.postgresPort}/margin_canvas\n`,
          configuration = json(expected);
        journal = {
          schema: 1,
          operationId: randomUUID(),
          instanceId: expected.instanceId,
          systemIdentifier: expected.systemIdentifier,
          bootstrapSha256: expected.bootstrapSha256,
          configSha256: scannerDigest(configuration),
          databaseSha256: scannerDigest(database),
          login: INSPECTOR_LOGIN,
          configuration: expected,
          database,
        };
        context.signal.throwIfAborted();
        await save(journalPath, json(journal), journal.operationId);
        context.signal.throwIfAborted();
      }
      context.signal.throwIfAborted();
      await ensureDerivedFile(expected.databaseFile, journal.database, journal);
      context.signal.throwIfAborted();
      await ensureDerivedFile(configPath, json(journal.configuration), journal);
      context.signal.throwIfAborted();
      const marker = `margin-local-scanner:${journal.instanceId}:${journal.operationId}`;
      let role = await priorRole();
      if (hadInstallation) scannerAssert(role?.marker === marker);
      let reconciled = hadJournal;
      if (role) {
        scannerAssert(role.marker === marker);
      } else {
        const database = await scannerRead(expected.databaseFile, 8192);
        let password: string;
        try {
          const url = new URL(utf8(database).trim());
          scannerAssert(
            url.username === INSPECTOR_LOGIN && /^[A-Za-z0-9_-]{43}$/.test(url.password),
          );
          password = url.password;
        } finally {
          database.fill(0);
        }
        let commitAttempted = false;
        try {
          await context.client.query('BEGIN');
          await context.client.query(
            "SET LOCAL lock_timeout='2s'; SET LOCAL statement_timeout='8s'; SET LOCAL idle_in_transaction_session_timeout='10s'; SET LOCAL synchronous_commit='on'; SET LOCAL log_statement='none'; SET LOCAL log_min_error_statement='panic'",
          );
          await context.client.query(
            `CREATE ROLE ${INSPECTOR_LOGIN} LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 6 PASSWORD '${password}'`,
          );
          await context.client.query(
            `COMMENT ON ROLE ${INSPECTOR_LOGIN} IS '${marker}'; GRANT margin_ingestion_inspector TO ${INSPECTOR_LOGIN}; GRANT CONNECT ON DATABASE margin_canvas TO ${INSPECTOR_LOGIN}; GRANT USAGE ON SCHEMA margin_local TO margin_ingestion_inspector; GRANT SELECT ON margin_local.installation,margin_local.migrations,margin_local.policy_contract TO margin_ingestion_inspector`,
          );
          commitAttempted = true;
          await context.client.query('COMMIT');
        } catch (error) {
          if (!commitAttempted) {
            await context.client.query('ROLLBACK').catch(() => {});
            throw error;
          }
          await context.reconnect();
          context.signal.throwIfAborted();
          role = await priorRole();
          scannerAssert(role?.marker === marker);
          reconciled = true;
        }
      }
      // Publish the final receipt only after the exact stored password logs in
      // over verified TLS and the dedicated role/schema contract passes.
      const databaseBytes = await scannerRead(expected.databaseFile, 8192),
        ca = await scannerRead(expected.databaseCaFile, 65536);
      try {
        const url = new URL(utf8(databaseBytes).trim());
        scannerAssert(
          url.username === INSPECTOR_LOGIN &&
            url.hostname === '127.0.0.1' &&
            url.port === String(saved.postgresPort) &&
            url.pathname === '/margin_canvas' &&
            /^[A-Za-z0-9_-]{43}$/.test(url.password) &&
            !url.search &&
            !url.hash,
        );
        await assertCanvasInspectorReady(
          {
            host: '127.0.0.1',
            port: saved.postgresPort,
            user: INSPECTOR_LOGIN,
            password: url.password,
            database: 'margin_canvas',
            ssl: { ca: utf8(ca), rejectUnauthorized: true },
            sslnegotiation: 'postgres',
            options: '-c search_path=pg_catalog',
            client_encoding: 'UTF8',
            connectionTimeoutMillis: 5000,
            application_name: 'margin-canvas-inspector-setup',
          },
          {
            instanceId: expected.instanceId,
            systemIdentifier: expected.systemIdentifier,
            signal: context.signal,
          },
        );
      } finally {
        databaseBytes.fill(0);
        ca.fill(0);
      }
      context.signal.throwIfAborted();
      if (!hadInstallation) {
        await save(installedPath, json(publicationReceipt(journal)), journal.operationId);
        context.signal.throwIfAborted();
        await sync(sidecar);
        context.signal.throwIfAborted();
      } else {
        const installed = await readJournal(installedPath, false);
        scannerAssert(JSON.stringify(installed) === JSON.stringify(publicationReceipt(journal)));
        await recoverPublishedLink(installedPath, journal.operationId);
      }
      const loaded = await loadLocalScannerConfig(configPath);
      loaded.dispose();
      context.signal.throwIfAborted();
      return { configPath, changed: !hadInstallation, reconciled: !hadInstallation && reconciled };
    });
  } catch (error) {
    if (error instanceof LocalScannerConfigurationError) throw error;
    throw new LocalScannerConfigurationError();
  }
}
