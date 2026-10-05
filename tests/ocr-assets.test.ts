import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { readFile, mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  getOcrAssetStatus,
  prepareOcrAssets,
  validateOcrManifest,
  OCR_BASE_URL,
  OCR_CACHE,
  OCR_PACK_ID,
  OCR_WORKER_CSP,
} from '../apps/web/src/editor/ocrAssets';
import { MemoryPublicCaches, publicPackFixture } from './helpers/ocr-cache';

let storage: MemoryPublicCaches, fixture: ReturnType<typeof publicPackFixture>;
let fetcher: ReturnType<typeof vi.fn>;
beforeEach(() => {
  storage = new MemoryPublicCaches();
  fixture = publicPackFixture();
  fetcher = vi.fn(async (path: string, options?: RequestInit) => {
    if (options?.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const body = fixture.bodies.get(path);
    if (!body) throw new Error('Unexpected non-pack network request');
    return new Response(new Uint8Array(body), {
      headers: {
        'Content-Type': path.endsWith('.json') ? 'application/json' : 'application/octet-stream',
      },
    });
  });
  vi.stubGlobal('caches', storage);
  vi.stubGlobal('navigator', { serviceWorker: {} });
  vi.stubGlobal('fetch', fetcher);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('public OCR asset preparation', () => {
  it('does not fetch or create a cache when checking unprepared status', async () => {
    expect(await getOcrAssetStatus()).toMatchObject({
      ready: false,
      cached: false,
      offlineReady: false,
    });
    expect(fetcher).not.toHaveBeenCalled();
    expect(await storage.keys()).toEqual([]);
  });
  it('verifies every asset before readiness, preserves worker CSP, and distinguishes dev cache from offline support', async () => {
    const progress = vi.fn();
    const result = await prepareOcrAssets(undefined, progress);
    expect(result).toEqual({
      packId: OCR_PACK_ID,
      ready: true,
      cached: true,
      offlineReady: false,
      totalBytes: fixture.manifest.totalBytes,
      assetCount: 12,
    });
    expect(fetcher).toHaveBeenCalledTimes(13);
    for (const [, options] of fetcher.mock.calls)
      expect(options).toMatchObject({
        redirect: 'error',
        credentials: 'same-origin',
        cache: 'no-store',
      });
    const cache = await storage.open(OCR_CACHE);
    expect(
      (await cache.match(`${OCR_BASE_URL}worker.min.js`))!.headers.get('content-security-policy'),
    ).toBe(OCR_WORKER_CSP);
    expect(await cache.keys()).toHaveLength(14);
    expect(progress).toHaveBeenLastCalledWith({
      phase: 'verifying',
      completedBytes: fixture.manifest.totalBytes,
      totalBytes: fixture.manifest.totalBytes,
    });
    fetcher.mockClear();
    vi.stubGlobal('navigator', { serviceWorker: { controller: {} } });
    expect(await getOcrAssetStatus()).toMatchObject({ ready: true, offlineReady: true });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it.each(['missing', 'tampered', 'worker-policy', 'readiness-evidence'] as const)(
    'rejects %s cache contents without a network request',
    async (failure) => {
      await prepareOcrAssets();
      const cache = await storage.open(OCR_CACHE);
      const path = `${OCR_BASE_URL}worker.min.js`;
      if (failure === 'missing') await cache.delete(path);
      else if (failure === 'tampered')
        await cache.put(
          path,
          new Response('different bytes', {
            headers: { 'Content-Security-Policy': OCR_WORKER_CSP },
          }),
        );
      else if (failure === 'worker-policy')
        await cache.put(path, new Response(new Uint8Array(fixture.bodies.get(path)!)));
      else
        await cache.put(
          `${OCR_BASE_URL}.ready`,
          new Response(JSON.stringify({ packId: OCR_PACK_ID, manifestSha256: '0'.repeat(64) })),
        );
      fetcher.mockClear();
      expect(await getOcrAssetStatus()).toMatchObject({ ready: false, offlineReady: false });
      expect(fetcher).not.toHaveBeenCalled();
    },
  );
  it.each(['integrity', 'oversized', 'html'] as const)(
    'removes incomplete public caches after an %s download failure',
    async (failure) => {
      const path = fixture.manifest.assets[2].path;
      if (failure === 'integrity')
        fixture.bodies.set(path, Buffer.alloc(fixture.manifest.assets[2].bytes, 65));
      else if (failure === 'oversized')
        fixture.bodies.set(path, Buffer.alloc(fixture.manifest.assets[2].bytes + 1));
      else
        fetcher.mockImplementation(async (url: string) =>
          url === path
            ? new Response('<html>fallback</html>', { headers: { 'Content-Type': 'text/html' } })
            : new Response(new Uint8Array(fixture.bodies.get(url)!)),
        );
      await expect(prepareOcrAssets()).rejects.toThrow(/integrity|size limit|could not be loaded/);
      expect(await storage.has(OCR_CACHE)).toBe(false);
      expect((await getOcrAssetStatus()).ready).toBe(false);
    },
  );
  it('cancels a stalled asset response and never marks the partial cache ready', async () => {
    const abort = new AbortController();
    let started!: () => void;
    const stalled = new Promise<void>((resolve) => {
      started = resolve;
    });
    const original = fetcher.getMockImplementation()!;
    fetcher.mockImplementation(async (path: string, options?: RequestInit) => {
      if (path.endsWith('worker.min.js')) {
        started();
        return new Response(new ReadableStream<Uint8Array>({ start() {} }));
      }
      return original(path, options);
    });
    const pending = prepareOcrAssets(abort.signal);
    await stalled;
    abort.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(await storage.has(OCR_CACHE)).toBe(false);
  });
  it('refuses missing, duplicate, external, oversized and unexpected manifest paths', () => {
    expect(validateOcrManifest(fixture.manifest)).toEqual(fixture.manifest);
    for (const patch of [
      (value: typeof fixture.manifest) => value.assets.pop(),
      (value: typeof fixture.manifest) => {
        value.assets[1] = value.assets[0];
      },
      (value: typeof fixture.manifest) => {
        value.assets[0].path = 'https://example.com/model';
      },
      (value: typeof fixture.manifest) => {
        value.assets[0].bytes = 64 * 1024 * 1024;
      },
      (value: typeof fixture.manifest) => {
        value.assets[0].path = `${OCR_BASE_URL}../api/documents`;
      },
    ]) {
      const manifest = structuredClone(fixture.manifest);
      patch(manifest);
      expect(() => validateOcrManifest(manifest)).toThrow();
    }
  });
  it('uses a controlling service worker for explicit preparation and forwards cancellation', async () => {
    const requests: string[] = [];
    let port: MessagePort | undefined;
    const controller = {
      postMessage(message: { type: string }, ports?: MessagePort[]) {
        requests.push(message.type);
        port = ports?.[0] || port;
      },
    };
    vi.stubGlobal('navigator', { serviceWorker: { controller } });
    const abort = new AbortController();
    const pending = prepareOcrAssets(abort.signal);
    expect(requests).toEqual(['MARGIN_OCR_PREPARE']);
    abort.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(requests).toEqual(['MARGIN_OCR_PREPARE', 'MARGIN_OCR_ABORT']);
    expect(fetcher).not.toHaveBeenCalled();
    port?.close();
  });
  it('rejects a dependency version mismatch before replacing any generated files', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'margin-ocr-version-'));
    try {
      const packagePath = join(directory, 'node_modules/tesseract.js');
      await mkdir(packagePath, { recursive: true });
      await writeFile(join(packagePath, 'package.json'), JSON.stringify({ version: '999.0.0' }));
      const outputRoot = join(directory, 'output');
      await mkdir(outputRoot);
      await writeFile(join(outputRoot, 'preserve.txt'), 'existing asset');
      const { prepareOcrAssets: packageAssets } = await import(
        new URL('../scripts/prepare-ocr.mjs', import.meta.url).href
      );
      await expect(packageAssets({ projectRoot: directory, outputRoot })).rejects.toThrow(
        'OCR requires tesseract.js@7.0.0',
      );
      expect(await readFile(join(outputRoot, 'preserve.txt'), 'utf8')).toBe('existing asset');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
