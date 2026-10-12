import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, realpath, rmdir, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import {
  absolutePath,
  checkDedicatedDirectory,
  readProtectedFile,
} from '../canvas-local/protected-files.js';
import {
  containerId,
  scannerCreateArgs,
  scannerName,
  scannerOwnerLabel,
  validateSandbox,
  verifyScannerContainer,
  verifyScannerOwnership,
  verifyScannerImage,
  type ScannerSandbox,
} from './policy.js';
import {
  scannerCommand,
  type ScannerCommandOptions,
  type ScannerCommandResult,
} from './process.js';

export interface DockerScannerOptions {
  executable: string;
  socketPath: string;
  stateDirectory: string;
}
export class ScannerExecutorError extends Error {
  readonly name = 'ScannerExecutorError';
  constructor(readonly code: 'unavailable' | 'busy' | 'closed' | 'cleanup_pending' | 'ownership') {
    super(
      code === 'cleanup_pending'
        ? 'Scanner cleanup is unconfirmed. Its private journal and execution lock were retained; restore the Docker daemon and retry reconciliation.'
        : 'The isolated scanner executor is unavailable or its ownership could not be verified.',
    );
  }
}
interface Journal {
  schema: 1;
  owner: string;
  name: string;
  endpoint: string;
  sandbox: ScannerSandbox;
  phase: 'prepared' | 'creating' | 'identified';
  id?: string;
}
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
function fail(code: ConstructorParameters<typeof ScannerExecutorError>[0] = 'unavailable'): never {
  throw new ScannerExecutorError(code);
}
function check(signal?: AbortSignal) {
  if (signal?.aborted) fail();
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
async function writePrivate(path: string, value: string, append = false) {
  const handle = await open(
    path,
    constants.O_WRONLY |
      constants.O_NOFOLLOW |
      (append ? constants.O_APPEND : constants.O_CREAT | constants.O_EXCL),
    0o600,
  );
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o7777) !== 0o600)
      fail('ownership');
    await handle.writeFile(value);
    await handle.sync();
  } finally {
    await handle.close();
  }
}
function snapshot(sandbox: ScannerSandbox): ScannerSandbox {
  validateSandbox(sandbox);
  if (
    Object.keys(sandbox).some(
      (key) => !['imageId', 'kind', 'uid', 'gid', 'definitionsDirectory'].includes(key),
    )
  )
    fail('ownership');
  return {
    imageId: sandbox.imageId,
    kind: sandbox.kind,
    uid: sandbox.uid,
    gid: sandbox.gid,
    ...(sandbox.definitionsDirectory !== undefined
      ? { definitionsDirectory: sandbox.definitionsDirectory }
      : {}),
  };
}
function decodeJournal(bytes: Buffer, filename: string, endpoint: string): Journal {
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    // Every published phase is newline-terminated and fsynced before its external action.
    // A final partial append cannot authorize a later action and is ignored conservatively.
    const lines = text.split('\n');
    const tail = lines.pop()!;
    if (tail.length > 4096 || !lines.length || lines.length > 3) throw new Error();
    let previous: Journal | undefined;
    for (const line of lines) {
      const value = JSON.parse(line) as Journal;
      if (
        JSON.stringify(value) !== line ||
        value.schema !== 1 ||
        !uuid.test(value.owner) ||
        !scannerName.test(value.name) ||
        value.name + '.jsonl' !== filename ||
        value.endpoint !== endpoint ||
        Object.keys(value).some(
          (key) => !['schema', 'owner', 'name', 'endpoint', 'sandbox', 'phase', 'id'].includes(key),
        )
      )
        throw new Error();
      value.sandbox = snapshot(value.sandbox);
      if (!previous) {
        if (value.phase !== 'prepared' || value.id !== undefined) throw new Error();
      } else {
        const expected = previous.phase === 'prepared' ? 'creating' : 'identified';
        if (
          previous.phase === 'identified' ||
          value.phase !== expected ||
          JSON.stringify({ ...previous, phase: undefined, id: undefined }) !==
            JSON.stringify({ ...value, phase: undefined, id: undefined })
        )
          throw new Error();
      }
      if (value.phase === 'identified' ? !containerId.test(value.id ?? '') : value.id !== undefined)
        throw new Error();
      previous = value;
    }
    return previous!;
  } catch {
    return fail('ownership');
  }
}

