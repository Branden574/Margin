import { beforeAll, beforeEach, describe, it, expect, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { transformWithEsbuild } from 'vite';
import { MemoryPublicCaches, OCR_TEST_ORIGIN, publicPackFixture } from './helpers/ocr-cache';
import { OCR_BASE_URL, OCR_CACHE, OCR_WORKER_CSP } from '../apps/web/src/editor/ocrAssets';

let runtime: string, worker: string;
let storage: MemoryPublicCaches, pack: ReturnType<typeof publicPackFixture>;
type Message = {
  kind: string;
  status?: { ready: boolean; offlineReady: boolean };
  progress?: unknown;
  error?: string;
};
beforeAll(async () => {
  const source = await readFile(
    new URL('../apps/web/src/editor/ocrAssets.ts', import.meta.url),
    'utf8',
  );
  runtime = (
    await transformWithEsbuild(source, 'ocrAssets.ts', {
      loader: 'ts',
      format: 'iife',
      globalName: 'MarginOcrAssets',
      target: 'es2022',
      sourcemap: false,
    })
  ).code;
  worker = await readFile(new URL('../apps/web/public/sw.js', import.meta.url), 'utf8');
});
beforeEach(() => {
  storage = new MemoryPublicCaches();
  pack = publicPackFixture();
});

function serviceWorker(
  fetcher = vi.fn(async (url: string | Request) => {
    const path = new URL(typeof url === 'string' ? url : url.url, OCR_TEST_ORIGIN).pathname;
    if (path === '/') return new Response('<!doctype html><title>Synthetic shell</title>');
    const body = pack.bodies.get(path);
    if (!body) throw new Error('Unexpected network request');
    return new Response(new Uint8Array(body));
  }),
) {
  const handlers = new Map<string, (event: any) => void>();
  const context = vm.createContext({
    caches: storage,
    fetch: fetcher,
    navigator: {},
    crypto,
    Response,
    Request,
    Headers,
    URL,
    TextDecoder,
    Uint8Array,
    ReadableStream,
    AbortController,
    AbortSignal,
    DOMException,
    setTimeout,
    clearTimeout,
    console,
  });
  context.self = context;
  context.location = { origin: OCR_TEST_ORIGIN };
  context.registration = { scope: `${OCR_TEST_ORIGIN}/` };
  context.clients = { claim: vi.fn() };
  context.skipWaiting = vi.fn();
  context.addEventListener = (name: string, handler: (event: any) => void) =>
    handlers.set(name, handler);
  context.importScripts = (url: string) => {
    expect(url).toBe(`${OCR_BASE_URL}ocr-runtime.js`);
    vm.runInContext(runtime, context);
  };
  vm.runInContext(worker, context);
  const dispatch = (name: string, event: Record<string, unknown>) => {
    let work: Promise<unknown> | undefined;
    handlers.get(name)!({
      ...event,
      waitUntil: (promise: Promise<unknown>) => {
        work = promise;
      },
    });
    return work;
  };
  const message = (
    type: string,
    requestId = 'test-request',
    clientId = 'client-1',
    url = `${OCR_TEST_ORIGIN}/`,
  ) => {
    const messages: Message[] = [];
    const work = dispatch('message', {
      data: { type, requestId },
      source: { id: clientId, url },
      ports: [{ postMessage: (value: Message) => messages.push(value), close() {} }],
    });
    return { work, messages };
  };
  return {
    fetcher,
    dispatch,
    message,
    context,
    async asset(path: string) {
      let response: Promise<Response> | undefined;
      dispatch('fetch', {
        request: new Request(`${OCR_TEST_ORIGIN}${path}`),
        respondWith: (value: Promise<Response>) => {
          response = value;
        },
      });
      return response;
    },
  };
}

describe('on-demand OCR service worker cache', () => {
  it('installs the shell without downloading the model or core pack', async () => {
    const sw = serviceWorker();
    await sw.dispatch('install', {});
    expect(sw.fetcher.mock.calls.map(([url]) => String(url))).toEqual([`${OCR_TEST_ORIGIN}/`]);
    expect(await storage.has(OCR_CACHE)).toBe(false);
    expect(sw.context.skipWaiting).toHaveBeenCalledOnce();
  });
  it('precaches a hashed TTF discovered through a lazy worker without downloading the OCR pack', async () => {
    const fontPath = '/assets/NotoSans-Regular-AbCd1234.ttf';
    const font = Uint8Array.from([0, 1, 0, 0, 83, 89, 78, 84, 72]);
    const responses = new Map<string, string | Uint8Array>([
      ['/', '<script src="/assets/main-EfGh5678.js"></script>'],
      [
        '/assets/main-EfGh5678.js',
        'new Worker(new URL("./pdfOperations-IjKl9012.js", import.meta.url))',
      ],
      [
        '/assets/pdfOperations-IjKl9012.js',
        'const font="./NotoSans-Regular-AbCd1234.ttf"; const fallback="./unbundled.ttf"',
      ],
      [fontPath, font],
    ]);
    const fetcher = vi.fn(async (url: string | Request) => {
      const path = new URL(typeof url === 'string' ? url : url.url, OCR_TEST_ORIGIN).pathname;
      const body = responses.get(path);
      if (!body) throw new Error(`Unexpected public asset request: ${path}`);
      return new Response(body);
    });
    const sw = serviceWorker(fetcher);
    await sw.dispatch('install', {});
    expect(fetcher.mock.calls.map(([url]) => new URL(String(url)).pathname)).toEqual([
      ...responses.keys(),
    ]);
    expect(await storage.has(OCR_CACHE)).toBe(false);
    const offlineFetch = vi.fn(async () => {
      throw new Error('Offline: no network');
    });
    const offline = serviceWorker(offlineFetch);
    const cached = await offline.asset(fontPath);
    expect(new Uint8Array(await cached!.arrayBuffer())).toEqual(font);
    expect(offlineFetch).not.toHaveBeenCalled();
  });
  it('prepares a complete verified pack, preserves worker CSP, and serves it across offline SW restarts', async () => {
    const sw = serviceWorker();
    const prepare = sw.message('MARGIN_OCR_PREPARE');
    await prepare.work;
    expect(prepare.messages.at(-1)).toMatchObject({
      kind: 'result',
      status: { ready: true, offlineReady: true },
    });
    expect(prepare.messages.some((item) => item.kind === 'progress')).toBe(true);
    const offlineFetch = vi.fn(async () => {
      throw new Error('Offline: no network');
    });
    const restarted = serviceWorker(offlineFetch);
    const status = restarted.message('MARGIN_OCR_STATUS');
    await status.work;
    expect(status.messages.at(-1)).toMatchObject({
      kind: 'result',
      status: { ready: true, offlineReady: true },
    });
    const model = await restarted.asset(`${OCR_BASE_URL}lang/eng.traineddata.gz`);
    expect(Buffer.from(await model!.arrayBuffer())).toEqual(
      pack.bodies.get(`${OCR_BASE_URL}lang/eng.traineddata.gz`),
    );
    const worker = await restarted.asset(`${OCR_BASE_URL}worker.min.js`);
    expect(worker!.headers.get('content-security-policy')).toBe(OCR_WORKER_CSP);
    expect(offlineFetch).not.toHaveBeenCalled();
  });
  it('rejects foreign clients and incomplete request identities before any cache/network work', () => {
    const sw = serviceWorker();
    expect(
      sw.message('MARGIN_OCR_PREPARE', 'test', 'outside', 'https://example.com/').work,
    ).toBeUndefined();
    expect(sw.message('MARGIN_OCR_PREPARE', '../arbitrary', 'client-1').work).toBeUndefined();
    expect(sw.message('MARGIN_OCR_PREPARE', 'test', '').work).toBeUndefined();
    expect(sw.fetcher).not.toHaveBeenCalled();
  });
  it('only lets the requesting client cancel a download and removes its partial cache', async () => {
    let started!: () => void;
    const pending = new Promise<void>((resolve) => {
      started = resolve;
    });
    const cancelled = vi.fn();
    const sw = serviceWorker(
      vi.fn(async (url: string | Request) => {
        const path = typeof url === 'string' ? url : new URL(url.url).pathname;
        if (path.endsWith('manifest.json'))
          return new Response(new Uint8Array(pack.bodies.get(path)!));
        started();
        return new Response(new ReadableStream({ cancel: cancelled }));
      }),
    );
    const preparing = sw.message('MARGIN_OCR_PREPARE', 'owner-request');
    await pending;
    sw.message('MARGIN_OCR_ABORT', 'owner-request', 'different-client');
    expect(cancelled).not.toHaveBeenCalled();
    sw.message('MARGIN_OCR_ABORT', 'owner-request');
    await preparing.work;
    expect(cancelled).toHaveBeenCalled();
    expect(preparing.messages.at(-1)).toMatchObject({ kind: 'error' });
    expect(await storage.has(OCR_CACHE)).toBe(false);
  });
});
