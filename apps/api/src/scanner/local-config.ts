import { createHash, X509Certificate } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import type { PoolConfig } from 'pg';
import { strictJson } from '../strict-json.js';
import {
  absolutePath,
  checkDedicatedDirectory,
  readProtectedFile,
  utf8,
} from '../canvas-local/protected-files.js';
import type { CanvasBootstrapReceipt } from '../canvas-local/bootstrap.js';

export const INSPECTOR_LOGIN = 'margin_canvas_inspector';
export class LocalScannerConfigurationError extends Error {
  readonly name = 'LocalScannerConfigurationError';
  constructor() {
    super(
      'The private local scanner configuration is unavailable or inconsistent with its installation.',
    );
  }
}
export function scannerAssert(value: unknown): asserts value {
  if (!value) throw new LocalScannerConfigurationError();
}
export const scannerDigest = (value: Buffer | string) =>
  createHash('sha256').update(value).digest('hex');
const sha = /^[a-f0-9]{64}$/;
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
export function scannerObject(value: unknown, names: readonly string[]): Record<string, unknown> {
  scannerAssert(value && typeof value === 'object' && !Array.isArray(value));
  const record = value as Record<string, unknown>;
  scannerAssert(Object.keys(record).sort().join(',') === [...names].sort().join(','));
  return record;
}
export async function scannerRead(path: string, maximum = 16384): Promise<Buffer> {
  const bytes = await readProtectedFile(path, maximum);
  try {
    scannerAssert((await lstat(path)).nlink === 1);
    return bytes;
  } catch (error) {
    bytes.fill(0);
    throw error;
  }
}
export interface ScannerBinding {
  receipt: CanvasBootstrapReceipt;
  bootstrapSha256: string;
  artifactDirectory: string;
  databaseCaFile: string;
  wrappingKeyFile: string;
  wrappingKeyId: string;
}
/** Metadata and minimal references only: never reads the operator, API, session or signing secrets. */
export async function readScannerBinding(canvasRoot: string): Promise<ScannerBinding> {
  absolutePath(canvasRoot);
  await checkDedicatedDirectory(canvasRoot);
  const raw = await scannerRead(join(canvasRoot, 'bootstrap.json'), 65536);
  let receipt: CanvasBootstrapReceipt;
  const bootstrapSha256 = scannerDigest(raw);
  try {
    const value = scannerObject(strictJson(utf8(raw)), [
      'schema',
      'instanceId',
      'rootDirectory',
      'dataDirectory',
      'postgresPort',
      'configPath',
      'systemIdentifier',
      'files',
    ]);
    scannerAssert(
      value.schema === 1 &&
        value.rootDirectory === canvasRoot &&
        value.configPath === join(canvasRoot, 'config.json') &&
        typeof value.instanceId === 'string' &&
        uuid.test(value.instanceId) &&
        typeof value.systemIdentifier === 'string' &&
        /^[0-9]{1,24}$/.test(value.systemIdentifier),
    );
    scannerAssert(
      Number.isSafeInteger(value.postgresPort) &&
        (value.postgresPort as number) >= 1024 &&
        (value.postgresPort as number) <= 65535,
    );
    scannerAssert(value.files && typeof value.files === 'object' && !Array.isArray(value.files));
    for (const [name, digest] of Object.entries(value.files))
      scannerAssert(
        name &&
          !name.startsWith('/') &&
          !name.split('/').includes('..') &&
          typeof digest === 'string' &&
          sha.test(digest),
      );
    receipt = value as unknown as CanvasBootstrapReceipt;
  } finally {
    raw.fill(0);
  }
  const config = await scannerRead(receipt.configPath, 65536);
  try {
    scannerAssert(scannerDigest(config) === receipt.files['config.json']);
    const value = strictJson(utf8(config)) as Record<string, unknown>;
    scannerAssert(value.schema === 1 && value.secrets && typeof value.secrets === 'object');
    const artifactDirectory = absolutePath(value.artifactDirectory);
    const databaseCaFile = absolutePath(value.databaseCaFile);
    const wrappingKeyFile = absolutePath((value.secrets as Record<string, unknown>).wrapping);
    scannerAssert(
      artifactDirectory === join(canvasRoot, 'artifacts') &&
        databaseCaFile === join(canvasRoot, 'postgres-tls/ca.pem') &&
        wrappingKeyFile === join(canvasRoot, 'secrets/wrapping.key'),
    );
    scannerAssert(
      typeof value.wrappingKeyId === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(value.wrappingKeyId),
    );
    for (const path of [databaseCaFile, wrappingKeyFile])
      scannerAssert(sha.test(receipt.files[relative(canvasRoot, path).split(sep).join('/')] ?? ''));
    return {
      receipt,
      bootstrapSha256,
      artifactDirectory,
      databaseCaFile,
      wrappingKeyFile,
      wrappingKeyId: value.wrappingKeyId,
    };
  } finally {
    config.fill(0);
  }
}
export interface LocalScannerReferences {
  schema: 1;
  canvasRoot: string;
  instanceId: string;
  systemIdentifier: string;
  bootstrapSha256: string;
  databaseFile: string;
  databaseCaFile: string;
  artifactDirectory: string;
  wrappingKeyFile: string;
  wrappingKeyId: string;
  parserImage: string;
  antivirusImage: string;
  definitionsDirectory: string;
  docker: { executable: string; socketPath: string; stateDirectory: string };
  uid: number;
  gid: number;
}
export interface LocalScannerConfiguration
  extends Omit<LocalScannerReferences, 'databaseFile' | 'databaseCaFile' | 'wrappingKeyFile'> {
  database: PoolConfig;
  wrappingKey: Buffer;
}
export function scannerReferences(value: unknown, canvasRoot: string): LocalScannerReferences {
  const root = scannerObject(value, [
    'schema',
    'canvasRoot',
    'instanceId',
    'systemIdentifier',
    'bootstrapSha256',
    'databaseFile',
    'databaseCaFile',
    'artifactDirectory',
    'wrappingKeyFile',
    'wrappingKeyId',
    'parserImage',
    'antivirusImage',
    'definitionsDirectory',
    'docker',
    'uid',
    'gid',
  ]);
  const docker = scannerObject(root.docker, ['executable', 'socketPath', 'stateDirectory']);
  scannerAssert(
    root.schema === 1 &&
      root.canvasRoot === canvasRoot &&
      typeof root.instanceId === 'string' &&
      uuid.test(root.instanceId) &&
      typeof root.systemIdentifier === 'string' &&
      /^[0-9]{1,24}$/.test(root.systemIdentifier) &&
      typeof root.bootstrapSha256 === 'string' &&
      sha.test(root.bootstrapSha256),
  );
  for (const key of [
    'databaseFile',
    'databaseCaFile',
    'artifactDirectory',
    'wrappingKeyFile',
    'definitionsDirectory',
  ])
    absolutePath(root[key]);
  for (const key of ['executable', 'socketPath', 'stateDirectory']) absolutePath(docker[key]);
  scannerAssert(
    root.databaseFile === join(canvasRoot, 'scanner/database.url') &&
      docker.stateDirectory === join(canvasRoot, 'scanner/executor'),
  );
  scannerAssert(
    typeof root.parserImage === 'string' &&
      /^sha256:[a-f0-9]{64}$/.test(root.parserImage) &&
      typeof root.antivirusImage === 'string' &&
      /^sha256:[a-f0-9]{64}$/.test(root.antivirusImage),
  );
  scannerAssert(
    root.uid === process.getuid?.() &&
      Number.isSafeInteger(root.uid) &&
      (root.uid as number) > 0 &&
      root.gid === process.getgid?.() &&
      Number.isSafeInteger(root.gid) &&
      (root.gid as number) > 0,
  );
  return root as unknown as LocalScannerReferences;
}
export async function loadLocalScannerConfig(
  configPath: string,
): Promise<{ configuration: LocalScannerConfiguration; dispose(): void }> {
  const retained: Buffer[] = [];
  const dispose = () => retained.forEach((bytes) => bytes.fill(0));
  try {
    scannerAssert(
      process.env.NODE_ENV !== 'production' &&
        process.env.NODE_TLS_REJECT_UNAUTHORIZED !== '0' &&
        !process.env.PGREPLICATION &&
        !process.env.PGBINARY,
    );
    absolutePath(configPath);
    const sidecar = dirname(configPath),
      canvasRoot = dirname(sidecar);
    scannerAssert(configPath === join(canvasRoot, 'scanner/inspector.json'));
    await checkDedicatedDirectory(sidecar);
    const binding = await readScannerBinding(canvasRoot);
    const raw = await scannerRead(configPath);
    retained.push(raw);
    const refs = scannerReferences(strictJson(utf8(raw)), canvasRoot);
    scannerAssert(
      refs.instanceId === binding.receipt.instanceId &&
        refs.systemIdentifier === binding.receipt.systemIdentifier &&
        refs.bootstrapSha256 === binding.bootstrapSha256 &&
        refs.wrappingKeyId === binding.wrappingKeyId &&
        refs.artifactDirectory === binding.artifactDirectory &&
        refs.wrappingKeyFile === binding.wrappingKeyFile &&
        refs.databaseCaFile === binding.databaseCaFile,
    );
    const installedRaw = await scannerRead(join(sidecar, 'installation.json'));
    retained.push(installedRaw);
    const installed = scannerObject(strictJson(utf8(installedRaw)), [
      'schema',
      'operationId',
      'instanceId',
      'systemIdentifier',
      'bootstrapSha256',
      'configSha256',
      'databaseSha256',
      'login',
    ]);
    scannerAssert(
      installed.schema === 1 &&
        typeof installed.operationId === 'string' &&
        uuid.test(installed.operationId) &&
        installed.instanceId === refs.instanceId &&
        installed.systemIdentifier === refs.systemIdentifier &&
        installed.bootstrapSha256 === binding.bootstrapSha256 &&
        installed.configSha256 === scannerDigest(raw) &&
        installed.login === INSPECTOR_LOGIN &&
        typeof installed.databaseSha256 === 'string' &&
        sha.test(installed.databaseSha256),
    );
    const urlBytes = await scannerRead(refs.databaseFile, 8192);
    retained.push(urlBytes);
    scannerAssert(scannerDigest(urlBytes) === installed.databaseSha256);
    const text = utf8(urlBytes).replace(/\r?\n$/, '');
    const url = new URL(text);
    scannerAssert(
      url.href === text &&
        url.protocol === 'postgresql:' &&
        url.hostname === '127.0.0.1' &&
        url.port === String(binding.receipt.postgresPort) &&
        url.pathname === '/margin_canvas' &&
        url.username === INSPECTOR_LOGIN &&
        /^[A-Za-z0-9_-]{43}$/.test(url.password) &&
        !url.search &&
        !url.hash,
    );
    const ca = await scannerRead(refs.databaseCaFile, 65536);
    retained.push(ca);
    scannerAssert(scannerDigest(ca) === binding.receipt.files['postgres-tls/ca.pem']);
    const certificate = new X509Certificate(ca);
    scannerAssert(
      certificate.ca &&
        Date.parse(certificate.validFrom) <= Date.now() &&
        Date.parse(certificate.validTo) > Date.now(),
    );
    const keyFile = await scannerRead(refs.wrappingKeyFile, 8192);
    retained.push(keyFile);
    scannerAssert(scannerDigest(keyFile) === binding.receipt.files['secrets/wrapping.key']);
    const encoded = utf8(keyFile).replace(/\r?\n$/, '');
    const wrappingKey = Buffer.from(encoded, 'base64');
    retained.push(wrappingKey);
    scannerAssert(wrappingKey.length === 32 && wrappingKey.toString('base64') === encoded);
    await checkDedicatedDirectory(refs.artifactDirectory);
    await checkDedicatedDirectory(refs.docker.stateDirectory);
    const database: PoolConfig = {
      host: '127.0.0.1',
      port: binding.receipt.postgresPort,
      user: INSPECTOR_LOGIN,
      password: url.password,
      database: 'margin_canvas',
      ssl: { ca: utf8(ca), rejectUnauthorized: true },
      sslnegotiation: 'postgres',
      options: '-c search_path=pg_catalog',
      client_encoding: 'UTF8',
      connectionTimeoutMillis: 5000,
      application_name: 'margin-canvas-inspector',
    };
    const { databaseFile: _, databaseCaFile: __, wrappingKeyFile: ___, ...rest } = refs;
    for (const bytes of retained) if (bytes !== wrappingKey) bytes.fill(0);
    return { configuration: { ...rest, database, wrappingKey }, dispose };
  } catch {
    dispose();
    throw new LocalScannerConfigurationError();
  }
}