/** One executor owns one private lifetime lock. A stale lock is never guessed dead or removed automatically. */
export class DockerScannerExecutor {
  private readonly stopping = new AbortController();
  private readonly journals = new Map<string, Journal>();
  private active: Promise<unknown> | undefined;
  private closing: Promise<void> | undefined;
  private released = false;
  private architecture: string | undefined;
  private constructor(
    private readonly options: DockerScannerOptions,
    private readonly lockReceipt: string,
  ) {}

  static async create(input: DockerScannerOptions): Promise<DockerScannerExecutor> {
    absolutePath(input.executable);
    absolutePath(input.socketPath);
    absolutePath(input.stateDirectory);
    const executable = await realpath(input.executable),
      socketPath = await realpath(input.socketPath);
    const binary = await lstat(executable),
      socket = await lstat(socketPath);
    if (
      !binary.isFile() ||
      !(binary.mode & 0o111) ||
      binary.mode & 0o022 ||
      ![0, process.getuid?.()].includes(binary.uid) ||
      !socket.isSocket()
    )
      fail('ownership');
    const options = { executable, socketPath, stateDirectory: input.stateDirectory };
    await checkDedicatedDirectory(options.stateDirectory);
    try {
      await mkdir(options.stateDirectory, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    await checkDedicatedDirectory(options.stateDirectory);
    // The journal directory itself must remain reachable after a host crash. Sync its parent
    // even on retry: an earlier mkdir may have succeeded before its parent fsync failed.
    await syncDirectory(dirname(options.stateDirectory));
    const lock = join(options.stateDirectory, '.executor-lock');
    try {
      await mkdir(lock, { mode: 0o700 });
    } catch {
      return fail('busy');
    }
    const owner =
      JSON.stringify({ schema: 1, owner: randomUUID(), pid: process.pid, endpoint: socketPath }) +
      '\n';
    const executor = new DockerScannerExecutor(options, owner);
    try {
      await writePrivate(join(lock, 'owner.json'), owner);
      await syncDirectory(lock);
      await syncDirectory(options.stateDirectory);
      const filenames = await readdir(options.stateDirectory);
      if (filenames.length > 33) fail('ownership');
      for (const filename of filenames) {
        if (filename === '.executor-lock') continue;
        if (!/^margin-inspection-[a-f0-9-]{36}\.jsonl$/.test(filename)) fail('ownership');
        const raw = await readProtectedFile(join(options.stateDirectory, filename), 16384);
        try {
          executor.journals.set(filename, decodeJournal(raw, filename, socketPath));
        } finally {
          raw.fill(0);
        }
      }
      return executor;
    } catch (error) {
      await executor.releaseLock().catch(() => {});
      throw error;
    }
  }
  status() {
    return {
      busy: !!this.active,
      closed: this.stopping.signal.aborted,
      pendingCleanup: this.journals.size,
    };
  }
  private command(args: readonly string[], options: ScannerCommandOptions = {}) {
    return scannerCommand(
      this.options.executable,
      ['--host', 'unix://' + this.options.socketPath, ...args],
      options,
    );
  }
  private async json(args: readonly string[], signal?: AbortSignal): Promise<unknown> {
    const result = await this.command(args, { signal, maximumOutput: 1024 * 1024 });
    try {
      if (result.exitCode !== 0) fail();
      return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(result.stdout));
    } catch {
      return fail();
    } finally {
      result.stdout.fill(0);
    }
  }
  private admit<T>(work: (signal: AbortSignal) => Promise<T>, external?: AbortSignal): Promise<T> {
    if (this.stopping.signal.aborted) return Promise.reject(new ScannerExecutorError('closed'));
    if (this.active) return Promise.reject(new ScannerExecutorError('busy'));
    const signal = AbortSignal.any([this.stopping.signal, ...(external ? [external] : [])]);
    const task = Promise.resolve().then(() => {
      check(signal);
      return work(signal);
    });
    this.active = task;
    const release = () => {
      if (this.active === task) this.active = undefined;
    };
    void task.then(release, release);
    return task;
  }
  private async environment(signal: AbortSignal) {
    const daemon = (await this.json(['info', '--format', '{{json .}}'], signal)) as Record<
      string,
      unknown
    >;
    const architectures: Record<string, string> = {
      aarch64: 'arm64',
      arm64: 'arm64',
      x86_64: 'amd64',
      amd64: 'amd64',
    };
    const architecture = architectures[String(daemon.Architecture)];
    if (
      daemon.OSType !== 'linux' ||
      !architecture ||
      architecture !== (process.arch === 'x64' ? 'amd64' : process.arch) ||
      !Array.isArray(daemon.SecurityOptions) ||
      !daemon.SecurityOptions.includes('name=seccomp,profile=builtin')
    )
      fail();
    this.architecture = architecture;
  }
  async ready(signal: AbortSignal): Promise<void> {
    return this.admit(async (active) => {
      await this.reconcile();
      check(active);
      await this.environment(active);
    }, signal);
  }
  async checkSandbox(sandbox: ScannerSandbox, signal: AbortSignal): Promise<void> {
    const expected = snapshot(sandbox);
    return this.admit(async (active) => {
      await this.reconcile();
      check(active);
      await this.environment(active);
      verifyScannerImage(
        await this.json(['image', 'inspect', expected.imageId], active),
        expected,
        this.architecture!,
      );
    }, signal);
  }
  execute(
    sandbox: ScannerSandbox,
    bytes: Uint8Array,
    signal: AbortSignal,
  ): Promise<ScannerCommandResult> {
    const expected = snapshot(sandbox);
    if (
      !(bytes instanceof Uint8Array) ||
      bytes.byteLength < 1 ||
      bytes.byteLength > 100 * 1024 * 1024
    )
      return Promise.reject(new ScannerExecutorError('unavailable'));
    return this.admit(async (active) => {
      await this.reconcile();
      check(active);
      await this.environment(active);
      verifyScannerImage(
        await this.json(['image', 'inspect', expected.imageId], active),
        expected,
        this.architecture!,
      );
      check(active);
      let journal: Journal = {
        schema: 1,
        owner: randomUUID(),
        name: 'margin-inspection-' + randomUUID(),
        endpoint: this.options.socketPath,
        sandbox: expected,
        phase: 'prepared',
      };
      const filename = journal.name + '.jsonl';
      await writePrivate(
        join(this.options.stateDirectory, filename),
        JSON.stringify(journal) + '\n',
      );
      this.journals.set(filename, journal);
      await syncDirectory(this.options.stateDirectory);
      let output: Buffer | undefined;
      try {
        journal = await this.advance(journal, 'creating');
        check(active);
        const created = await this.command(scannerCreateArgs(expected, journal), {
          signal: active,
          maximumOutput: 4096,
        });
        let id: string;
        try {
          id = created.stdout.toString('utf8').trim();
          if (created.exitCode !== 0 || !containerId.test(id)) fail();
        } finally {
          created.stdout.fill(0);
        }
        journal = await this.advance(journal, 'identified', id!);
        check(active);
        const configured = verifyScannerContainer(
          await this.json(['container', 'inspect', id!], active),
          expected,
          journal,
        );
        if (configured.running || configured.oom || configured.error) fail();
        const result = await this.command(
          ['container', 'start', '--attach', '--interactive', id!],
          { signal: active, input: bytes, timeoutMs: 60000, maximumOutput: 262144 },
        );
        output = result.stdout;
        check(active);
        const state = verifyScannerContainer(
          await this.json(['container', 'inspect', id!], active),
          expected,
          journal,
        );
        if (state.running || state.oom || state.error || state.exitCode !== result.exitCode) fail();
        return { stdout: output, exitCode: state.exitCode };
      } catch (error) {
        output?.fill(0);
        throw error instanceof ScannerExecutorError
          ? error
          : new ScannerExecutorError('unavailable');
      } finally {
        try {
          await this.cleanup(this.journals.get(filename) ?? journal);
        } catch (error) {
          output?.fill(0);
          throw error;
        }
      }
    }, signal);
  }
  private async advance(journal: Journal, phase: Journal['phase'], id?: string) {
    const updated: Journal = { ...journal, phase, ...(id ? { id } : {}) };
    const path = join(this.options.stateDirectory, journal.name + '.jsonl');
    const raw = await readProtectedFile(path, 16384);
    try {
      if (
        JSON.stringify(decodeJournal(raw, journal.name + '.jsonl', this.options.socketPath)) !==
        JSON.stringify(journal)
      )
        fail('ownership');
      const last = raw.lastIndexOf(10) + 1;
      if (last !== raw.length) {
        const handle = await open(path, constants.O_WRONLY | constants.O_NOFOLLOW);
        try {
          await handle.truncate(last);
          await handle.sync();
        } finally {
          await handle.close();
        }
      }
    } finally {
      raw.fill(0);
    }
    await writePrivate(path, JSON.stringify(updated) + '\n', true);
    this.journals.set(journal.name + '.jsonl', updated);
    return updated;
  }
  private async inventory(filter: string): Promise<string[]> {
    const result = await this.command(
      ['container', 'ls', '--all', '--no-trunc', '--filter', filter, '--format', '{{.ID}}'],
      { maximumOutput: 4096 },
    );
    try {
      if (result.exitCode !== 0) fail();
      const text = result.stdout.toString('utf8').trim(),
        ids = text ? text.split('\n') : [];
      if (ids.length > 1 || ids.some((id) => !containerId.test(id))) fail('ownership');
      return ids;
    } finally {
      result.stdout.fill(0);
    }
  }
  private async cleanupOnce(journal: Journal): Promise<void> {
    if (journal.phase === 'prepared') return this.forget(journal);
    let id = journal.id;
    if (id) {
      const found = await this.inventory('id=' + id);
      if (!found.length) return this.forget(journal);
      if (found[0] !== id) fail('ownership');
    } else {
      const ids = new Set([
        ...(await this.inventory('name=^/' + journal.name + '$')),
        ...(await this.inventory('label=' + scannerOwnerLabel + '=' + journal.owner)),
      ]);
      // A lost create acknowledgement remains unresolved even when the daemon currently lists nothing.
      if (ids.size !== 1) fail('cleanup_pending');
      id = [...ids][0];
    }
    const owned = verifyScannerOwnership(
      await this.json(['container', 'inspect', id]),
      journal.sandbox,
      { ...journal, id },
    );
    if (!journal.id) journal = await this.advance(journal, 'identified', owned.id);
    if (owned.running) {
      const killed = await this.command(['container', 'kill', id], { maximumOutput: 4096 });
      killed.stdout.fill(0); // A concurrent natural exit can make kill fail; wait/inspect remain authoritative.
      const waited = await this.command(['container', 'wait', id], { maximumOutput: 4096 });
      try {
        if (waited.exitCode !== 0 || !/^\d+\s*$/.test(waited.stdout.toString('utf8'))) fail();
      } finally {
        waited.stdout.fill(0);
      }
    }
    // Waiting on a never-started container can block indefinitely. Removal of a verified
    // nonrunning ID plus authoritative absence is sufficient; a raced start makes rm fail.
    const stopped = verifyScannerOwnership(
      await this.json(['container', 'inspect', id]),
      journal.sandbox,
      { ...journal, id },
    );
    if (stopped.running) fail();
    const removed = await this.command(['container', 'rm', id], { maximumOutput: 4096 });
    removed.stdout.fill(0);
    if ((await this.inventory('id=' + id)).length) fail('cleanup_pending');
    await this.forget(journal);
  }
  private async forget(journal: Journal) {
    const filename = journal.name + '.jsonl';
    const raw = await readProtectedFile(join(this.options.stateDirectory, filename), 16384);
    try {
      const actual = decodeJournal(raw, filename, this.options.socketPath);
      if (JSON.stringify(actual) !== JSON.stringify(journal)) fail('ownership');
    } finally {
      raw.fill(0);
    }
    await unlink(join(this.options.stateDirectory, filename));
    await syncDirectory(this.options.stateDirectory);
    this.journals.delete(filename);
  }
  private async cleanup(journal: Journal) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await this.cleanupOnce(this.journals.get(journal.name + '.jsonl') ?? journal);
        return;
      } catch {
        if (attempt < 2) await delay(250 * 2 ** attempt);
      }
    }
    fail('cleanup_pending');
  }
  private async reconcile() {
    for (const journal of [...this.journals.values()]) await this.cleanup(journal);
  }
  private async releaseLock() {
    if (this.released) return;
    const lock = join(this.options.stateDirectory, '.executor-lock');
    const receipt = await readProtectedFile(join(lock, 'owner.json'), 4096);
    try {
      if (receipt.toString('utf8') !== this.lockReceipt) fail('ownership');
    } finally {
      receipt.fill(0);
    }
    await unlink(join(lock, 'owner.json'));
    await rmdir(lock);
    await syncDirectory(this.options.stateDirectory);
    this.released = true;
  }
  close(): Promise<void> {
    this.stopping.abort();
    if (this.closing) return this.closing;
    const closing = Promise.resolve().then(async () => {
      await this.active?.catch(() => {});
      await this.reconcile();
      await this.releaseLock();
    });
    this.closing = closing;
    void closing.catch(() => {
      if (this.closing === closing) this.closing = undefined;
    });
    return closing;
  }
}
export const createDockerScannerExecutor = (options: DockerScannerOptions) =>
  DockerScannerExecutor.create(options);
