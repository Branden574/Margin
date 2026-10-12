import { createHash } from 'node:crypto';
import type { SessionPrincipal } from '../identity/types.js';
import type {
  ArtifactIdentity,
  ArtifactMetadata,
  ArtifactReceipt,
  ArtifactSource,
} from '../cloud/types.js';
import { cancelStream, nextChunk, StreamBudget } from '../cloud/limits.js';
import type { PostgresIngestionRepository } from './postgres.js';
import {
  IngestionError,
  type IngestionStatus,
  type SourceUploadDetails,
  type SourceUploadInput,
} from './types.js';

export interface SourceUploadStatus {
  id: string;
  requestId: string;
  status: IngestionStatus;
}
export interface SourceUploadResult {
  upload: SourceUploadStatus;
  duplicate: boolean;
}
export interface SourceUploadService {
  reserve(
    principal: SessionPrincipal,
    input: SourceUploadInput,
    options?: { signal?: AbortSignal },
  ): Promise<SourceUploadResult>;
  read(
    principal: SessionPrincipal,
    id: string,
    options?: { signal?: AbortSignal },
  ): Promise<SourceUploadStatus>;
  upload(
    principal: SessionPrincipal,
    id: string,
    source: AsyncIterable<Uint8Array>,
    options?: { signal?: AbortSignal },
  ): Promise<SourceUploadResult>;
}
type Repository = Pick<
  PostgresIngestionRepository,
  'reserveUpload' | 'uploadDetails' | 'stageConfirmed'
>;
/** Must authenticate and reconcile an exact retry after an unknown publication result. */
export interface SourceUploadStorage {
  put(
    identity: ArtifactIdentity,
    source: ArtifactSource,
    metadata: ArtifactMetadata,
    expectedBytes: number,
    signal?: AbortSignal,
  ): Promise<ArtifactReceipt>;
}
const publicStatus = (details: SourceUploadDetails): SourceUploadStatus => ({
  id: details.identity.artifactId,
  requestId: details.expected.requestId,
  status: details.status,
});
const cancelled = () =>
  new IngestionError(
    409,
    'source_upload_interrupted',
    'The upload response was interrupted. Check its saved status before retrying.',
  );
const check = (signal: AbortSignal) => {
  if (signal.aborted) throw cancelled();
};

/** Retain the actual producer work after an abort race, including a pending iterator return. */
function retainedSource(source: AsyncIterable<Uint8Array>) {
  const iterator = source[Symbol.asyncIterator]();
  const pending = new Set<Promise<unknown>>();
  let ended = false;
  let returning: Promise<IteratorResult<Uint8Array>> | undefined;
  const track = <T>(invoke: () => T | Promise<T>): Promise<T> => {
    const task = Promise.resolve().then(invoke);
    pending.add(task);
    void task.finally(() => pending.delete(task)).catch(() => {});
    return task;
  };
  const stop = () =>
    (returning ??= track(async () => {
      if (!ended && iterator.return) return await iterator.return();
      return { done: true as const, value: undefined };
    }));
  const wrapper: AsyncIterator<Uint8Array> & AsyncIterable<Uint8Array> = {
    [Symbol.asyncIterator]() {
      return this;
    },
    next: () =>
      track(async () => {
        const value = await iterator.next();
        if (value.done) ended = true;
        return value;
      }),
    return: stop,
  };
  return {
    source: wrapper,
    async drain() {
      void stop().catch(() => {});
      while (pending.size) await Promise.allSettled([...pending]);
    },
  };
}

/** Authenticates the entire stream before the encrypted storage adapter can publish it. */
async function* verifiedBytes(
  source: AsyncIterable<Uint8Array>,
  expected: SourceUploadDetails['expected'],
  signal: AbortSignal,
  verified: () => void,
) {
  const iterator = source[Symbol.asyncIterator]();
  const digest = createHash('sha256');
  const budget = new StreamBudget();
  let count = 0,
    ended = false;
  try {
    for (;;) {
      check(signal);
      const item = await nextChunk(iterator, signal);
      if (item.done) {
        ended = true;
        break;
      }
      if (!(item.value instanceof Uint8Array))
        throw new IngestionError(
          400,
          'invalid_upload_content',
          'The source upload contains invalid or excessive chunks.',
        );
      if (!(await budget.observe(item.value.byteLength, signal))) continue;
      count += item.value.byteLength;
      if (count > expected.plaintextBytes)
        throw new IngestionError(
          413,
          'source_upload_size',
          'The PDF exceeds the size in its saved upload request.',
        );
      // Own this chunk until its consumer advances; a producer cannot change bytes after hashing.
      const bytes = Buffer.from(item.value);
      try {
        digest.update(bytes);
        yield bytes;
      } finally {
        bytes.fill(0);
      }
    }
    check(signal);
    if (count !== expected.plaintextBytes || digest.digest('hex') !== expected.plaintextSha256)
      throw new IngestionError(
        409,
        'source_upload_mismatch',
        'Choose the exact PDF from this saved upload request. Its bytes do not match.',
      );
    verified();
  } finally {
    if (!ended) cancelStream(iterator);
  }
}

