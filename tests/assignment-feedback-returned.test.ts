import { describe, expect, it } from 'vitest';
import { createReturnedFeedbackReader } from '../apps/web/src/lib/assignment-feedback/returned-reader';
import type { StudentFeedback } from '../apps/web/src/lib/assignment-feedback/decode';

async function fixture() {
  const source = new Blob(['%PDF-1.7 synthetic immutable feedback source']);
  const sha256 = [
    ...new Uint8Array(await crypto.subtle.digest('SHA-256', await source.arrayBuffer())),
  ]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
  const data: StudentFeedback = {
    capture: {
      submissionId: 'submission',
      snapshotPin: 'pin',
      documentId: 'document',
      versionId: 'version',
      frozenCursor: 1,
      frozenAt: new Date(1800000000000).toISOString(),
      pages: [{ id: 'page', index: 0, width: 612, height: 792 }],
      source: { sha256, bytes: source.size, mimeType: 'application/pdf' },
    },
    released: null,
  };
  const binding = {
    identity: { documentId: 'document', versionId: 'version' },
    sourceSha256: sha256,
  };
  let failure: Error | null = null,
    bindingReads = 0,
    valid = true,
    invalidateDuringBinding = false;
  const read = createReturnedFeedbackReader({
    source,
    readFeedback: async () => {
      if (failure) throw failure;
      return structuredClone(data);
    },
    readBinding: async () => {
      bindingReads++;
      if (invalidateDuringBinding) valid = false;
      return binding;
    },
    check: () => {
      if (!valid) throw new Error('Feedback access ended.');
    },
  });
  return {
    read,
    data,
    binding,
    bindingReads: () => bindingReads,
    fail: () => {
      failure = new Error('The captured document is not ready yet.');
    },
    recover: () => {
      failure = null;
    },
    revoke: () => {
      valid = false;
    },
    invalidateDuringBinding: () => {
      invalidateDuringBinding = true;
    },
  };
}

describe('returned feedback recovery', () => {
  it('verifies the complete binding and source when polling succeeds after an initial not-ready response', async () => {
    const f = await fixture();
    f.fail();
    await expect(f.read()).rejects.toThrow('not ready');
    expect(f.bindingReads()).toBe(0);
    f.recover();
    await expect(f.read()).resolves.toEqual(f.data);
    expect(f.bindingReads()).toBe(1);
    f.data.released = {
      revision: 1,
      releasedAt: new Date(1800000001000).toISOString(),
      content: { comment: 'Returned later', annotations: [] },
    };
    await expect(f.read()).resolves.toEqual(f.data);
    expect(f.bindingReads()).toBe(1);
  });
  it('rejects a mismatched binding on the first successful recovery and does not cache that failed verification', async () => {
    const f = await fixture();
    f.fail();
    await expect(f.read()).rejects.toThrow();
    f.recover();
    f.binding.identity.versionId = 'another-version';
    await expect(f.read()).rejects.toThrow('different captured document');
    f.binding.identity.versionId = 'version';
    await expect(f.read()).resolves.toEqual(f.data);
    expect(f.bindingReads()).toBe(2);
  });
  it('hashes the actual source rather than trusting matching response and stored digests after recovery', async () => {
    const f = await fixture();
    f.fail();
    await expect(f.read()).rejects.toThrow();
    f.recover();
    f.data.capture.source.sha256 = 'a'.repeat(64);
    f.binding.sourceSha256 = 'a'.repeat(64);
    await expect(f.read()).rejects.toThrow('source could not be verified');
  });
  it('continues to reject changed captures after a transient failure clears the displayed data', async () => {
    const f = await fixture();
    await f.read();
    f.fail();
    await expect(f.read()).rejects.toThrow();
    f.recover();
    f.data.capture.snapshotPin = 'changed-pin';
    await expect(f.read()).rejects.toThrow('captured submission changed');
  });
  it('refuses results when authority is lost during first verification or after a verified capture', async () => {
    const first = await fixture();
    first.invalidateDuringBinding();
    await expect(first.read()).rejects.toThrow('access ended');
    const later = await fixture();
    await later.read();
    later.revoke();
    await expect(later.read()).rejects.toThrow('access ended');
  });
});
