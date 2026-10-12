import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:net';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  createDockerScannerExecutor,
  type DockerScannerExecutor,
} from '../apps/api/src/scanner/docker';
import { scannerCommand, type ScannerCommandOptions } from '../apps/api/src/scanner/process';
import {
  scannerCreateArgs,
  scannerOwnerLabel,
  sandboxLimits,
  type ScannerSandbox,
} from '../apps/api/src/scanner/policy';

const durability = vi.hoisted(() => ({ failedDirectory: undefined as string | undefined }));
vi.mock('node:fs/promises', async (original) => {
  const filesystem = await original<typeof import('node:fs/promises')>();
  return {
    ...filesystem,
    open: async (...args: Parameters<typeof filesystem.open>) => {
      const handle = await filesystem.open(...args);
      const sync = handle.sync.bind(handle);
      handle.sync = async () => {
        if (args[0] === durability.failedDirectory)
          throw new Error('Synthetic directory fsync failure');
        await sync();
      };
      return handle;
    },
  };
});
vi.mock('../apps/api/src/scanner/process', () => ({ scannerCommand: vi.fn() }));
const command = vi.mocked(scannerCommand);
const sandbox: ScannerSandbox = {
  kind: 'parser',
  imageId: 'sha256:' + 'a'.repeat(64),
  uid: 65532,
  gid: 65532,
};
const nativeArchitecture = process.arch === 'x64' ? 'amd64' : process.arch;
function image() {
  return [
    {
      Id: sandbox.imageId,
      Os: 'linux',
      Architecture: nativeArchitecture,
      Config: {
        Labels: {
          'com.margin.inspection.protocol': 'margin-pdf-inspection-v1',
          'com.margin.inspection.policy': 'qpdf-12.4.2+pdfjs-6.3.289+policy-1',
        },
        Entrypoint: ['node', '--max-old-space-size=512', '/app/runner.mjs'],
        Cmd: null,
        Volumes: null,
        OnBuild: null,
        WorkingDir: '/work',
        User: '65532:65532',
        Env: [
          'PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
          'NODE_VERSION=22.23.1',
          'YARN_VERSION=1.22.22',
        ],
      },
    },
  ];
}
function container(name: string, owner: string, id = 'b'.repeat(64)) {
  const args = scannerCreateArgs(sandbox, { name, owner });
  const tmpfs = Object.fromEntries(
    args.flatMap((arg, index) => {
      if (arg !== '--tmpfs') return [];
      const value = args[index + 1],
        at = value.indexOf(':');
      return [[value.slice(0, at), value.slice(at + 1)]];
    }),
  );
  const { memory } = sandboxLimits(sandbox.kind);
  return {
    Id: id,
    Name: '/' + name,
    Image: sandbox.imageId,
    Config: {
      Labels: { [scannerOwnerLabel]: owner },
      User: '65532:65532',
      Tty: false,
      OpenStdin: true,
      AttachStdin: true,
      AttachStdout: true,
      AttachStderr: true,
    },
    HostConfig: {
      NetworkMode: 'none',
      ReadonlyRootfs: true,
      Privileged: false,
      CapDrop: ['ALL'],
      CapAdd: null,
      SecurityOpt: ['no-new-privileges'],
      Memory: memory,
      MemorySwap: memory,
      NanoCpus: 1_000_000_000,
      PidsLimit: 64,
      Init: true,
      IpcMode: 'none',
      RestartPolicy: { Name: 'no' },
      LogConfig: { Type: 'none' },
      Devices: [],
      DeviceRequests: [],
      VolumesFrom: null,
      Links: null,
      GroupAdd: null,
      PidMode: '',
      UTSMode: '',
      PublishAllPorts: false,
      PortBindings: {},
      Ulimits: [
        { Name: 'core', Soft: 0, Hard: 0 },
        { Name: 'nofile', Soft: 256, Hard: 256 },
      ],
      Tmpfs: tmpfs,
    },
    Mounts: [],
    State: { Running: false, OOMKilled: false, ExitCode: 0, Error: '' },
  };
}
type Container = ReturnType<typeof container>;
type Journal = {
  schema: number;
  owner: string;
  name: string;
  endpoint: string;
  sandbox: ScannerSandbox;
  phase: string;
  id?: string;
};
let base: string, directory: string, socketPath: string, socket: Server;
let executor: DockerScannerExecutor | undefined, latest: Journal | undefined;
let containers: Map<string, Container>, calls: string[][], daemon: boolean;
let onCreate: (() => void | Promise<void>) | undefined;
let onStart:
  | ((
      value: Container,
      options: ScannerCommandOptions,
    ) => Promise<{ stdout: Buffer; exitCode: number }>)
  | undefined;
