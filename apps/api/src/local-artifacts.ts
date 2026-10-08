import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import { link, lstat, mkdir, open, realpath, unlink, type FileHandle } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, parse, resolve } from 'node:path';
import {
  artifactIdentity,
  artifactPath,
  MAX_ARTIFACT_BYTES,
  MAX_ENVELOPE_OVERHEAD,
  openArtifact,
  sealArtifact,
} from './cloud/envelope.js';
import { cancelStream } from './cloud/limits.js';
import type {
  ArtifactIdentity,
  ArtifactMetadata,
  ArtifactReceipt,
  ArtifactSource,
  ReadArtifact,
} from './cloud/types.js';
import type { KeyManagementProvider } from './encryption.js';

const MAX_STORED_BYTES = MAX_ARTIFACT_BYTES + MAX_ENVELOPE_OVERHEAD;
const BLOCK_BYTES = 1024 * 1024;
const error = (code: string, message: string) => new LocalArtifactError(code, message);
export class LocalArtifactError extends Error {
  readonly name = 'LocalArtifactError';
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
export interface LocalArtifactOptions {
  /** A dedicated private directory; its parent must already exist. Never supplied by HTTP. */
  rootDirectory: string;
  /** Borrowed provider. close() does not destroy its keys. */
  keyManagementProvider: KeyManagementProvider;
  timeoutMs?: number;
}
function interrupted(signal: AbortSignal) {
  if (signal.aborted)
    throw error(
      'operation_aborted',
      'The local artifact operation was interrupted. Retry using the same artifact identity.',
    );
}
function unavailable(): never {
  throw error('artifact_unavailable', 'The exact local artifact is unavailable.');
}
function unsafe(): never {
  throw error(
    'unsafe_local_store',
    'Local artifacts require owned private directories and regular private files without symlinks.',
  );
}
function filesystemError(reason: unknown): never {
  const code = (reason as NodeJS.ErrnoException)?.code;
  if (code === 'ENOENT') return unavailable();
  if (['ELOOP', 'ENOTDIR', 'EACCES', 'EPERM'].includes(code ?? '')) return unsafe();
  if (reason instanceof LocalArtifactError) throw reason;
  throw error(
    'local_storage_error',
    'The local artifact filesystem operation was not confirmed. Retry using the same artifact identity.',
  );
}
function owned(stat: Stats, directory: boolean) {
  if (
    stat.uid !== process.getuid!() ||
    (directory ? !stat.isDirectory() : !stat.isFile()) ||
    stat.isSymbolicLink() ||
    (stat.mode & 0o777) !== (directory ? 0o700 : 0o600)
  )
    unsafe();
}
function reference(bytes: Buffer): ArtifactReceipt {
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  return {
    objectVersionId: `local-v1-${sha256}`,
    etag: `"local-v1-${sha256}"`,
    ciphertextSha256: sha256,
    storedBytes: bytes.length,
  };
}
function checkedReceipt(value: ArtifactReceipt): ArtifactReceipt {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).length !== 4 ||
    !['objectVersionId', 'etag', 'ciphertextSha256', 'storedBytes'].every((key) =>
      Object.hasOwn(value, key),
    ) ||
    typeof value.ciphertextSha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(value.ciphertextSha256) ||
    value.objectVersionId !== `local-v1-${value.ciphertextSha256}` ||
    value.etag !== `"local-v1-${value.ciphertextSha256}"` ||
    !Number.isSafeInteger(value.storedBytes) ||
    value.storedBytes < 30 ||
    value.storedBytes > MAX_STORED_BYTES
  )
    throw error('invalid_receipt', 'Use the exact local artifact receipt.');
  return { ...value };
}
function sameReceipt(actual: ArtifactReceipt, expected: ArtifactReceipt) {
  return (
    actual.objectVersionId === expected.objectVersionId &&
    actual.etag === expected.etag &&
    actual.storedBytes === expected.storedBytes &&
    timingSafeEqual(
      Buffer.from(actual.ciphertextSha256, 'hex'),
      Buffer.from(expected.ciphertextSha256, 'hex'),
    )
  );
}
/** Keep admission until an abort-ignoring source actually settles its outstanding calls. */
function retainedSource(source: ArtifactSource) {
  if (source instanceof Uint8Array || !source?.[Symbol.asyncIterator])
    return { source, cancel: () => cancelStream(source), drain: async () => {} };
  const raw = source[Symbol.asyncIterator]();
  const pending = new Set<Promise<unknown>>();
  const track = <T>(value: Promise<T>) => {
    pending.add(value);
    void value.then(
      () => pending.delete(value),
      () => pending.delete(value),
    );
    return value;
  };
  let returning: Promise<IteratorResult<Uint8Array>> | undefined;
  const stop = () => {
    if (!returning) {
      try {
        returning = track(Promise.resolve(raw.return?.() ?? { done: true, value: undefined }));
      } catch (reason) {
        returning = Promise.reject(reason);
        void returning.catch(() => {});
      }
    }
    return returning;
  };
  const wrapper: AsyncIterable<Uint8Array> & AsyncIterator<Uint8Array> = {
    [Symbol.asyncIterator]() {
      return this;
    },
    next: () => track(Promise.resolve().then(() => raw.next())),
    return: stop,
  };
  return {
    source: wrapper,
    cancel() {
      try {
        (source as { destroy?: () => void }).destroy?.();
      } catch {
        /* Cancellation is best effort. */
      }
      void stop().catch(() => {});
    },
    async drain() {
      while (pending.size) await Promise.allSettled([...pending]);
    },
  };
}

