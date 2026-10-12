import { beforeEach, expect, it, vi } from 'vitest';
import { createIsolatedSourceScanner } from '../apps/api/src/scanner/index';
import type { IsolatedSourceScanner } from '../apps/api/src/scanner/source';
const mocks = vi.hoisted(() => ({ create: vi.fn(), definitions: vi.fn() }));
vi.mock('../apps/api/src/scanner/docker', () => ({
  createDockerScannerExecutor: mocks.create,
  ScannerExecutorError: class extends Error {},
}));
vi.mock('../infra/scanner/clamav/definitions.mjs', () => ({
  readScannerDefinitions: mocks.definitions,
}));
const options = {
  parserImage: 'sha256:' + 'a'.repeat(64),
  antivirusImage: 'sha256:' + 'b'.repeat(64),
  definitionsDirectory: '/fixture/definitions',
  uid: 501,
  gid: 20,
  docker: {
    executable: '/fixture/docker',
    socketPath: '/fixture/socket',
    stateDirectory: '/fixture/state',
  },
};
beforeEach(() => {
  vi.clearAllMocks();
  mocks.definitions.mockResolvedValue({
    directory: '/fixture/definitions/version',
    manifestSha256: 'c'.repeat(64),
  });
});
it('returns only after real-provider readiness and both sandbox contracts', async () => {
  const executor = {
    ready: vi.fn().mockResolvedValue(undefined),
    checkSandbox: vi.fn().mockResolvedValue(undefined),
    execute: vi.fn(),
    close: vi.fn().mockResolvedValue(undefined),
  };
  mocks.create.mockResolvedValue(executor);
  let owned: IsolatedSourceScanner | undefined;
  const scanner = await createIsolatedSourceScanner(
    options,
    new AbortController().signal,
    (value) => (owned = value),
  );
  expect(owned).toBe(scanner);
  expect(executor.checkSandbox).toHaveBeenCalledTimes(2);
  await scanner.close();
  expect(executor.close).toHaveBeenCalledOnce();
});
it('retains retryable cleanup ownership when startup and its first close both fail', async () => {
  const executor = {
    ready: vi.fn().mockRejectedValue(new Error('unavailable')),
    checkSandbox: vi.fn(),
    execute: vi.fn(),
    close: vi
      .fn()
      .mockRejectedValueOnce(new Error('cleanup pending'))
      .mockResolvedValueOnce(undefined),
  };
  mocks.create.mockResolvedValue(executor);
  let owned: IsolatedSourceScanner | undefined;
  await expect(
    createIsolatedSourceScanner(options, new AbortController().signal, (value) => (owned = value)),
  ).rejects.toThrow('cleanup pending');
  expect(owned).toBeDefined();
  await owned!.close();
  expect(executor.close).toHaveBeenCalledTimes(2);
  expect(executor.execute).not.toHaveBeenCalled();
});
