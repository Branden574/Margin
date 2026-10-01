import { describe, expect, it, vi } from 'vitest';
import { acquireDocumentLock } from '../apps/web/src/lib/document-lock';

function lockManager() {
  const held = new Set<string>();
  const manager = {
    request: vi.fn(
      async (name: string, _options: unknown, callback: (lock: Lock | null) => Promise<void>) => {
        if (held.has(name)) return callback(null);
        held.add(name);
        try {
          await callback({ name, mode: 'exclusive' } as Lock);
          // Browser release becomes visible only after the callback settles.
          await Promise.resolve();
        } finally {
          held.delete(name);
        }
      },
    ),
  } as unknown as LockManager;
  return { manager, held };
}
const settle = async () => {
  for (let i = 0; i < 12; i++) await Promise.resolve();
};

describe('document editing leases', () => {
  it('waits for a released local lease before an immediate remount', async () => {
    const { manager, held } = lockManager();
    const first = vi.fn();
    const release = acquireDocumentLock(manager, 'a', first);
    await settle();
    expect(first).toHaveBeenLastCalledWith('owned');
    release();
    const second = vi.fn();
    const releaseSecond = acquireDocumentLock(manager, 'a', second);
    await settle();
    expect(second.mock.calls.map(([status]) => status)).toEqual(['pending', 'owned']);
    releaseSecond();
    await settle();
    expect(held.size).toBe(0);
  });
  it('keeps a genuinely concurrent editor read-only', async () => {
    const { manager } = lockManager();
    const release = acquireDocumentLock(manager, 'a', vi.fn());
    await settle();
    const status = vi.fn();
    const releaseSecond = acquireDocumentLock(manager, 'a', status);
    await settle();
    expect(status).toHaveBeenLastCalledWith('blocked');
    releaseSecond();
    release();
    await settle();
  });
  it('cancels abandoned mounts without leaking a lock or updating their state', async () => {
    const { manager, held } = lockManager();
    const status = vi.fn();
    acquireDocumentLock(manager, 'a', status)();
    await settle();
    expect(manager.request).not.toHaveBeenCalled();
    expect(status.mock.calls).toEqual([['pending']]);
    expect(held.size).toBe(0);
  });
  it('reports a failed lock API without allowing writes', async () => {
    const { manager } = lockManager();
    vi.mocked(manager.request).mockRejectedValueOnce(new Error('Unavailable'));
    const status = vi.fn();
    const release = acquireDocumentLock(manager, 'a', status);
    await settle();
    expect(status).toHaveBeenLastCalledWith('unsupported');
    release();
  });
});
