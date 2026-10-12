import { expect, it, vi } from 'vitest';
import { scannerCommand, ScannerProcessError } from '../apps/api/src/scanner/process';

it('sends exact bounded binary input and does not inherit Docker or loader overrides', async () => {
  vi.stubEnv('DOCKER_HOST', 'tcp://fixture.invalid:2375');
  vi.stubEnv('DOCKER_CONTEXT', 'foreign-fixture');
  vi.stubEnv('NODE_OPTIONS', '--title=untrusted-fixture');
  const bytes = Buffer.from(Array.from({ length: 180000 }, (_, i) => i % 256));
  try {
    const result = await scannerCommand(
      process.execPath,
      [
        '-e',
        `
      if(process.env.DOCKER_HOST || process.env.DOCKER_CONTEXT || process.env.NODE_OPTIONS) process.exit(9);
      process.stdin.pipe(process.stdout);
    `,
      ],
      { input: bytes },
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout.equals(bytes)).toBe(true);
    expect(bytes.some((v) => v !== 0)).toBe(true);
  } finally {
    vi.unstubAllEnvs();
  }
});
it('waits for a process that ignores TERM to actually die after cancellation', async () => {
  const controller = new AbortController();
  const start = Date.now();
  const promise = scannerCommand(
    process.execPath,
    ['-e', `process.on('SIGTERM',()=>{}); setInterval(()=>{},1000);`],
    { signal: controller.signal },
  );
  const timer = setTimeout(() => controller.abort(), 250);
  await expect(promise).rejects.toBeInstanceOf(ScannerProcessError);
  clearTimeout(timer);
  expect(Date.now() - start).toBeGreaterThanOrEqual(1100);
});
it.each(['stdout', 'stderr'])('bounds %s without exposing diagnostics', async (stream) => {
  await expect(
    scannerCommand(
      process.execPath,
      ['-e', `process.${stream}.write('PRIVATE_FIXTURE'.repeat(25000)); setInterval(()=>{},1000);`],
      { maximumOutput: 4096 },
    ),
  ).rejects.toThrow('within its bounds');
});
it('returns nonzero engine exits for strict protocol classification', async () => {
  const result = await scannerCommand(process.execPath, [
    '-e',
    `process.stdout.write('{"status":"rejected"}'); process.exitCode=10;`,
  ]);
  expect(result.exitCode).toBe(10);
  expect(result.stdout.toString()).toBe('{"status":"rejected"}');
});
it('rejects missing binaries, invalid bounds, prior cancellation and stdin early closure', async () => {
  await expect(scannerCommand('/not-a-margin-executable', [])).rejects.toBeInstanceOf(
    ScannerProcessError,
  );
  await expect(
    scannerCommand(process.execPath, [], { maximumOutput: 1024 ** 2 + 1 }),
  ).rejects.toBeInstanceOf(ScannerProcessError);
  await expect(
    scannerCommand(process.execPath, [], { signal: AbortSignal.abort() }),
  ).rejects.toBeInstanceOf(ScannerProcessError);
  await expect(
    scannerCommand(process.execPath, ['-e', 'process.exit(0)'], {
      input: Buffer.alloc(4 * 1024 * 1024),
    }),
  ).rejects.toBeInstanceOf(ScannerProcessError);
});
it('enforces its own deadline even without a caller abort', async () => {
  await expect(
    scannerCommand(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { timeoutMs: 100 }),
  ).rejects.toBeInstanceOf(ScannerProcessError);
});
