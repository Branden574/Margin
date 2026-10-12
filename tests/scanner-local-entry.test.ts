import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const f = vi.hoisted(() => ({ start: vi.fn() }));
vi.mock('../apps/api/src/scanner/local-runtime', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../apps/api/src/scanner/local-runtime')>()),
  startLocalScanner: f.start,
}));
let argv: string[],
  exitCode: typeof process.exitCode,
  intListeners: Function[],
  termListeners: Function[];
let out: ReturnType<typeof vi.spyOn>, err: ReturnType<typeof vi.spyOn>;
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
};
function interrupt() {
  for (const listener of process.listeners('SIGINT'))
    if (!intListeners.includes(listener)) listener.call(process, 'SIGINT');
}
beforeEach(() => {
  vi.resetModules();
  f.start.mockReset();
  argv = process.argv;
  exitCode = process.exitCode;
  process.exitCode = undefined;
  intListeners = process.listeners('SIGINT');
  termListeners = process.listeners('SIGTERM');
  process.argv = ['node', 'scanner-local-entry.ts', '/private/fixture/inspector.json'];
  out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});
afterEach(() => {
  for (const listener of process.listeners('SIGINT'))
    if (!intListeners.includes(listener)) process.off('SIGINT', listener);
  for (const listener of process.listeners('SIGTERM'))
    if (!termListeners.includes(listener)) process.off('SIGTERM', listener);
  process.argv = argv;
  process.exitCode = exitCode;
  vi.restoreAllMocks();
});
it('prints readiness only after successful startup and drains on Ctrl-C', async () => {
  const admission = new AbortController(),
    starting = deferred<any>();
  const close = vi.fn().mockResolvedValue(undefined);
  f.start.mockReturnValue(starting.promise);
  const entry = import('../apps/api/src/scanner-local-entry');
  await vi.waitFor(() => expect(f.start).toHaveBeenCalledOnce(), { timeout: 5000 });
  expect(out).not.toHaveBeenCalled();
  starting.resolve({ signal: admission.signal, close });
  await entry;
  expect(out).toHaveBeenCalledWith(expect.stringContaining('inspector is ready'));
  interrupt();
  await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
  await tick();
  expect(process.listeners('SIGINT')).toEqual(intListeners);
  expect(err).not.toHaveBeenCalled();
});
it('reports lease loss, stops admission and closes without printing native diagnostics', async () => {
  const admission = new AbortController();
  const close = vi.fn().mockResolvedValue(undefined);
  f.start.mockResolvedValue({ signal: admission.signal, close });
  await import('../apps/api/src/scanner-local-entry');
  admission.abort(new Error('private socket/credential failure'));
  await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
  await tick();
  expect(process.exitCode).toBe(1);
  expect(err.mock.calls.flat().join('')).toContain('maintenance admission was lost');
  expect(err.mock.calls.flat().join('')).not.toContain('private');
});
it('refuses startup without a readiness announcement or leaked exception', async () => {
  f.start.mockRejectedValue(new Error('private DB password and document'));
  await import('../apps/api/src/scanner-local-entry');
  expect(out).not.toHaveBeenCalled();
  expect(err.mock.calls.flat().join('')).toContain('startup was refused');
  expect(err.mock.calls.flat().join('')).not.toContain('private DB');
  expect(process.exitCode).toBe(1);
  expect(process.listeners('SIGINT')).toEqual(intListeners);
});
it('holds retry ownership after failed shutdown and a second Ctrl-C retries only cleanup', async () => {
  const { LocalScannerCleanupPendingError } = await import('../apps/api/src/scanner/local-runtime');
  const retry = vi.fn().mockResolvedValue(undefined);
  const close = vi.fn().mockRejectedValueOnce(new LocalScannerCleanupPendingError(retry));
  f.start.mockResolvedValue({ signal: new AbortController().signal, close });
  await import('../apps/api/src/scanner-local-entry');
  interrupt();
  await vi.waitFor(() =>
    expect(err).toHaveBeenCalledWith(expect.stringContaining('cleanup is pending')),
  );
  expect(process.listeners('SIGINT').length).toBe(intListeners.length + 1);
  interrupt();
  await vi.waitFor(() => expect(retry).toHaveBeenCalledOnce());
  await tick();
  expect(close).toHaveBeenCalledOnce();
  expect(process.listeners('SIGINT')).toEqual(intListeners);
});
it('retains a startup cleanup handle without advertising readiness and retries it in the same process', async () => {
  const { LocalScannerCleanupPendingError } = await import('../apps/api/src/scanner/local-runtime');
  const retry = vi.fn().mockResolvedValue(undefined);
  f.start.mockRejectedValue(new LocalScannerCleanupPendingError(retry));
  await import('../apps/api/src/scanner-local-entry');
  expect(out).not.toHaveBeenCalled();
  expect(process.exitCode).toBe(1);
  interrupt();
  await vi.waitFor(() => expect(retry).toHaveBeenCalledOnce());
  await tick();
  expect(process.listeners('SIGINT')).toEqual(intListeners);
});
it('forwards cancellation during startup and announces no readiness for an already-stopping runtime', async () => {
  const starting = deferred<any>(),
    close = vi.fn().mockResolvedValue(undefined);
  f.start.mockReturnValue(starting.promise);
  const entry = import('../apps/api/src/scanner-local-entry');
  await vi.waitFor(() => expect(f.start).toHaveBeenCalledOnce(), { timeout: 5000 });
  interrupt();
  expect(f.start.mock.calls[0][1].signal.aborted).toBe(true);
  starting.resolve({ signal: new AbortController().signal, close });
  await entry;
  await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
  await tick();
  expect(out).not.toHaveBeenCalled();
});
it('rejects extra CLI arguments without invoking runtime startup', async () => {
  process.argv.push('/extra');
  await import('../apps/api/src/scanner-local-entry');
  expect(f.start).not.toHaveBeenCalled();
  expect(out).not.toHaveBeenCalled();
  expect(process.exitCode).toBe(1);
});