/**
 * Local POSIX development storage, not AWS or managed KMS. Receipts identify immutable
 * ciphertext; authenticity comes from the existing identity-bound AES-GCM envelope.
 * Authorization and malware approval remain the caller's responsibility.
 *
 * The configured directory and its parent are trusted operator configuration. We reject
 * observed symlinks and use O_NOFOLLOW for leaves, but Node's path APIs cannot defend
 * against an adversary with the same OS identity concurrently renaming ancestor paths.
 * Run under a dedicated account when that is part of the threat model.
 */
export class LocalEncryptedArtifactRepository {
  private readonly configuredRoot: string;
  private readonly timeout: number;
  private readonly provider: KeyManagementProvider;
  private rootBinding: { path: string; dev: number; ino: number } | undefined;
  private busy = false;
  private closed = false;
  private active: AbortController | undefined;
  private pending: Promise<void> = Promise.resolve();
  constructor(options: LocalArtifactOptions) {
    if (!process.getuid || !constants.O_NOFOLLOW || !constants.O_DIRECTORY)
      throw error(
        'unsupported_local_filesystem',
        'Private local artifact storage requires POSIX ownership and no-follow support.',
      );
    if (
      typeof options.rootDirectory !== 'string' ||
      !isAbsolute(options.rootDirectory) ||
      options.rootDirectory.includes('\0')
    )
      throw error(
        'invalid_local_directory',
        'Configure an absolute dedicated local artifact directory.',
      );
    this.configuredRoot = resolve(options.rootDirectory);
    if (this.configuredRoot === parse(this.configuredRoot).root)
      throw error('invalid_local_directory', 'Configure a dedicated local artifact directory.');
    if (!options.keyManagementProvider?.wrapKey || !options.keyManagementProvider.unwrapKey)
      throw error('invalid_key_provider', 'Configure an explicit artifact key provider.');
    this.provider = options.keyManagementProvider;
    this.timeout = options.timeoutMs ?? 60000;
    if (!Number.isSafeInteger(this.timeout) || this.timeout < 1 || this.timeout > 60000)
      throw error(
        'invalid_timeout',
        'Local artifact deadlines must be between one millisecond and sixty seconds.',
      );
  }
  /** Reject new work, abort callers promptly, and wait for owned cleanup even if a provider ignores abort. */
  async close(): Promise<void> {
    this.closed = true;
    this.active?.abort();
    await this.pending;
  }
  private async run<T>(
    external: AbortSignal | undefined,
    work: (signal: AbortSignal) => Promise<T>,
    disposeLate?: (value: T) => void,
  ): Promise<T> {
    if (this.closed) throw error('local_store_closed', 'The local artifact store is closed.');
    if (this.busy)
      throw error(
        'local_store_busy',
        'This local artifact store is busy. Retry after the active operation finishes.',
      );
    if (external?.aborted)
      throw error('operation_aborted', 'The local artifact operation was cancelled.');
    this.busy = true;
    const controller = new AbortController();
    this.active = controller;
    let rejectAbort!: (reason: unknown) => void;
    const aborted = new Promise<never>((_, reject) => {
      rejectAbort = reject;
    });
    const abort = () =>
      rejectAbort(
        error(
          'operation_aborted',
          'The local artifact operation was interrupted. Retry using the same artifact identity.',
        ),
      );
    const externalAbort = () => controller.abort();
    controller.signal.addEventListener('abort', abort, { once: true });
    external?.addEventListener('abort', externalAbort, { once: true });
    const timer = setTimeout(() => controller.abort(), this.timeout);
    const result = Promise.resolve()
      .then(async () => {
        interrupted(controller.signal);
        const value = await work(controller.signal);
        if (controller.signal.aborted) {
          disposeLate?.(value);
          interrupted(controller.signal);
        }
        return value;
      })
      .finally(() => {
        clearTimeout(timer);
        controller.signal.removeEventListener('abort', abort);
        external?.removeEventListener('abort', externalAbort);
        this.busy = false;
        if (this.active === controller) this.active = undefined;
      });
    // Admission is released only by the actual task, not by the caller's timeout race.
    this.pending = result.then(
      () => {},
      () => {},
    );
    try {
      return await Promise.race([result, aborted]);
    } finally {
      if (external?.aborted) controller.abort();
    }
  }
  private keys(signal: AbortSignal): KeyManagementProvider {
    return {
      wrapKey: async (key, context) => {
        const copy = Buffer.from(key);
        const clear = () => {
          copy.fill(0);
          key.fill(0);
        };
        signal.addEventListener('abort', clear, { once: true });
        try {
          interrupted(signal);
          const wrapped = await this.provider.wrapKey(copy, context);
          interrupted(signal);
          return wrapped;
        } finally {
          signal.removeEventListener('abort', clear);
          copy.fill(0);
          if (signal.aborted) key.fill(0);
        }
      },
      unwrapKey: async (envelope, context) => {
        interrupted(signal);
        const key = await this.provider.unwrapKey(envelope, context);
        if (signal.aborted) {
          key.fill(0);
          interrupted(signal);
        }
        return key;
      },
    };
  }
  private async root(create: boolean): Promise<string> {
    try {
      if (create) {
        try {
          await mkdir(this.configuredRoot, { mode: 0o700 });
        } catch (reason) {
          if ((reason as NodeJS.ErrnoException).code !== 'EEXIST') throw reason;
        }
      }
      const observed = await lstat(this.configuredRoot);
      owned(observed, true);
      const path = await realpath(this.configuredRoot);
      const actual = await lstat(path);
      owned(actual, true);
      if (actual.dev !== observed.dev || actual.ino !== observed.ino) unsafe();
      if (
        this.rootBinding &&
        (this.rootBinding.path !== path ||
          this.rootBinding.dev !== actual.dev ||
          this.rootBinding.ino !== actual.ino)
      )
        unsafe();
      this.rootBinding = { path, dev: actual.dev, ino: actual.ino };
      // Persist the root's directory entry too. Its trusted parent may be a normal
      // 0755 project directory; it is not an artifact-content directory.
      if (create) await this.syncDirectory(dirname(path), false);
      return path;
    } catch (reason) {
      return filesystemError(reason);
    }
  }
  private async directory(
    identity: ArtifactIdentity,
    create: boolean,
    signal: AbortSignal,
  ): Promise<string> {
    let path = await this.root(create);
    const components = dirname(artifactPath(identity)).split('/');
    try {
      for (const component of components) {
        interrupted(signal);
        const parent = path;
        path = join(path, component);
        if (create) {
          try {
            await mkdir(path, { mode: 0o700 });
          } catch (reason) {
            if ((reason as NodeJS.ErrnoException).code !== 'EEXIST') throw reason;
          }
        }
        owned(await lstat(path), true);
        // Also sync existing entries when reconciling an interrupted earlier creation.
        if (create) await this.syncDirectory(parent);
      }
      interrupted(signal);
      return path;
    } catch (reason) {
      return filesystemError(reason);
    }
  }
  private async syncDirectory(path: string, privateDirectory = true) {
    let handle: FileHandle | undefined;
    try {
      handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      const stat = await handle.stat();
      if (privateDirectory) owned(stat, true);
      else if (!stat.isDirectory()) unsafe();
      await handle.sync();
    } finally {
      await handle?.close();
    }
  }
  private async readStored(path: string, signal: AbortSignal): Promise<Buffer> {
    let handle: FileHandle | undefined, bytes: Buffer | undefined;
    try {
      interrupted(signal);
      // A substituted FIFO/device must be rejected by fstat without blocking open.
      handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const before = await handle.stat();
      owned(before, false);
      if (!Number.isSafeInteger(before.size) || before.size < 30 || before.size > MAX_STORED_BYTES)
        throw error('artifact_too_large', 'The stored local artifact has an unsupported size.');
      bytes = Buffer.alloc(before.size);
      let offset = 0;
      while (offset < bytes.length) {
        interrupted(signal);
        const { bytesRead } = await handle.read(
          bytes,
          offset,
          Math.min(BLOCK_BYTES, bytes.length - offset),
          offset,
        );
        if (bytesRead === 0)
          throw error('artifact_size_mismatch', 'The stored local artifact was truncated.');
        offset += bytesRead;
      }
      const extra = Buffer.alloc(1);
      try {
        const { bytesRead } = await handle.read(extra, 0, 1, bytes.length);
        const after = await handle.stat();
        owned(after, false);
        if (
          bytesRead !== 0 ||
          after.size !== before.size ||
          after.dev !== before.dev ||
          after.ino !== before.ino
        )
          throw error('artifact_size_mismatch', 'The stored local artifact changed while reading.');
      } finally {
        extra.fill(0);
      }
      interrupted(signal);
      const result = bytes;
      bytes = undefined;
      return result;
    } catch (reason) {
      return filesystemError(reason);
    } finally {
      bytes?.fill(0);
      await handle?.close();
    }
  }
  async get(
    identity: ArtifactIdentity,
    receipt: ArtifactReceipt,
    signal?: AbortSignal,
  ): Promise<ReadArtifact> {
    const scope = artifactIdentity(identity),
      expected = checkedReceipt(receipt);
    return this.run(
      signal,
      async (active) => {
        const directory = await this.directory(scope, false, active);
        const ciphertext = await this.readStored(
          join(directory, basename(artifactPath(scope))),
          active,
        );
        let result: ReadArtifact | undefined;
        try {
          if (!sameReceipt(reference(ciphertext), expected))
            throw error(
              'artifact_receipt_mismatch',
              'The stored local artifact does not match its authorized receipt.',
            );
          result = await openArtifact(scope, ciphertext, this.keys(active), active);
          interrupted(active);
          const returned = result;
          result = undefined;
          return returned;
        } finally {
          ciphertext.fill(0);
          result?.bytes.fill(0);
        }
      },
      (value) => value.bytes.fill(0),
    );
  }
  async put(
    identity: ArtifactIdentity,
    source: ArtifactSource,
    metadata: ArtifactMetadata,
    expectedBytes: number,
    signal?: AbortSignal,
  ): Promise<ArtifactReceipt> {
    const scope = artifactIdentity(identity),
      properties = { ...metadata };
    return this.run(signal, async (active) => {
      const input = retainedSource(source);
      const cancel = () => input.cancel();
      active.addEventListener('abort', cancel, { once: true });
      let ciphertext: Buffer | undefined,
        temporary: string | undefined,
        handle: FileHandle | undefined;
      try {
        ciphertext = await sealArtifact(
          scope,
          input.source,
          properties,
          expectedBytes,
          this.keys(active),
          active,
        );
        interrupted(active);
        const directory = await this.directory(scope, true, active);
        const path = join(directory, basename(artifactPath(scope)));
        temporary = join(directory, `.${scope.artifactId}.${randomUUID()}.tmp`);
        handle = await open(
          temporary,
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
          0o600,
        );
        owned(await handle.stat(), false);
        let offset = 0;
        while (offset < ciphertext.length) {
          interrupted(active);
          const { bytesWritten } = await handle.write(
            ciphertext,
            offset,
            Math.min(BLOCK_BYTES, ciphertext.length - offset),
            offset,
          );
          if (bytesWritten < 1)
            throw error('local_storage_error', 'The local artifact write did not advance.');
          offset += bytesWritten;
        }
        await handle.sync();
        await handle.close();
        handle = undefined;
        interrupted(active);
        // Recheck every directory immediately before no-overwrite publication.
        if ((await this.directory(scope, false, active)) !== directory) unsafe();
        let duplicate = false;
        try {
          await link(temporary, path);
        } catch (reason) {
          if ((reason as NodeJS.ErrnoException).code !== 'EEXIST') throw reason;
          duplicate = true;
        }
        await unlink(temporary);
        temporary = undefined;
        await this.syncDirectory(directory);
        interrupted(active);
        if (!duplicate) return reference(ciphertext);
        const existing = await this.readStored(path, active);
        let old: ReadArtifact | undefined, proposed: ReadArtifact | undefined;
        try {
          old = await openArtifact(scope, existing, this.keys(active), active);
          interrupted(active);
          proposed = await openArtifact(scope, ciphertext, this.keys(active), active);
          interrupted(active);
          if (
            old.metadata.name !== proposed.metadata.name ||
            old.metadata.mimeType !== proposed.metadata.mimeType ||
            old.bytes.length !== proposed.bytes.length ||
            !timingSafeEqual(old.bytes, proposed.bytes)
          )
            throw error(
              'artifact_exists',
              'This immutable local artifact already contains different content or metadata. Preserve its identity and use a new artifact for new content.',
            );
          return reference(existing);
        } finally {
          existing.fill(0);
          old?.bytes.fill(0);
          proposed?.bytes.fill(0);
        }
      } catch (reason) {
        // Authentication/stream/provider failures retain their bounded domain codes.
        if (
          typeof (reason as { code?: unknown })?.code === 'string' &&
          !/^[A-Z][A-Z0-9_]*$/.test((reason as { code: string }).code)
        )
          throw reason;
        return filesystemError(reason);
      } finally {
        active.removeEventListener('abort', cancel);
        ciphertext?.fill(0);
        try {
          await handle?.close();
        } finally {
          if (temporary) {
            try {
              await unlink(temporary);
            } catch {
              /* Only our uncommitted ciphertext staging file may remain after a filesystem failure. */
            }
          }
          input.cancel();
          await input.drain();
        }
      }
    });
  }
}
