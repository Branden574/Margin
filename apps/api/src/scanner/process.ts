import { spawn } from 'node:child_process';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export class ScannerProcessError extends Error {
  readonly name = 'ScannerProcessError';
  constructor() {
    super('The isolated scanner command could not complete within its bounds.');
  }
}
export interface ScannerCommandResult {
  stdout: Buffer;
  exitCode: number;
}
export interface ScannerCommandOptions {
  signal?: AbortSignal;
  input?: Uint8Array;
  timeoutMs?: number;
  maximumOutput?: number;
}
/** No shell, inherited Docker overrides, raw diagnostics, or early release of a live process. */
export async function scannerCommand(
  executable: string,
  args: readonly string[],
  options: ScannerCommandOptions = {},
): Promise<ScannerCommandResult> {
  const maximum = options.maximumOutput ?? 262144;
  const timeout = options.timeoutMs ?? 10000;
  if (
    !Number.isSafeInteger(maximum) ||
    maximum < 1 ||
    maximum > 1024 * 1024 ||
    !Number.isSafeInteger(timeout) ||
    timeout < 1 ||
    timeout > 60000 ||
    !executable.startsWith('/') ||
    executable.includes('\0') ||
    args.some((argument) => typeof argument !== 'string' || argument.includes('\0'))
  )
    throw new ScannerProcessError();
  if (options.signal?.aborted) throw new ScannerProcessError();
  const child = spawn(executable, [...args], {
    shell: false,
    env: { PATH: process.env.PATH, LANG: 'C', LC_ALL: 'C' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const parts: Buffer[] = [];
  let outputSize = 0,
    diagnosticsSize = 0,
    failed = false,
    force: NodeJS.Timeout | undefined;
  let closed = false;
  const terminate = () => {
    failed = true;
    if (closed) return;
    child.kill('SIGTERM');
    force ??= setTimeout(() => {
      if (!closed) child.kill('SIGKILL');
    }, 1000);
    force.unref();
  };
  const stopped = new Promise<number>((resolve) => {
    child.once('error', () => {
      failed = true;
    });
    child.once('close', (code, signal) => {
      closed = true;
      if (signal || code === null) failed = true;
      resolve(code ?? -1);
    });
  });
  child.stdout.on('data', (chunk: Buffer) => {
    outputSize += chunk.length;
    if (outputSize > maximum) terminate();
    else if (!failed) parts.push(Buffer.from(chunk));
  });
  child.stderr.on('data', (chunk: Buffer) => {
    diagnosticsSize += chunk.length;
    if (diagnosticsSize > 65536) terminate();
  });
  options.signal?.addEventListener('abort', terminate, { once: true });
  if (options.signal?.aborted) terminate();
  const timer = setTimeout(terminate, timeout);
  timer.unref();
  const writing = pipeline(
    Readable.from(
      (function* () {
        const input = options.input;
        if (input)
          for (let offset = 0; offset < input.byteLength; offset += 65536) {
            yield input.subarray(offset, Math.min(offset + 65536, input.byteLength));
          }
      })(),
    ),
    child.stdin,
  ).catch(() => {
    terminate();
  });
  try {
    const [exitCode] = await Promise.all([stopped, writing]);
    if (failed || options.signal?.aborted) throw new ScannerProcessError();
    return { stdout: Buffer.concat(parts), exitCode };
  } finally {
    clearTimeout(timer);
    if (force) clearTimeout(force);
    options.signal?.removeEventListener('abort', terminate);
    for (const part of parts) part.fill(0);
  }
}
