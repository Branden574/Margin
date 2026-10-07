import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PoolConfig } from 'pg';
import { PostgresLmsRepository } from '../apps/api/src/lms/postgres';

const pool = vi.hoisted(() => ({
  construct: vi.fn<(options: PoolConfig) => void>(),
  end: vi.fn<() => Promise<void>>(),
}));
vi.mock('pg', () => ({
  Pool: class {
    constructor(options: PoolConfig) {
      pool.construct(options);
    }
    end() {
      return pool.end();
    }
  },
}));

const verifiedTls: PoolConfig = { host: 'synthetic-db.test', ssl: { rejectUnauthorized: true } };

function trackOwnedCopies(caller: Uint8Array) {
  const from = vi.spyOn(Buffer, 'from');
  return () => {
    const copies = from.mock.calls.flatMap((args, index) =>
      args[0] === caller ? [from.mock.results[index].value as Buffer] : [],
    );
    from.mockRestore();
    return copies;
  };
}

beforeEach(() => {
  pool.construct.mockReset();
  pool.end.mockReset().mockResolvedValue(undefined);
  vi.stubEnv('NODE_TLS_REJECT_UNAUTHORIZED', '1');
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('LMS repository owned lookup-key lifecycle with an injected PostgreSQL pool', () => {
  it.each(['success', 'rejection', 'synchronous throw'] as const)(
    'clears its copy after shutdown %s while preserving caller bytes and the original error',
    async (outcome) => {
      const caller = new Uint8Array(32).fill(73);
      const copies = trackOwnedCopies(caller);
      const repository = new PostgresLmsRepository(verifiedTls, caller);
      const owned = copies();
      expect(owned).toHaveLength(1);
      expect(owned[0]).not.toBe(caller);
      expect(owned[0]).toEqual(Buffer.alloc(32, 73));
      const failure = new Error('Synthetic pool shutdown failure');
      if (outcome === 'rejection') pool.end.mockRejectedValueOnce(failure);
      if (outcome === 'synchronous throw')
        pool.end.mockImplementationOnce(() => {
          throw failure;
        });

      if (outcome === 'success') await repository.close();
      else await expect(repository.close()).rejects.toBe(failure);

      expect(pool.end).toHaveBeenCalledOnce();
      expect(owned[0]).toEqual(Buffer.alloc(32));
      expect(caller).toEqual(new Uint8Array(32).fill(73));
    },
  );

  it.each([
    { host: 'synthetic-db.test', ssl: false },
    { ...verifiedTls, connectionString: 'postgresql://synthetic/db?sslmode=disable' },
    { ...verifiedTls, connectionString: 'invalid URL' },
  ] satisfies PoolConfig[])(
    'does not retain a copied key when PostgreSQL configuration validation fails: %j',
    (options) => {
      const caller = new Uint8Array(32).fill(91);
      const copies = trackOwnedCopies(caller);
      expect(() => new PostgresLmsRepository(options, caller)).toThrow();
      expect(copies()).toEqual([]);
      expect(pool.construct).not.toHaveBeenCalled();
      expect(caller).toEqual(new Uint8Array(32).fill(91));
    },
  );

  it('clears the owned copy if pool construction throws without masking the construction error', () => {
    const caller = new Uint8Array(32).fill(117);
    const failure = new Error('Synthetic pool construction failure');
    pool.construct.mockImplementationOnce(() => {
      throw failure;
    });
    const copies = trackOwnedCopies(caller);
    let received: unknown;
    try {
      new PostgresLmsRepository(verifiedTls, caller);
    } catch (error) {
      received = error;
    }
    const owned = copies();
    expect(received).toBe(failure);
    expect(owned).toHaveLength(1);
    expect(owned[0]).toEqual(Buffer.alloc(32));
    expect(caller).toEqual(new Uint8Array(32).fill(117));
    expect(pool.end).not.toHaveBeenCalled();
  });
});
