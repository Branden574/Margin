import { createHash } from 'node:crypto';
import { OCR_BASE_URL, OCR_PACK_ID } from '../../apps/web/src/editor/ocrAssets';

export const OCR_TEST_ORIGIN = 'https://127.0.0.1:4173';
const key = (request: RequestInfo | URL) =>
  new URL(request instanceof Request ? request.url : String(request), OCR_TEST_ORIGIN).href;
export class MemoryPublicCache {
  readonly rows = new Map<string, Response>();
  async match(request: RequestInfo | URL) {
    return this.rows.get(key(request))?.clone();
  }
  async put(request: RequestInfo | URL, response: Response) {
    this.rows.set(key(request), response.clone());
  }
  async delete(request: RequestInfo | URL) {
    return this.rows.delete(key(request));
  }
  async keys() {
    return [...this.rows.keys()].map((url) => new Request(url));
  }
}
export class MemoryPublicCaches {
  readonly stores = new Map<string, MemoryPublicCache>();
  async match(request: RequestInfo | URL) {
    for (const cache of this.stores.values()) {
      const response = await cache.match(request);
      if (response) return response;
    }
    return undefined;
  }
  async has(name: string) {
    return this.stores.has(name);
  }
  async open(name: string) {
    if (!this.stores.has(name)) this.stores.set(name, new MemoryPublicCache());
    return this.stores.get(name)!;
  }
  async delete(name: string) {
    return this.stores.delete(name);
  }
  async keys() {
    return [...this.stores.keys()];
  }
}
export function publicPackFixture() {
  const names = [
    'ocr-runtime.js',
    'worker.min.js',
    'worker.min.js.LICENSE.txt',
    'LICENSE.tesseract-core.txt',
    'third-party-notices.json',
    'lang/eng.traineddata.gz',
    ...['lstm', 'simd-lstm', 'relaxedsimd-lstm'].flatMap((variant) =>
      ['wasm.js', 'wasm'].map((extension) => `core/tesseract-core-${variant}.${extension}`),
    ),
  ];
  const bodies = new Map<string, Buffer>();
  const assets = names.map((name) => {
    const path = `${OCR_BASE_URL}${name}`;
    const bytes = Buffer.from(`Synthetic public asset: ${name}`);
    bodies.set(path, bytes);
    return {
      path,
      bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      contentType: name.endsWith('.wasm')
        ? 'application/wasm'
        : name.endsWith('.gz')
          ? 'application/gzip'
          : name.endsWith('.txt')
            ? 'text/plain'
            : name.endsWith('.json')
              ? 'application/json'
              : 'text/javascript',
    };
  });
  const manifest = {
    schemaVersion: 1,
    packId: OCR_PACK_ID,
    baseUrl: OCR_BASE_URL,
    totalBytes: assets.reduce((sum, asset) => sum + asset.bytes, 0),
    assets,
  };
  bodies.set(`${OCR_BASE_URL}manifest.json`, Buffer.from(JSON.stringify(manifest)));
  return { manifest, bodies };
}
