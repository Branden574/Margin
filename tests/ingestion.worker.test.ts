import { afterEach, expect, it, vi } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import {
  SourceInspectionWorker,
  type InspectionClaim,
  type PostgresIngestionRepository,
  type SourceScanner,
} from '../apps/api/src/ingestion/index';
const claim: InspectionClaim = {
  identity: {
    organizationId: randomUUID(),
    documentId: randomUUID(),
    versionId: randomUUID(),
    artifactId: randomUUID(),
    kind: 'source-pdf',
  },
  claimId: randomUUID(),
  token: 'a'.repeat(64),
  attempt: 1,
  expiresAt: Date.now() + 120000,
  receipt: {
    objectVersionId: 'synthetic-version',
    etag: 'synthetic-etag',
    ciphertextSha256: 'b'.repeat(64),
    storedBytes: 100,
  },
  expected: {
    metadata: { name: 'Synthetic.pdf', mimeType: 'application/pdf' },
    plaintextBytes: 1,
    plaintextSha256: 'c'.repeat(64),
  },
};
afterEach(() => vi.useRealTimers());
it('holds its execution slot when a synthetic transport ignores abort and clears late plaintext', async () => {
  vi.useFakeTimers();
  let finish!: (v: { bytes: Buffer; metadata: typeof claim.expected.metadata }) => void;
  const pending = new Promise<{ bytes: Buffer; metadata: typeof claim.expected.metadata }>(
    (r) => (finish = r),
  );
  const fixture = {
    purpose: 'inspector',
    claimNext: vi.fn().mockResolvedValueOnce(claim).mockResolvedValue(null),
    retry: vi.fn().mockResolvedValue(undefined),
    complete: vi.fn(),
  };
  const scanner = { inspect: vi.fn() };
  const worker = new SourceInspectionWorker(
    fixture as unknown as PostgresIngestionRepository,
    { get: () => pending },
    scanner,
  );
  const outcome = worker.runOne().then(
    (value) => ({ value }),
    (error) => ({ error }),
  );
  await vi.advanceTimersByTimeAsync(20001);
  expect(await outcome).toMatchObject({ error: { code: 'operation_aborted' } });
  expect(fixture.retry).not.toHaveBeenCalled();
  expect(fixture.complete).not.toHaveBeenCalled();
  expect(scanner.inspect).not.toHaveBeenCalled();
  await expect(worker.runOne()).rejects.toMatchObject({ code: 'inspection_busy' });
  const plaintext = Buffer.from('late private fixture bytes');
  finish({ bytes: plaintext, metadata: claim.expected.metadata });
  await vi.advanceTimersByTimeAsync(1);
  expect(plaintext.every((v) => v === 0)).toBe(true);
  expect(fixture.retry).toHaveBeenCalledOnce();
  expect(await worker.runOne()).toBeNull();
  await worker.close();
});

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}
const clean = {
  verdict: 'ready',
  engine: 'synthetic',
  engineVersion: '1',
  definitionsVersion: 'test',
  pageCount: 1,
  pageGeometry: [{ index: 0, width: 612, height: 792 }],
  reason: 'clean',
} as const;
const receipt = { id: randomUUID(), status: 'ready', duplicate: false } as const;
function fixture() {
  const bytes = Buffer.from('private synthetic PDF contents');
  const current = {
    ...claim,
    expected: {
      ...claim.expected,
      plaintextBytes: bytes.length,
      plaintextSha256: createHash('sha256').update(bytes).digest('hex'),
    },
  };
  const repository = {
    purpose: 'inspector',
    claimNext: vi.fn().mockResolvedValue(current),
    complete: vi.fn().mockResolvedValue(receipt),
    retry: vi.fn().mockResolvedValue(undefined),
    close: vi.fn(),
  };
  const storage = {
    get: vi.fn().mockResolvedValue({ bytes, metadata: current.expected.metadata }),
    close: vi.fn(),
  };
  const scanner = {
    ready: vi.fn().mockResolvedValue(undefined),
    inspect: vi.fn().mockResolvedValue(clean),
    close: vi.fn(),
  };
  const worker = new SourceInspectionWorker(
    repository as unknown as PostgresIngestionRepository,
    storage,
    scanner,
  );
  return { bytes, current, repository, storage, scanner, worker };
}
async function flush() {
  for (let index = 0; index < 20; index++) await Promise.resolve();
}
function observe<T>(promise: Promise<T>) {
  return promise.then(
    (value) => ({ value }),
    (error) => ({ error }),
  );
}

