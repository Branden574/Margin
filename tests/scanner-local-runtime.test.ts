import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { LocalKeyProvider } from '../apps/api/src/encryption';
import {
  startLocalScanner,
  LocalScannerCleanupPendingError,
} from '../apps/api/src/scanner/local-runtime';

const f = vi.hoisted(() => ({
  events: [] as string[],
  load: vi.fn(),
  admission: vi.fn(),
  preflight: vi.fn(),
  factory: vi.fn(),
  repo: vi.fn(),
  store: vi.fn(),
  claim: vi.fn(),
  retry: vi.fn(),
  complete: vi.fn(),
  get: vi.fn(),
  repoClose: vi.fn(),
  storeClose: vi.fn(),
  scannerClose: vi.fn(),
  ready: vi.fn(),
  inspect: vi.fn(),
}));
vi.mock('../apps/api/src/scanner/local-config', () => ({ loadLocalScannerConfig: f.load }));
vi.mock('../apps/api/src/canvas-local/maintenance', () => ({
  acquireCanvasRuntimeAdmission: f.admission,
}));
vi.mock('../apps/api/src/canvas-local/preflight', () => ({
  assertCanvasInspectorReady: f.preflight,
}));
vi.mock('../apps/api/src/scanner/index', () => ({ createIsolatedSourceScanner: f.factory }));
vi.mock('../apps/api/src/local-artifacts', () => ({
  LocalEncryptedArtifactRepository: class {
    constructor(options: unknown) {
      f.store(options);
    }
    get = f.get;
    close = f.storeClose;
  },
}));
vi.mock('../apps/api/src/ingestion/postgres', () => ({
  PostgresIngestionRepository: class {
    purpose = 'inspector';
    constructor(...args: unknown[]) {
      f.repo(...args);
    }
    claimNext = f.claim;
    retry = f.retry;
    complete = f.complete;
    close = f.repoClose;
  },
}));
let admission: AbortController,
  external: AbortController,
  wrappingKey: Buffer,
  configuration: any,
  dispose: ReturnType<typeof vi.fn>;
let leaseClose: ReturnType<typeof vi.fn>;
const originalKeyClose = LocalKeyProvider.prototype.close;
const scanner = { ready: f.ready, inspect: f.inspect, close: f.scannerClose };
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
};
const settled = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
beforeEach(() => {
  vi.clearAllMocks();
  f.events.length = 0;
  admission = new AbortController();
  external = new AbortController();
  wrappingKey = Buffer.alloc(32, 73);
  configuration = {
    database: {
      host: '127.0.0.1',
      port: 43210,
      database: 'margin_canvas',
      user: 'dedicated_inspector',
      password: 'private-fixture',
    },
    wrappingKey,
    wrappingKeyId: 'test-key',
    artifactDirectory: '/private/fixture/artifacts',
    instanceId: 'aeff13a9-bade-48ed-bc38-251e4da6baab',
    systemIdentifier: '1234567890',
    parserImage: 'sha256:' + 'a'.repeat(64),
    antivirusImage: 'sha256:' + 'b'.repeat(64),
    definitionsDirectory: '/private/fixture/definitions',
    docker: {
      executable: '/fixture/docker',
      socketPath: '/fixture/docker.sock',
      stateDirectory: '/private/fixture/state',
    },
    uid: 501,
    gid: 20,
  };
  dispose = vi.fn(() => {
    f.events.push('dispose');
    wrappingKey.fill(0);
  });
  leaseClose = vi.fn(async () => {
    f.events.push('admission-close');
  });
  f.load.mockImplementation(async () => {
    f.events.push('load');
    return { configuration, dispose };
  });
  f.admission.mockImplementation(async () => {
    f.events.push('admission');
    return { signal: admission.signal, close: leaseClose };
  });
  f.preflight.mockImplementation(async () => {
    f.events.push('preflight');
  });
  f.ready.mockImplementation(async () => {
    f.events.push('ready');
  });
  f.scannerClose.mockImplementation(async () => {
    f.events.push('scanner-close');
  });
  f.factory.mockImplementation(async (_config, signal, onCreated) => {
    onCreated(scanner);
    await f.ready(signal);
    return scanner;
  });
  f.claim.mockImplementation(async () => {
    f.events.push('claim');
    return null;
  });
  f.retry.mockResolvedValue(undefined);
  f.complete.mockResolvedValue(undefined);
  f.repoClose.mockImplementation(async () => {
    f.events.push('repo-close');
  });
  f.storeClose.mockImplementation(async () => {
    f.events.push('store-close');
  });
  vi.spyOn(LocalKeyProvider.prototype, 'close').mockImplementation(function (
    this: LocalKeyProvider,
  ) {
    f.events.push('keys-close');
    originalKeyClose.call(this);
  });
});
afterEach(() => vi.restoreAllMocks());

