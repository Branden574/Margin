export const OCR_PACK_ID = 'tesseract-7.0.0-eng-1';
export const OCR_BASE_URL = `/ocr/${OCR_PACK_ID}/`;
export const OCR_CACHE = `margin-ocr-${OCR_PACK_ID}`;
export const OCR_WORKER_CSP =
  "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'self'; worker-src 'none'; object-src 'none'; base-uri 'none'";
const MANIFEST = `${OCR_BASE_URL}manifest.json`;
const READY = `${OCR_BASE_URL}.ready`;
const MAX_PACK_BYTES = 32 * 1024 * 1024;
const MAX_ASSET_BYTES = 8 * 1024 * 1024;
const FILES = new Set([
  'ocr-runtime.js',
  'worker.min.js',
  'worker.min.js.LICENSE.txt',
  'LICENSE.tesseract-core.txt',
  'third-party-notices.json',
  'lang/eng.traineddata.gz',
  ...['lstm', 'simd-lstm', 'relaxedsimd-lstm'].flatMap((variant) =>
    ['wasm.js', 'wasm'].map((extension) => `core/tesseract-core-${variant}.${extension}`),
  ),
]);
export interface OcrAssetProgress {
  phase: 'checking' | 'downloading' | 'verifying';
  completedBytes: number;
  totalBytes: number;
}
export interface OcrAssetStatus {
  packId: string;
  ready: boolean;
  cached: boolean;
  offlineReady: boolean;
  totalBytes: number;
  assetCount: number;
}
interface Asset {
  path: string;
  bytes: number;
  sha256: string;
  contentType: string;
}
interface Manifest {
  schemaVersion: number;
  packId: string;
  baseUrl: string;
  totalBytes: number;
  assets: Asset[];
}
const emptyStatus = (): OcrAssetStatus => ({
  packId: OCR_PACK_ID,
  ready: false,
  cached: false,
  offlineReady: false,
  totalBytes: 0,
  assetCount: 0,
});
const cancelled = () => new DOMException('OCR preparation was cancelled.', 'AbortError');
const checkAbort = (signal?: AbortSignal) => {
  if (signal?.aborted) throw cancelled();
};
export function validateOcrManifest(value: unknown): Manifest {
  const manifest = value as Manifest;
  if (
    !manifest ||
    manifest.schemaVersion !== 1 ||
    manifest.packId !== OCR_PACK_ID ||
    manifest.baseUrl !== OCR_BASE_URL ||
    !Array.isArray(manifest.assets) ||
    manifest.assets.length !== FILES.size
  )
    throw new Error('The local OCR asset manifest is invalid.');
  const remaining = new Set(FILES);
  let total = 0;
  for (const asset of manifest.assets) {
    if (
      !asset ||
      typeof asset.path !== 'string' ||
      !asset.path.startsWith(OCR_BASE_URL) ||
      !remaining.delete(asset.path.slice(OCR_BASE_URL.length)) ||
      !Number.isSafeInteger(asset.bytes) ||
      asset.bytes <= 0 ||
      asset.bytes > MAX_ASSET_BYTES ||
      !/^[a-f0-9]{64}$/.test(asset.sha256) ||
      ![
        'text/javascript',
        'application/wasm',
        'application/gzip',
        'text/plain',
        'application/json',
      ].includes(asset.contentType)
    )
      throw new Error('The local OCR asset manifest is invalid.');
    total += asset.bytes;
  }
  if (remaining.size || total !== manifest.totalBytes || total > MAX_PACK_BYTES)
    throw new Error('The local OCR asset manifest size is invalid.');
  return manifest;
}
async function readBounded(response: Response, limit: number, signal?: AbortSignal) {
  if (!response.ok || !response.body || response.headers.get('content-type')?.includes('text/html'))
    throw new Error('A local OCR asset could not be loaded.');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  const abort = () => void reader.cancel().catch(() => {});
  signal?.addEventListener('abort', abort, { once: true });
  try {
    while (true) {
      checkAbort(signal);
      const { value, done } = await reader.read();
      checkAbort(signal);
      if (done) break;
      length += value.byteLength;
      if (length > limit) throw new Error('A local OCR asset exceeds its size limit.');
      chunks.push(value);
    }
    const result = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      result.set(chunk, offset);
      offset += chunk.length;
    }
    return result;
  } finally {
    signal?.removeEventListener('abort', abort);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
const digest = async (bytes: Uint8Array) =>
  Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as BufferSource)))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');

