import { afterEach, describe, expect, it, vi } from 'vitest';
import { SubmissionProviderAdmission } from '../apps/api/src/assignments/submissions/processing/providers';
import { newWrappedKey, unwrapKey } from '../apps/api/src/sync/encryption';
import type { KeyManagementProvider, WrappedDataKey } from '../apps/api/src/encryption';
const wrapped: WrappedDataKey = {
  provider: 'test',
  keyId: 'test',
  iv: 'test',
  tag: 'test',
  ciphertext: 'test',
};
afterEach(() => vi.useRealTimers());
describe('submission supplied-provider admission', () => {
  it('retains both raw unwrap slots beyond outer deadlines and clears late plaintext keys', async () => {
    vi.useFakeTimers();
    const admission = new SubmissionProviderAdmission();
    const resolve: Array<(key: Buffer) => void> = [];
    const provider: KeyManagementProvider = {
      async wrapKey() {
        return wrapped;
      },
      unwrapKey() {
        return new Promise((r) => resolve.push(r));
      },
    };
    const keys = admission.keys(provider);
    const a = unwrapKey(keys, wrapped, 'a'),
      b = unwrapKey(keys, wrapped, 'b');
    const aRejected = expect(a).rejects.toThrow('deadline'),
      bRejected = expect(b).rejects.toThrow('deadline');
    await vi.advanceTimersByTimeAsync(3001);
    await Promise.all([aRejected, bRejected]);
    expect(() => admission.assertAvailable()).toThrow();
    await expect(unwrapKey(keys, wrapped, 'c')).rejects.toMatchObject({ code: 'processor_busy' });
    expect(resolve).toHaveLength(2);
    const lateA = Buffer.alloc(32, 1),
      lateB = Buffer.alloc(32, 2);
    resolve[0](lateA);
    resolve[1](lateB);
    await vi.advanceTimersByTimeAsync(0);
    expect(lateA.every((v) => v === 0)).toBe(true);
    expect(lateB.every((v) => v === 0)).toBe(true);
    expect(() => admission.assertAvailable()).not.toThrow();
  });
  it('keeps wrap admission after the deadline clears its input and releases after late rejection', async () => {
    vi.useFakeTimers();
    const admission = new SubmissionProviderAdmission();
    const inputs: Buffer[] = [];
    const reject: Array<(e: Error) => void> = [];
    const provider: KeyManagementProvider = {
      wrapKey(key) {
        inputs.push(key);
        return new Promise((_, r) => reject.push(r));
      },
      async unwrapKey() {
        return Buffer.alloc(32);
      },
    };
    const a = newWrappedKey(admission.keys(provider), 'a'),
      b = newWrappedKey(admission.keys(provider), 'b');
    const aRejected = expect(a).rejects.toThrow('deadline'),
      bRejected = expect(b).rejects.toThrow('deadline');
    await vi.advanceTimersByTimeAsync(3001);
    await Promise.all([aRejected, bRejected]);
    expect(inputs.every((v) => v.every((b) => b === 0))).toBe(true);
    expect(() => admission.assertAvailable()).toThrow();
    reject[0](new Error('late provider failure'));
    reject[1](new Error('late provider failure'));
    await vi.advanceTimersByTimeAsync(0);
    expect(inputs.every((v) => v.every((b) => b === 0))).toBe(true);
    expect(() => admission.assertAvailable()).not.toThrow();
  });
  it('releases synchronous failures and closes without waiting for an uncooperative provider', async () => {
    const admission = new SubmissionProviderAdmission();
    await expect(
      admission.run(() => {
        throw Error('failure');
      }),
    ).rejects.toThrow('failure');
    let release!: (v: number) => void;
    const pending = admission.run(
      () =>
        new Promise<number>((r) => {
          release = r;
        }),
    );
    admission.close();
    expect(() => admission.assertAvailable()).toThrow();
    release(1);
    expect(await pending).toBe(1);
    expect(() => admission.assertAvailable()).toThrow();
  });
});
