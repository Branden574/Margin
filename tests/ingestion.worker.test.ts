import { afterEach, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  SourceInspectionWorker,
  type InspectionClaim,
  type PostgresIngestionRepository,
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
  expect(fixture.retry).toHaveBeenCalledOnce();
  expect(fixture.complete).not.toHaveBeenCalled();
  expect(scanner.inspect).not.toHaveBeenCalled();
  await expect(worker.runOne()).rejects.toMatchObject({ code: 'inspection_busy' });
  const plaintext = Buffer.from('late private fixture bytes');
  finish({ bytes: plaintext, metadata: claim.expected.metadata });
  await vi.advanceTimersByTimeAsync(1);
  expect(plaintext.every((v) => v === 0)).toBe(true);
  expect(await worker.runOne()).toBeNull();
});
