import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  TeacherSourceUploadService,
  type SourceUploadStorage,
} from '../apps/api/src/ingestion/upload';
import {
  IngestionError,
  type SourceUploadDetails,
  type SourceUploadInput,
} from '../apps/api/src/ingestion/types';
import { LocalKeyProvider } from '../apps/api/src/encryption';
import { LocalEncryptedArtifactRepository } from '../apps/api/src/local-artifacts';
import { artifactPath } from '../apps/api/src/cloud/envelope';
import type { ArtifactReceipt } from '../apps/api/src/cloud/types';
import type { SessionPrincipal } from '../apps/api/src/identity/types';

const principal: SessionPrincipal = {
  sessionId: randomUUID(),
  userId: randomUUID(),
  organizationId: randomUUID(),
  authenticationMethod: 'lti',
  role: 'teacher',
  mfa: false,
  createdAt: Date.now(),
  lastSeenAt: Date.now(),
  expiresAt: Date.now() + 3600000,
};
const content = Buffer.from('%PDF-1.7\nPrivate source upload fixture.\n');
const input = (): SourceUploadInput => ({
  requestId: randomUUID(),
  metadata: { name: 'Private worksheet.pdf', mimeType: 'application/pdf' },
  plaintextBytes: content.length,
  plaintextSha256: createHash('sha256').update(content).digest('hex'),
});
async function* stream(bytes = content) {
  yield bytes.subarray(0, 3);
  yield bytes.subarray(3);
}
let directory: string, keys: LocalKeyProvider, store: LocalEncryptedArtifactRepository;
let details: SourceUploadDetails | null, savedReceipt: ArtifactReceipt | undefined;
const services: TeacherSourceUploadService[] = [];
const releases: Array<() => void> = [];
const repository = {
  reserveUpload: vi.fn(async (_p: SessionPrincipal, value: SourceUploadInput) => {
    const duplicate = !!details;
    details ??= {
      identity: {
        organizationId: principal.organizationId,
        documentId: randomUUID(),
        versionId: randomUUID(),
        artifactId: randomUUID(),
        kind: 'source-pdf',
      },
      expected: structuredClone(value),
      status: 'pending',
    };
    return { identity: details.identity, status: details.status, duplicate };
  }),
  uploadDetails: vi.fn(
    async (_p: SessionPrincipal, _id: string) => details && structuredClone(details),
  ),
  stageConfirmed: vi.fn(async (_p: SessionPrincipal, _id: string, receipt: ArtifactReceipt) => {
    const duplicate = !!savedReceipt;
    if (savedReceipt) expect(receipt).toEqual(savedReceipt);
    savedReceipt = structuredClone(receipt);
    details!.status = 'quarantined';
    return { identity: details!.identity, status: details!.status, duplicate };
  }),
};
function service(storage: SourceUploadStorage = store) {
  const value = new TeacherSourceUploadService(repository, storage);
  services.push(value);
  return value;
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  releases.push(resolve);
  return { promise, resolve };
}
beforeEach(async () => {
  vi.clearAllMocks();
  details = null;
  savedReceipt = undefined;
  directory = await realpath(await mkdtemp(join(tmpdir(), 'margin-source-upload-')));
  keys = new LocalKeyProvider(randomBytes(32), 'source-upload-fixture');
  store = new LocalEncryptedArtifactRepository({
    rootDirectory: directory,
    keyManagementProvider: keys,
  });
});
afterEach(async () => {
  for (const release of releases.splice(0)) release();
  await Promise.all(services.splice(0).map((value) => value.close()));
  await store.close();
  keys.close();
  await rm(directory, { recursive: true, force: true });
});
describe('teacher source upload service with actual encrypted local artifacts', () => {
  it('stores authenticated bytes and queues quarantine without approving or exposing storage fields', async () => {
    const uploads = service(),
      request = input();
    const reservation = await uploads.reserve(principal, request);
    expect(reservation).toEqual({
      upload: { id: details!.identity.artifactId, requestId: request.requestId, status: 'pending' },
      duplicate: false,
    });
    expect(await uploads.upload(principal, reservation.upload.id, stream())).toEqual({
      upload: { ...reservation.upload, status: 'quarantined' },
      duplicate: false,
    });
    const encrypted = await readFile(join(directory, artifactPath(details!.identity)));
    expect(encrypted.includes(content)).toBe(false);
    const restored = await store.get(details!.identity, savedReceipt!);
    expect(restored.bytes).toEqual(content);
    expect(restored.metadata).toEqual(request.metadata);
    restored.bytes.fill(0);
    expect(Object.keys(await uploads.read(principal, reservation.upload.id))).toEqual([
      'id',
      'requestId',
      'status',
    ]);
  });
  it('reconciles storage publication followed by a lost database acknowledgement using the original bytes', async () => {
    const uploads = service(),
      reserved = await uploads.reserve(principal, input());
    repository.stageConfirmed.mockRejectedValueOnce(
      new Error('synthetic database disconnect with private data'),
    );
    await expect(uploads.upload(principal, reserved.upload.id, stream())).rejects.toMatchObject({
      code: 'source_upload_unconfirmed',
    });
    expect((await uploads.read(principal, reserved.upload.id)).status).toBe('pending');
    await uploads.close();
    await store.close();
    store = new LocalEncryptedArtifactRepository({
      rootDirectory: directory,
      keyManagementProvider: keys,
    });
    const restarted = service();
    const recovered = await restarted.upload(principal, reserved.upload.id, stream());
    expect(recovered.upload.status).toBe('quarantined');
    const again = await restarted.upload(principal, reserved.upload.id, stream());
    expect(again.duplicate).toBe(true);
  });
  it.each(['hash', 'short', 'oversize'] as const)(
    'refuses %s content before publication or staging',
    async (kind) => {
      const uploads = service(),
        reserved = await uploads.reserve(principal, input());
      const bytes =
        kind === 'hash'
          ? Buffer.alloc(content.length, 1)
          : kind === 'short'
            ? content.subarray(0, -1)
            : Buffer.concat([content, Buffer.from('!')]);
      await expect(
        uploads.upload(principal, reserved.upload.id, stream(bytes)),
      ).rejects.toMatchObject({
        code: kind === 'oversize' ? 'source_upload_size' : 'source_upload_mismatch',
      });
      expect(repository.stageConfirmed).not.toHaveBeenCalled();
      await expect(
        readFile(join(directory, artifactPath(details!.identity))),
      ).rejects.toMatchObject({ code: 'ENOENT' });
      expect(content.toString()).toContain('Private source upload fixture');
    },
  );
  it('never stages a storage adapter that returned without consuming and authenticating the source', async () => {
    const uploads = service({
      put: async () => ({
        objectVersionId: 'untrusted',
        etag: 'untrusted',
        ciphertextSha256: '0'.repeat(64),
        storedBytes: 90,
      }),
    });
    const reserved = await uploads.reserve(principal, input());
    await expect(uploads.upload(principal, reserved.upload.id, stream())).rejects.toMatchObject({
      code: 'source_upload_unconfirmed',
    });
    expect(repository.stageConfirmed).not.toHaveBeenCalled();
  });
  it('rechecks authorization after storage publication and withholds staging on revocation', async () => {
    const uploads = service({
      put: async (...args) => {
        const receipt = await store.put(...args);
        details = null;
        return receipt;
      },
    });
    const reserved = await uploads.reserve(principal, input());
    await expect(uploads.upload(principal, reserved.upload.id, stream())).rejects.toMatchObject({
      code: 'source_unavailable',
    });
    expect(repository.stageConfirmed).not.toHaveBeenCalled();
  });
  it('withholds a staged acknowledgement if current access is revoked before the final response', async () => {
    const uploads = service(),
      reserved = await uploads.reserve(principal, input());
    repository.stageConfirmed.mockImplementationOnce(async () => {
      const identity = details!.identity;
      details = null;
      return { identity, status: 'quarantined', duplicate: false };
    });
    await expect(uploads.upload(principal, reserved.upload.id, stream())).rejects.toMatchObject({
      code: 'source_unavailable',
    });
  });
  it.each(['student', 'viewer', 'school_admin'] as const)(
    'denies a %s before consulting storage or the repository',
    async (role) => {
      await expect(service().reserve({ ...principal, role }, input())).rejects.toMatchObject({
        code: 'teacher_launch_required',
      });
      expect(repository.reserveUpload).not.toHaveBeenCalled();
    },
  );
  it('denies ordinary OIDC sessions and absent uploads', async () => {
    const uploads = service();
    await expect(
      uploads.reserve({ ...principal, authenticationMethod: 'oidc' }, input()),
    ).rejects.toMatchObject({ code: 'teacher_launch_required' });
    await expect(uploads.read(principal, randomUUID())).rejects.toMatchObject({
      code: 'source_unavailable',
    });
  });
  it('retains admission until a cancelled provider actually settles and drains it on close', async () => {
    const gate = deferred(),
      entered = deferred();
    const uploads = service({
      put: async (...args) => {
        entered.resolve();
        await gate.promise;
        return store.put(...args);
      },
    });
    const reserved = await uploads.reserve(principal, input()),
      abort = new AbortController();
    const uploading = uploads.upload(principal, reserved.upload.id, stream(), {
      signal: abort.signal,
    });
    const failed = expect(uploading).rejects.toMatchObject({ code: 'source_upload_interrupted' });
    await entered.promise;
    abort.abort();
    await failed;
    await expect(uploads.upload(principal, reserved.upload.id, stream())).rejects.toMatchObject({
      code: 'source_upload_busy',
    });
    let closed = false;
    const closing = uploads.close().then(() => {
      closed = true;
    });
    await new Promise((done) => setImmediate(done));
    expect(closed).toBe(false);
    gate.resolve();
    await closing;
    expect(repository.stageConfirmed).not.toHaveBeenCalled();
    await expect(uploads.read(principal, reserved.upload.id)).rejects.toMatchObject({
      code: 'source_upload_busy',
    });
  });
  it('preserves typed authority failures while hiding unexpected provider errors', async () => {
    const uploads = service();
    repository.uploadDetails.mockRejectedValueOnce(
      new IngestionError(403, 'ingestion_revoked', 'Current course access changed.'),
    );
    await expect(uploads.read(principal, randomUUID())).rejects.toMatchObject({
      status: 403,
      code: 'ingestion_revoked',
    });
    repository.uploadDetails.mockRejectedValueOnce(new Error('private database URL and password'));
    await expect(uploads.read(principal, randomUUID())).rejects.toThrow(
      'The source upload was not confirmed.',
    );
  });
  it('holds upload admission and shutdown until an abort-ignoring producer has really ended', async () => {
    const gate = deferred(),
      entered = deferred();
    const uploads = service(),
      reserved = await uploads.reserve(principal, input()),
      abort = new AbortController();
    const producer: AsyncIterable<Uint8Array> = {
      [Symbol.asyncIterator]: () => ({
        next: async () => {
          entered.resolve();
          await gate.promise;
          return { done: true, value: undefined };
        },
        return: async () => {
          await gate.promise;
          return { done: true, value: undefined };
        },
      }),
    };
    const pending = uploads.upload(principal, reserved.upload.id, producer, {
      signal: abort.signal,
    });
    const rejected = expect(pending).rejects.toMatchObject({ code: 'source_upload_interrupted' });
    await entered.promise;
    abort.abort();
    await rejected;
    await expect(uploads.upload(principal, reserved.upload.id, stream())).rejects.toMatchObject({
      code: 'source_upload_busy',
    });
    let closed = false;
    const closing = uploads.close().then(() => {
      closed = true;
    });
    await new Promise((done) => setImmediate(done));
    expect(closed).toBe(false);
    gate.resolve();
    await closing;
    expect(repository.stageConfirmed).not.toHaveBeenCalled();
  });
});
