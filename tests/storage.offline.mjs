import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { createHash, X509Certificate } from 'node:crypto';
import { chromium } from 'playwright';
import { PDFDocument } from 'pdf-lib';

// Run after a production build and HTTPS preview: node tests/storage.offline.mjs
const origin = process.env.MARGIN_OFFLINE_URL || 'https://127.0.0.1:4173';
const certificate = new X509Certificate(
  await readFile(new URL('../.local/tls/cert.pem', import.meta.url)),
);
const publicKeyPin = createHash('sha256')
  .update(certificate.publicKey.export({ type: 'spki', format: 'der' }))
  .digest('base64');
const browser = await chromium.launch({
  headless: true,
  args: [`--ignore-certificate-errors-spki-list=${publicKeyPin}`],
});
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const page = await context.newPage();
const failures = [];
page.on('pageerror', (error) => failures.push(error.message));
page.on('console', (message) => {
  if (message.type() === 'error') failures.push(message.text());
});
page.on('requestfailed', (request) =>
  failures.push(`${request.url()}: ${request.failure()?.errorText}`),
);
const passphrase = 'offline verification synthetic passphrase';
async function awaitRenderedPage(minimumInk = 200) {
  await page.waitForFunction((threshold) => {
    const canvas = document.querySelector('.editor-canvas-area canvas');
    if (!(canvas instanceof HTMLCanvasElement) || canvas.width < 100) return false;
    const pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
    let ink = 0;
    for (let index = 0; index < pixels.length; index += 4)
      if (pixels[index] < 200 && pixels[index + 1] < 200 && pixels[index + 2] < 200) ink++;
    return ink > threshold;
  }, minimumInk);
}
try {
  await page.goto(origin);
  await page.locator('input[name=passphrase]').fill(passphrase);
  await page.locator('input[name=confirm]').fill(passphrase);
  await page.getByRole('button', { name: 'Create private workspace' }).click();
  await page.getByRole('heading', { name: 'Welcome back, Alex.' }).waitFor();
  await page.evaluate(async () => {
    await Promise.race([
      navigator.serviceWorker.ready,
      new Promise((_, reject) =>
        setTimeout(
          () =>
            reject(
              new Error('Offline service worker installation did not complete within 15 seconds.'),
            ),
          15_000,
        ),
      ),
    ]);
  });
  await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller));
  const cached = await page.evaluate(async () =>
    (await (await caches.open('margin-shell-v4')).keys()).map(
      (request) => new URL(request.url).pathname,
    ),
  );
  const assets = await readdir(new URL('../apps/web/dist/assets/', import.meta.url));
  assert.deepEqual(
    assets.filter((asset) => !cached.includes(`/assets/${asset}`)),
    [],
    'Every emitted asset, including lazy workers and fonts, must be precached at its exact URL.',
  );
  assert(cached.some((asset) => asset.startsWith('/assets/pdf.worker') && asset.endsWith('.mjs')));
  assert(
    cached.some((asset) => asset.startsWith('/assets/import.worker') && asset.endsWith('.js')),
  );
  assert(cached.some((asset) => asset.endsWith('.woff2')));
  const encryption = await page.evaluate(async () => {
    const request = indexedDB.open('margin-vault-v1');
    const db = await new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const store = db.transaction('records').objectStore('records');
    const requestRows = store.getAll();
    const rows = await new Promise((resolve, reject) => {
      requestRows.onsuccess = () => resolve(requestRows.result);
      requestRows.onerror = () => reject(requestRows.error);
    });
    db.close();
    return {
      count: rows.length,
      encrypted: rows.every(
        (row) =>
          row.ciphertext?.bytes instanceof Uint8Array &&
          row.ciphertext.iv.length === 12 &&
          !('name' in row) &&
          !('blob' in row),
      ),
    };
  });
  assert(encryption.encrypted && encryption.count > 10);
  // No PDF editor has been opened online. Everything below must load from the offline shell.
  await context.setOffline(true);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.getByRole('heading', { name: 'Welcome back to Margin.' }).waitFor();
  await page.locator('input[name=passphrase]').fill(passphrase);
  await page.getByRole('button', { name: 'Unlock workspace' }).click();
  await page.getByRole('button', { name: 'Open Quadratic equations', exact: true }).click();
  await awaitRenderedPage();
  assert.equal(await page.locator('.editor-error').count(), 0);
  await page.screenshot({ path: '/tmp/margin-offline-encrypted-editor.png', fullPage: true });
  await page.getByRole('button', { name: 'Back to workspace', exact: true }).click();
  await page.getByRole('button', { name: 'Blank document', exact: true }).click();
  await page
    .getByRole('textbox', { name: 'Document name', exact: true })
    .fill('Offline private notebook');
  await page.getByRole('button', { name: 'Create document', exact: true }).click();
  await awaitRenderedPage(20);
  await page.getByRole('button', { name: 'Back to workspace', exact: true }).click();
  const pdf = await PDFDocument.create();
  pdf.addPage();
  await page.locator('input[type=file][aria-label="Choose documents to upload"]').setInputFiles({
    name: 'Offline import.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(await pdf.save()),
  });
  await page.getByRole('button', { name: 'Open Offline import', exact: true }).waitFor();
  assert.equal(await page.locator('[role=alert]').count(), 0);
  assert.deepEqual(
    failures,
    [],
    'No browser errors should occur while opening or importing offline.',
  );
  console.log(
    JSON.stringify(
      {
        result: 'passed',
        cachedAssets: assets.length,
        encryptedRecords: encryption.count,
        verified: [
          'vault setup',
          'ciphertext-only IndexedDB',
          'offline reload requires passphrase',
          'unopened sample PDF renders offline',
          'offline blank PDF module worker',
          'offline PDF import module worker',
          'all lazy assets and local fonts cached',
        ],
      },
      null,
      2,
    ),
  );
} catch (error) {
  const cacheDebug = await page.evaluate(async () => {
    const cache = await caches.open('margin-shell-v4');
    const keys = (await cache.keys()).filter(
      (request) => request.url.includes('DocumentEditor') && request.url.endsWith('.css'),
    );
    return Promise.all(
      keys.map(async (request) => {
        const response = await cache.match(request, { ignoreVary: true });
        let fetched;
        try {
          fetched = (await fetch(request.url)).status;
        } catch (reason) {
          fetched = String(reason);
        }
        return {
          url: request.url,
          cachedMode: request.mode,
          responseType: response.type,
          headers: [...response.headers],
          fetched,
        };
      }),
    );
  });
  console.error(JSON.stringify({ cacheDebug }, null, 2));
  console.error(
    JSON.stringify(
      {
        failures,
        visibleText: (await page.locator('body').innerText()).slice(0, 2000),
        url: page.url(),
      },
      null,
      2,
    ),
  );
  await page.screenshot({ path: '/tmp/margin-offline-failure.png', fullPage: true });
  throw error;
} finally {
  await context.close();
  await browser.close();
}