let imageMetadata: unknown, info: Record<string, unknown>;
const answer = (value: unknown, exitCode = 0) => ({
  stdout: Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)),
  exitCode,
});
async function create() {
  executor = await createDockerScannerExecutor({
    executable: process.execPath,
    socketPath,
    stateDirectory: directory,
  });
  return executor;
}
const signal = () => new AbortController().signal;
async function journals() {
  return (await readdir(directory)).filter((name) => name.endsWith('.jsonl'));
}
async function readLatest() {
  const names = await journals();
  const rows = (await readFile(join(directory, names[0]), 'utf8')).trimEnd().split('\n');
  return JSON.parse(rows.at(-1)!) as Journal;
}
beforeEach(async () => {
  durability.failedDirectory = undefined;
  base = await realpath(await mkdtemp('/tmp/margin-dkr-'));
  directory = join(base, 'state');
  socketPath = join(base, 'daemon.sock');
  socket = createServer();
  await new Promise<void>((resolve) => socket.listen(socketPath, resolve));
  containers = new Map();
  calls = [];
  daemon = true;
  latest = undefined;
  onCreate = undefined;
  onStart = undefined;
  imageMetadata = image();
  info = {
    OSType: 'linux',
    Architecture: nativeArchitecture,
    SecurityOptions: ['name=seccomp,profile=builtin'],
  };
  command.mockReset();
  command.mockImplementation(async (executable, raw, options = {}) => {
    expect(executable).toBe(await realpath(process.execPath));
    expect(raw.slice(0, 2)).toEqual(['--host', 'unix://' + socketPath]);
    const args = [...raw.slice(2)];
    calls.push(args);
    if (!daemon) throw new Error('synthetic daemon unavailable');
    if (args[0] === 'info') return answer(info);
    if (args[0] === 'image') return answer(imageMetadata);
    if (args[1] === 'create') {
      latest = await readLatest();
      expect(latest.phase).toBe('creating');
      expect((await stat(join(directory, latest.name + '.jsonl'))).mode & 0o777).toBe(0o600);
      expect(options.input).toBeUndefined();
      const name = args[args.indexOf('--name') + 1],
        owner = args[args.indexOf('--label') + 1].split('=')[1];
      expect(latest).toMatchObject({ name, owner, sandbox });
      containers.set('b'.repeat(64), container(name, owner));
      await onCreate?.();
      return answer('b'.repeat(64) + '\n');
    }
    if (args[1] === 'ls') {
      const filter = args[args.indexOf('--filter') + 1];
      return answer(
        [...containers.values()]
          .filter((value) =>
            filter.startsWith('id=')
              ? value.Id === filter.slice(3)
              : filter.startsWith('name=')
                ? '^' + value.Name + '$' === filter.slice(5)
                : filter ===
                  'label=' + scannerOwnerLabel + '=' + value.Config.Labels[scannerOwnerLabel],
          )
          .map((value) => value.Id)
          .join('\n'),
      );
    }
    const id = args.at(-1)!,
      value = containers.get(id);
    if (!value) return answer('', 1);
    if (args[1] === 'inspect') return answer([value]);
    if (args[1] === 'start') {
      value.State.Running = true;
      if (onStart) return onStart(value, options);
      value.State.Running = false;
      return answer('synthetic bounded report');
    }
    if (args[1] === 'kill') {
      value.State.Running = false;
      return answer(id);
    }
    if (args[1] === 'wait') return answer(String(value.State.ExitCode));
    if (args[1] === 'rm') {
      containers.delete(id);
      return answer(id);
    }
    throw new Error('Unexpected synthetic command');
  });
});
afterEach(async () => {
  durability.failedDirectory = undefined;
  // Disposable fake daemon only: restore discoverable owned metadata for any intentional failure.
  daemon = true;
  if (latest && !containers.has('b'.repeat(64)))
    containers.set('b'.repeat(64), container(latest.name, latest.owner));
  for (const value of containers.values())
    if (latest) {
      value.Name = '/' + latest.name;
      value.Config.Labels[scannerOwnerLabel] = latest.owner;
    }
  await executor?.close();
  executor = undefined;
  await new Promise<void>((resolve, reject) =>
    socket.close((error) => (error ? reject(error) : resolve())),
  );
  await rm(base, { recursive: true, force: true });
});

it('journals before create, verifies image and container before stdin, and confirms removal before returning', async () => {
  const worker = await create();
  await worker.ready(signal());
  await worker.checkSandbox(sandbox, signal());
  const input = Buffer.from('private fixture bytes');
  const result = await worker.execute(sandbox, input, signal());
  expect(result.stdout.toString()).toBe('synthetic bounded report');
  expect(input.toString()).toBe('private fixture bytes');
  expect(calls.findIndex((args) => args[1] === 'inspect')).toBeLessThan(
    calls.findIndex((args) => args[1] === 'start'),
  );
  expect(calls.find((args) => args[1] === 'start')).toEqual([
    'container',
    'start',
    '--attach',
    '--interactive',
    'b'.repeat(64),
  ]);
  expect(calls.some((args) => args[1] === 'wait')).toBe(false);
  expect(containers.size).toBe(0);
  expect(await journals()).toEqual([]);
  expect(worker.status().pendingCleanup).toBe(0);
});

