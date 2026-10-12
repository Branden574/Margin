import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import { startCanvasLocalWorkers, type CanvasLocalJob } from '../apps/api/src/canvas-local/workers';
import { LocalKeyProvider } from '../apps/api/src/encryption';

afterEach(() => vi.useRealTimers());
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

describe('persistent Canvas worker admission and shutdown', () => {
  it('runs provisioning and materialization in sequence without overlapping rounds', async () => {
    vi.useFakeTimers();
    const first = deferred();
    const provision = vi
      .fn()
      .mockImplementationOnce(() => first.promise)
      .mockResolvedValue(null);
    const materialize = vi.fn().mockResolvedValue(null);
    const loop = startCanvasLocalWorkers(
      [
        { name: 'provision', run: provision },
        { name: 'materialize', run: materialize },
      ],
      { intervalMs: 100 },
    );
    await vi.advanceTimersByTimeAsync(500);
    expect(provision).toHaveBeenCalledTimes(1);
    expect(materialize).not.toHaveBeenCalled();
    first.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(materialize).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(100);
    expect(provision).toHaveBeenCalledTimes(2);
    expect(materialize).toHaveBeenCalledTimes(2);
    await loop.close();
    await vi.advanceTimersByTimeAsync(1000);
    expect(provision).toHaveBeenCalledTimes(2);
  });

  it('keeps timed-out underlying work admitted until it settles, and close aborts before draining', async () => {
    vi.useFakeTimers();
    const active = deferred();
    let signal!: AbortSignal;
    const materialize = vi.fn().mockResolvedValue(null);
    const loop = startCanvasLocalWorkers(
      [
        {
          name: 'provision',
          run: async (value) => {
            signal = value;
            await active.promise;
          },
        },
        { name: 'materialize', run: materialize },
      ],
      { jobDeadlineMs: 100, intervalMs: 100 },
    );
    await vi.advanceTimersByTimeAsync(500);
    expect(signal.aborted).toBe(true);
    expect(materialize).not.toHaveBeenCalled();
    let closed = false;
    const closing = loop.close().then(() => {
      closed = true;
    });
    await vi.advanceTimersByTimeAsync(1000);
    expect(closed).toBe(false);
    active.resolve();
    await closing;
    expect(materialize).not.toHaveBeenCalled();
    await loop.close();
  });

  it('only logs static worker status and continues other jobs after failure', async () => {
    vi.useFakeTimers();
    const event = vi.fn(() => {
      throw new Error('logging unavailable');
    });
    const materialize = vi.fn().mockResolvedValue(null);
    const loop = startCanvasLocalWorkers(
      [
        {
          name: 'provision',
          run: async () => {
            throw new Error('secret database URL and document text');
          },
        },
        { name: 'materialize', run: materialize },
      ],
      { intervalMs: 100, onEvent: event },
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(event).toHaveBeenCalledExactlyOnceWith({ worker: 'provision', status: 'failed' });
    expect(materialize).toHaveBeenCalledTimes(1);
    await loop.close();
  });

  it('interrupts an idle poll immediately and rejects unbounded or incomplete schedules', async () => {
    vi.useFakeTimers();
    const jobs: CanvasLocalJob[] = [
      { name: 'provision', run: async () => null },
      { name: 'materialize', run: async () => null },
    ];
    expect(() => startCanvasLocalWorkers(jobs, { intervalMs: 0 })).toThrow();
    expect(() => startCanvasLocalWorkers(jobs, { jobDeadlineMs: Infinity })).toThrow();
    expect(() => startCanvasLocalWorkers([jobs[0], jobs[0]])).toThrow();
    const loop = startCanvasLocalWorkers(jobs, { intervalMs: 60000 });
    await vi.advanceTimersByTimeAsync(0);
    await loop.close();
    expect(vi.getTimerCount()).toBe(0);
  });
});

it('closes the local wrapping provider without modifying the caller key, and refuses further crypto', async () => {
  const callerKey = randomBytes(32),
    expected = Buffer.from(callerKey),
    dataKey = randomBytes(32);
  const provider = new LocalKeyProvider(callerKey, 'canvas-private-test-key');
  const envelope = await provider.wrapKey(dataKey, 'test');
  expect(await provider.unwrapKey(envelope, 'test')).toEqual(dataKey);
  provider.close();
  provider.close();
  expect(callerKey).toEqual(expected);
  await expect(provider.wrapKey(dataKey, 'test')).rejects.toThrow('closed');
  await expect(provider.unwrapKey(envelope, 'test')).rejects.toThrow('closed');
  const restarted = new LocalKeyProvider(callerKey, 'canvas-private-test-key');
  expect(await restarted.unwrapKey(envelope, 'test')).toEqual(dataKey);
  restarted.close();
  callerKey.fill(0);
  expected.fill(0);
  dataKey.fill(0);
});
