import { describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { decrypt, encrypt } from '../apps/api/src/sync/encryption';
import { MAX_OPERATION_BYTES } from '../apps/api/src/sync/validation';

const context = 'synthetic-geometry-envelope-v1';
describe('bounded authenticated geometry envelopes', () => {
  it('keeps the operation limit by default while permitting an explicit bounded geometry payload', () => {
    const key = randomBytes(32);
    const geometry = Buffer.alloc(MAX_OPERATION_BYTES + 1, 71);
    const encrypted = encrypt(key, geometry, context);
    expect(() => decrypt(key, encrypted, context)).toThrow('Invalid encrypted operation envelope');
    expect(decrypt(key, encrypted, context, 262144)).toEqual(geometry);
    expect(() => decrypt(key, encrypted, context, geometry.length - 1)).toThrow(
      'Invalid encrypted operation envelope',
    );
  });
  it.each([0, -1, 1.5, NaN, Infinity, 262145])(
    'rejects an invalid caller-supplied maximum %s',
    (maximum) => {
      const key = randomBytes(32);
      const encrypted = encrypt(key, Buffer.from('synthetic'), context);
      expect(() => decrypt(key, encrypted, context, maximum)).toThrow(
        'Invalid encrypted operation envelope',
      );
    },
  );
  it('rejects an envelope exceeding the absolute geometry limit and preserves authentication at the limit', () => {
    const key = randomBytes(32);
    const oversized = encrypt(key, Buffer.alloc(262145, 71), context);
    expect(() => decrypt(key, oversized, context, 262144)).toThrow(
      'Invalid encrypted operation envelope',
    );
    const geometry = Buffer.alloc(262144, 83);
    const encrypted = encrypt(key, geometry, context);
    expect(decrypt(key, encrypted, context, 262144)).toEqual(geometry);
    expect(() => decrypt(key, encrypted, 'another-source-receipt', 262144)).toThrow();
    const changed = { ...encrypted, ciphertext: Buffer.from(encrypted.ciphertext) };
    changed.ciphertext[changed.ciphertext.length - 1] ^= 1;
    expect(() => decrypt(key, changed, context, 262144)).toThrow();
    expect(() => decrypt(randomBytes(32), encrypted, context, 262144)).toThrow();
  });
});
