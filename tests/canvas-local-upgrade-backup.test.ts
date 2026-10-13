import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChildProcess } from 'node:child_process';
import { mkdtemp, readdir, realpath, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const processes = vi.hoisted(() => ({ spawn: vi.fn(), execFile: vi.fn() }));
vi.mock('node:child_process', async (original) => {
  const actual = await original<typeof import('node:child_process')>();
  return { ...actual, spawn: processes.spawn, execFile: processes.execFile };
});
// The real child is a bounded local fixture; PostgreSQL is never contacted by these process tests.
const native = await vi.importActual<typeof import('node:child_process')>('node:child_process');
import { migrationManifest } from '../apps/api/src/canvas-local/bootstrap';
import { createCanvasUpgradeBackup } from '../apps/api/src/canvas-local/upgrade-backup';

describe('Canvas upgrade backup process cancellation', () => {
  let root: string, child: ChildProcess | undefined;
  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'margin-backup-process-')));
    processes.spawn.mockReset();
    processes.execFile.mockReset();
  });
  afterEach(async () => {
    if (child && child.exitCode === null && child.signalCode === null) {
      const stopped = new Promise<void>((resolve) => child!.once('close', () => resolve()));
      child.kill('SIGKILL');
      await stopped;
    }
    child = undefined;
    await rm(root, { recursive: true, force: true });
  });

  it.each(['ignore', 'exit-zero'] as const)(
    'bounds a child that closes stdout then stalls and %s on TERM',
    async (mode) => {
      let ready = false,
        stdoutClosed = false;
      processes.spawn.mockImplementation((_command, _args, options) => {
        child = native.spawn(
          process.execPath,
          [
            '-e',
            `
          process.on('SIGTERM', () => { ${mode === 'exit-zero' ? 'process.exit(0);' : ''} });
          process.stdout.end();
          process.stderr.write('ready');
          setInterval(() => {}, 1000);
        `,
          ],
          options,
        );
        child.stderr!.on('data', () => {
          ready = true;
        });
        child.stdout!.on('end', () => {
          stdoutClosed = true;
        });
        return child;
      });
      await expect(
        createCanvasUpgradeBackup(
          root,
          {},
          {
            instanceId: 'test',
            systemIdentifier: 'test',
            files: {},
          },
          await migrationManifest(12),
          { maximumArchiveBytes: 1024, timeoutMs: 1000 },
        ),
      ).rejects.toThrow('backup could not be verified');
      expect(ready).toBe(true);
      expect(stdoutClosed).toBe(true);
      expect(mode === 'exit-zero' ? child!.exitCode : child!.signalCode).toBe(
        mode === 'exit-zero' ? 0 : 'SIGKILL',
      );
      expect(processes.execFile).not.toHaveBeenCalled();
      const entries = await readdir(join(root, 'backups'));
      expect(entries).toHaveLength(1);
      await expect(stat(join(root, 'backups', entries[0], 'manifest.json'))).rejects.toMatchObject({
        code: 'ENOENT',
      });
    },
    7000,
  );
});
