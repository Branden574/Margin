import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LocalEncryptedArtifactRepository } from '../apps/api/src/local-artifacts';
import { LocalKeyProvider, type KeyManagementProvider } from '../apps/api/src/encryption';
import {
  artifactPath,
  MAX_ARTIFACT_BYTES,
  MAX_ENVELOPE_OVERHEAD,
} from '../apps/api/src/cloud/envelope';
import type { ArtifactIdentity, ArtifactReceipt } from '../apps/api/src/cloud/types';
import { receipt as ingestionReceipt } from '../apps/api/src/ingestion/validation';

const hooks = vi.hoisted(() => ({
  syncs: [] as string[],
  afterLink: undefined as ((path: string) => void) | undefined,
  beforeSync: undefined as ((path: string) => void) | undefined,
}));
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args),
        sync = handle.sync.bind(handle);
      handle.sync = async () => {
        hooks.syncs.push(String(args[0]));
        hooks.beforeSync?.(String(args[0]));
        await sync();
      };
      return handle;
    },
    link: async (...args: Parameters<typeof actual.link>) => {
      await actual.link(...args);
      hooks.afterLink?.(String(args[1]));
    },
  };
});
const id = (n: number) => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const identity = (): ArtifactIdentity => ({
  organizationId: id(1),
  documentId: id(2),
  versionId: id(3),
  artifactId: id(4),
  kind: 'source-pdf',
});
const metadata = { name: 'Private synthetic worksheet.pdf', mimeType: 'application/pdf' as const };
const body = () => Buffer.from('%PDF-1.7\nPrivate synthetic worksheet content.\n');
let temporary: string, root: string, key: Buffer, keys: LocalKeyProvider;
const stores: LocalEncryptedArtifactRepository[] = [],
  releases: Array<() => void> = [];
function store(provider: KeyManagementProvider = keys, directory = root, timeoutMs = 60000) {
  const value = new LocalEncryptedArtifactRepository({
    rootDirectory: directory,
    keyManagementProvider: provider,
    timeoutMs,
  });
  stores.push(value);
  return value;
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((yes) => {
    resolve = yes;
  });
  releases.push(resolve);
  return { promise, resolve };
}
async function paths(path: string): Promise<string[]> {
  const result: string[] = [];
  for (const item of await readdir(path, { withFileTypes: true })) {
    const name = join(path, item.name);
    result.push(name);
    if (item.isDirectory()) result.push(...(await paths(name)));
  }
  return result;
}
beforeEach(async () => {
  temporary = await mkdtemp(join(tmpdir(), 'margin-local-artifacts-'));
  root = join(temporary, 'store');
  key = randomBytes(32);
  keys = new LocalKeyProvider(key, 'local-artifact-test');
  hooks.syncs.length = 0;
  hooks.afterLink = undefined;
  hooks.beforeSync = undefined;
});
afterEach(async () => {
  hooks.afterLink = undefined;
  hooks.beforeSync = undefined;
  for (const release of releases.splice(0)) release();
  await Promise.all(stores.splice(0).map((s) => s.close()));
  key.fill(0);
  await rm(temporary, { recursive: true, force: true });
});