it('composes exact dedicated credentials, copies the key before disposal, and gates claims on real factory readiness', async () => {
  const ready = deferred<void>();
  f.ready.mockImplementation(() => ready.promise);
  const starting = startLocalScanner('/private/scanner/inspector.json', {
    signal: external.signal,
    intervalMs: 100,
  });
  await vi.waitFor(() => expect(f.ready).toHaveBeenCalledOnce());
  expect(f.claim).not.toHaveBeenCalled();
  expect(wrappingKey.every((v) => v === 0)).toBe(true);
  const keys = f.store.mock.calls[0][0].keyManagementProvider as LocalKeyProvider;
  const original = Buffer.alloc(32, 1),
    wrapped = await keys.wrapKey(original, 'fixture');
  expect(await keys.unwrapKey(wrapped, 'fixture')).toEqual(original);
  expect(f.preflight.mock.calls[0]).toEqual([
    configuration.database,
    {
      instanceId: configuration.instanceId,
      systemIdentifier: configuration.systemIdentifier,
      signal: expect.any(AbortSignal),
    },
  ]);
  expect(f.factory.mock.calls[0][0]).toEqual({
    parserImage: configuration.parserImage,
    antivirusImage: configuration.antivirusImage,
    definitionsDirectory: configuration.definitionsDirectory,
    docker: configuration.docker,
    uid: 501,
    gid: 20,
  });
  expect(f.repo.mock.calls[0]).toEqual([configuration.database, keys, 'inspector']);
  ready.resolve();
  const runtime = await starting;
  await vi.waitFor(() => expect(f.claim).toHaveBeenCalledOnce());
  await runtime.close();
  expect(f.events.slice(-6)).toEqual([
    'scanner-close',
    'repo-close',
    'store-close',
    'keys-close',
    'admission-close',
    'dispose',
  ]);
  await expect(keys.unwrapKey(wrapped, 'fixture')).rejects.toThrow('closed');
});
it('prior abort opens no files or database connection', async () => {
  await expect(
    startLocalScanner('/private/fixture', { signal: AbortSignal.abort() }),
  ).rejects.toMatchObject({ code: 'scanner_startup_refused' });
  expect(f.load).not.toHaveBeenCalled();
  expect(f.admission).not.toHaveBeenCalled();
});
it.each(['load', 'admission', 'preflight'] as const)(
  'scrubs %s startup failures and unwinds only acquired resources',
  async (stage) => {
    f[stage].mockRejectedValue(new Error('raw-private-secret-and-host'));
    let failure: unknown;
    try {
      await startLocalScanner('/fixture');
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({ code: 'scanner_startup_refused' });
    expect(String(failure) + JSON.stringify(failure)).not.toContain('raw-private');
    expect(failure).not.toHaveProperty('cause');
    expect(f.factory).not.toHaveBeenCalled();
    if (stage !== 'load') expect(dispose).toHaveBeenCalled();
    if (stage === 'preflight') expect(leaseClose).toHaveBeenCalledOnce();
  },
);
it('cancels startup before any claim and drains a late readiness provider', async () => {
  const ready = deferred<void>();
  f.ready.mockImplementation(() => ready.promise);
  const starting = startLocalScanner('/fixture', { signal: external.signal });
  await vi.waitFor(() => expect(f.ready).toHaveBeenCalledOnce());
  external.abort();
  let done = false;
  void starting.catch(() => {
    done = true;
  });
  await settled();
  expect(done).toBe(false);
  expect(f.scannerClose).not.toHaveBeenCalled();
  ready.resolve();
  await expect(starting).rejects.toMatchObject({ code: 'scanner_startup_refused' });
  expect(f.claim).not.toHaveBeenCalled();
  expect(leaseClose).toHaveBeenCalledOnce();
});
it.each(['close', 'external', 'admission'] as const)(
  'stops new claims on %s but retains dependencies until a late database claim settles',
  async (source) => {
    const claim = deferred<null>();
    f.claim.mockImplementation(() => claim.promise);
    const runtime = await startLocalScanner('/fixture', {
      signal: external.signal,
      intervalMs: 100,
    });
    await vi.waitFor(() => expect(f.claim).toHaveBeenCalledOnce());
    if (source === 'external') external.abort();
    if (source === 'admission') admission.abort();
    const closing = runtime.close();
    let closed = false;
    void closing.then(() => {
      closed = true;
    });
    await settled();
    expect(closed).toBe(false);
    expect(f.scannerClose).not.toHaveBeenCalled();
    expect(leaseClose).not.toHaveBeenCalled();
    claim.resolve(null);
    await closing;
    expect(f.claim).toHaveBeenCalledOnce();
    expect(f.scannerClose).toHaveBeenCalledOnce();
    expect(leaseClose).toHaveBeenCalledOnce();
  },
);
it('wipes late plaintext and waits for retry before closing scanner, storage or database', async () => {
  const metadata = { filename: 'fixture.pdf', mimeType: 'application/pdf' };
  f.claim.mockResolvedValueOnce({
    identity: {},
    receipt: {},
    expected: { metadata, plaintextBytes: 3, plaintextSha256: 'a'.repeat(64) },
    attempt: 1,
  });
  const read = deferred<{ bytes: Buffer; metadata: typeof metadata }>();
  f.get.mockImplementation(() => read.promise);
  const retry = deferred<void>();
  f.retry.mockImplementation(() => retry.promise);
  const runtime = await startLocalScanner('/fixture', { intervalMs: 100 });
  await vi.waitFor(() => expect(f.get).toHaveBeenCalledOnce());
  const closing = runtime.close();
  const bytes = Buffer.from('pdf');
  read.resolve({ bytes, metadata });
  await vi.waitFor(() => expect(f.retry).toHaveBeenCalledOnce());
  expect(bytes).toEqual(Buffer.alloc(3));
  expect(f.scannerClose).not.toHaveBeenCalled();
  retry.resolve();
  await closing;
  expect(f.inspect).not.toHaveBeenCalled();
  expect(f.complete).not.toHaveBeenCalled();
});
it('retains dependencies and admission on cleanup_pending, and explicit retry finishes only remaining stages', async () => {
  const runtime = await startLocalScanner('/fixture');
  f.scannerClose.mockRejectedValueOnce(new Error('private Docker response'));
  await expect(runtime.close()).rejects.toMatchObject({ code: 'cleanup_pending' });
  expect(f.repoClose).not.toHaveBeenCalled();
  expect(f.storeClose).not.toHaveBeenCalled();
  expect(leaseClose).not.toHaveBeenCalled();
  await runtime.close();
  expect(f.scannerClose).toHaveBeenCalledTimes(2);
  expect(f.repoClose).toHaveBeenCalledOnce();
  expect(leaseClose).toHaveBeenCalledOnce();
  await runtime.close();
  expect(f.scannerClose).toHaveBeenCalledTimes(2);
});
it('exposes a retryable owned cleanup handle after startup readiness and cleanup both fail', async () => {
  f.ready.mockRejectedValue(new Error('private readiness error'));
  f.scannerClose.mockRejectedValueOnce(new Error('private cleanup error'));
  let error: unknown;
  try {
    await startLocalScanner('/fixture');
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeInstanceOf(LocalScannerCleanupPendingError);
  expect(String(error) + JSON.stringify(error)).not.toContain('private');
  expect(f.claim).not.toHaveBeenCalled();
  expect(leaseClose).not.toHaveBeenCalled();
  await (error as LocalScannerCleanupPendingError).retryClose();
  expect(leaseClose).toHaveBeenCalledOnce();
});
it('retains keys and lease when storage cleanup fails, then retries without reclosing the scanner or repository', async () => {
  const runtime = await startLocalScanner('/fixture');
  f.storeClose.mockRejectedValueOnce(new Error('late store cleanup'));
  await expect(runtime.close()).rejects.toMatchObject({ code: 'cleanup_pending' });
  expect(leaseClose).not.toHaveBeenCalled();
  expect(f.events).not.toContain('keys-close');
  await runtime.close();
  expect(f.scannerClose).toHaveBeenCalledOnce();
  expect(f.repoClose).toHaveBeenCalledOnce();
  expect(f.storeClose).toHaveBeenCalledTimes(2);
});