it('checks readiness before every claim and does not consume attempts while unavailable', async () => {
  const f = fixture();
  f.scanner.ready.mockRejectedValue(new Error('synthetic stale definitions'));
  for (let index = 0; index < 3; index++)
    await expect(f.worker.runOne()).rejects.toThrow('synthetic stale definitions');
  expect(f.scanner.ready).toHaveBeenCalledTimes(3);
  expect(f.repository.claimNext).not.toHaveBeenCalled();
  expect(f.repository.retry).not.toHaveBeenCalled();
  expect(f.storage.get).not.toHaveBeenCalled();
  await f.worker.close();
});

it('drains an uncooperative readiness check and never claims after external cancellation', async () => {
  const f = fixture(),
    readiness = deferred<void>(),
    abort = new AbortController();
  f.scanner.ready.mockReturnValue(readiness.promise);
  const outcome = observe(f.worker.runOne(abort.signal));
  await flush();
  abort.abort();
  expect(await outcome).toMatchObject({ error: { code: 'operation_aborted' } });
  const close = f.worker.close();
  expect(f.worker.close()).toBe(close);
  let drained = false;
  void close.then(() => {
    drained = true;
  });
  await flush();
  expect(drained).toBe(false);
  readiness.resolve();
  await close;
  expect(f.repository.claimNext).not.toHaveBeenCalled();
  expect(f.repository.retry).not.toHaveBeenCalled();
});

it('times out readiness without claiming or admitting overlapping work, and drains its real promise', async () => {
  vi.useFakeTimers();
  const f = fixture(),
    readiness = deferred<void>();
  f.scanner.ready.mockReturnValue(readiness.promise);
  const outcome = observe(f.worker.runOne());
  await vi.advanceTimersByTimeAsync(10001);
  expect(await outcome).toMatchObject({ error: { code: 'operation_aborted' } });
  await expect(f.worker.runOne()).rejects.toMatchObject({ code: 'inspection_busy' });
  expect(f.repository.claimNext).not.toHaveBeenCalled();
  readiness.resolve();
  await f.worker.close();
});

it('retains a late claim and retries it only after acquisition, draining retry before closing', async () => {
  const f = fixture(),
    claimed = deferred<InspectionClaim | null>(),
    retried = deferred<void>();
  const abort = new AbortController();
  f.repository.claimNext.mockReturnValue(claimed.promise);
  f.repository.retry.mockReturnValue(retried.promise);
  const outcome = observe(f.worker.runOne(abort.signal));
  await flush();
  expect(f.repository.claimNext).toHaveBeenCalledOnce();
  abort.abort();
  expect(await outcome).toMatchObject({ error: { code: 'operation_aborted' } });
  const close = f.worker.close();
  let drained = false;
  void close.then(() => {
    drained = true;
  });
  await flush();
  expect(f.repository.retry).not.toHaveBeenCalled();
  expect(drained).toBe(false);
  claimed.resolve(f.current);
  await flush();
  expect(f.repository.retry).toHaveBeenCalledWith(f.current, 30);
  expect(drained).toBe(false);
  expect(f.storage.get).not.toHaveBeenCalled();
  expect(f.repository.complete).not.toHaveBeenCalled();
  retried.resolve();
  await close;
  expect(drained).toBe(true);
});

it('retains a timed-out claim operation, without retrying an unknown failed acquisition', async () => {
  vi.useFakeTimers();
  const f = fixture(),
    claimed = deferred<InspectionClaim | null>();
  f.repository.claimNext.mockReturnValue(claimed.promise);
  const outcome = observe(f.worker.runOne());
  await vi.advanceTimersByTimeAsync(15001);
  expect(await outcome).toMatchObject({ error: { code: 'operation_aborted' } });
  await expect(f.worker.runOne()).rejects.toMatchObject({ code: 'inspection_busy' });
  claimed.reject(new Error('unknown claim commit'));
  await f.worker.close();
  expect(f.repository.retry).not.toHaveBeenCalled();
  expect(f.repository.complete).not.toHaveBeenCalled();
});