describe('durable private local artifact provider', () => {
  it('persists authenticated ciphertext with local receipts, survives repository/key-provider restart, and preserves caller buffers', async () => {
    const bytes = body(),
      original = Buffer.from(bytes),
      first = store();
    const receipt = await first.put(identity(), bytes, metadata, bytes.length);
    expect(receipt.objectVersionId).toBe(`local-v1-${receipt.ciphertextSha256}`);
    expect(receipt.etag).toBe(`"${receipt.objectVersionId}"`);
    expect(ingestionReceipt(receipt)).toEqual(receipt);
    expect(bytes).toEqual(original);
    const filename = join(root, artifactPath(identity())),
      ciphertext = await readFile(filename);
    expect(ciphertext.subarray(0, 8).toString()).toBe('MGART001');
    expect(ciphertext.includes(bytes)).toBe(false);
    expect(ciphertext.includes(Buffer.from(metadata.name))).toBe(false);
    expect((await lstat(filename)).mode & 0o777).toBe(0o600);
    for (const path of [root, ...(await paths(root)).filter((p) => !p.endsWith('.mga'))])
      expect((await lstat(path)).mode & 0o777).toBe(0o700);
    await first.close();
    const restarted = store(new LocalKeyProvider(key, 'local-artifact-test'));
    const result = await restarted.get(identity(), receipt);
    expect(result.bytes).toEqual(original);
    expect(result.metadata).toEqual(metadata);
    result.bytes.fill(0);
    expect((await restarted.get(identity(), receipt)).bytes).toEqual(original);
  });
  it('returns the original receipt for an exact repeat and never replaces its randomized ciphertext', async () => {
    const s = store(),
      bytes = body(),
      a = await s.put(identity(), bytes, metadata, bytes.length);
    const before = await readFile(join(root, artifactPath(identity())));
    const repeated = await s.put(
      identity(),
      bytes,
      { mimeType: metadata.mimeType, name: metadata.name },
      bytes.length,
    );
    expect(repeated).toEqual(a);
    expect(await readFile(join(root, artifactPath(identity())))).toEqual(before);
    expect((await paths(root)).filter((p) => p.endsWith('.tmp'))).toEqual([]);
  });
  it.each(['bytes', 'name', 'mimeType'])(
    'rejects a repeated immutable identity with changed %s',
    async (field) => {
      const s = store(),
        bytes = body(),
        receipt = await s.put(identity(), bytes, metadata, bytes.length);
      const changed = Buffer.from(bytes);
      if (field === 'bytes') changed[10] ^= 1;
      const info =
        field === 'name'
          ? { ...metadata, name: 'Other.pdf' }
          : field === 'mimeType'
            ? { ...metadata, mimeType: 'application/octet-stream' as const }
            : metadata;
      await expect(s.put(identity(), changed, info, changed.length)).rejects.toMatchObject({
        code: 'artifact_exists',
      });
      expect((await s.get(identity(), receipt)).bytes).toEqual(bytes);
    },
  );
  it('reconciles simultaneous identical publications from independent repositories', async () => {
    const a = store(),
      b = store(),
      bytes = body();
    const results = await Promise.all([
      a.put(identity(), bytes, metadata, bytes.length),
      b.put(identity(), bytes, metadata, bytes.length),
    ]);
    expect(results[0]).toEqual(results[1]);
    expect((await paths(root)).filter((p) => p.endsWith('.mga'))).toHaveLength(1);
    expect((await paths(root)).filter((p) => p.endsWith('.tmp'))).toHaveLength(0);
  });
  it('only permits one winner for concurrent differing content without replacing the winner', async () => {
    const a = store(),
      b = store(),
      bytes = body(),
      changed = Buffer.from(bytes);
    changed[10] ^= 1;
    const results = await Promise.allSettled([
      a.put(identity(), bytes, metadata, bytes.length),
      b.put(identity(), changed, metadata, changed.length),
    ]);
    const success = results.find(
      (result): result is PromiseFulfilledResult<ArtifactReceipt> => result.status === 'fulfilled',
    )!;
    const rejected = results.find(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    )!;
    expect(success).toBeDefined();
    expect(rejected.reason).toMatchObject({ code: 'artifact_exists' });
    const stored = (await a.get(identity(), success.value)).bytes;
    expect(stored.equals(bytes) || stored.equals(changed)).toBe(true);
  });
  it('recovers the same ciphertext after publication succeeds but acknowledgement is lost', async () => {
    const s = store(),
      bytes = body();
    hooks.afterLink = () => {
      hooks.afterLink = undefined;
      throw Object.assign(Error('synthetic lost filesystem acknowledgement'), { code: 'EIO' });
    };
    await expect(s.put(identity(), bytes, metadata, bytes.length)).rejects.toMatchObject({
      code: 'local_storage_error',
    });
    const before = await readFile(join(root, artifactPath(identity())));
    const recovered = await s.put(identity(), bytes, metadata, bytes.length);
    expect(await readFile(join(root, artifactPath(identity())))).toEqual(before);
    expect((await s.get(identity(), recovered)).bytes).toEqual(bytes);
  });
  it('syncs root parent and every ancestor again after an interrupted directory creation', async () => {
    await chmod(temporary, 0o755);
    const s = store(),
      bytes = body(),
      canonicalRoot = join(await realpath(temporary), 'store');
    let fail = true;
    hooks.beforeSync = (path) => {
      if (fail && path === canonicalRoot) {
        fail = false;
        throw Object.assign(Error('synthetic fsync failure'), { code: 'EIO' });
      }
    };
    await expect(s.put(identity(), bytes, metadata, bytes.length)).rejects.toMatchObject({
      code: 'local_storage_error',
    });
    hooks.syncs.length = 0;
    const receipt = await s.put(identity(), bytes, metadata, bytes.length);
    expect(hooks.syncs).toContain(await realpath(temporary));
    for (
      let path = dirname(join(canonicalRoot, artifactPath(identity())));
      path.startsWith(canonicalRoot);
      path = dirname(path)
    )
      expect(hooks.syncs).toContain(path);
    expect((await s.get(identity(), receipt)).bytes).toEqual(bytes);
  });
  it.each(['checksum', 'version', 'etag', 'size', 'extra'])(
    'rejects a changed receipt %s before releasing content',
    async (field) => {
      const s = store(),
        bytes = body(),
        receipt = await s.put(identity(), bytes, metadata, bytes.length);
      const bad = { ...receipt };
      if (field === 'checksum') {
        bad.ciphertextSha256 = 'a'.repeat(64);
        bad.objectVersionId = `local-v1-${bad.ciphertextSha256}`;
        bad.etag = `"${bad.objectVersionId}"`;
      }
      if (field === 'version') bad.objectVersionId = 'aws-looking-version';
      if (field === 'etag') bad.etag = '"wrong"';
      if (field === 'size') bad.storedBytes++;
      if (field === 'extra') Object.assign(bad, { approved: true });
      await expect(s.get(identity(), bad)).rejects.toMatchObject({
        code: ['checksum', 'size'].includes(field)
          ? 'artifact_receipt_mismatch'
          : 'invalid_receipt',
      });
    },
  );
  it('detects ciphertext corruption and refuses to overwrite it during retry', async () => {
    const s = store(),
      bytes = body(),
      receipt = await s.put(identity(), bytes, metadata, bytes.length),
      path = join(root, artifactPath(identity()));
    const corrupt = await readFile(path);
    corrupt[corrupt.length - 1] ^= 1;
    await writeFile(path, corrupt);
    await expect(s.get(identity(), receipt)).rejects.toMatchObject({
      code: 'artifact_receipt_mismatch',
    });
    await expect(s.put(identity(), bytes, metadata, bytes.length)).rejects.toMatchObject({
      code: 'artifact_authentication_failed',
    });
    expect(await readFile(path)).toEqual(corrupt);
  });
  it('authenticates scope even when a valid ciphertext and its receipt are copied to another identity', async () => {
    const s = store(),
      bytes = body(),
      receipt = await s.put(identity(), bytes, metadata, bytes.length);
    const other = { ...identity(), artifactId: id(8) };
    await copyFile(join(root, artifactPath(identity())), join(root, artifactPath(other)));
    await expect(s.get(other, receipt)).rejects.toMatchObject({
      code: 'artifact_authentication_failed',
    });
    await expect(s.get({ ...identity(), kind: 'attachment' }, receipt)).rejects.toMatchObject({
      code: 'artifact_authentication_failed',
    });
    await expect(
      store(new LocalKeyProvider(randomBytes(32), 'local-artifact-test')).get(identity(), receipt),
    ).rejects.toMatchObject({ code: 'artifact_authentication_failed' });
  });
  it('rejects traversal identities and does not create an unrelated destination', async () => {
    const s = store();
    await expect(
      s.put({ ...identity(), artifactId: '../../outside' }, body(), metadata, body().length),
    ).rejects.toMatchObject({ code: 'invalid_identity' });
    await expect(lstat(root)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('rejects symlink root and intermediate directory without following them', async () => {
    const actual = join(temporary, 'actual');
    await mkdir(actual, { mode: 0o700 });
    await symlink(actual, root);
    await expect(store().put(identity(), body(), metadata, body().length)).rejects.toMatchObject({
      code: 'unsafe_local_store',
    });
    expect(await readdir(actual)).toEqual([]);
    await unlink(root);
    await mkdir(root, { mode: 0o700 });
    await symlink(actual, join(root, 'artifacts'));
    await expect(store().put(identity(), body(), metadata, body().length)).rejects.toMatchObject({
      code: 'unsafe_local_store',
    });
    expect(await readdir(actual)).toEqual([]);
  });
  it('rejects a symlink leaf for reads and duplicate writes', async () => {
    const s = store(),
      bytes = body(),
      receipt = await s.put(identity(), bytes, metadata, bytes.length),
      path = join(root, artifactPath(identity()));
    const outside = join(temporary, 'outside');
    await copyFile(path, outside);
    await unlink(path);
    await symlink(outside, path);
    await expect(s.get(identity(), receipt)).rejects.toMatchObject({ code: 'unsafe_local_store' });
    await expect(s.put(identity(), bytes, metadata, bytes.length)).rejects.toMatchObject({
      code: 'unsafe_local_store',
    });
    expect(await readFile(outside)).toHaveLength(receipt.storedBytes);
  });
  it('does not block on a FIFO substituted for an artifact leaf', async () => {
    const s = store(),
      bytes = body(),
      receipt = await s.put(identity(), bytes, metadata, bytes.length),
      path = join(root, artifactPath(identity()));
    await unlink(path);
    execFileSync('mkfifo', ['-m', '600', path]);
    await expect(s.get(identity(), receipt)).rejects.toMatchObject({ code: 'unsafe_local_store' });
    await expect(s.put(identity(), bytes, metadata, bytes.length)).rejects.toMatchObject({
      code: 'unsafe_local_store',
    });
  });
  it.each(['root', 'leaf', 'directory'])(
    'refuses excessive %s permissions without changing them',
    async (kind) => {
      const s = store(),
        bytes = body(),
        receipt = await s.put(identity(), bytes, metadata, bytes.length);
      const path =
        kind === 'root'
          ? root
          : kind === 'leaf'
            ? join(root, artifactPath(identity()))
            : join(root, 'artifacts');
      const mode = kind === 'leaf' ? 0o644 : 0o755;
      await chmod(path, mode);
      await expect(s.get(identity(), receipt)).rejects.toMatchObject({
        code: 'unsafe_local_store',
      });
      expect((await lstat(path)).mode & 0o777).toBe(mode);
    },
  );
  it('rejects replaced root directories within a live repository lifetime', async () => {
    const s = store(),
      bytes = body(),
      receipt = await s.put(identity(), bytes, metadata, bytes.length);
    await rename(root, join(temporary, 'old-root'));
    await mkdir(root, { mode: 0o700 });
    await expect(s.get(identity(), receipt)).rejects.toMatchObject({ code: 'unsafe_local_store' });
  });
  it('rejects missing and oversized on-disk files without allocating their declared size', async () => {
    const s = store(),
      bytes = body(),
      receipt = await s.put(identity(), bytes, metadata, bytes.length),
      path = join(root, artifactPath(identity()));
    const handle = await open(path, 'r+');
    await handle.truncate(MAX_ARTIFACT_BYTES + MAX_ENVELOPE_OVERHEAD + 1);
    await handle.close();
    await expect(s.get(identity(), receipt)).rejects.toMatchObject({ code: 'artifact_too_large' });
    await unlink(path);
    await expect(s.get(identity(), receipt)).rejects.toMatchObject({
      code: 'artifact_unavailable',
    });
  });
  it('accepts bounded asynchronous source chunks and enforces the exact declared length', async () => {
    const s = store(),
      bytes = body();
    async function* source() {
      yield bytes.subarray(0, 8);
      yield bytes.subarray(8);
    }
    const receipt = await s.put(identity(), source(), metadata, bytes.length);
    expect((await s.get(identity(), receipt)).bytes).toEqual(bytes);
    await expect(
      s.put({ ...identity(), artifactId: id(9) }, source(), metadata, bytes.length - 1),
    ).rejects.toMatchObject({ code: 'artifact_size_mismatch' });
    await expect(
      s.put({ ...identity(), artifactId: id(9) }, source(), metadata, bytes.length + 1),
    ).rejects.toMatchObject({ code: 'artifact_size_mismatch' });
  });
  it('rejects excessive empty source chunks and oversized declared input before publication', async () => {
    const s = store();
    async function* empty() {
      for (let i = 0; i < 1025; i++) yield new Uint8Array();
    }
    await expect(s.put(identity(), empty(), metadata, 1)).rejects.toMatchObject({
      code: 'stream_chunk_limit',
    });
    await expect(s.put(identity(), body(), metadata, MAX_ARTIFACT_BYTES + 1)).rejects.toMatchObject(
      { code: 'artifact_too_large' },
    );
    await expect(lstat(root)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('wipes owned wrap input on abort and holds admission until a noncooperative provider settles', async () => {
    const gate = deferred(),
      started = deferred();
    let passed: Buffer | undefined;
    const provider: KeyManagementProvider = {
      async wrapKey(value, context) {
        passed = value;
        started.resolve();
        await gate.promise;
        return keys.wrapKey(value, context);
      },
      unwrapKey: (e, c) => keys.unwrapKey(e, c),
    };
    const s = store(provider),
      controller = new AbortController(),
      bytes = body(),
      original = Buffer.from(bytes);
    const pending = s.put(identity(), bytes, metadata, bytes.length, controller.signal),
      rejected = expect(pending).rejects.toMatchObject({ code: 'operation_aborted' });
    await started.promise;
    controller.abort();
    await rejected;
    expect(passed?.every((n) => n === 0)).toBe(true);
    expect(bytes).toEqual(original);
    await expect(s.put(identity(), bytes, metadata, bytes.length)).rejects.toMatchObject({
      code: 'local_store_busy',
    });
    let closed = false;
    const closing = s.close().then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(closed).toBe(false);
    gate.resolve();
    await closing;
    await expect(lstat(root)).rejects.toMatchObject({ code: 'ENOENT' });
    // The borrowed provider is still usable after repository close.
    expect(await keys.wrapKey(randomBytes(32), 'caller-owned-provider')).toHaveProperty(
      'ciphertext',
    );
  });
  it('erases a late unwrap key and releases no plaintext after cancellation', async () => {
    const original = store(),
      bytes = body(),
      receipt = await original.put(identity(), bytes, metadata, bytes.length);
    const gate = deferred(),
      started = deferred();
    let unwrapped: Buffer | undefined;
    const provider: KeyManagementProvider = {
      wrapKey: (k, c) => keys.wrapKey(k, c),
      async unwrapKey(e, c) {
        unwrapped = await keys.unwrapKey(e, c);
        started.resolve();
        await gate.promise;
        return unwrapped;
      },
    };
    const s = store(provider),
      controller = new AbortController();
    const pending = s.get(identity(), receipt, controller.signal),
      rejected = expect(pending).rejects.toMatchObject({ code: 'operation_aborted' });
    await started.promise;
    controller.abort();
    await rejected;
    await expect(s.get(identity(), receipt)).rejects.toMatchObject({ code: 'local_store_busy' });
    gate.resolve();
    await s.close();
    expect(unwrapped?.every((n) => n === 0)).toBe(true);
  });
  it('retains admission for an abort-ignoring asynchronous producer until next/return settle', async () => {
    const gate = deferred(),
      started = deferred(),
      controller = new AbortController();
    const source: AsyncIterable<Uint8Array> & AsyncIterator<Uint8Array> = {
      [Symbol.asyncIterator]() {
        return this;
      },
      async next() {
        started.resolve();
        await gate.promise;
        return { done: true, value: undefined };
      },
      async return() {
        await gate.promise;
        return { done: true, value: undefined };
      },
    };
    const s = store(),
      pending = s.put(identity(), source, metadata, 1, controller.signal),
      rejected = expect(pending).rejects.toMatchObject({ code: 'operation_aborted' });
    await started.promise;
    controller.abort();
    await rejected;
    await expect(s.put(identity(), body(), metadata, body().length)).rejects.toMatchObject({
      code: 'local_store_busy',
    });
    gate.resolve();
    await s.close();
    await expect(lstat(root)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('applies a real operation deadline while keeping an unresponsive provider admitted', async () => {
    const gate = deferred(),
      provider: KeyManagementProvider = {
        async wrapKey(k, c) {
          await gate.promise;
          return keys.wrapKey(k, c);
        },
        unwrapKey: (e, c) => keys.unwrapKey(e, c),
      };
    const s = store(provider, root, 10);
    await expect(s.put(identity(), body(), metadata, body().length)).rejects.toMatchObject({
      code: 'operation_aborted',
    });
    await expect(s.put(identity(), body(), metadata, body().length)).rejects.toMatchObject({
      code: 'local_store_busy',
    });
    gate.resolve();
    await s.close();
  });
  it('rejects work after close and rejects pre-aborted work without consuming a source', async () => {
    const s = store(),
      controller = new AbortController();
    controller.abort();
    const next = vi.fn();
    const source = { [Symbol.asyncIterator]: () => ({ next }) };
    await expect(s.put(identity(), source, metadata, 1, controller.signal)).rejects.toMatchObject({
      code: 'operation_aborted',
    });
    expect(next).not.toHaveBeenCalled();
    await s.close();
    await expect(s.put(identity(), body(), metadata, body().length)).rejects.toMatchObject({
      code: 'local_store_closed',
    });
  });
});
