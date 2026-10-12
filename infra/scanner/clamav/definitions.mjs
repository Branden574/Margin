import { constants } from 'node:fs';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';

export const CLAMAV_BASE_IMAGE =
  'clamav/clamav-debian@sha256:1b9f632fd2756d647ea76721c190f1a8821f3f1dc099b6b671e265d4346fcec4';
export const CLAMAV_VERSION = '1.4.6';
export const DEFINITION_NAMES = ['bytecode.cvd', 'daily.cvd', 'main.cvd'];
export const MAX_DEFINITION_BYTES = 512 * 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const DAY = 86_400_000;

export class ScannerDefinitionsError extends Error {
  constructor() {
    super('Scanner definitions are unavailable, stale, or failed private snapshot validation.');
    this.name = 'ScannerDefinitionsError';
  }
}
function insist(value) {
  if (!value) throw new ScannerDefinitionsError();
}
function owner() {
  const uid = process.getuid?.();
  insist(Number.isInteger(uid) && uid > 0);
  return uid;
}
function keys(value, expected) {
  insist(value && typeof value === 'object' && !Array.isArray(value));
  insist(Object.keys(value).sort().join(',') === [...expected].sort().join(','));
}
function iso(value) {
  insist(typeof value === 'string');
  const timestamp = Date.parse(value);
  insist(Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value);
  return timestamp;
}
function integer(value) {
  return Number.isSafeInteger(value) && value > 0;
}
function sameFile(before, after) {
  insist(
    before.dev === after.dev &&
      before.ino === after.ino &&
      before.size === after.size &&
      before.mtimeMs === after.mtimeMs &&
      before.ctimeMs === after.ctimeMs &&
      before.mode === after.mode &&
      before.uid === after.uid &&
      before.nlink === after.nlink,
  );
}
export async function privateDirectory(path, mode = 0o700) {
  insist((await realpath(path)) === resolve(path));
  const info = await lstat(path);
  insist(info.isDirectory() && info.uid === owner() && (info.mode & 0o777) === mode);
}
export async function readPrivateDefinitionFile(path, maxBytes, mode = 0o400) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await handle.stat();
    insist(
      before.isFile() &&
        before.uid === owner() &&
        before.nlink === 1 &&
        (before.mode & 0o777) === mode &&
        integer(before.size) &&
        before.size <= maxBytes,
    );
    const hash = createHash('sha256');
    const chunks = [];
    let length = 0;
    const buffer = Buffer.alloc(64 * 1024);
    const header = Buffer.alloc(Math.min(before.size, 512));
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      insist(length + bytesRead <= before.size);
      if (length < header.length)
        buffer.copy(header, length, 0, Math.min(bytesRead, header.length - length));
      hash.update(buffer.subarray(0, bytesRead));
      if (maxBytes <= 8192) chunks.push(Buffer.from(buffer.subarray(0, bytesRead)));
      length += bytesRead;
    }
    insist(length === before.size);
    sameFile(before, await handle.stat());
    sameFile(before, await lstat(path));
    return {
      bytes: length,
      sha256: hash.digest('hex'),
      header,
      text: maxBytes <= 8192 ? Buffer.concat(chunks).toString('utf8') : undefined,
    };
  } finally {
    await handle.close();
  }
}
export function cvdMetadata(header) {
  insist(Buffer.isBuffer(header) && header.length === 512);
  const values = header.toString('ascii').trim().split(':');
  insist(
    values.length === 9 &&
      values[0] === 'ClamAV-VDB' &&
      /^[1-9][0-9]*$/.test(values[2]) &&
      /^[1-9][0-9]*$/.test(values[3]) &&
      /^[0-9]+$/.test(values[4]) &&
      /^[a-f0-9]{32}$/.test(values[5]) &&
      /^[1-9][0-9]*$/.test(values[8]),
  );
  const version = Number(values[2]);
  const builtAt = new Date(Number(values[8]) * 1000).toISOString();
  insist(integer(version));
  return { version, builtAt };
}
function canonicalJson(text) {
  const parsed = JSON.parse(text);
  // Our publisher uses one encoding. This also refuses duplicate JSON keys.
  insist(JSON.stringify(parsed, null, 2) + '\n' === text);
  return parsed;
}
async function load(rootDirectory, now, fresh) {
  try {
    const root = resolve(rootDirectory);
    const timestamp = now.getTime();
    insist(Number.isFinite(timestamp));
    await privateDirectory(root);
    await privateDirectory(join(root, 'definitions'));
    const pointerFile = await readPrivateDefinitionFile(join(root, 'current.json'), 1024, 0o600);
    const pointer = canonicalJson(pointerFile.text);
    keys(pointer, ['schemaVersion', 'id', 'manifestSha256']);
    insist(
      pointer.schemaVersion === 1 && UUID.test(pointer.id) && SHA256.test(pointer.manifestSha256),
    );
    const directory = join(root, 'definitions', pointer.id);
    // Immutability is enforced by publication: updates create a new UUID and
    // never rewrite a published snapshot. The trusted owner can chmod files;
    // private directory permissions are not a cryptographic write barrier.
    await privateDirectory(directory);
    insist(
      (await readdir(directory)).sort().join(',') ===
        [...DEFINITION_NAMES, 'manifest.json'].sort().join(','),
    );
    const manifestFile = await readPrivateDefinitionFile(join(directory, 'manifest.json'), 8192);
    insist(manifestFile.sha256 === pointer.manifestSha256);
    const manifest = canonicalJson(manifestFile.text);
    keys(manifest, [
      'schemaVersion',
      'id',
      'engine',
      'engineVersion',
      'baseImage',
      'confirmedAt',
      'files',
    ]);
    insist(
      manifest.schemaVersion === 1 &&
        manifest.id === pointer.id &&
        manifest.engine === 'clamav' &&
        manifest.engineVersion === CLAMAV_VERSION &&
        manifest.baseImage === CLAMAV_BASE_IMAGE,
    );
    const confirmedAt = iso(manifest.confirmedAt);
    insist(confirmedAt <= timestamp && (!fresh || timestamp - confirmedAt <= DAY));
    insist(Array.isArray(manifest.files) && manifest.files.length === 3);
    let total = 0;
    for (let index = 0; index < DEFINITION_NAMES.length; index += 1) {
      const file = manifest.files[index];
      keys(file, ['name', 'bytes', 'sha256', 'version', 'builtAt']);
      insist(
        file.name === DEFINITION_NAMES[index] &&
          integer(file.bytes) &&
          file.bytes >= 512 &&
          file.bytes <= MAX_DEFINITION_BYTES &&
          SHA256.test(file.sha256) &&
          integer(file.version),
      );
      total += file.bytes;
      insist(total <= MAX_DEFINITION_BYTES);
      const builtAt = iso(file.builtAt);
      insist(builtAt <= confirmedAt);
      if (file.name === 'daily.cvd') insist(!fresh || timestamp - builtAt <= 2 * DAY);
      const actual = await readPrivateDefinitionFile(join(directory, file.name), file.bytes);
      const metadata = cvdMetadata(actual.header);
      insist(
        actual.bytes === file.bytes &&
          actual.sha256 === file.sha256 &&
          metadata.version === file.version &&
          metadata.builtAt === file.builtAt,
      );
    }
    return { directory, manifest, manifestSha256: manifestFile.sha256 };
  } catch {
    throw new ScannerDefinitionsError();
  }
}
export async function readScannerDefinitions(rootDirectory, { now = new Date() } = {}) {
  return load(rootDirectory, now, true);
}
// Updater-only reuse prevents a full download simply because the previous
// confirmation aged out. All ownership, inventory and content checks remain.
export async function readScannerDefinitionsForUpdate(rootDirectory, { now = new Date() } = {}) {
  return load(rootDirectory, now, false);
}