it.each(['external', 'close'] as const)(
  'drains a late storage result after %s, wipes it, and skips scanning',
  async (mode) => {
    const f = fixture(),
      recovered = deferred<{ bytes: Buffer; metadata: typeof claim.expected.metadata }>(),
      abort = new AbortController();
    f.storage.get.mockReturnValue(recovered.promise);
    const outcome = observe(f.worker.runOne(abort.signal));
    await flush();
    expect(f.storage.get).toHaveBeenCalledOnce();
    if (mode === 'external') abort.abort();
    else void f.worker.close();
    expect(await outcome).toMatchObject({ error: { code: 'operation_aborted' } });
    expect(f.storage.get.mock.calls[0][2].aborted).toBe(true);
    const close = f.worker.close();
    let drained = false;
    void close.then(() => {
      drained = true;
    });
    await flush();
    expect(drained).toBe(false);
    expect(f.repository.retry).not.toHaveBeenCalled();
    recovered.resolve({ bytes: f.bytes, metadata: f.current.expected.metadata });
    await close;
    expect(f.bytes.every((value) => value === 0)).toBe(true);
    expect(f.scanner.inspect).not.toHaveBeenCalled();
    expect(f.repository.complete).not.toHaveBeenCalled();
    expect(f.repository.retry).toHaveBeenCalledOnce();
  },
);

it.each(['external', 'close', 'deadline'] as const)(
  'retains scanner plaintext after %s until actual settlement and never promotes a late mutated result',
  async (mode) => {
    vi.useFakeTimers();
    const f = fixture(),
      scanned = deferred<Awaited<ReturnType<SourceScanner['inspect']>>>();
    const abort = new AbortController();
    f.scanner.inspect.mockReturnValue(scanned.promise);
    const original = Buffer.from(f.bytes);
    const outcome = observe(f.worker.runOne(abort.signal));
    await flush();
    expect(f.scanner.inspect).toHaveBeenCalledOnce();
    if (mode === 'external') abort.abort();
    else if (mode === 'deadline') await vi.advanceTimersByTimeAsync(45001);
    else void f.worker.close();
    expect(await outcome).toMatchObject({ error: { code: 'operation_aborted' } });
    expect(f.bytes).toEqual(original);
    expect(f.scanner.inspect.mock.calls[0][1].aborted).toBe(true);
    expect(f.repository.complete).not.toHaveBeenCalled();
    expect(f.repository.retry).not.toHaveBeenCalled();
    if (mode !== 'close')
      await expect(f.worker.runOne()).rejects.toMatchObject({ code: 'inspection_busy' });
    let drained = false;
    const close = f.worker.close().then(() => {
      drained = true;
    });
    await flush();
    expect(drained).toBe(false);
    f.bytes.fill(7); // An ignored abort cannot turn this late scanner answer into an approval.
    scanned.resolve({ ...clean, pageGeometry: [...clean.pageGeometry] });
    await close;
    expect(f.bytes.every((value) => value === 0)).toBe(true);
    expect(f.repository.complete).not.toHaveBeenCalled();
    expect(f.repository.retry).toHaveBeenCalledOnce();
    for (const provider of [f.repository, f.storage, f.scanner])
      expect(provider.close).not.toHaveBeenCalled();
  },
);

it.each(['success', 'unknown-error'] as const)(
  'drains completion after cancellation with %s and never races its retry',
  async (result) => {
    const f = fixture(),
      completing = deferred<typeof receipt>(),
      abort = new AbortController();
    f.repository.complete.mockReturnValue(completing.promise);
    const outcome = observe(f.worker.runOne(abort.signal));
    await flush();
    expect(f.repository.complete).toHaveBeenCalledOnce();
    expect(f.bytes.every((value) => value === 0)).toBe(true);
    abort.abort();
    expect(await outcome).toMatchObject({ error: { code: 'operation_aborted' } });
    const close = f.worker.close();
    let drained = false;
    void close.then(() => {
      drained = true;
    });
    await flush();
    expect(drained).toBe(false);
    expect(f.repository.retry).not.toHaveBeenCalled();
    if (result === 'success') completing.resolve(receipt);
    else {
      f.repository.retry.mockRejectedValue(new Error('claim already committed or stale'));
      completing.reject(new Error('unknown commit acknowledgement'));
    }
    await close;
    expect(f.repository.retry).toHaveBeenCalledTimes(result === 'success' ? 0 : 1);
    expect(f.repository.complete).toHaveBeenCalledOnce();
  },
);

