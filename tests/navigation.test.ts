import { describe, it, expect } from 'vitest';
import { parseRoute, fetchDocumentBlob } from '../apps/web/src/lib/navigation';
import { vi } from 'vitest';
describe('safe navigation', () => {
  it('recovers malformed and unknown routes', () => {
    expect(parseRoute('#%E0%A4%A')).toEqual({ page: 'home', documentId: null });
    expect(parseRoute('#unknown')).toEqual({ page: 'home', documentId: null });
  });
  it('decodes document ids and routes known pages', () => {
    expect(parseRoute('#document/abc%201').documentId).toBe('abc 1');
    expect(parseRoute('#folder:folder-biology').page).toBe('folder:folder-biology');
  });
  it('caps streamed remote documents with missing content length', async () => {
    let cancelled = false;
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(8));
        controller.enqueue(new Uint8Array(8));
      },
      cancel() {
        cancelled = true;
      },
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(body)),
    );
    try {
      await expect(fetchDocumentBlob('https://example.test/file.pdf', 10)).rejects.toThrow(
        '100 MB',
      );
      expect(cancelled).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
