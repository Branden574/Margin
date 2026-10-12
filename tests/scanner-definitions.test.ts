import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CLAMAV_BASE_IMAGE,
  DEFINITION_NAMES,
  readScannerDefinitions,
  readScannerDefinitionsForUpdate,
  type ScannerDefinitionsManifest,
} from '../infra/scanner/clamav/definitions.mjs';

const now = new Date('2026-10-11T12:00:00.000Z');
const DAY = 86_400_000;
let root: string;
let directory: string;
let manifest: ScannerDefinitionsManifest;
const hash = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
const json = (value: unknown) => JSON.stringify(value, null, 2) + '\n';

// These are metadata fixtures, not signed databases and never run in ClamAV.
// The runtime validates a snapshot previously verified by the real updater.
function cvd(version: number, builtAt: Date) {
  const header = `ClamAV-VDB:11 Oct 2026 12-00 +0000:${version}:1:90:${'0'.repeat(32)}:signature:builder:${Math.floor(builtAt.getTime() / 1000)}`;
  return Buffer.concat([Buffer.from(header.padEnd(512, ' ')), Buffer.from('fixture')]);
}
async function publishMetadata() {
  const text = json(manifest);
  await chmod(directory, 0o700);
  const path = join(directory, 'manifest.json');
  try {
    await chmod(path, 0o600);
  } catch {}
  await writeFile(path, text, { mode: 0o400 });
  await chmod(path, 0o400);
  await writeFile(
    join(root, 'current.json'),
    json({ schemaVersion: 1, id: manifest.id, manifestSha256: hash(text) }),
    { mode: 0o600 },
  );
  await chmod(directory, 0o700);
}
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'margin-definition-test-')));
  await chmod(root, 0o700);
  await mkdir(join(root, 'definitions'), { mode: 0o700 });
  const id = randomUUID();
  directory = join(root, 'definitions', id);
  await mkdir(directory, { mode: 0o700 });
  const files = [];
  for (const name of DEFINITION_NAMES) {
    const builtAt = new Date(now.getTime() - 60_000);
    const bytes = cvd(10, builtAt);
    await writeFile(join(directory, name), bytes, { mode: 0o400 });
    files.push({
      name,
      bytes: bytes.length,
      sha256: hash(bytes),
      version: 10,
      builtAt: builtAt.toISOString(),
    });
  }
  manifest = {
    schemaVersion: 1,
    id,
    engine: 'clamav',
    engineVersion: '1.4.6',
    baseImage: CLAMAV_BASE_IMAGE,
    confirmedAt: now.toISOString(),
    files,
  };
  await publishMetadata();
});
afterEach(async () => {
  await chmod(directory, 0o700).catch(() => {});
  await rm(root, { recursive: true, force: true });
});

describe('immutable ClamAV definition snapshot metadata', () => {
  it('reads exact private snapshot and CVD metadata with bounded file hashes', async () => {
    const result = await readScannerDefinitions(root, { now });
    expect(result.directory).toBe(directory);
    expect(result.manifest).toEqual(manifest);
    expect(result.manifestSha256).toBe(hash(json(manifest)));
  });
  it('expires confirmation after24hours while updater-only reuse preserves content validation', async () => {
    const later = new Date(now.getTime() + DAY + 1);
    await expect(readScannerDefinitions(root, { now: later })).rejects.toThrow('definitions');
    expect((await readScannerDefinitionsForUpdate(root, { now: later })).manifest.id).toBe(
      manifest.id,
    );
  });
  it('rejects a future confirmation', async () => {
    await expect(
      readScannerDefinitions(root, { now: new Date(now.getTime() - 1) }),
    ).rejects.toThrow();
  });
  it('rejects daily databases older than48hours even after a recent update confirmation', async () => {
    const file = manifest.files.find((entry) => entry.name === 'daily.cvd')!;
    const builtAt = new Date(now.getTime() - 2 * DAY - 1000);
    const bytes = cvd(file.version, builtAt);
    await chmod(join(directory, file.name), 0o600);
    await writeFile(join(directory, file.name), bytes);
    await chmod(join(directory, file.name), 0o400);
    Object.assign(file, {
      sha256: hash(bytes),
      bytes: bytes.length,
      builtAt: builtAt.toISOString(),
    });
    await publishMetadata();
    await expect(readScannerDefinitions(root, { now })).rejects.toThrow();
  });
  it('checks actual CVD version and date independently of a rewritten manifest hash', async () => {
    manifest.files[1].version += 1;
    await publishMetadata();
    await expect(readScannerDefinitions(root, { now })).rejects.toThrow();
    manifest.files[1].version -= 1;
    manifest.files[1].builtAt = new Date(now.getTime() - 30_000).toISOString();
    await publishMetadata();
    await expect(readScannerDefinitions(root, { now })).rejects.toThrow();
  });
  it('rejects altered bytes and manifest hash drift', async () => {
    const path = join(directory, 'daily.cvd');
    await chmod(path, 0o600);
    const bytes = await readFile(path);
    bytes[bytes.length - 1] ^= 1;
    await writeFile(path, bytes);
    await chmod(path, 0o400);
    await expect(readScannerDefinitions(root, { now })).rejects.toThrow();
  });
  it.each([0o600, 0o444])('rejects CVD mode %s rather than repairing permissions', async (mode) => {
    await chmod(join(directory, 'daily.cvd'), mode);
    await expect(readScannerDefinitions(root, { now })).rejects.toThrow();
  });
  it('rejects hard links and symlinked roots', async () => {
    await link(join(directory, 'daily.cvd'), join(root, 'alias.cvd'));
    await expect(readScannerDefinitions(root, { now })).rejects.toThrow();
    await symlink(root, join(root, 'root-link'));
    await expect(readScannerDefinitions(join(root, 'root-link'), { now })).rejects.toThrow();
  });
  it('rejects unexpected files and alternate base image identity', async () => {
    await chmod(directory, 0o700);
    await writeFile(join(directory, 'extra.ndb'), 'untrusted', { mode: 0o400 });
    await chmod(directory, 0o700);
    await expect(readScannerDefinitions(root, { now })).rejects.toThrow();
    await chmod(directory, 0o700);
    await rm(join(directory, 'extra.ndb'));
    manifest.baseImage = 'clamav/clamav-debian:latest';
    await publishMetadata();
    await expect(readScannerDefinitions(root, { now })).rejects.toThrow();
  });
  it('rejects duplicate JSON keys even when semantically equivalent', async () => {
    await writeFile(
      join(root, 'current.json'),
      `{"schemaVersion":1,"schemaVersion":1,"id":"${manifest.id}","manifestSha256":"${hash(json(manifest))}"}\n`,
    );
    await expect(readScannerDefinitions(root, { now })).rejects.toThrow();
  });
  it('rejects oversized metadata before reading a database', async () => {
    await chmod(join(directory, 'manifest.json'), 0o600);
    await writeFile(join(directory, 'manifest.json'), ' '.repeat(8193));
    await chmod(join(directory, 'manifest.json'), 0o400);
    await expect(readScannerDefinitions(root, { now })).rejects.toThrow();
  });
});
