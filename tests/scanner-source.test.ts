import { beforeEach, expect, it, vi } from 'vitest';
import {
  IsolatedSourceScanner,
  type IsolatedScannerExecutor,
} from '../apps/api/src/scanner/source';
import { PARSER_VERSION } from '../apps/api/src/scanner/protocol';
const readDefinitions = vi.hoisted(() => vi.fn());
vi.mock('../infra/scanner/clamav/definitions.mjs', () => ({
  readScannerDefinitions: readDefinitions,
}));
const snapshot = { directory: '/fixture/definitions/one', manifestSha256: 'a'.repeat(64) };
const parser = {
  protocol: 'margin-pdf-inspection-v1',
  engine: 'qpdf-pdfjs',
  engineVersion: PARSER_VERSION,
  status: 'valid',
  reason: 'clean',
  pageCount: 1,
  pageGeometry: [{ index: 0, width: 612, height: 792 }],
};
const antivirus = {
  protocol: 'margin-av-inspection-v1',
  engine: 'clamav',
  engineVersion: '1.4.6',
  status: 'clean',
};
const output = (value: unknown, exitCode = 0) => ({
  stdout: Buffer.from(JSON.stringify(value)),
  exitCode,
});
function fixture() {
  const executor = {
    ready: vi.fn().mockResolvedValue(undefined),
    checkSandbox: vi.fn().mockResolvedValue(undefined),
    execute: vi
      .fn()
      .mockImplementation(async (sandbox) =>
        output(sandbox.kind === 'parser' ? parser : antivirus),
      ),
    close: vi.fn().mockResolvedValue(undefined),
  };
  const scanner = new IsolatedSourceScanner(executor, {
    parserImage: 'sha256:' + 'b'.repeat(64),
    antivirusImage: 'sha256:' + 'c'.repeat(64),
    definitionsDirectory: '/fixture',
    uid: 501,
    gid: 20,
  });
  return { executor, scanner, signal: new AbortController().signal };
}
beforeEach(() => {
  readDefinitions.mockReset().mockResolvedValue(snapshot);
});
it('checks both real image contracts and definitions before work is claimed', async () => {
  const { scanner, executor, signal } = fixture();
  await scanner.ready(signal);
  expect(executor.ready).toHaveBeenCalledOnce();
  expect(executor.checkSandbox).toHaveBeenCalledTimes(2);
  expect(readDefinitions).toHaveBeenCalledWith('/fixture');
  expect(executor.execute).not.toHaveBeenCalled();
  await scanner.close();
});
it('requires parser and AV approval, preserves source bytes and wipes returned engine output', async () => {
  const { scanner, executor, signal } = fixture();
  const bytes = Buffer.from('source-fixture');
  const results = [output(parser), output(antivirus)];
  executor.execute.mockReset().mockResolvedValueOnce(results[0]).mockResolvedValueOnce(results[1]);
  const verdict = await scanner.inspect(bytes, signal);
  expect(verdict).toMatchObject({
    verdict: 'ready',
    reason: 'clean',
    pageCount: 1,
    pageGeometry: parser.pageGeometry,
    definitionsVersion: snapshot.manifestSha256,
  });
  expect(executor.execute.mock.calls.map(([v]) => v.kind)).toEqual(['parser', 'antivirus']);
  expect(results.every((v) => v.stdout.every((byte) => byte === 0))).toBe(true);
  expect(bytes.toString()).toBe('source-fixture');
  await scanner.close();
});
it('uses the exact current snapshot at AV launch after a publication during parsing', async () => {
  const { scanner, executor, signal } = fixture();
  readDefinitions.mockResolvedValueOnce(snapshot).mockResolvedValueOnce({
    directory: '/fixture/definitions/two',
    manifestSha256: 'd'.repeat(64),
  });
  expect((await scanner.inspect(Buffer.from('source'), signal)).definitionsVersion).toBe(
    'd'.repeat(64),
  );
  expect(executor.execute.mock.calls[1][0].definitionsDirectory).toBe('/fixture/definitions/two');
  await scanner.close();
});
it('rejects active content without launching AV and does not invent a definition scan', async () => {
  const { scanner, executor, signal } = fixture();
  const { pageGeometry, ...rejected } = parser;
  executor.execute.mockResolvedValueOnce(
    output({ ...rejected, status: 'rejected', reason: 'unsupported', pageCount: 0 }, 10),
  );
  expect(await scanner.inspect(Buffer.from('source'), signal)).toMatchObject({
    verdict: 'rejected',
    reason: 'unsupported',
    pageCount: 0,
    definitionsVersion: 'none',
  });
  expect(executor.execute).toHaveBeenCalledOnce();
  await scanner.close();
});
it.each(['malware', 'unsupported'])(
  'persists AV rejection %s without page geometry',
  async (status) => {
    const { scanner, executor, signal } = fixture();
    executor.execute
      .mockReset()
      .mockResolvedValueOnce(output(parser))
      .mockResolvedValueOnce(output({ ...antivirus, status }, 10));
    const verdict = await scanner.inspect(Buffer.from('source'), signal);
    expect(verdict).toMatchObject({ verdict: 'rejected', reason: status, pageCount: 0 });
    expect(verdict.pageGeometry).toBeUndefined();
    await scanner.close();
  },
);
it('stale definitions before claim or after parsing prevent AV approval', async () => {
  const { scanner, executor, signal } = fixture();
  readDefinitions.mockRejectedValueOnce(new Error('stale'));
  await expect(scanner.ready(signal)).rejects.toThrow();
  expect(executor.execute).not.toHaveBeenCalled();
  readDefinitions.mockResolvedValueOnce(snapshot).mockRejectedValueOnce(new Error('stale'));
  await expect(scanner.inspect(Buffer.from('source'), signal)).rejects.toThrow();
  expect(executor.execute).toHaveBeenCalledOnce();
  await scanner.close();
});
it('retains the slot and shutdown until cancelled provider work actually settles', async () => {
  const { scanner, executor } = fixture();
  let finish!: (v: ReturnType<typeof output>) => void;
  executor.execute.mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)));
  const controller = new AbortController(),
    pending = scanner.inspect(Buffer.from('source'), controller.signal);
  const outcome = pending.catch((e) => e);
  await vi.waitFor(() => expect(executor.execute).toHaveBeenCalledOnce());
  controller.abort();
  await expect(scanner.ready(new AbortController().signal)).rejects.toThrow();
  let closed = false;
  const closing = scanner.close().then(() => {
    closed = true;
  });
  await Promise.resolve();
  expect(closed).toBe(false);
  expect(executor.close).not.toHaveBeenCalled();
  const returned = output(parser);
  finish(returned);
  expect(await outcome).toBeInstanceOf(Error);
  await closing;
  expect(returned.stdout.every((v) => v === 0)).toBe(true);
  expect(executor.execute).toHaveBeenCalledOnce();
});
it('keeps resource-limit and mismatched output quarantined, and retries uncertain cleanup on close', async () => {
  const { scanner, executor, signal } = fixture();
  executor.execute.mockResolvedValueOnce(
    output({ ...parser, status: 'rejected', reason: 'resource_limit', pageCount: 0 }, 10),
  );
  await expect(scanner.inspect(Buffer.from('source'), signal)).rejects.toThrow('quarantined');
  executor.close
    .mockRejectedValueOnce(new Error('cleanup pending'))
    .mockResolvedValueOnce(undefined);
  await expect(scanner.close()).rejects.toThrow('cleanup pending');
  await scanner.close();
  expect(executor.close).toHaveBeenCalledTimes(2);
  await expect(scanner.ready(signal)).rejects.toThrow();
});