it('refuses admission when the new journal directory cannot be made durable, then safely retries', async () => {
  durability.failedDirectory = base;
  await expect(create()).rejects.toThrow('Synthetic directory fsync failure');
  // mkdir succeeded, but no lifetime lock or external Docker action may precede parent fsync.
  expect(await readdir(directory)).toEqual([]);
  expect(command).not.toHaveBeenCalled();
  // Retrying the now-existing directory must still establish parent durability.
  await expect(create()).rejects.toThrow('Synthetic directory fsync failure');
  expect(await readdir(directory)).toEqual([]);
  durability.failedDirectory = undefined;
  const recovered = await create();
  await recovered.ready(signal());
  expect(recovered.status()).toEqual({ busy: false, closed: false, pendingCleanup: 0 });
});

it('refuses concurrent executors and never treats a stale host PID as permission to remove a lock', async () => {
  await create();
  const options = { executable: process.execPath, socketPath, stateDirectory: directory };
  await expect(createDockerScannerExecutor(options)).rejects.toMatchObject({ code: 'busy' });
  const owned = await readFile(join(directory, '.executor-lock/owner.json'));
  await writeFile(
    join(directory, '.executor-lock/owner.json'),
    JSON.stringify({ pid: 2147483647 }) + '\n',
  );
  await expect(createDockerScannerExecutor(options)).rejects.toMatchObject({ code: 'busy' });
  expect(calls).toEqual([]);
  await writeFile(join(directory, '.executor-lock/owner.json'), owned);
});

it.each(['bad-platform', 'missing-seccomp', 'mutable-image', 'extra-volume'] as const)(
  'refuses %s before creating any container',
  async (kind) => {
    const worker = await create();
    if (kind === 'bad-platform') info.OSType = 'windows';
    else if (kind === 'missing-seccomp') info.SecurityOptions = [];
    else if (kind === 'mutable-image') (imageMetadata as ReturnType<typeof image>)[0].Id = 'latest';
    else
      (imageMetadata as ReturnType<typeof image>)[0].Config.Volumes = { '/untrusted': {} } as never;
    await expect(worker.execute(sandbox, Buffer.from('source'), signal())).rejects.toThrow();
    expect(calls.some((args) => args[1] === 'create')).toBe(false);
    expect(await journals()).toEqual([]);
  },
);

it('removes an owned container with failed isolation without starting it or exposing source bytes', async () => {
  const worker = await create();
  onCreate = () => {
    containers.get('b'.repeat(64))!.HostConfig.Privileged = true;
  };
  await expect(worker.execute(sandbox, Buffer.from('source'), signal())).rejects.toThrow();
  expect(calls.some((args) => args[1] === 'start')).toBe(false);
  expect(calls.some((args) => args[1] === 'rm')).toBe(true);
  expect(calls.some((args) => args[1] === 'wait')).toBe(false);
  expect(containers.size).toBe(0);
});

it('removes a known owned creation cancelled before start without waiting on an unstarted container', async () => {
  const worker = await create(),
    abort = new AbortController();
  onCreate = () => {
    abort.abort();
  };
  await expect(worker.execute(sandbox, Buffer.from('source'), abort.signal)).rejects.toThrow();
  expect(calls.some((args) => ['start', 'wait', 'kill'].includes(args[1]))).toBe(false);
  expect(calls.some((args) => args[1] === 'rm')).toBe(true);
  expect(await journals()).toEqual([]);
});

it('cancels attach, waits for its real settlement, then kills/waits/removes the exact owned container', async () => {
  const worker = await create(),
    abort = new AbortController();
  let release!: () => void, started!: () => void;
  const begun = new Promise<void>((resolve) => {
    started = resolve;
  });
  onStart = async (_value, options) => {
    started();
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    expect(options.signal!.aborted).toBe(true);
    throw new Error('attached client terminated');
  };
  const running = worker
    .execute(sandbox, Buffer.from('source'), abort.signal)
    .catch((error) => error);
  await begun;
  abort.abort();
  await expect(worker.ready(signal())).rejects.toMatchObject({ code: 'busy' });
  let closed = false;
  const closing = worker.close().then(() => {
    closed = true;
  });
  await Promise.resolve();
  expect(closed).toBe(false);
  expect(calls.some((args) => args[1] === 'kill')).toBe(false);
  release();
  expect(await running).toMatchObject({ code: 'unavailable' });
  await closing;
  expect(
    calls.filter((args) => ['kill', 'wait', 'rm'].includes(args[1])).map((args) => args[1]),
  ).toEqual(['kill', 'wait', 'rm']);
  expect(await journals()).toEqual([]);
});

