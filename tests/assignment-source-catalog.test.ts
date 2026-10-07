import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { IngestionAssignmentSourceCatalog } from '../apps/api/src/ingestion/catalog';
import { SOURCE_CATALOG_TIMEOUT_MS } from '../apps/api/src/ingestion/types';
import type { PostgresIngestionRepository } from '../apps/api/src/ingestion/postgres';
import type { SessionPrincipal } from '../apps/api/src/identity/types';
const principal = {
  sessionId: randomUUID(),
  userId: randomUUID(),
  organizationId: randomUUID(),
  role: 'teacher',
  authenticationMethod: 'lti',
  mfa: false,
  createdAt: 0,
  lastSeenAt: 0,
  expiresAt: Date.now() + 60000,
} satisfies SessionPrincipal;
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
afterEach(() => vi.useRealTimers());
describe('source catalog deadline and admission', () => {
  it('rejects worker credentials before opening any catalog request', () => {
    expect(
      () =>
        new IngestionAssignmentSourceCatalog({
          purpose: 'inspector',
        } as PostgresIngestionRepository),
    ).toThrow('runtime ingestion');
  });
  it('bounds the whole call, retains admission until abandoned underlying reads settle, and consumes late rejection', async () => {
    vi.useFakeTimers();
    const first = deferred<{ sources: []; nextPosition: null }>(),
      second = deferred<{ sources: []; nextPosition: null }>();
    const inspectedCatalogPage = vi
      .fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)
      .mockResolvedValue({ sources: [], nextPosition: null });
    const catalog = new IngestionAssignmentSourceCatalog({
      purpose: 'runtime',
      inspectedCatalogPage,
    } as unknown as PostgresIngestionRepository);
    const one = catalog.list(principal),
      two = catalog.list(principal);
    const rejected = [
      expect(one).rejects.toMatchObject({ code: 'source_catalog_unavailable' }),
      expect(two).rejects.toMatchObject({ code: 'source_catalog_unavailable' }),
    ];
    await Promise.resolve();
    await expect(catalog.list(principal)).rejects.toMatchObject({ code: 'source_catalog_busy' });
    await vi.advanceTimersByTimeAsync(SOURCE_CATALOG_TIMEOUT_MS);
    await Promise.all(rejected);
    expect(inspectedCatalogPage.mock.calls.every((call) => call[2].aborted)).toBe(true);
    await expect(catalog.list(principal)).rejects.toMatchObject({ code: 'source_catalog_busy' });
    first.resolve({ sources: [], nextPosition: null });
    second.resolve({ sources: [], nextPosition: null });
    await vi.advanceTimersByTimeAsync(0);
    expect(await catalog.list(principal)).toEqual({ sources: [], nextCursor: null });
  });
  it('rejects an already-aborted request without consuming admission or issuing SQL', async () => {
    const inspectedCatalogPage = vi.fn(async () => ({ sources: [], nextPosition: null }));
    const catalog = new IngestionAssignmentSourceCatalog({
      purpose: 'runtime',
      inspectedCatalogPage,
    } as unknown as PostgresIngestionRepository);
    const controller = new AbortController();
    controller.abort();
    for (let n = 0; n < 3; n++)
      await expect(
        catalog.list(principal, undefined, { signal: controller.signal }),
      ).rejects.toMatchObject({ status: 503 });
    expect(inspectedCatalogPage).not.toHaveBeenCalled();
    expect(await catalog.list(principal)).toEqual({ sources: [], nextCursor: null });
  });
});