/** Owns request admission, not the borrowed repositories, storage or scanner. */
export class TeacherSourceUploadService implements SourceUploadService {
  private readonly shutdown = new AbortController();
  private readonly active = new Set<Promise<unknown>>();
  private readonly uploading = new Set<string>();
  private closing?: Promise<void>;
  constructor(
    private readonly repository: Repository,
    private readonly storage: SourceUploadStorage,
  ) {}
  close(): Promise<void> {
    this.shutdown.abort();
    return (this.closing ??= Promise.allSettled([...this.active]).then(() => {}));
  }
  private run<T>(
    principal: SessionPrincipal,
    inputSignal: AbortSignal | undefined,
    operation: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    if (principal.authenticationMethod !== 'lti' || principal.role !== 'teacher')
      return Promise.reject(
        new IngestionError(
          403,
          'teacher_launch_required',
          'Open assignment setup from an approved Canvas teacher account.',
        ),
      );
    if (this.shutdown.signal.aborted || this.active.size >= 16)
      return Promise.reject(
        new IngestionError(
          503,
          'source_upload_busy',
          'Source uploads are busy. Keep the saved request and retry shortly.',
        ),
      );
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(), 60_000);
    timer.unref();
    const signal = AbortSignal.any([
      this.shutdown.signal,
      deadline.signal,
      ...(inputSignal ? [inputSignal] : []),
    ]);
    const task = Promise.resolve()
      .then(async () => {
        check(signal);
        const result = await operation(signal);
        check(signal);
        return result;
      })
      .catch((reason: unknown) => {
        if (signal.aborted) throw cancelled();
        if (reason instanceof IngestionError) throw reason;
        throw new IngestionError(
          503,
          'source_upload_unconfirmed',
          'The source upload was not confirmed. Keep the saved request and check its status before retrying.',
        );
      });
    this.active.add(task);
    void task
      .finally(() => {
        clearTimeout(timer);
        this.active.delete(task);
      })
      .catch(() => {});
    // The caller may time out, but admission and shutdown retain the real provider promise.
    return new Promise<T>((resolve, reject) => {
      const aborted = () => reject(cancelled());
      if (signal.aborted) aborted();
      else signal.addEventListener('abort', aborted, { once: true });
      void task.then(resolve, reject).finally(() => signal.removeEventListener('abort', aborted));
    });
  }
  reserve(
    principal: SessionPrincipal,
    input: SourceUploadInput,
    options: { signal?: AbortSignal } = {},
  ) {
    principal = { ...principal };
    input = structuredClone(input);
    return this.run(principal, options.signal, async (signal) => {
      const result = await this.repository.reserveUpload(principal, input, { signal });
      check(signal);
      const details = await this.repository.uploadDetails(principal, result.identity.artifactId, {
        signal,
      });
      if (!details)
        throw new IngestionError(404, 'source_unavailable', 'This source upload is unavailable.');
      return { upload: publicStatus(details), duplicate: result.duplicate };
    });
  }
  read(principal: SessionPrincipal, id: string, options: { signal?: AbortSignal } = {}) {
    principal = { ...principal };
    return this.run(principal, options.signal, async (signal) => {
      const details = await this.repository.uploadDetails(principal, id, { signal });
      if (!details)
        throw new IngestionError(404, 'source_unavailable', 'This source upload is unavailable.');
      return publicStatus(details);
    });
  }
  upload(
    principal: SessionPrincipal,
    id: string,
    source: AsyncIterable<Uint8Array>,
    options: { signal?: AbortSignal } = {},
  ) {
    principal = { ...principal };
    return this.run(principal, options.signal, async (signal) => {
      const owner = `${principal.organizationId}:${principal.userId}`;
      if (this.uploading.size >= 2 || this.uploading.has(owner))
        throw new IngestionError(
          429,
          'source_upload_busy',
          'Another source upload is in progress. Retry this saved request shortly.',
        );
      this.uploading.add(owner);
      let retained: ReturnType<typeof retainedSource> | undefined;
      try {
        const details = await this.repository.uploadDetails(principal, id, { signal });
        if (!details)
          throw new IngestionError(404, 'source_unavailable', 'This source upload is unavailable.');
        check(signal);
        retained = retainedSource(source);
        let verified = false;
        const receipt = await this.storage.put(
          details.identity,
          verifiedBytes(retained.source, details.expected, signal, () => {
            verified = true;
          }),
          details.expected.metadata,
          details.expected.plaintextBytes,
          signal,
        );
        check(signal);
        if (!verified)
          throw new IngestionError(
            503,
            'source_upload_unconfirmed',
            'Storage did not consume and verify the complete upload. Retry the saved request.',
          );
        // Storage publication alone is not permission to stage or disclose a receipt.
        const current = await this.repository.uploadDetails(principal, id, { signal });
        if (!current)
          throw new IngestionError(404, 'source_unavailable', 'This source upload is unavailable.');
        check(signal);
        const result = await this.repository.stageConfirmed(principal, id, receipt);
        check(signal);
        const confirmed = await this.repository.uploadDetails(principal, id, { signal });
        if (!confirmed)
          throw new IngestionError(404, 'source_unavailable', 'This source upload is unavailable.');
        return { upload: publicStatus(confirmed), duplicate: result.duplicate };
      } finally {
        await retained?.drain();
        this.uploading.delete(owner);
      }
    });
  }
}