it('bounds an uncooperative completion deadline but does not release admission or retry until it settles', async () => {
  vi.useFakeTimers();
  const f = fixture(),
    completing = deferred<typeof receipt>();
  f.repository.complete.mockReturnValue(completing.promise);
  const outcome = observe(f.worker.runOne());
  await vi.advanceTimersByTimeAsync(15001);
  expect(await outcome).toMatchObject({ error: { code: 'operation_aborted' } });
  await expect(f.worker.runOne()).rejects.toMatchObject({ code: 'inspection_busy' });
  expect(f.repository.retry).not.toHaveBeenCalled();
  completing.resolve(receipt);
  await f.worker.close();
  expect(f.repository.retry).not.toHaveBeenCalled();
});

it('drains retry after a scanner failure and releases plaintext before slow retry', async () => {
  const f = fixture(),
    retried = deferred<void>(),
    abort = new AbortController();
  f.scanner.inspect.mockRejectedValue(new Error('synthetic scanner failure'));
  f.repository.retry.mockReturnValue(retried.promise);
  await expect(f.worker.runOne(abort.signal)).rejects.toThrow('synthetic scanner failure');
  expect(f.repository.retry).toHaveBeenCalledOnce();
  expect(f.bytes.every((value) => value === 0)).toBe(true);
  abort.abort();
  const close = f.worker.close();
  let drained = false;
  void close.then(() => {
    drained = true;
  });
  await flush();
  expect(drained).toBe(false);
  retried.reject(new Error('queue retry unavailable'));
  await close;
  expect(f.repository.complete).not.toHaveBeenCalled();
});

it('rejects already cancelled and closed work before touching providers', async () => {
  const f = fixture(),
    abort = new AbortController();
  abort.abort();
  await expect(f.worker.runOne(abort.signal)).rejects.toMatchObject({ code: 'operation_aborted' });
  await f.worker.close();
  await expect(f.worker.runOne()).rejects.toMatchObject({ code: 'inspection_closed' });
  expect(f.scanner.ready).not.toHaveBeenCalled();
  expect(f.repository.claimNext).not.toHaveBeenCalled();
});

it('completes a ready source and clears plaintext before completion', async () => {
  const f = fixture();
  f.repository.complete.mockImplementation(async () => {
    expect(f.bytes.every((value) => value === 0)).toBe(true);
    return receipt;
  });
  expect(await f.worker.runOne()).toEqual(receipt);
  expect(f.scanner.ready.mock.invocationCallOrder[0]).toBeLessThan(
    f.repository.claimNext.mock.invocationCallOrder[0],
  );
  expect(f.repository.retry).not.toHaveBeenCalled();
  f.repository.claimNext.mockResolvedValue(null);
  expect(await f.worker.runOne()).toBeNull();
  await f.worker.close();
});

it('keeps the scheduler result pending after caller abort until actual provider and retry drain', async () => {
  const f = fixture();
  const provider = deferred<typeof clean>();
  f.scanner.inspect.mockImplementationOnce(() => provider.promise);
  const controller = new AbortController();
  let settled = false;
  const outcome = f.worker.runOneAndDrain(controller.signal).then(
    (value) => {
      settled = true;
      return { value };
    },
    (error) => {
      settled = true;
      return { error };
    },
  );
  await vi.waitFor(() => expect(f.scanner.inspect).toHaveBeenCalledOnce());
  controller.abort();
  await Promise.resolve();
  await Promise.resolve();
  expect(settled).toBe(false);
  provider.resolve(clean);
  expect(await outcome).toHaveProperty('error');
  expect(f.repository.complete).not.toHaveBeenCalled();
  expect(f.repository.retry).toHaveBeenCalledOnce();
  await f.worker.close();
});
