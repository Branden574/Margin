import { loadCanvasFeedbackDatabase } from './feedback-companion.js';
import { assertCanvasFeedbackReady } from './preflight.js';
import { execFile } from 'node:child_process';
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  randomBytes,
  randomUUID,
  X509Certificate,
} from 'node:crypto';
import { constants } from 'node:fs';
import { link, lstat, mkdir, open, readdir, rename, unlink } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { checkServerIdentity } from 'node:tls';
import { promisify } from 'node:util';
import { Client, type ClientConfig, type PoolConfig } from 'pg';
import {
  CANVAS_DATABASE_ROLES,
  canvasCertificateOwnership as owned,
  type CanvasBootstrapReceipt,
} from './bootstrap.js';
import { CANVAS_CERTIFICATE_MAINTENANCE_MARKER } from './certificate-barrier.js';
import { acquireCanvasMaintenance } from './maintenance.js';
import {
  absolutePath,
  checkDedicatedDirectory,
  readProtectedFile,
  utf8,
} from './protected-files.js';
import { assertCanvasDatabaseReady, assertCanvasInspectorReady } from './preflight.js';
import { strictJson } from '../strict-json.js';

const exec = promisify(execFile);
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const SHA = /^[a-f0-9]{64}$/;
const extensions =
  'basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=IP:127.0.0.1\n';