it('recovers an unknown create acknowledgement by verified random name and owner label', async () => {
  const worker = await create();
  onCreate = () => {
    throw new Error('lost create acknowledgement');
  };
  await expect(worker.execute(sandbox, Buffer.from('source'), signal())).rejects.toThrow();
  expect(calls.some((args) => args[1] === 'start')).toBe(false);
  expect(containers.size).toBe(0);
  expect(await journals()).toEqual([]);
});

it('retains unknown creation despite an empty inventory and explicitly reconciles it later', async () => {
  const worker = await create();
  onCreate = () => {
    containers.clear();
    throw new Error('create request still in flight');
  };
  await expect(worker.execute(sandbox, Buffer.from('source'), signal())).rejects.toMatchObject({
    code: 'cleanup_pending',
  });
  expect(worker.status().pendingCleanup).toBe(1);
  expect(await journals()).toHaveLength(1);
  expect((await stat(join(directory, '.executor-lock'))).isDirectory()).toBe(true);
  const before = calls.filter((args) => args[1] === 'create').length;
  await expect(worker.ready(signal())).rejects.toMatchObject({ code: 'cleanup_pending' });
  expect(calls.filter((args) => args[1] === 'create')).toHaveLength(before);
  containers.set('b'.repeat(64), container(latest!.name, latest!.owner));
  await worker.ready(signal());
  expect(worker.status().pendingCleanup).toBe(0);
  expect(containers.size).toBe(0);
});

it('keeps journal and lock when the daemon disappears and close cannot confirm cleanup', async () => {
  const worker = await create();
  onStart = async () => {
    daemon = false;
    throw new Error('daemon lost after start');
  };
  await expect(worker.execute(sandbox, Buffer.from('source'), signal())).rejects.toMatchObject({
    code: 'cleanup_pending',
  });
  await expect(worker.close()).rejects.toMatchObject({ code: 'cleanup_pending' });
  expect(await journals()).toHaveLength(1);
  expect((await stat(join(directory, '.executor-lock'))).isDirectory()).toBe(true);
  daemon = true;
  await worker.close();
  expect(containers.size).toBe(0);
  await expect(stat(join(directory, '.executor-lock'))).rejects.toMatchObject({ code: 'ENOENT' });
});

it('never signals or removes a container whose ownership differs from its journal', async () => {
  const worker = await create();
  onCreate = () => {
    containers.get('b'.repeat(64))!.Config.Labels[scannerOwnerLabel] = randomUUID();
  };
  await expect(worker.execute(sandbox, Buffer.from('source'), signal())).rejects.toMatchObject({
    code: 'cleanup_pending',
  });
  expect(calls.some((args) => ['kill', 'wait', 'rm', 'start'].includes(args[1]))).toBe(false);
  expect(await journals()).toHaveLength(1);
  containers.get('b'.repeat(64))!.Config.Labels[scannerOwnerLabel] = latest!.owner;
  await worker.ready(signal());
});

it('reconciles a valid crash journal including a partial final append before admitting work', async () => {
  await mkdir(directory, { mode: 0o700 });
  latest = {
    schema: 1,
    owner: randomUUID(),
    name: 'margin-inspection-' + randomUUID(),
    endpoint: socketPath,
    sandbox,
    phase: 'prepared',
  };
  const prepared = JSON.stringify(latest) + '\n';
  latest = { ...latest, phase: 'creating' };
  await writeFile(
    join(directory, latest.name + '.jsonl'),
    prepared + JSON.stringify(latest) + '\n{"schema":1',
    { mode: 0o600 },
  );
  const value = container(latest.name, latest.owner);
  value.State.Running = true;
  containers.set(value.Id, value);
  const worker = await create();
  expect(worker.status().pendingCleanup).toBe(1);
  await worker.ready(signal());
  expect(containers.size).toBe(0);
  expect(await journals()).toEqual([]);
  expect(calls.some((args) => args[1] === 'create')).toBe(false);
});

it('preserves malformed or foreign files and refuses recovery without Docker mutations', async () => {
  await mkdir(directory, { mode: 0o700 });
  const name = 'margin-inspection-' + randomUUID() + '.jsonl';
  await writeFile(join(directory, name), '{"schema":1,"schema":2}\n', { mode: 0o600 });
  await expect(create()).rejects.toThrow();
  expect(await readFile(join(directory, name), 'utf8')).toBe('{"schema":1,"schema":2}\n');
  expect(calls).toEqual([]);
});
