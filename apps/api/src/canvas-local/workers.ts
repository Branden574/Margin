export type CanvasWorkerName = 'provision' | 'materialize';
export interface CanvasLocalJob {
  name: CanvasWorkerName;
  run(signal: AbortSignal): Promise<unknown>;
}
export interface CanvasWorkerEvent {
  worker: CanvasWorkerName;
  status: 'failed';
}

/** One job at a time. Cancellation never frees admission before the actual job settles. */
export function startCanvasLocalWorkers(
  jobs: readonly CanvasLocalJob[],
  options: {
    intervalMs?: number;
    jobDeadlineMs?: number;
    onEvent?: (event: CanvasWorkerEvent) => void;
  } = {},
): { close(): Promise<void> } {
  const intervalMs = options.intervalMs ?? 1000;
  const jobDeadlineMs = options.jobDeadlineMs ?? 90000;
  if (
    !Number.isSafeInteger(intervalMs) ||
    intervalMs < 100 ||
    intervalMs > 60000 ||
    !Number.isSafeInteger(jobDeadlineMs) ||
    jobDeadlineMs < 100 ||
    jobDeadlineMs > 540000 ||
    jobs.length !== 2 ||
    new Set(jobs.map((job) => job.name)).size !== 2 ||
    jobs.some((job) => !['provision', 'materialize'].includes(job.name))
  )
    throw new Error('Configure both local Canvas workers with bounded scheduling intervals.');
  const queue = jobs.map((job) => ({ ...job }));
  const stopping = new AbortController();
  const done = (async () => {
    while (!stopping.signal.aborted) {
      for (const job of queue) {
        if (stopping.signal.aborted) break;
        const deadline = new AbortController();
        const timer = setTimeout(() => deadline.abort(), jobDeadlineMs);
        timer.unref();
        try {
          await job.run(AbortSignal.any([stopping.signal, deadline.signal]));
        } catch {
          if (!stopping.signal.aborted) {
            // Never forward provider exceptions, document identifiers or user content to logs.
            try {
              options.onEvent?.({ worker: job.name, status: 'failed' });
            } catch {
              /* logging is non-authoritative */
            }
          }
        } finally {
          clearTimeout(timer);
        }
      }
      if (stopping.signal.aborted) break;
      await new Promise<void>((resolve) => {
        const finish = () => {
          clearTimeout(timer);
          stopping.signal.removeEventListener('abort', finish);
          resolve();
        };
        const timer = setTimeout(finish, intervalMs);
        timer.unref();
        stopping.signal.addEventListener('abort', finish, { once: true });
      });
    }
  })();
  return {
    close() {
      stopping.abort();
      return done;
    },
  };
}
