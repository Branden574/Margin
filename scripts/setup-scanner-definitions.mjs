#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  open,
  readdir,
  rename,
  rmdir,
  statfs,
  unlink,
} from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CLAMAV_BASE_IMAGE,
  CLAMAV_VERSION,
  DEFINITION_NAMES,
  MAX_DEFINITION_BYTES,
  cvdMetadata,
  privateDirectory,
  readPrivateDefinitionFile,
  readScannerDefinitions,
  readScannerDefinitionsForUpdate,
} from '../infra/scanner/clamav/definitions.mjs';

class DefinitionsSetupError extends Error {}
function insist(value, message = 'The private definition update did not complete.') {
  if (!value) throw new DefinitionsSetupError(message);
}
const safeEnvironment = () => ({ PATH: process.env.PATH, HOME: process.env.HOME });
async function command(args, timeout = 30_000, signal) {
  signal?.throwIfAborted();
  const child = spawn('docker', args, {
    env: safeEnvironment(),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const chunks = [];
  let length = 0;
  let rejected = false;
  let escalation;
  const terminate = () => {
    rejected = true;
    child.kill('SIGTERM');
    escalation ??= setTimeout(() => child.kill('SIGKILL'), 1000);
  };
  const deadline = setTimeout(terminate, timeout);
  signal?.addEventListener('abort', terminate, { once: true });
  const collect = (chunk) => {
    length += chunk.length;
    if (length > 65536) terminate();
    else chunks.push(chunk);
  };
  child.stdout.on('data', collect);
  child.stderr.on('data', collect);
  try {
    const result = await new Promise((fulfill, reject) => {
      child.once('error', reject);
      child.once('close', (code) => fulfill(code));
    });
    signal?.throwIfAborted();
    insist(!rejected && result === 0);
    return Buffer.concat(chunks).toString('utf8');
  } finally {
    clearTimeout(deadline);
    clearTimeout(escalation);
    signal?.removeEventListener('abort', terminate);
  }
}
async function syncDirectory(path) {
  const handle = await open(path, constants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
async function save(path, value, mode) {
  const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, mode);
  try {
    await handle.writeFile(value);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await syncDirectory(dirname(path));
}
async function ensureDirectory(path) {
  try {
    await mkdir(path, { mode: 0o700 });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  await privateDirectory(path);
}
async function optionalSnapshot(rootDirectory, read) {
  try {
    return await read(rootDirectory);
  } catch {
    // Never silently adopt or replace a malformed pointer. An expired but
    // otherwise valid snapshot is handled only by the updater-specific reader.
    try {
      await lstat(join(rootDirectory, 'current.json'));
    } catch (error) {
      if (error.code === 'ENOENT') return undefined;
    }
    throw new DefinitionsSetupError(
      'Existing definitions failed validation; preserve them for operator review.',
    );
  }
}

/** Explicit operator operation. Importing this module never starts Docker. */
export async function setupScannerDefinitions({ rootDirectory, image, refresh = false }) {
  insist(/^sha256:[a-f0-9]{64}$/.test(image), 'Use the exact locally built scanner image ID.');
  const uid = process.getuid?.(),
    gid = process.getgid?.();
  insist(Number.isInteger(uid) && uid > 0 && Number.isInteger(gid) && gid >= 0);
  const root = resolve(rootDirectory);
  insist(!/[,\r\n]/.test(root));
  await ensureDirectory(root);
  await ensureDirectory(join(root, 'definitions'));
  const lock = join(root, '.update-lock');
  try {
    await mkdir(lock, { mode: 0o700 });
  } catch {
    throw new DefinitionsSetupError(
      'A definition update is already running or needs operator recovery.',
    );
  }
  let ownedContainer;
  let updateId;
  let journalCreated = false;
  let dockerHost;
  let cleanupConfirmed = true;
  const cancellation = new AbortController();
  const abort = () =>
    cancellation.abort(
      new DefinitionsSetupError('Definition update cancelled; existing snapshots were preserved.'),
    );
  process.on('SIGINT', abort);
  process.on('SIGTERM', abort);
  const cleanup = async () => {
    const details = JSON.parse(
      await command(['--host', dockerHost, 'inspect', '--format', '{{json .}}', ownedContainer]),
    );
    insist(
      details.Config?.Labels?.['io.margin.definitions-update'] === updateId &&
        details.Config?.Image === image &&
        details.Name === `/${ownedContainer}` &&
        /^[a-f0-9]{64}$/.test(details.Id),
    );
    await command(['--host', dockerHost, 'rm', '--force', details.Id]);
    const remaining = await command([
      '--host',
      dockerHost,
      'container',
      'ls',
      '--all',
      '--no-trunc',
      '--filter',
      `id=${details.Id}`,
      '--format',
      '{{.ID}}',
    ]);
    insist(remaining.trim() === '');
    cleanupConfirmed = true;
    ownedContainer = undefined;
  };
  try {
    const prior = await optionalSnapshot(root, readScannerDefinitionsForUpdate);
    if (!refresh && prior) {
      try {
        return { ...(await readScannerDefinitions(root)), changed: false };
      } catch {
        /* A previously verified snapshot can still seed an overdue update. */
      }
    }
    const capacity = await statfs(root);
    insist(
      capacity.bavail * capacity.bsize >= 2 * 1024 ** 3,
      'At least 2 GiB of available storage is required for a definition update.',
    );
    dockerHost = (
      await command(
        ['context', 'inspect', '--format', '{{.Endpoints.docker.Host}}'],
        30_000,
        cancellation.signal,
      )
    ).trim();
    insist(/^unix:\/\/\/[^\r\n]+$/.test(dockerHost), 'Use a local Unix-socket Docker context.');
    const docker = (args, timeout) =>
      command(['--host', dockerHost, ...args], timeout, cancellation.signal);
    const imageInfo = JSON.parse(
      await docker(['image', 'inspect', '--format', '{{json .}}', image]),
    );
    insist(
      imageInfo.Id === image && imageInfo.Architecture === 'arm64' && imageInfo.Os === 'linux',
    );
    insist(
      imageInfo.Config?.Labels?.['com.margin.inspection.protocol'] === 'margin-av-inspection-v1' &&
        imageInfo.Config?.Labels?.['com.margin.inspection.policy'] === 'clamav-1.4.6-policy-1' &&
        JSON.stringify(imageInfo.Config?.Entrypoint) === JSON.stringify(['/opt/margin/scan.sh']) &&
        (imageInfo.Config?.Cmd == null || imageInfo.Config.Cmd.length === 0) &&
        (imageInfo.Config?.Volumes == null || Object.keys(imageInfo.Config.Volumes).length === 0),
    );
    const id = randomUUID();
    updateId = id;
    const staging = join(root, `pending-${id}`);
    await mkdir(staging, { mode: 0o700 });
    if (prior) {
      for (const name of DEFINITION_NAMES) {
        await copyFile(join(prior.directory, name), join(staging, name), constants.COPYFILE_EXCL);
        await chmod(join(staging, name), 0o600);
      }
    }
    ownedContainer = `margin-definitions-${id}`;
    // Journal before dispatch. If create's acknowledgement is lost, an empty
    // immediate lookup cannot prove the daemon will not create it later. Keep
    // this lock/journal unless the exact labeled container is identified and
    // its removal acknowledged; recovery is an explicit operator operation.
    await save(
      join(lock, 'operation.json'),
      JSON.stringify(
        {
          schemaVersion: 1,
          id,
          containerName: ownedContainer,
          image,
          dockerHost,
          state: 'creating',
          createdAt: new Date().toISOString(),
        },
        null,
        2,
      ) + '\n',
      0o600,
    );
    journalCreated = true;
    cleanupConfirmed = false;
    const containerId = (
      await docker([
        'create',
        '--pull=never',
        '--name',
        ownedContainer,
        '--label',
        `io.margin.definitions-update=${id}`,
        '--network=bridge',
        '--read-only',
        '--user',
        `${uid}:${gid}`,
        '--memory=4g',
        '--memory-swap=4g',
        '--cpus=1',
        '--pids-limit=64',
        '--ulimit',
        'fsize=268435456:268435456',
        '--cap-drop=ALL',
        '--security-opt=no-new-privileges',
        '--log-driver=none',
        '--tmpfs',
        `/tmp:rw,noexec,nosuid,nodev,size=536870912,mode=700,uid=${uid},gid=${gid}`,
        '--mount',
        `type=bind,source=${staging},target=/definitions`,
        '--entrypoint=/opt/margin/update.sh',
        image,
      ])
    ).trim();
    insist(/^[a-f0-9]{64}$/.test(containerId));
    await docker(['start', '--attach', ownedContainer], 600_000);
    const state = JSON.parse(
      await docker(['inspect', '--format', '{{json .State}}', ownedContainer]),
    );
    insist(state.Running === false && state.ExitCode === 0 && state.OOMKilled === false);
    // Killing an attached docker CLI does not stop its container. Remove this
    // exact owned instance and wait for acknowledgement before publication.
    await cleanup();
    cancellation.signal.throwIfAborted();
    const inventory = await readdir(staging);
    insist(inventory.every((name) => [...DEFINITION_NAMES, 'freshclam.dat'].includes(name)));
    if (inventory.includes('freshclam.dat')) {
      const cache = await lstat(join(staging, 'freshclam.dat'));
      insist(cache.isFile() && cache.nlink === 1 && cache.uid === uid);
      await unlink(join(staging, 'freshclam.dat'));
    }
    insist((await readdir(staging)).sort().join(',') === DEFINITION_NAMES.join(','));
    const files = [];
    let total = 0;
    for (const name of DEFINITION_NAMES) {
      cancellation.signal.throwIfAborted();
      const path = join(staging, name);
      // FreshClam creates owner-private files; never repair a foreign/link entry.
      const info = await lstat(path);
      insist(info.isFile() && info.nlink === 1 && info.uid === uid && (info.mode & 0o077) === 0);
      await chmod(path, 0o400);
      const file = await readPrivateDefinitionFile(path, MAX_DEFINITION_BYTES);
      total += file.bytes;
      insist(total <= MAX_DEFINITION_BYTES);
      const metadata = cvdMetadata(file.header);
      files.push({ name, bytes: file.bytes, sha256: file.sha256, ...metadata });
      const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
    }
    const confirmedAt = new Date().toISOString();
    const now = Date.parse(confirmedAt);
    insist(files.every((file) => Date.parse(file.builtAt) <= now));
    insist(
      now - Date.parse(files.find((file) => file.name === 'daily.cvd').builtAt) <= 2 * 86_400_000,
    );
    const manifest = {
      schemaVersion: 1,
      id,
      engine: 'clamav',
      engineVersion: CLAMAV_VERSION,
      baseImage: CLAMAV_BASE_IMAGE,
      confirmedAt,
      files,
    };
    const manifestText = JSON.stringify(manifest, null, 2) + '\n';
    cancellation.signal.throwIfAborted();
    await save(join(staging, 'manifest.json'), manifestText, 0o400);
    const manifestSha256 = createHash('sha256').update(manifestText).digest('hex');
    await syncDirectory(staging);
    const published = join(root, 'definitions', id);
    // Keep the private directory writable for normal macOS rename semantics;
    // published files are0400 and this updater never rewrites a snapshot UUID.
    await rename(staging, published);
    await syncDirectory(published);
    await syncDirectory(join(root, 'definitions'));
    const pointer = join(root, `current-${id}.json`);
    await save(
      pointer,
      JSON.stringify({ schemaVersion: 1, id, manifestSha256 }, null, 2) + '\n',
      0o600,
    );
    cancellation.signal.throwIfAborted();
    // Publication is atomic. Previously published snapshots remain immutable.
    await rename(pointer, join(root, 'current.json'));
    await syncDirectory(root);
    return { ...(await readScannerDefinitions(root)), changed: true };
  } finally {
    if (ownedContainer && dockerHost) {
      try {
        await cleanup();
      } catch {
        /* Keep the lock if cleanup cannot be proved. Never touch other containers. */
      }
    }
    process.removeListener('SIGINT', abort);
    process.removeListener('SIGTERM', abort);
    if (cleanupConfirmed) {
      if (journalCreated) await unlink(join(lock, 'operation.json'));
      await rmdir(lock);
      await syncDirectory(root);
    }
  }
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    const args = process.argv.slice(2);
    if (args.includes('--help')) {
      process.stdout.write(
        'Usage: node scripts/setup-scanner-definitions.mjs --image sha256:<built-image-id> [--root PATH] [--refresh]\nReuses a fresh verified snapshot by default. --refresh explicitly checks official signed CVD updates. No documents or application secrets are mounted.\n',
      );
    } else {
      const options = new Map();
      let refresh = false;
      for (let index = 0; index < args.length; index += 1) {
        const name = args[index];
        if (name === '--refresh' && !refresh) {
          refresh = true;
          continue;
        }
        insist(['--root', '--image'].includes(name) && !options.has(name));
        const value = args[++index];
        insist(value && !value.startsWith('--'));
        options.set(name, value);
      }
      const repository = fileURLToPath(new URL('../', import.meta.url));
      if (!options.has('--root')) await ensureDirectory(join(repository, '.local'));
      const result = await setupScannerDefinitions({
        rootDirectory: options.get('--root') ?? join(repository, '.local/scanner'),
        image: options.get('--image'),
        refresh,
      });
      process.stdout.write(
        `Official signed ClamAV definitions ${result.changed ? 'updated' : 'verified and reused'}: ${result.manifest.id}\nConfirmed: ${result.manifest.confirmedAt}\nNo scanner worker has been activated.\n`,
      );
    }
  } catch (error) {
    // Native Docker/engine errors may contain paths or environment details.
    process.stderr.write(
      `Definition setup failed: ${error instanceof DefinitionsSetupError ? error.message : 'Private snapshot validation or Docker execution failed; existing snapshots are preserved.'}\n`,
    );
    process.exitCode = 1;
  }
}