/** Reads only the public cache; opening the reading panel must not fetch the model. */
export async function getOcrAssetStatus(signal?: AbortSignal): Promise<OcrAssetStatus> {
  checkAbort(signal);
  if (!('caches' in globalThis) || !(await caches.has(OCR_CACHE))) return emptyStatus();
  const cache = await caches.open(OCR_CACHE);
  const marker = await cache.match(READY);
  if (!marker) return emptyStatus();
  try {
    const response = await cache.match(MANIFEST);
    if (!response) return emptyStatus();
    const manifestBytes = await readBounded(response, 16384, signal);
    const evidence = JSON.parse(new TextDecoder().decode(await readBounded(marker, 1024, signal)));
    if (
      evidence.packId !== OCR_PACK_ID ||
      evidence.manifestSha256 !== (await digest(manifestBytes))
    )
      return emptyStatus();
    const manifest = validateOcrManifest(JSON.parse(new TextDecoder().decode(manifestBytes)));
    for (const asset of manifest.assets) {
      checkAbort(signal);
      const cached = await cache.match(asset.path);
      if (!cached) return emptyStatus();
      if (
        asset.path === `${OCR_BASE_URL}worker.min.js` &&
        cached.headers.get('Content-Security-Policy') !== OCR_WORKER_CSP
      )
        return emptyStatus();
      const bytes = await readBounded(cached, asset.bytes, signal);
      if (bytes.length !== asset.bytes || (await digest(bytes)) !== asset.sha256)
        return emptyStatus();
    }
    return {
      packId: OCR_PACK_ID,
      ready: true,
      cached: true,
      offlineReady: !!navigator.serviceWorker?.controller,
      totalBytes: manifest.totalBytes,
      assetCount: manifest.assets.length,
    };
  } catch (error) {
    checkAbort(signal);
    return emptyStatus();
  }
}

let developmentPreparation: Promise<OcrAssetStatus> | null = null;
async function prepareWithoutController(
  signal?: AbortSignal,
  onProgress?: (value: OcrAssetProgress) => void,
) {
  const current = await getOcrAssetStatus(signal);
  if (current.ready) return current;
  onProgress?.({ phase: 'checking', completedBytes: 0, totalBytes: 0 });
  const response = await fetch(MANIFEST, {
    cache: 'no-store',
    credentials: 'same-origin',
    redirect: 'error',
    signal,
  });
  const manifestBytes = await readBounded(response, 16384, signal);
  const manifest = validateOcrManifest(JSON.parse(new TextDecoder().decode(manifestBytes)));
  await caches.delete(OCR_CACHE);
  const cache = await caches.open(OCR_CACHE);
  let completedBytes = 0;
  try {
    for (const asset of manifest.assets) {
      checkAbort(signal);
      onProgress?.({ phase: 'downloading', completedBytes, totalBytes: manifest.totalBytes });
      const response = await fetch(asset.path, {
        cache: 'no-store',
        credentials: 'same-origin',
        redirect: 'error',
        signal,
      });
      const bytes = await readBounded(response, asset.bytes, signal);
      onProgress?.({ phase: 'verifying', completedBytes, totalBytes: manifest.totalBytes });
      if (bytes.length !== asset.bytes || (await digest(bytes)) !== asset.sha256)
        throw new Error('A local OCR asset failed its integrity check.');
      const headers = new Headers({
        'Content-Type': asset.contentType,
        'X-Content-Type-Options': 'nosniff',
      });
      if (asset.path === `${OCR_BASE_URL}worker.min.js`)
        headers.set('Content-Security-Policy', OCR_WORKER_CSP);
      await cache.put(asset.path, new Response(bytes, { headers }));
      completedBytes += asset.bytes;
    }
    checkAbort(signal);
    await cache.put(
      MANIFEST,
      new Response(manifestBytes, { headers: { 'Content-Type': 'application/json' } }),
    );
    await cache.put(
      READY,
      new Response(
        JSON.stringify({ packId: OCR_PACK_ID, manifestSha256: await digest(manifestBytes) }),
      ),
    );
    onProgress?.({ phase: 'verifying', completedBytes, totalBytes: manifest.totalBytes });
    return {
      packId: OCR_PACK_ID,
      ready: true,
      cached: true,
      offlineReady: false,
      totalBytes: manifest.totalBytes,
      assetCount: manifest.assets.length,
    };
  } catch (error) {
    await caches.delete(OCR_CACHE);
    throw error;
  }
}

export async function prepareOcrAssets(
  signal?: AbortSignal,
  onProgress?: (value: OcrAssetProgress) => void,
): Promise<OcrAssetStatus> {
  checkAbort(signal);
  const controller = navigator.serviceWorker?.controller;
  if (!controller) {
    if (developmentPreparation) throw new Error('OCR preparation is already running in this tab.');
    const deadline = new AbortController();
    const timeout = setTimeout(() => deadline.abort(), 180_000);
    const boundedSignal = signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal;
    developmentPreparation = prepareWithoutController(boundedSignal, onProgress);
    try {
      return await developmentPreparation;
    } finally {
      clearTimeout(timeout);
      developmentPreparation = null;
    }
  }
  return new Promise((resolve, reject) => {
    const channel = new MessageChannel();
    const requestId = crypto.randomUUID();
    const clean = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      channel.port1.close();
    };
    const abort = () => {
      controller.postMessage({ type: 'MARGIN_OCR_ABORT', requestId });
      clean();
      reject(cancelled());
    };
    const timer = setTimeout(() => {
      controller.postMessage({ type: 'MARGIN_OCR_ABORT', requestId });
      clean();
      reject(new Error('OCR preparation timed out. Try again.'));
    }, 180_000);
    signal?.addEventListener('abort', abort, { once: true });
    channel.port1.onmessage = (event) => {
      const message = event.data;
      if (message?.kind === 'progress') onProgress?.(message.progress);
      else if (message?.kind === 'result') {
        clean();
        resolve({ ...message.status, offlineReady: true });
      } else if (message?.kind === 'error') {
        clean();
        reject(new Error(message.error || 'OCR preparation failed.'));
      }
    };
    controller.postMessage({ type: 'MARGIN_OCR_PREPARE', requestId }, [channel.port2]);
  });
}
