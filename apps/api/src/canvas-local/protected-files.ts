import { constants, type Stats } from 'node:fs';
import { lstat, open, type FileHandle } from 'node:fs/promises';
import { dirname, isAbsolute, join, parse, resolve, sep } from 'node:path';

export class CanvasLocalConfigError extends Error {
  readonly name = 'CanvasLocalConfigError';
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
export function invalid(code: string, message: string): never {
  throw new CanvasLocalConfigError(code, message);
}
export function absolutePath(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length > 4096 ||
    /[\u0000-\u001f\u007f]/.test(value) ||
    !isAbsolute(value) ||
    resolve(value) !== value ||
    value === parse(value).root
  )
    invalid(
      'invalid_path',
      'Configure canonical absolute paths to dedicated local files and directories.',
    );
  return value;
}
function privateStat(stat: Stats, directory: boolean) {
  if (
    !process.getuid ||
    stat.uid !== process.getuid() ||
    (directory ? !stat.isDirectory() : !stat.isFile()) ||
    (stat.mode & 0o7777) !== (directory ? 0o700 : 0o600)
  )
    invalid(
      'unsafe_file',
      'Local configuration requires owned mode 0600 regular files and mode 0700 dedicated directories.',
    );
}
/** Trusted operator paths only. As with artifact storage, same-account ancestor rename races require OS isolation. */
export async function checkParents(path: string): Promise<void> {
  let current = parse(path).root;
  for (const part of dirname(path).slice(current.length).split(sep).filter(Boolean)) {
    current = join(current, part);
    let handle: FileHandle | undefined;
    try {
      handle = await open(
        current,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      if (!(await handle.stat()).isDirectory())
        invalid('unsafe_file', 'Configuration paths must not traverse symbolic links.');
    } catch (reason) {
      if (reason instanceof CanvasLocalConfigError) throw reason;
      invalid(
        'unsafe_file',
        'Configuration paths must have existing real parent directories without symbolic links.',
      );
    } finally {
      await handle?.close();
    }
  }
}
export async function checkDedicatedDirectory(path: string): Promise<void> {
  await checkParents(path);
  try {
    privateStat(await lstat(path), true);
  } catch (reason) {
    if ((reason as NodeJS.ErrnoException)?.code === 'ENOENT') return;
    if (reason instanceof CanvasLocalConfigError) throw reason;
    invalid('unsafe_file', 'The dedicated local directory is unavailable or unsafe.');
  }
}
export async function readProtectedFile(path: string, maximum: number): Promise<Buffer> {
  absolutePath(path);
  await checkParents(path);
  let handle: FileHandle | undefined, bytes: Buffer | undefined;
  try {
    // NONBLOCK makes a FIFO fail the regular-file check instead of hanging before fstat.
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const before = await handle.stat();
    privateStat(before, false);
    if (!Number.isSafeInteger(before.size) || before.size < 1 || before.size > maximum)
      invalid('file_size', 'A protected configuration file is empty or exceeds its bounded size.');
    bytes = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      const read = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (read.bytesRead < 1)
        invalid('file_changed', 'A protected configuration file changed while being read.');
      offset += read.bytesRead;
    }
    const extra = Buffer.alloc(1);
    try {
      const read = await handle.read(extra, 0, 1, bytes.length),
        after = await handle.stat();
      privateStat(after, false);
      if (
        read.bytesRead ||
        after.size !== before.size ||
        after.dev !== before.dev ||
        after.ino !== before.ino ||
        after.mtimeMs !== before.mtimeMs ||
        after.ctimeMs !== before.ctimeMs
      )
        invalid('file_changed', 'A protected configuration file changed while being read.');
    } finally {
      extra.fill(0);
    }
    await handle.close();
    handle = undefined;
    const result = bytes;
    bytes = undefined;
    return result;
  } catch (reason) {
    if (reason instanceof CanvasLocalConfigError) throw reason;
    return invalid('unsafe_file', 'A protected configuration file is unavailable or unsafe.');
  } finally {
    bytes?.fill(0);
    await handle?.close();
  }
}
export function utf8(bytes: Buffer): string {
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return invalid('invalid_text', 'Configuration files must contain valid UTF-8.');
  }
}
