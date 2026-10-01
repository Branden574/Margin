import { setImmediate as yieldToEventLoop } from 'node:timers/promises';
export class CloudArtifactError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'CloudArtifactError';
  }
}
export function checkedRegion(region: string) {
  if (!/^(?:us(?:-gov)?|af|ap|ca|eu|il|me|mx|sa|cn)-(?:[a-z]+-)?[a-z]+-\d$/.test(region))
    throw new Error('Configure an explicit AWS region.');
  return region;
}
export function checkedKeyArn(value: string, region: string) {
  const match =
    /^arn:(aws|aws-us-gov|aws-cn):kms:([a-z0-9-]+):(\d{12}):key\/(?:[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}|mrk-[a-f0-9]{32})$/.exec(
      value,
    );
  if (
    !match ||
    match[2] !== region ||
    (region.startsWith('cn-')
      ? match[1] !== 'aws-cn'
      : region.startsWith('us-gov-')
        ? match[1] !== 'aws-us-gov'
        : match[1] !== 'aws')
  )
    throw new Error('Use an explicit KMS key ARN in the configured AWS region.');
  return value;
}
export function awsEndpoint(service: 'kms' | 's3', region: string) {
  checkedRegion(region);
  if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0')
    throw new Error('Cloud artifact access requires certificate-verified HTTPS.');
  return `https://${service}.${region}.${region.startsWith('cn-') ? 'amazonaws.com.cn' : 'amazonaws.com'}`;
}
/** Bounded SDK operation. Late plaintext key results are disposed even if a transport ignores abort. */
export async function bounded<T>(
  milliseconds: number,
  external: AbortSignal | undefined,
  work: (signal: AbortSignal) => Promise<T>,
  disposeLate?: (result: T) => void,
): Promise<T> {
  const controller = new AbortController();
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let rejectAbort!: (error: unknown) => void;
  const abortPromise = new Promise<never>((_, reject) => {
    rejectAbort = reject;
  });
  const stop = () => {
    stopped = true;
    controller.abort();
    rejectAbort(
      new CloudArtifactError(
        'operation_aborted',
        'The cloud operation was interrupted or exceeded its deadline. Retry without discarding local work.',
      ),
    );
  };
  if (external?.aborted)
    throw new CloudArtifactError('operation_aborted', 'The cloud operation was cancelled.');
  external?.addEventListener('abort', stop, { once: true });
  timer = setTimeout(stop, milliseconds);
  const result = Promise.resolve()
    .then(() => work(controller.signal))
    .then((value) => {
      if (stopped) {
        disposeLate?.(value);
        throw new CloudArtifactError('operation_aborted', 'The cloud operation was interrupted.');
      }
      return value;
    });
  try {
    return await Promise.race([result, abortPromise]);
  } finally {
    if (timer) clearTimeout(timer);
    external?.removeEventListener('abort', stop);
  }
}
export async function nextChunk<T>(
  iterator: AsyncIterator<T>,
  signal: AbortSignal,
): Promise<IteratorResult<T>> {
  if (signal.aborted)
    throw new CloudArtifactError('operation_aborted', 'The artifact stream was interrupted.');
  let listener!: () => void;
  try {
    const aborted = new Promise<never>((_, reject) => {
      listener = () =>
        reject(new CloudArtifactError('operation_aborted', 'The artifact stream was interrupted.'));
      signal.addEventListener('abort', listener, { once: true });
      if (signal.aborted) listener();
    });
    return await Promise.race([iterator.next(), aborted]);
  } finally {
    signal.removeEventListener('abort', listener);
  }
}
export function cancelStream(value: unknown) {
  const stream = value as { destroy?: () => void; return?: () => Promise<unknown> };
  try {
    stream.destroy?.();
    void stream.return?.().catch(() => {});
  } catch {
    /* Cleanup must not hide the original failure. */
  }
}

/** Bound both bytes' container overhead and iterator work, including zero-byte producers. */
export class StreamBudget {
  private chunks = 0;
  private emptyChunks = 0;
  async observe(byteLength: number, signal: AbortSignal): Promise<boolean> {
    if (++this.chunks > 65536 || (byteLength === 0 && ++this.emptyChunks > 1024))
      throw new CloudArtifactError(
        'stream_chunk_limit',
        'The artifact stream produced too many tiny or empty chunks. Coalesce the producer and retry.',
      );
    if (byteLength !== 0) this.emptyChunks = 0;
    // Promise/async-iterator microtasks alone can starve timers and AbortSignal delivery.
    if (this.chunks % 64 === 0) {
      try {
        await yieldToEventLoop(undefined, { signal });
      } catch {
        throw new CloudArtifactError('operation_aborted', 'The artifact stream was interrupted.');
      }
    }
    if (signal.aborted)
      throw new CloudArtifactError('operation_aborted', 'The artifact stream was interrupted.');
    return byteLength !== 0;
  }
}