const digest = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
const json = (value: unknown) => JSON.stringify(value, null, 2) + '\n';
const metadata = [
  'scanner/inspector.json',
  'scanner/installation.json',
  'scanner/setup-journal.json',
  'scanner/database.url',
];
export class CanvasCertificateMaintenanceError extends Error {
  readonly name = 'CanvasCertificateMaintenanceError';
  constructor(
    readonly code: string,
    message = 'Local PostgreSQL certificate renewal is incomplete. Preserve the private renewal journal and retry only the same owned installation.',
  ) {
    super(message);
  }
}
function requireValue(value: unknown, code = 'renewal_invalid'): asserts value {
  if (!value) throw new CanvasCertificateMaintenanceError(code);
}
function object(value: unknown, keys: string[]) {
  requireValue(value && typeof value === 'object' && !Array.isArray(value));
  const record = value as Record<string, unknown>;
  requireValue(Object.keys(record).sort().join(',') === [...keys].sort().join(','));
  return record;
}
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
async function privateDirectory(path: string, create = false) {
  await checkDedicatedDirectory(path);
  if (create) {
    try {
      await mkdir(path, { mode: 0o700 });
      await sync(dirname(path));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  }
  const s = await lstat(path);
  requireValue(
    s.isDirectory() &&
      !s.isSymbolicLink() &&
      s.uid === process.getuid?.() &&
      (s.mode & 0o7777) === 0o700,
  );
}
async function read(path: string, max = 131072) {
  return readProtectedFile(path, max);
}
async function readJson(path: string) {
  const bytes = await read(path);
  try {
    return strictJson(utf8(bytes));
  } finally {
    bytes.fill(0);
  }
}
async function writeNew(path: string, bytes: string | Buffer) {
  const h = await open(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await h.writeFile(bytes);
    await h.sync();
  } finally {
    await h.close();
  }
  await sync(dirname(path));
}
async function publishNew(path: string, bytes: string) {
  const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.pending`);
  await writeNew(temporary, bytes);
  await link(temporary, path);
  await sync(dirname(path));
  await unlink(temporary);
  await sync(dirname(path));
}
async function removePublishedAlias(path: string) {
  const original = await lstat(path);
  if (original.nlink === 1) return;
  requireValue(original.nlink === 2);
  let matching: string | undefined;
  for (const name of await readdir(dirname(path))) {
    if (
      !name.startsWith(`.${basename(path)}.`) ||
      !name.endsWith('.pending') ||
      !UUID.test(name.slice(basename(path).length + 2, -8))
    )
      continue;
    const candidate = join(dirname(path), name),
      s = await lstat(candidate);
    if (s.dev === original.dev && s.ino === original.ino) {
      requireValue(s.isFile() && s.uid === process.getuid?.() && (s.mode & 0o7777) === 0o600);
      requireValue(!matching);
      matching = candidate;
    }
  }
  requireValue(matching);
  await unlink(matching);
  await sync(dirname(path));
}
async function command(name: string, args: string[]) {
  const result = await exec(name, args, {
    timeout: 30000,
    maxBuffer: 262144,
    env: { PATH: process.env.PATH, LANG: 'C', LC_ALL: 'C' },
  });
  return result.stdout;
}
interface PlannedFile {
  path: string;
  old: string;
  next: string;
  oldSha256: string;
  nextSha256: string;
}
interface Plan {
  schema: 1;
  operationId: string;
  rootDirectory: string;
  instanceId: string;
  systemIdentifier: string;
  wasRunning: boolean;
  createdAt: string;
  leafSha256: string;
  files: PlannedFile[];
}
interface Marker {
  schema: 1;
  operationId: string;
  rootDirectory: string;
  instanceId: string;
  journalSha256: string;
}
interface Owner extends Marker {
  sequence: number;
  pid: number;
}
interface Completion extends Marker {
  filesSha256: string;
  restoredRunning: boolean;
}
type Phase =
  | 'marker'
  | `published:${string}`
  | 'verified'
  | 'restored'
  | 'completion'
  | 'barrier-cleared';
export interface CanvasCertificateRenewalResult {
  changed: boolean;
  resumed: boolean;
  /** A marker-free completion only retires ownership; runtimes may already have resumed. */
  completedPreviously: boolean;
  wasRunning: boolean;
  expiresAt: string;
  operationId?: string;
}
const markerPath = (root: string) => join(root, CANVAS_CERTIFICATE_MAINTENANCE_MARKER);
const operationPath = (root: string, id: string) => join(root, 'certificate-renewals', id);
function markerValue(value: unknown): Marker {
  const r = object(value, [
    'schema',
    'operationId',
    'rootDirectory',
    'instanceId',
    'journalSha256',
  ]);
  requireValue(
    r.schema === 1 &&
      typeof r.operationId === 'string' &&
      UUID.test(r.operationId) &&
      typeof r.instanceId === 'string' &&
      UUID.test(r.instanceId) &&
      typeof r.journalSha256 === 'string' &&
      SHA.test(r.journalSha256),
  );
  absolutePath(r.rootDirectory);
  return r as unknown as Marker;
}
function decodeFile(value: unknown): PlannedFile {
  const f = object(value, ['path', 'old', 'next', 'oldSha256', 'nextSha256']);
  requireValue(
    typeof f.path === 'string' &&
      ['postgres-tls/server.pem', 'bootstrap.json', ...metadata].includes(f.path),
  );
  for (const name of ['old', 'next']) {
    requireValue(typeof f[name] === 'string' && f[name].length <= 90000);
    const bytes = Buffer.from(f[name], 'base64');
    try {
      requireValue(bytes.toString('base64') === f[name] && digest(bytes) === f[`${name}Sha256`]);
    } finally {
      bytes.fill(0);
    }
  }
  return f as unknown as PlannedFile;
}
function fileBytes(file: PlannedFile, which: 'old' | 'next') {
  return Buffer.from(file[which], 'base64');
}
function fileObject(file: PlannedFile, which: 'old' | 'next') {
  const b = fileBytes(file, which);
  try {
    return strictJson(utf8(b)) as Record<string, unknown>;
  } finally {
    b.fill(0);
  }
}
function bootstrapValue(value: unknown, root: string): CanvasBootstrapReceipt {
  const r = object(value, [
    'schema',
    'instanceId',
    'rootDirectory',
    'dataDirectory',
    'postgresPort',
    'configPath',
    'systemIdentifier',
    'files',
  ]);
  requireValue(
    r.schema === 1 &&
      r.rootDirectory === root &&
      r.dataDirectory === join(root, 'postgres') &&
      r.configPath === join(root, 'config.json') &&
      typeof r.instanceId === 'string' &&
      UUID.test(r.instanceId) &&
      typeof r.systemIdentifier === 'string' &&
      /^\d{1,20}$/.test(r.systemIdentifier) &&
      Number.isInteger(r.postgresPort) &&
      Number(r.postgresPort) >= 1024 &&
      Number(r.postgresPort) <= 65535,
  );
  requireValue(
    r.files &&
      typeof r.files === 'object' &&
      !Array.isArray(r.files) &&
      Object.keys(r.files).length <= 64,
  );
  for (const [path, sha] of Object.entries(r.files))
    requireValue(
      path &&
        !path.startsWith('/') &&
        !path.split('/').includes('..') &&
        typeof sha === 'string' &&
        SHA.test(sha),
    );
  return r as unknown as CanvasBootstrapReceipt;
}
async function loadPlan(marker: Marker) {
  const directory = operationPath(marker.rootDirectory, marker.operationId);
  await privateDirectory(join(marker.rootDirectory, 'certificate-renewals'));
  await privateDirectory(directory);
  const raw = await read(join(directory, 'journal.json'));
  try {
    requireValue(digest(raw) === marker.journalSha256);
    const p = object(strictJson(utf8(raw)), [
      'schema',
      'operationId',
      'rootDirectory',
      'instanceId',
      'systemIdentifier',
      'wasRunning',
      'createdAt',
      'leafSha256',
      'files',
    ]);
    requireValue(
      p.schema === 1 &&
        p.operationId === marker.operationId &&
        p.rootDirectory === marker.rootDirectory &&
        p.instanceId === marker.instanceId &&
        typeof p.systemIdentifier === 'string' &&
        /^\d{1,20}$/.test(p.systemIdentifier) &&
        typeof p.wasRunning === 'boolean' &&
        typeof p.createdAt === 'string' &&
        Number.isFinite(Date.parse(p.createdAt)) &&
        Array.isArray(p.files) &&
        p.files.length >= 2 &&
        p.files.length <= 6,
    );
    const files = p.files.map(decodeFile);
    requireValue(
      new Set(files.map((f) => f.path)).size === files.length &&
        files[0].path === 'postgres-tls/server.pem' &&
        files[1].path === 'bootstrap.json' &&
        p.leafSha256 === files[0].nextSha256,
    );
    const oldReceipt = bootstrapValue(fileObject(files[1], 'old'), marker.rootDirectory);
    const nextReceipt = bootstrapValue(fileObject(files[1], 'next'), marker.rootDirectory);
    requireValue(
      oldReceipt.instanceId === marker.instanceId &&
        oldReceipt.systemIdentifier === p.systemIdentifier &&
        oldReceipt.files['postgres-tls/server.pem'] === files[0].oldSha256,
    );
    requireValue(
      JSON.stringify(nextReceipt) ===
        JSON.stringify({
          ...oldReceipt,
          files: { ...oldReceipt.files, 'postgres-tls/server.pem': files[0].nextSha256 },
        }),
    );
    const plan = { ...p, files } as unknown as Plan;
    await validateCompanionPlan(plan);
    return { plan, oldReceipt, nextReceipt, directory };
  } finally {
    raw.fill(0);
  }
}
function planned(path: string, oldBytes: Buffer, nextBytes: Buffer): PlannedFile {
  return {
    path,
    old: oldBytes.toString('base64'),
    next: nextBytes.toString('base64'),
    oldSha256: digest(oldBytes),
    nextSha256: digest(nextBytes),
  };
}
async function companionFiles(
  root: string,
  oldBootstrap: string,
  nextBootstrap: string,
): Promise<PlannedFile[]> {
  const has = await Promise.all(metadata.map((path) => exists(join(root, path))));
  if (has.every((value) => !value)) return [];
  // Complete or journaled pending setup is owned; unjournaled partial sidecars require operator inspection.
  requireValue(has[2], 'companion_incomplete');
  const rawJournal = await read(join(root, metadata[2]));
  const journal = strictJson(utf8(rawJournal)) as Record<string, unknown>;
  requireValue(
    journal &&
      journal.schema === 1 &&
      journal.bootstrapSha256 === oldBootstrap &&
      typeof journal.database === 'string' &&
      journal.configuration &&
      typeof journal.configuration === 'object' &&
      typeof journal.operationId === 'string' &&
      UUID.test(journal.operationId),
  );
  const configuration = journal.configuration as Record<string, unknown>;
  requireValue(
    configuration.bootstrapSha256 === oldBootstrap &&
      journal.configSha256 === digest(json(configuration)) &&
      journal.databaseSha256 === digest(journal.database),
  );
  const nextConfiguration = { ...configuration, bootstrapSha256: nextBootstrap };
  const nextJournal = {
    ...journal,
    bootstrapSha256: nextBootstrap,
    configuration: nextConfiguration,
    configSha256: digest(json(nextConfiguration)),
  };
  const output: PlannedFile[] = [];
  try {
    for (let index = 0; index < metadata.length; index++) {
      if (!has[index]) continue;
      const path = metadata[index],
        oldBytes = await read(join(root, path));
      try {
        let nextBytes: Buffer;
        if (index === 0) {
          requireValue(digest(oldBytes) === journal.configSha256);
          nextBytes = Buffer.from(json(nextConfiguration));
        } else if (index === 1) {
          const installed = strictJson(utf8(oldBytes)) as Record<string, unknown>;
          const { configuration: _c, database: _d, ...receipt } = journal;
          requireValue(JSON.stringify(installed) === JSON.stringify(receipt));
          nextBytes = Buffer.from(
            json({
              ...installed,
              bootstrapSha256: nextBootstrap,
              configSha256: nextJournal.configSha256,
            }),
          );
        } else if (index === 2) nextBytes = Buffer.from(json(nextJournal));
        else {
          requireValue(digest(oldBytes) === journal.databaseSha256);
          nextBytes = Buffer.from(oldBytes);
        }
        output.push(planned(path, oldBytes, nextBytes));
        nextBytes.fill(0);
      } finally {
        oldBytes.fill(0);
      }
    }
    requireValue(!has[1] || has.every(Boolean), 'companion_incomplete');
    return output;
  } finally {
    rawJournal.fill(0);
  }
}
async function validateCompanionPlan(plan: Plan) {
  const files = plan.files.slice(2);
  if (!files.length) return;
  const journal = files.find((f) => f.path === metadata[2]);
  requireValue(journal);
  const oldJournal = fileObject(journal, 'old'),
    nextJournal = fileObject(journal, 'next');
  const oldConfig = oldJournal.configuration as Record<string, unknown>;
  requireValue(
    oldJournal.bootstrapSha256 === plan.files[1].oldSha256 &&
      oldConfig?.bootstrapSha256 === plan.files[1].oldSha256 &&
      oldJournal.configSha256 === digest(json(oldConfig)) &&
      typeof oldJournal.database === 'string' &&
      oldJournal.databaseSha256 === digest(oldJournal.database),
  );
  const nextConfig = { ...oldConfig, bootstrapSha256: plan.files[1].nextSha256 };
  const expectedJournal = {
    ...oldJournal,
    bootstrapSha256: plan.files[1].nextSha256,
    configuration: nextConfig,
    configSha256: digest(json(nextConfig)),
  };
  requireValue(JSON.stringify(nextJournal) === JSON.stringify(expectedJournal));
  for (const file of files) {
    if (file.path === metadata[0]) {
      requireValue(
        file.oldSha256 === oldJournal.configSha256 &&
          file.nextSha256 === expectedJournal.configSha256,
      );
    } else if (file.path === metadata[1]) {
      const { configuration: _c, database: _d, ...receipt } = oldJournal;
      requireValue(
        JSON.stringify(fileObject(file, 'old')) === JSON.stringify(receipt) &&
          JSON.stringify(fileObject(file, 'next')) ===
            JSON.stringify({
              ...receipt,
              bootstrapSha256: plan.files[1].nextSha256,
              configSha256: expectedJournal.configSha256,
            }),
      );
    } else if (file.path === metadata[3])
      requireValue(
        file.oldSha256 === oldJournal.databaseSha256 && file.nextSha256 === file.oldSha256,
      );
  }
}
async function validateFiles(plan: Plan, receipt: CanvasBootstrapReceipt, final = false) {
  // A sidecar created between planning and writer admission cannot be silently left stale.
  for (const path of metadata)
    requireValue(
      (await exists(join(plan.rootDirectory, path))) ===
        plan.files.some((file) => file.path === path),
      'companion_changed',
    );
  for (const [path, sha] of Object.entries(receipt.files)) {
    const bytes = await read(join(plan.rootDirectory, path));
    try {
      const file = plan.files.find((f) => f.path === path);
      requireValue(
        file
          ? digest(bytes) === file.nextSha256 || (!final && digest(bytes) === file.oldSha256)
          : digest(bytes) === sha,
        'protected_file_changed',
      );
    } finally {
      bytes.fill(0);
    }
  }
  for (const file of plan.files) {
    const bytes = await read(join(plan.rootDirectory, file.path));
    try {
      requireValue(
        digest(bytes) === file.nextSha256 || (!final && digest(bytes) === file.oldSha256),
        'renewal_file_changed',
      );
    } finally {
      bytes.fill(0);
    }
  }
}
async function control(receipt: CanvasBootstrapReceipt) {
  const out = await command('pg_controldata', ['-D', receipt.dataDirectory]);
  requireValue(
    out.match(/^Database system identifier:\s+(\d+)$/m)?.[1] === receipt.systemIdentifier,
    'cluster_identity',
  );
  return out.match(/^Database cluster state:\s+(.+)$/m)?.[1]?.trim();
}
async function certificates(root: string, leaf: Buffer, allowExpired: boolean) {
  const [caBytes, keyBytes, caKeyBytes, extBytes] = await Promise.all(
    ['ca.pem', 'server.key', 'ca.key', 'server.ext'].map((name) =>
      read(join(root, 'postgres-tls', name), 65536),
    ),
  );
  try {
    const ca = new X509Certificate(caBytes),
      cert = new X509Certificate(leaf),
      now = Date.now();
    requireValue(
      ca.ca &&
        ca.verify(ca.publicKey) &&
        ca.checkPrivateKey(createPrivateKey(caKeyBytes)) &&
        Date.parse(ca.validFrom) <= now &&
        Date.parse(ca.validTo) > now,
      'ca_invalid',
    );
    requireValue(
      !cert.ca &&
        cert.subjectAltName === 'IP Address:127.0.0.1' &&
        cert.checkIP('127.0.0.1') === '127.0.0.1' &&
        cert.keyUsage?.length === 1 &&
        cert.keyUsage[0] === '1.3.6.1.5.5.7.3.1' &&
        cert.checkPrivateKey(createPrivateKey(keyBytes)) &&
        cert.verify(ca.publicKey) &&
        cert.issuer === ca.subject &&
        Date.parse(cert.validFrom) <= now &&
        (allowExpired || Date.parse(cert.validTo) > now) &&
        Date.parse(cert.validTo) <= Date.parse(ca.validTo) &&
        utf8(extBytes) === extensions,
      'leaf_invalid',
    );
    return {
      expiresAt: new Date(cert.validTo).toISOString(),
      expired: Date.parse(cert.validTo) <= now,
      caExpires: Date.parse(ca.validTo),
    };
  } finally {
    caBytes.fill(0);
    keyBytes.fill(0);
    caKeyBytes.fill(0);
    extBytes.fill(0);
  }
}
async function verifyConnection(receipt: CanvasBootstrapReceipt, leaf: Buffer) {
  const config = await owned.configuration(receipt.rootDirectory),
    ssl = config.ssl;
  requireValue(ssl && typeof ssl === 'object' && ssl.rejectUnauthorized === true);
  const expected = new X509Certificate(leaf).raw;
  const client = new Client({
    ...config,
    ssl: {
      ...ssl,
      checkServerIdentity: (host, peer) =>
        checkServerIdentity(host, peer) ??
        (Buffer.isBuffer(peer.raw) && peer.raw.equals(expected)
          ? undefined
          : new Error('The PostgreSQL leaf differs from this renewal.')),
    },
  } as ClientConfig);
  const lost = new AbortController();
  const fail = () => lost.abort(new CanvasCertificateMaintenanceError('admission_lost'));
  client.on('error', fail);
  client.on('end', fail);
  const close = async () => {
    client.off('error', fail);
    client.off('end', fail);
    client.on('error', () => {});
    await client.end().catch(() => {});
    if (Buffer.isBuffer(ssl.ca)) ssl.ca.fill(0);
  };
  try {
    await client.connect();
    const version = await owned.verify(client, receipt);
    await acquireCanvasMaintenance(client);
    lost.signal.throwIfAborted();
    return { client, version, signal: lost.signal, close };
  } catch (error) {
    await close();
    throw error;
  }
}
async function runtimeReadiness(receipt: CanvasBootstrapReceipt, plan: Plan, version: number) {
  const raw = await read(receipt.configPath),
    ca = await read(join(receipt.rootDirectory, 'postgres-tls/ca.pem'));
  try {
    const refs = strictJson(utf8(raw)) as { databases: Record<string, string> };
    const database = (url: URL): PoolConfig => ({
      host: '127.0.0.1',
      port: receipt.postgresPort,
      user: url.username,
      password: url.password,
      database: 'margin_canvas',
      ssl: { ca: utf8(ca), rejectUnauthorized: true },
      sslnegotiation: 'postgres',
      options: '-c search_path=pg_catalog',
      client_encoding: 'UTF8',
      connectionTimeoutMillis: 5000,
    });
    const databases = {} as Record<keyof typeof CANVAS_DATABASE_ROLES, PoolConfig>;
    for (const name of Object.keys(CANVAS_DATABASE_ROLES) as Array<
      keyof typeof CANVAS_DATABASE_ROLES
    >) {
      requireValue(
        refs.databases[name] === join(receipt.rootDirectory, 'databases', name + '.url'),
      );
      const bytes = await read(refs.databases[name], 8192);
      try {
        const url = new URL(utf8(bytes).trim());
        requireValue(
          url.hostname === '127.0.0.1' &&
            url.port === String(receipt.postgresPort) &&
            url.protocol === 'postgresql:' &&
            url.pathname === '/margin_canvas' &&
            !url.search &&
            !url.hash,
        );
        databases[name] = database(url);
      } finally {
        bytes.fill(0);
      }
    }
    // Exact schema 012 installations can renew before using the separate supported upgrade.
    if (version >= 13) await assertCanvasDatabaseReady(databases);
    const feedback = await loadCanvasFeedbackDatabase(receipt.rootDirectory);
    if (feedback) await assertCanvasFeedbackReady(feedback, { instanceId: receipt.instanceId });
    if (plan.files.some((f) => f.path === 'scanner/installation.json')) {
      const bytes = await read(join(receipt.rootDirectory, 'scanner/database.url'), 8192);
      try {
        await assertCanvasInspectorReady(database(new URL(utf8(bytes).trim())), {
          instanceId: receipt.instanceId,
          systemIdentifier: receipt.systemIdentifier,
        });
      } finally {
        bytes.fill(0);
      }
    }
  } finally {
    raw.fill(0);
    ca.fill(0);
  }
}
async function latestOwner(root: string) {
  const lock = join(root, '.bootstrap-lock');
  await privateDirectory(lock);
  const inventory = await readdir(lock);
  requireValue(
    inventory.length <= 128 &&
      inventory.every(
        (name) =>
          /^renewal-owner-\d{4}\.json$/.test(name) ||
          /^\.renewal-owner-\d{4}\.json\.[a-f0-9-]{36}\.pending$/.test(name),
      ),
    'foreign_lock',
  );
  const names = inventory.filter((name) => /^renewal-owner-\d{4}\.json$/.test(name)).sort();
  requireValue(names.length > 0 && names.length <= 64, 'foreign_lock');
  const values: Owner[] = [];
  for (let index = 0; index < names.length; index++) {
    requireValue(
      names[index] === `renewal-owner-${String(index).padStart(4, '0')}.json`,
      'foreign_lock',
    );
    const v = object(await readJson(join(lock, names[index])), [
      'schema',
      'operationId',
      'rootDirectory',
      'instanceId',
      'journalSha256',
      'sequence',
      'pid',
    ]);
    const { sequence, pid, ...base } = v;
    const marker = markerValue(base);
    requireValue(
      marker.rootDirectory === root &&
        sequence === index &&
        Number.isSafeInteger(pid) &&
        Number(pid) > 1,
      'foreign_lock',
    );
    if (values.length)
      requireValue(JSON.stringify(marker) === JSON.stringify(ownerMarker(values[0])));
    values.push({ ...marker, sequence: index, pid: Number(pid) });
  }
  return values[values.length - 1];
}
function ownerMarker(owner: Owner): Marker {
  const { sequence: _s, pid: _p, ...marker } = owner;
  return marker;
}
function dead(pid: number) {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH';
  }
}
async function takeLock(marker: Marker) {
  const lock = join(marker.rootDirectory, '.bootstrap-lock');
  let sequence = 0;
  if (await exists(lock)) {
    const prior = await latestOwner(marker.rootDirectory);
    requireValue(
      JSON.stringify(ownerMarker(prior)) === JSON.stringify(marker) && dead(prior.pid),
      'owner_unavailable',
    );
    sequence = prior.sequence + 1;
    requireValue(sequence < 64, 'owner_limit');
  } else {
    await mkdir(lock, { mode: 0o700 });
    await sync(marker.rootDirectory);
  }
  const owner: Owner = { ...marker, sequence, pid: process.pid };
  await publishNew(
    join(lock, `renewal-owner-${String(sequence).padStart(4, '0')}.json`),
    json(owner),
  );
  await sync(lock);
  await sync(marker.rootDirectory);
  // Only the winning writer reconciles complete hard-link publications from an interrupted owner.
  for (let index = 0; index <= sequence; index++)
    await removePublishedAlias(join(lock, `renewal-owner-${String(index).padStart(4, '0')}.json`));
  // A lost O_EXCL attempt never reaches this point or performs target mutations.
  return async () => {
    const current = await latestOwner(marker.rootDirectory);
    requireValue(JSON.stringify(current) === JSON.stringify(owner), 'owner_changed');
    await rename(
      lock,
      join(
        operationPath(marker.rootDirectory, marker.operationId),
        `released-lock-${randomUUID()}`,
      ),
    );
    await sync(marker.rootDirectory);
    await sync(operationPath(marker.rootDirectory, marker.operationId));
  };
}
async function markerFor(root: string): Promise<Marker | undefined> {
  if (await exists(markerPath(root))) {
    const marker = markerValue(await readJson(markerPath(root)));
    requireValue(marker.rootDirectory === root);
    return marker;
  }
  if (await exists(join(root, '.bootstrap-lock'))) return ownerMarker(await latestOwner(root));
  return undefined;
}
function completionValue(marker: Marker, plan: Plan): Completion {
  return {
    ...marker,
    filesSha256: digest(json(plan.files.map((f) => [f.path, f.nextSha256]))),
    restoredRunning: plan.wasRunning,
  };
}
async function prepared(root: string) {
  const receipt = await owned.receipt(root),
    oldLeaf = await read(join(root, 'postgres-tls/server.pem'));
  try {
    const current = await certificates(root, oldLeaf, true),
      wasRunning = await owned.running(receipt.dataDirectory);
    if (wasRunning && current.expired)
      throw new CanvasCertificateMaintenanceError(
        'running_expired',
        'The owned database is running with an expired PostgreSQL leaf. Stop the API and scanner, then use a scoped pg_ctl smart shutdown for this installation’s saved dataDirectory. Retry renewal only after shutdown is confirmed; TLS verification remains enabled.',
      );
    await control(receipt);
    const operationId = randomUUID(),
      directory = operationPath(root, operationId);
    await privateDirectory(join(root, 'certificate-renewals'), true);
    await privateDirectory(directory, true);
    const csrPub = await command('openssl', [
      'req',
      '-in',
      join(root, 'postgres-tls/server.csr'),
      '-pubkey',
      '-noout',
    ]);
    const keyBytes = await read(join(root, 'postgres-tls/server.key'));
    try {
      requireValue(
        createPublicKey(csrPub)
          .export({ type: 'spki', format: 'der' })
          .equals(
            createPublicKey(createPrivateKey(keyBytes)).export({ type: 'spki', format: 'der' }),
          ),
      );
    } finally {
      keyBytes.fill(0);
    }
    requireValue(current.caExpires > Date.now() + 30 * 86400000, 'ca_near_expiry');
    const staged = join(directory, 'new-server.pem');
    await command('openssl', [
      'x509',
      '-req',
      '-in',
      join(root, 'postgres-tls/server.csr'),
      '-CA',
      join(root, 'postgres-tls/ca.pem'),
      '-CAkey',
      join(root, 'postgres-tls/ca.key'),
      '-set_serial',
      '0x' + randomBytes(16).toString('hex'),
      '-out',
      staged,
      '-days',
      '30',
      '-sha256',
      '-extfile',
      join(root, 'postgres-tls/server.ext'),
    ]);
    const h = await open(staged, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      await h.chmod(0o600);
      await h.sync();
    } finally {
      await h.close();
    }
    await sync(directory);
    const leaf = await read(staged),
      oldBootstrap = await read(join(root, 'bootstrap.json'));
    try {
      await certificates(root, leaf, false);
      const nextReceipt = {
          ...receipt,
          files: { ...receipt.files, 'postgres-tls/server.pem': digest(leaf) },
        },
        nextBootstrap = Buffer.from(json(nextReceipt));
      const files = [
        planned('postgres-tls/server.pem', oldLeaf, leaf),
        planned('bootstrap.json', oldBootstrap, nextBootstrap),
        ...(await companionFiles(root, digest(oldBootstrap), digest(nextBootstrap))),
      ];
      nextBootstrap.fill(0);
      const plan: Plan = {
        schema: 1,
        operationId,
        rootDirectory: root,
        instanceId: receipt.instanceId,
        systemIdentifier: receipt.systemIdentifier,
        wasRunning,
        createdAt: new Date().toISOString(),
        leafSha256: digest(leaf),
        files,
      };
      const body = json(plan);
      await writeNew(join(directory, 'journal.json'), body);
      const marker: Marker = {
        schema: 1,
        operationId,
        rootDirectory: root,
        instanceId: receipt.instanceId,
        journalSha256: digest(body),
      };
      return marker;
    } finally {
      leaf.fill(0);
      oldBootstrap.fill(0);
    }
  } finally {
    oldLeaf.fill(0);
  }
}

async function verifyAndRestore(
  plan: Plan,
  receipt: CanvasBootstrapReceipt,
  leaf: Buffer,
  afterPhase?: (phase: Phase) => Promise<void>,
) {
  if (!(await owned.running(receipt.dataDirectory)))
    requireValue((await control(receipt)) === 'shut down', 'cluster_not_stopped');
  await owned.start(receipt);
  const operator = await verifyConnection(receipt, leaf);
  try {
    await runtimeReadiness(receipt, plan, operator.version);
    operator.signal.throwIfAborted();
    await afterPhase?.('verified');
  } finally {
    await operator.close();
  }
  if (!plan.wasRunning) await owned.stop(receipt);
  requireValue((await owned.running(receipt.dataDirectory)) === plan.wasRunning, 'running_state');
  if (!plan.wasRunning) requireValue((await control(receipt)) === 'shut down');
  await afterPhase?.('restored');
}

/** Explicit CA/key-preserving PostgreSQL leaf renewal. Never adjusts browser/OS trust. */
export async function renewCanvasPostgresCertificate(
  rootDirectory: string,
  tests?: { afterPhase?: (phase: Phase) => Promise<void> },
): Promise<CanvasCertificateRenewalResult> {
  let release: (() => Promise<void>) | undefined;
  try {
    requireValue(!tests || process.env.NODE_ENV === 'test', 'test_hook_refused');
    const root = await owned.root(rootDirectory),
      prior = await markerFor(root),
      resumed = !!prior;
    const marker = prior ?? (await prepared(root));
    const { plan, oldReceipt, nextReceipt, directory } = await loadPlan(marker);
    release = await takeLock(marker);
    await validateFiles(plan, oldReceipt);
    const completePath = join(directory, 'verified-complete.json'),
      complete = completionValue(marker, plan);
    const newLeaf = fileBytes(plan.files[0], 'next');
    try {
      const validity = await certificates(root, newLeaf, false);
      if (await exists(completePath)) {
        requireValue(
          JSON.stringify(await readJson(completePath)) === JSON.stringify(complete),
          'completion_changed',
        );
        await validateFiles(plan, oldReceipt, true);
        await removePublishedAlias(completePath);
        const pending = await exists(markerPath(root));
        if (pending) {
          requireValue(
            JSON.stringify(markerValue(await readJson(markerPath(root)))) ===
              JSON.stringify(marker),
          );
          await removePublishedAlias(markerPath(root));
          await verifyAndRestore(plan, nextReceipt, newLeaf, tests?.afterPhase);
          await unlink(markerPath(root));
          await sync(root);
        }
        return {
          changed: false,
          resumed: true,
          completedPreviously: !pending,
          wasRunning: plan.wasRunning,
          expiresAt: validity.expiresAt,
          operationId: plan.operationId,
        };
      }
      if (!resumed)
        requireValue(
          (await owned.running(oldReceipt.dataDirectory)) === plan.wasRunning,
          'running_state_changed',
        );
      // A live server must authenticate before smart shutdown. Expired running leaves remain a refusal.
      let connection: Awaited<ReturnType<typeof verifyConnection>> | undefined;
      if (await owned.running(oldReceipt.dataDirectory)) {
        const current = await read(join(root, 'postgres-tls/server.pem'));
        try {
          await certificates(root, current, false);
          connection = await verifyConnection(oldReceipt, current);
        } finally {
          current.fill(0);
        }
      } else requireValue((await control(oldReceipt)) === 'shut down', 'cluster_not_stopped');
      try {
        if (!(await exists(markerPath(root)))) await publishNew(markerPath(root), json(marker));
        else
          requireValue(
            JSON.stringify(markerValue(await readJson(markerPath(root)))) ===
              JSON.stringify(marker),
          );
        await removePublishedAlias(markerPath(root));
        connection?.signal.throwIfAborted();
        await tests?.afterPhase?.('marker');
      } finally {
        await connection?.close();
      }
      if (await owned.running(oldReceipt.dataDirectory)) await owned.stop(oldReceipt);
      requireValue(
        !(await owned.running(oldReceipt.dataDirectory)) &&
          (await control(oldReceipt)) === 'shut down',
        'cluster_not_stopped',
      );
      for (const file of plan.files) {
        const path = join(root, file.path),
          bytes = await read(path);
        try {
          requireValue(
            digest(bytes) === file.oldSha256 || digest(bytes) === file.nextSha256,
            'renewal_file_changed',
          );
          if (digest(bytes) === file.nextSha256) continue;
        } finally {
          bytes.fill(0);
        }
        const temporary = join(
            dirname(path),
            `.renewal-${plan.operationId}-${randomUUID()}.pending`,
          ),
          next = fileBytes(file, 'next');
        try {
          await writeNew(temporary, next);
        } finally {
          next.fill(0);
        }
        await rename(temporary, path);
        await sync(dirname(path));
        await tests?.afterPhase?.(`published:${file.path}`);
      }
      await validateFiles(plan, oldReceipt, true);
      await verifyAndRestore(plan, nextReceipt, newLeaf, tests?.afterPhase);
      await validateFiles(plan, oldReceipt, true);
      await publishNew(completePath, json(complete));
      await tests?.afterPhase?.('completion');
      requireValue(
        JSON.stringify(markerValue(await readJson(markerPath(root)))) === JSON.stringify(marker),
      );
      await unlink(markerPath(root));
      await sync(root);
      await tests?.afterPhase?.('barrier-cleared');
      return {
        changed: true,
        resumed,
        completedPreviously: false,
        wasRunning: plan.wasRunning,
        expiresAt: validity.expiresAt,
        operationId: plan.operationId,
      };
    } finally {
      newLeaf.fill(0);
    }
  } catch (error) {
    if (error instanceof CanvasCertificateMaintenanceError) throw error;
    throw new CanvasCertificateMaintenanceError('renewal_failed');
  } finally {
    try {
      await release?.();
    } catch {
      throw new CanvasCertificateMaintenanceError('owner_release');
    }
  }
}
