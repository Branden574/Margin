import assert from 'node:assert/strict';
import { createHash, X509Certificate } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { expect } from '@playwright/test';
import { createOcrPdfFixture } from './helpers/ocr-fixture.mjs';

// Production-preview browser verification. Run in remote CI, not as a unit test.
const origin = process.env.MARGIN_OFFLINE_URL || 'https://127.0.0.1:4173';
const base = '/ocr/tesseract-7.0.0-eng-1/';
const cacheName = 'margin-ocr-tesseract-7.0.0-eng-1';
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
page.setDefaultTimeout(20_000);
const failures = [];
const externalRequests = [];
const modelRequests = [];
page.on('pageerror', (error) => failures.push(error.message));
page.on('console', (message) => {
  if (message.type() === 'error') failures.push(message.text());
});
context.on('request', (request) => {
  const url = new URL(request.url());
  if (['http:', 'https:'].includes(url.protocol) && url.origin !== origin)
    externalRequests.push(request.url());
  if (url.pathname.startsWith(`${base}core/`) || url.pathname.startsWith(`${base}lang/`))
    modelRequests.push(request.url());
});
const passphrase = 'synthetic offline OCR verification passphrase';
const ocr = page.getByRole('region', { name: 'Text recognition', exact: true });
async function unlock() {
  await page.getByLabel('Workspace passphrase', { exact: true }).fill(passphrase);
  await page.getByRole('button', { name: 'Unlock workspace', exact: true }).click();
  await expect(page.locator('.document-editor')).toBeVisible();
}
async function encryptedRecords() {
  return page.evaluate(async () => {
    const open = indexedDB.open('margin-vault-v1');
    const db = await new Promise((resolve, reject) => {
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(open.error);
    });
    try {
      const query = db
        .transaction('records')
        .objectStore('records')
        .index('by-store')
        .getAll('ocr');
      const rows = await new Promise((resolve, reject) => {
        query.onsuccess = () => resolve(query.result);
        query.onerror = () => reject(query.error);
      });
      return {
        count: rows.length,
        encrypted: rows.every(
          (row) =>
            row.ciphertext?.bytes instanceof Uint8Array &&
            row.ciphertext.iv.length === 12 &&
            !('text' in row) &&
            !('words' in row),
        ),
      };
    } finally {
      db.close();
    }
  });
}
async function recognize(pageNumber) {
  await ocr.getByRole('button', { name: 'Recognize this page', exact: true }).click();
  await expect(ocr.getByRole('status')).toHaveText(
    'Recognized text saved encrypted on this device.',
    { timeout: 100_000 },
  );
  await expect(
    page.getByRole('region', { name: `Page ${pageNumber} text`, exact: true }),
  ).toContainText(/silver moon/i);
}
try {
  const response = await page.goto(`${origin}/#documents`);
  const documentCsp = response.headers()['content-security-policy'];
  assert.match(documentCsp, /(?:^|;)\s*script-src 'self'\s*(?:;|$)/);
  assert(!documentCsp.includes('unsafe-eval'), 'The page must keep its restrictive script policy.');
  await page.getByLabel('Workspace passphrase', { exact: true }).fill(passphrase);
  await page.getByLabel('Confirm passphrase', { exact: true }).fill(passphrase);
  await page.getByRole('button', { name: 'Create private workspace', exact: true }).click();
  await expect(page.locator('.app-shell')).toBeVisible();
  await page.evaluate(async () => {
    await Promise.race([
      navigator.serviceWorker.ready,
      new Promise((_, reject) =>
        setTimeout(
          () => reject(new Error('The service worker was not ready within 15 seconds.')),
          15_000,
        ),
      ),
    ]);
  });
  await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller));
  assert.equal(await page.evaluate((name) => caches.has(name), cacheName), false);
  assert.deepEqual(
    modelRequests,
    [],
    'Installing the shell must not download the OCR model or core.',
  );
  await page.getByLabel('Choose documents to upload', { exact: true }).setInputFiles({
    name: 'Synthetic offline OCR.pdf',
    mimeType: 'application/pdf',
    buffer: await createOcrPdfFixture(),
  });
  await page
    .getByRole('button', { name: 'Synthetic offline OCR PDF document', exact: true })
    .click();
  await page.getByRole('button', { name: 'Read aloud', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Page 1 text', exact: true })).toContainText(
    'This page has no selectable text.',
  );
  assert.deepEqual(modelRequests, [], 'Opening reading tools must not download the OCR pack.');
  await recognize(1);
  await expect(ocr).toContainText('Recognition pack verified and available offline.');
  assert.deepEqual(await encryptedRecords(), { count: 1, encrypted: true });
  const cachedPack = await page.evaluate(
    async ({ base, cacheName }) => {
      const cache = await caches.open(cacheName);
      const manifestResponse = await cache.match(`${base}manifest.json`);
      const manifestBytes = await manifestResponse.arrayBuffer();
      const manifest = JSON.parse(new TextDecoder().decode(manifestBytes));
      const marker = await (await cache.match(`${base}.ready`)).json();
      const digest = async (bytes) =>
        Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)))
          .map((value) => value.toString(16).padStart(2, '0'))
          .join('');
      const assets = [];
      for (const asset of manifest.assets) {
        const response = await cache.match(asset.path);
        const bytes = await response.arrayBuffer();
        assets.push({
          path: asset.path,
          verified: bytes.byteLength === asset.bytes && (await digest(bytes)) === asset.sha256,
        });
      }
      const worker = await cache.match(`${base}worker.min.js`);
      const model = await cache.match(`${base}lang/eng.traineddata.gz`);
      const modelBytes = new Uint8Array(await model.arrayBuffer());
      return {
        paths: (await cache.keys()).map((request) => new URL(request.url).pathname).sort(),
        expectedPaths: [
          ...assets.map((asset) => asset.path),
          `${base}manifest.json`,
          `${base}.ready`,
        ].sort(),
        verified: assets.every((asset) => asset.verified),
        assets: assets.length,
        evidence:
          marker.packId === manifest.packId &&
          marker.manifestSha256 === (await digest(manifestBytes)),
        workerCsp: worker.headers.get('Content-Security-Policy'),
        modelEncoding: model.headers.get('Content-Encoding'),
        modelMagic: [...modelBytes.slice(0, 2)],
      };
    },
    { base, cacheName },
  );
  assert.equal(cachedPack.assets, 12);
  assert.equal(cachedPack.verified, true);
  assert.equal(cachedPack.evidence, true);
  assert.deepEqual(
    cachedPack.paths,
    cachedPack.expectedPaths,
    'CacheStorage must contain only the declared public pack.',
  );
  assert.equal(
    cachedPack.workerCsp,
    "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'self'; worker-src 'none'; object-src 'none'; base-uri 'none'",
  );
  assert.equal(cachedPack.modelEncoding, null);
  assert.deepEqual(cachedPack.modelMagic, [0x1f, 0x8b]);

  // Reload destroys the first OCR worker. Page three has never been recognized: both
  // fresh worker initialization and real recognition must now work from the public cache.
  await context.setOffline(true);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await unlock();
  await page.getByRole('button', { name: 'Read aloud', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Page 1 text', exact: true })).toContainText(
    /silver moon/i,
  );
  assert.deepEqual(await encryptedRecords(), { count: 1, encrypted: true });
  await page.getByRole('spinbutton', { name: 'Current page', exact: true }).fill('3');
  await expect(page.getByRole('region', { name: 'Page 3 text', exact: true })).toContainText(
    'This page has no selectable text.',
  );
  await recognize(3);
  await expect(ocr).toContainText('Recognition pack verified and available offline.');
  assert.deepEqual(await encryptedRecords(), { count: 2, encrypted: true });
  await page.getByRole('spinbutton', { name: 'Current page', exact: true }).fill('2');
  await expect(page.getByRole('region', { name: 'Page 2 text', exact: true })).toContainText(
    'This page has no selectable text.',
  );
  await ocr.getByRole('button', { name: 'Recognize this page', exact: true }).click();
  await expect(ocr.getByRole('status')).toHaveText(
    'No printed text was found. Try a clearer scan.',
    { timeout: 100_000 },
  );
  assert.deepEqual(await encryptedRecords(), { count: 2, encrypted: true });
  assert.deepEqual(
    externalRequests,
    [],
    'Recognition must never request a runtime CDN or external service.',
  );
  assert.deepEqual(
    failures,
    [],
    'Production and offline recognition must not produce browser errors.',
  );
  console.log(
    JSON.stringify(
      {
        result: 'passed',
        ocrRecognizedPages: 2,
        cachedOcrAssets: cachedPack.assets,
        encryptedOcrRecords: 2,
        verified: [
          'on-demand public pack download',
          'byte lengths and SHA-256 for every cached public asset',
          'worker-only WebAssembly CSP and restrictive document CSP',
          'encrypted OCR recovery after offline reload',
          'fresh offline worker recognizes a previously unrecognized rotated crop',
          'blank page leaves no OCR record',
          'no external requests or browser errors',
        ],
      },
      null,
      2,
    ),
  );
} catch (error) {
  const evidence = new URL('../test-results/ocr-offline/', import.meta.url);
  await mkdir(evidence, { recursive: true });
  await page
    .screenshot({ path: new URL('failure.png', evidence).pathname, fullPage: true })
    .catch(() => {});
  console.error(
    JSON.stringify(
      {
        failures,
        externalRequests,
        body: (
          await page
            .locator('body')
            .innerText()
            .catch(() => '')
        ).slice(-8000),
      },
      null,
      2,
    ),
  );
  throw error;
} finally {
  await context.close();
  await browser.close();
}
