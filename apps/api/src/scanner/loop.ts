import type { InspectionReceipt } from '../ingestion/types.js';

export interface DrainedInspectionWorker {
  runOneAndDrain(signal: AbortSignal): Promise<InspectionReceipt | null>;
  close(): Promise<void>;
}
export type InspectionLoopEvent = 'processed' | 'idle' | 'deferred';
/** One local inspector; idle/error backoff avoids repeatedly hashing public definition snapshots. */
export function startInspectionLoop(
  worker: DrainedInspectionWorker,
  options: {
    signal?: AbortSignal;
    intervalMs?: number;
    onEvent?: (event: InspectionLoopEvent) => void;
  } = {},
) {
  const intervalMs = options.intervalMs ?? 15000;
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 100 || intervalMs > 60000)
    throw new Error('Configure a bounded inspection polling interval.');
  const stopping = new AbortController();
  const signal = AbortSignal.any([stopping.signal, ...(options.signal ? [options.signal] : [])]);
  let closing: Promise<void> | undefined;
  const emit = (event: InspectionLoopEvent) => {
    try {
      options.onEvent?.(event);
    } catch {
      /* Logging cannot authorize inspection. */
    }
  };
  const done = (async () => {
    while (!signal.aborted) {
      let processed = false;
      try {
        const receipt = await worker.runOneAndDrain(signal);
        if (!signal.aborted) {
          processed = receipt !== null;
          emit(processed ? 'processed' : 'idle');
        }
      } catch {
        if (!signal.aborted) emit('deferred');
      }
      if (signal.aborted) break;
      if (processed) continue;
      await new Promise<void>((resolve) => {
        const finish = () => {
          clearTimeout(timer);
          signal.removeEventListener('abort', finish);
          resolve();
        };
        const timer = setTimeout(finish, intervalMs);
        // This worker is a standalone service; an idle poll keeps its process alive.
        signal.addEventListener('abort', finish, { once: true });
        if (signal.aborted) finish();
      });
    }
  })();
  return {
    done,
    close(): Promise<void> {
      stopping.abort();
      return (closing ??= (async () => {
        // Both stop admission synchronously; resources stay owned until actual worker work drains.
        await Promise.all([done, worker.close()]);
      })());
    },
  };
}
