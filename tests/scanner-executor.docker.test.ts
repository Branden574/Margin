import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import {
  createDockerScannerExecutor,
  type DockerScannerExecutor,
} from '../apps/api/src/scanner/docker';
import {
  containerId,
  scannerCreateArgs,
  verifyScannerOwnership,
  type ScannerSandbox,
} from '../apps/api/src/scanner/policy';
import { scannerCommand } from '../apps/api/src/scanner/process';
import { checkDedicatedDirectory } from '../apps/api/src/canvas-local/protected-files';

const executable = process.env.MARGIN_SCANNER_DOCKER_BIN;
const socketPath = process.env.MARGIN_SCANNER_DOCKER_SOCKET;
const imageId = process.env.MARGIN_SCANNER_EXECUTOR_IMAGE;
it.skipIf(!executable || !socketPath || !imageId)(
  'removes a real owned Docker container that was created but never started',
  async () => {
    const parent = resolve('.local/scanner-executor-test');
    await checkDedicatedDirectory(parent);
    try {
      await mkdir(parent, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    await checkDedicatedDirectory(parent);
    const root = await realpath(await mkdtemp(join(parent, 'case-')));
    const state = join(root, 'state'),
      definitions = join(root, 'definitions');
    await mkdir(state, { mode: 0o700 });
    await mkdir(definitions, { mode: 0o700 });
    const sandbox: ScannerSandbox = {
      kind: 'antivirus',
      imageId: imageId!,
      uid: 65532,
      gid: 65532,
      definitionsDirectory: definitions,
    };
    const endpoint = await realpath(socketPath!);
    const identity = { name: 'margin-inspection-' + randomUUID(), owner: randomUUID() };
    const journal = { schema: 1, ...identity, endpoint, sandbox, phase: 'prepared' };
    const journalPath = join(state, identity.name + '.jsonl');
    let executor: DockerScannerExecutor | undefined;
    const docker = (args: string[]) =>
      scannerCommand(executable!, ['--host', 'unix://' + endpoint, ...args]);
    try {
      await writeFile(journalPath, JSON.stringify(journal) + '\n', {
        mode: 0o600,
        flag: 'wx',
        flush: true,
      });
      await appendFile(journalPath, JSON.stringify({ ...journal, phase: 'creating' }) + '\n', {
        flush: true,
      });
      const created = await docker(scannerCreateArgs(sandbox, identity));
      let id: string;
      try {
        id = created.stdout.toString('utf8').trim();
        expect(created.exitCode).toBe(0);
        expect(containerId.test(id)).toBe(true);
      } finally {
        created.stdout.fill(0);
      }
      await appendFile(
        journalPath,
        JSON.stringify({ ...journal, phase: 'identified', id }) + '\n',
        { flush: true },
      );
      const inspected = await docker(['container', 'inspect', id]);
      try {
        expect(inspected.exitCode).toBe(0);
        const value = JSON.parse(inspected.stdout.toString('utf8'));
        expect(verifyScannerOwnership(value, sandbox, { ...identity, id }).running).toBe(false);
        expect(value[0].State.Status).toBe('created');
      } finally {
        inspected.stdout.fill(0);
      }
      executor = await createDockerScannerExecutor({
        executable: executable!,
        socketPath: endpoint,
        stateDirectory: state,
      });
      await executor.ready(new AbortController().signal);
      expect(executor.status().pendingCleanup).toBe(0);
      const remaining = await docker([
        'container',
        'ls',
        '--all',
        '--no-trunc',
        '--filter',
        'id=' + id,
        '--format',
        '{{.ID}}',
      ]);
      try {
        expect(remaining.exitCode).toBe(0);
        expect(remaining.stdout.toString().trim()).toBe('');
      } finally {
        remaining.stdout.fill(0);
      }
    } finally {
      // The fixture owns only this random label/name. If cleanup cannot be confirmed, keep its
      // journal and private state for explicit recovery; never erase the only ownership evidence.
      executor ??= await createDockerScannerExecutor({
        executable: executable!,
        socketPath: endpoint,
        stateDirectory: state,
      });
      await executor.close();
      await rm(root, { recursive: true });
    }
  },
  60000,
);
