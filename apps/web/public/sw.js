/* Build-only registration in the app keeps development HMR out of the offline cache. */
// This small verification helper contains no model or user document data. Language/core
// bytes are cached only after an explicit MARGIN_OCR_PREPARE request from a live client.
importScripts('/ocr/tesseract-7.0.0-eng-1/ocr-runtime.js');
const CACHE = 'margin-shell-v4';
const OCR = self.MarginOcrAssets;
let ocrPreparation = null;
const ASSET = /["'(]((?:\/?assets\/|\.{1,2}\/)[^"'()\s]+\.(?:m?js|css|woff2?|png|jpe?g|webp|svg))/g;
function discoverAssets(source, base) {
  return [...source.matchAll(ASSET)]
    .map(
      (match) =>
        new URL(match[1], match[1].startsWith('assets/') ? self.registration.scope : base).href,
    )
    .filter((value) => {
      const url = new URL(value);
      // Only Vite's emitted hashed files. Libraries also contain fallback names
      // such as "./pdf.worker.mjs" that are not actual deployed assets.
      return (
        url.origin === self.location.origin &&
        url.pathname.includes('/assets/') &&
        /-[A-Za-z0-9_-]{6,}\.(?:m?js|css|woff2?|png|jpe?g|webp|svg)$/.test(url.pathname)
      );
    });
}

async function cacheShell() {
  const cache = await caches.open(CACHE);
  const root = new URL('./', self.registration.scope).href;
  const response = await fetch(root, { cache: 'reload' });
  if (!response.ok) throw new Error('The app shell could not be cached.');
  await cache.put(root, response.clone());
  const queue = discoverAssets(await response.text(), root);
  const visited = new Set();
  while (queue.length) {
    const url = queue.shift();
    if (visited.has(url)) continue;
    visited.add(url);
    const asset = await fetch(url, { cache: 'reload' });
    if (!asset.ok || asset.headers.get('content-type')?.includes('text/html'))
      throw new Error('An app asset could not be cached.');
    await cache.put(url, asset.clone());
    if (/\.(m?js|css)$/.test(url)) {
      queue.push(...discoverAssets(await asset.text(), url));
    }
  }
}
self.addEventListener('install', (event) => {
  event.waitUntil(cacheShell().then(() => self.skipWaiting()));
});
self.addEventListener('activate', (event) => {
  event.waitUntil(
    Promise.all([
      caches
        .keys()
        .then((names) =>
          Promise.all(
            names
              .filter((name) => name.startsWith('margin-shell-') && name !== CACHE)
              .map((name) => caches.delete(name)),
          ),
        ),
      self.clients.claim(),
    ]),
  );
});
self.addEventListener('message', (event) => {
  const type = event.data?.type;
  if (!['MARGIN_OCR_PREPARE', 'MARGIN_OCR_STATUS', 'MARGIN_OCR_ABORT'].includes(type)) return;
  const source = event.source;
  if (!source?.id || !source.url || new URL(source.url).origin !== self.location.origin) return;
  const requestId = event.data?.requestId;
  if (typeof requestId !== 'string' || !/^[a-zA-Z0-9-]{1,64}$/.test(requestId)) return;
  if (type === 'MARGIN_OCR_ABORT') {
    if (ocrPreparation?.requestId === requestId && ocrPreparation.clientId === source.id)
      ocrPreparation.controller.abort();
    return;
  }
  const port = event.ports?.[0];
  if (!port) return;
  const send = (message) => port.postMessage(message);
  if (type === 'MARGIN_OCR_STATUS') {
    event.waitUntil(
      OCR.getOcrAssetStatus()
        .then((status) =>
          send({ kind: 'result', status: { ...status, offlineReady: status.ready } }),
        )
        .catch(() => send({ kind: 'error', error: 'OCR cache status could not be read.' })),
    );
    return;
  }
  if (ocrPreparation) {
    send({
      kind: 'error',
      error: 'OCR preparation is already running in another request. Try again shortly.',
    });
    return;
  }
  const controller = new AbortController();
  ocrPreparation = { requestId, clientId: source.id, controller };
  event.waitUntil(
    OCR.prepareOcrAssets(controller.signal, (progress) => send({ kind: 'progress', progress }))
      .then(async (status) => {
        if (!status.ready) throw new Error('OCR preparation did not complete.');
        await Promise.all(
          (await caches.keys())
            .filter((name) => name.startsWith('margin-ocr-') && name !== OCR.OCR_CACHE)
            .map((name) => caches.delete(name)),
        );
        send({ kind: 'result', status: { ...status, offlineReady: true } });
      })
      .catch((error) => send({ kind: 'error', error: error.message || 'OCR preparation failed.' }))
      .finally(() => {
        ocrPreparation = null;
        port.close();
      }),
  );
});
self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (
    request.method !== 'GET' ||
    url.origin !== self.location.origin ||
    url.pathname.startsWith('/api/')
  )
    return;
  if (url.pathname.startsWith(OCR.OCR_BASE_URL) && !url.search) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(OCR.OCR_CACHE);
        const cached = (await cache.match(`${OCR.OCR_BASE_URL}.ready`))
          ? await cache.match(request, { ignoreVary: true })
          : undefined;
        return cached || fetch(request);
      })(),
    );
    return;
  }
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then(async (response) => {
          if (response.ok)
            await (
              await caches.open(CACHE)
            ).put(new URL('./', self.registration.scope).href, response.clone());
          return response;
        })
        .catch(
          async () =>
            (await caches.match(new URL('./', self.registration.scope).href, {
              ignoreVary: true,
            })) || Response.error(),
        ),
    );
    return;
  }
  // Vite's public assets may carry Vary: Origin; module/font requests and install
  // prefetches use different Origin headers. Hashed same-origin assets are identical.
  if (url.pathname.includes('/assets/'))
    event.respondWith(
      caches.match(request, { ignoreVary: true }).then(
        (cached) =>
          cached ||
          fetch(request).then(async (response) => {
            if (response.ok) await (await caches.open(CACHE)).put(request, response.clone());
            return response;
          }),
      ),
    );
});
