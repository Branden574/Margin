import { afterEach, expect, it, vi } from 'vitest';
import { startInspectionLoop } from '../apps/api/src/scanner/loop';
afterEach(() => vi.useRealTimers());
it('polls idle and failures with backoff, processes successive jobs without an idle delay, and emits no identifiers', async () => {
  vi.useFakeTimers();
  const events: string[] = [];
  const worker = {
    runOneAndDrain: vi
      .fn()
      .mockResolvedValueOnce(null)
      .mockRejectedValueOnce(new Error('private fixture'))
      .mockResolvedValueOnce({ id: 'private', status: 'ready', duplicate: false })
      .mockResolvedValue(null),
    close: vi.fn().mockResolvedValue(undefined),
  };
  const loop = startInspectionLoop(worker, {
    intervalMs: 1000,
    onEvent: (event) => events.push(event),
  });
  await vi.advanceTimersByTimeAsync(0);
  expect(worker.runOneAndDrain).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(999);
  expect(worker.runOneAndDrain).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(events).toEqual(['idle', 'deferred']);
  await vi.advanceTimersByTimeAsync(1000);
  expect(events).toEqual(['idle', 'deferred', 'processed', 'idle']);
  await loop.close();
  expect(worker.close).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(5000);
  expect(worker.runOneAndDrain).toHaveBeenCalledTimes(4);
});
it('waits for actual drained work before shutdown and signals the active operation', async () => {
  let finish!: (v: null) => void;
  const pending = new Promise<null>((resolve) => (finish = resolve));
  const worker = {
    runOneAndDrain: vi.fn((_signal: AbortSignal) => pending),
    close: vi.fn(() => pending.then(() => {})),
  };
  const loop = startInspectionLoop(worker);
  await Promise.resolve();
  const signal = worker.runOneAndDrain.mock.calls[0][0];
  let stopped = false;
  const closed = loop.close().then(() => (stopped = true));
  expect(signal.aborted).toBe(true);
  await Promise.resolve();
  expect(stopped).toBe(false);
  finish(null);
  await closed;
  expect(stopped).toBe(true);
});
it('does no work after prior cancellation, and invalid intervals do not start work', async () => {
  const worker = {
    runOneAndDrain: vi.fn().mockResolvedValue(null),
    close: vi.fn().mockResolvedValue(undefined),
  };
  const loop = startInspectionLoop(worker, { signal: AbortSignal.abort() });
  await loop.done;
  await loop.close();
  expect(worker.runOneAndDrain).not.toHaveBeenCalled();
  expect(() => startInspectionLoop(worker, { intervalMs: 0 })).toThrow();
});
