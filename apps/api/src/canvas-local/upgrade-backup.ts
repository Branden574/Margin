import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants, createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, open } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ClientConfig } from 'pg';
import { checkDedicatedDirectory } from './protected-files.js';

const execute = promisify(execFile);
export interface CanvasUpgradeBackup {
  directory: string;
  archive: string;
  sha256: string;
  bytes: number;
}
async function syncDirectory(path: string) {
  const handle = await open(
    path,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
async function boundedDump(
  archive: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  maximum: number,
  timeoutMs: number,
) {
  const child = spawn('pg_dump', args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
  const stopped = new Promise<void>((resolve, reject) => {
    child.once('error', () => reject(new Error('Backup process could not start.')));
    child.once('close', (code) =>
      code === 0 ? resolve() : reject(new Error('Backup process failed.')),
    );
  });
  const cancellation = new AbortController();
  let force: NodeJS.Timeout | undefined;
  const terminate = () => {
    child.kill('SIGTERM');
    force ??= setTimeout(() => child.kill('SIGKILL'), 1000);
    force.unref();
  };
  // Cancellation must still terminate a process that closed stdout but has not exited.
  cancellation.signal.addEventListener('abort', terminate, { once: true });
  let bytes = 0,
    stderrBytes = 0;
  child.stderr.on('data', (chunk: Buffer) => {
    stderrBytes += chunk.length;
    if (stderrBytes > 65536) cancellation.abort();
  });
  const limiter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      bytes += chunk.length;
      if (bytes > maximum) callback(new Error('Backup exceeds its bounded size.'));
      else callback(null, chunk);
    },
  });
  const timer = setTimeout(() => cancellation.abort(), timeoutMs);
  timer.unref();
  const writing = pipeline(
    child.stdout,
    limiter,
    createWriteStream(archive, { flags: 'wx', mode: 0o600 }),
    { signal: cancellation.signal },
  );
  try {
    await Promise.all([writing, stopped]);
    cancellation.signal.throwIfAborted();
  } catch {
    cancellation.abort();
    // Child owns only stdout. Await both termination and the file pipeline before returning.
    await Promise.allSettled([writing, stopped]);
    throw new Error('Backup output could not be completed within its bounds.');
  } finally {
    clearTimeout(timer);
    if (force) clearTimeout(force);
    cancellation.signal.removeEventListener('abort', terminate);
  }
}

/** Private logical database recovery point. Existing keys, artifacts and configuration remain in their original root. */
export async function createCanvasUpgradeBackup(
  root: string,
  database: ClientConfig,
  identity: { instanceId: string; systemIdentifier: string; files: Record<string, string> },
  migrations: Array<{ position: number; name: string; sha256: string }>,
  tests?: { maximumArchiveBytes: number; timeoutMs?: number },
): Promise<CanvasUpgradeBackup> {
  if (
    tests &&
    (process.env.NODE_ENV !== 'test' ||
      !Number.isSafeInteger(tests.maximumArchiveBytes) ||
      tests.maximumArchiveBytes < 1 ||
      tests.maximumArchiveBytes > 2 * 1024 ** 3 ||
      (tests.timeoutMs !== undefined &&
        (!Number.isSafeInteger(tests.timeoutMs) || tests.timeoutMs < 1 || tests.timeoutMs > 60000)))
  )
    throw new Error('Backup test bounds require a disposable test environment.');
  const maximum = tests?.maximumArchiveBytes ?? 2 * 1024 ** 3;
  const parent = join(root, 'backups');
  await checkDedicatedDirectory(parent);
  try {
    await mkdir(parent, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  await checkDedicatedDirectory(parent);
  const from = migrations.length,
    to = from + 1;
  if (from !== 12 && from !== 13) throw new Error('Unsupported backup migration boundary.');
  const directory = await mkdtemp(join(parent, `before-${String(to).padStart(3, '0')}-`));
  await syncDirectory(parent);
  const archive = join(directory, 'database.dump');
  try {
    await boundedDump(
      archive,
      [
        '--host',
        '127.0.0.1',
        '--port',
        String(database.port),
        '--username',
        String(database.user),
        '--dbname',
        'margin_canvas',
        '--format',
        'custom',
        '--no-password',
        '--lock-wait-timeout=2s',
      ],
      {
        PATH: process.env.PATH,
        LANG: 'C',
        PGCLIENTENCODING: 'UTF8',
        PGPASSWORD: String(database.password),
        PGCONNECT_TIMEOUT: '5',
        PGSSLMODE: 'verify-full',
        PGSSLROOTCERT: join(root, 'postgres-tls/ca.pem'),
        PGSSLMINPROTOCOLVERSION: 'TLSv1.2',
        PGOPTIONS: '-c search_path=pg_catalog -c statement_timeout=30000',
        PGAPPNAME: 'margin-canvas-upgrade-backup',
      },
      maximum,
      tests?.timeoutMs ?? 60000,
    );
    const handle = await open(
      archive,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    let digest: string, bytes: number;
    try {
      const before = await handle.stat();
      if (
        !before.isFile() ||
        before.uid !== process.getuid?.() ||
        (before.mode & 0o7777) !== 0o600 ||
        before.size < 1 ||
        before.size > maximum
      )
        throw new Error();
      const hash = createHash('sha256'),
        buffer = Buffer.alloc(1024 * 1024);
      let offset = 0;
      try {
        while (offset < before.size) {
          const read = await handle.read(
            buffer,
            0,
            Math.min(buffer.length, before.size - offset),
            offset,
          );
          if (!read.bytesRead) throw new Error();
          hash.update(buffer.subarray(0, read.bytesRead));
          offset += read.bytesRead;
        }
      } finally {
        buffer.fill(0);
      }
      const after = await handle.stat();
      if (
        before.size !== after.size ||
        before.mtimeMs !== after.mtimeMs ||
        before.ctimeMs !== after.ctimeMs
      )
        throw new Error();
      await handle.sync();
      digest = hash.digest('hex');
      bytes = before.size;
    } finally {
      await handle.close();
    }
    // pg_restore recognizes and parses the archive before it becomes an accepted recovery point.
    await execute('pg_restore', ['--list', archive], {
      timeout: 10000,
      maxBuffer: 4 * 1024 * 1024,
    });
    const manifest = await open(join(directory, 'manifest.json'), 'wx', 0o600);
    try {
      await manifest.writeFile(
        JSON.stringify(
          {
            schema: 1,
            from,
            to,
            ...identity,
            migrations,
            archive: 'database.dump',
            sha256: digest,
            bytes,
            restore: `Restore with pg_restore into a separate verified-TLS PostgreSQL database using the retained original roles, then validate schema 001–${String(from).padStart(3, '0')} and its policy contract. Keep the original protected root, keys, credentials and encrypted artifacts. This archive does not copy artifact files or global PostgreSQL roles. Never automatically restore over the live database.`,
          },
          null,
          2,
        ) + '\n',
      );
      await manifest.sync();
    } finally {
      await manifest.close();
    }
    await syncDirectory(directory);
    await syncDirectory(root);
    return { directory, archive, sha256: digest, bytes };
  } catch {
    throw new Error(
      'The private Canvas database backup could not be verified. No migration was started; incomplete backup files were preserved.',
    );
  }
}
