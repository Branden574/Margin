import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { unlockWorkspace } from './vault-helpers';
const { createOcrPdfFixture } = (await import(
  new URL('../helpers/ocr-fixture.mjs', import.meta.url).href
)) as { createOcrPdfFixture(): Promise<Buffer> };
const ASSET_BASE = '/ocr/tesseract-7.0.0-eng-1/';

async function openScan(page: Page) {
  await page.goto('/#documents');
  await unlockWorkspace(page);
  await page.getByLabel('Choose documents to upload', { exact: true }).setInputFiles({
    name: 'Synthetic OCR browser scan.pdf',
    mimeType: 'application/pdf',
    buffer: await createOcrPdfFixture(),
  });
  await page
    .getByRole('button', { name: 'Synthetic OCR browser scan PDF document', exact: true })
    .click();
  await page.getByRole('button', { name: 'Read aloud', exact: true }).click();
  const text = page.getByRole('region', { name: 'Page 1 text', exact: true });
  await expect(text).toContainText('This page has no selectable text.');
  const ocr = page.getByRole('region', { name: 'Text recognition', exact: true });
  await expect(ocr.getByRole('button', { name: 'Recognize this page', exact: true })).toBeEnabled();
  return ocr;
}
async function rawOcrRecords(page: Page) {
  return page.evaluate(async () => {
    const open = indexedDB.open('margin-vault-v1');
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(open.error);
    });
    try {
      const query = db
        .transaction('records')
        .objectStore('records')
        .index('by-store')
        .getAll('ocr');
      const rows = await new Promise<Record<string, any>[]>((resolve, reject) => {
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

test('real local OCR persists encrypted text, copies, searches, highlights and handles a rotated crop', async ({
  page,
  context,
}) => {
  test.setTimeout(180_000);
  const failures: string[] = [];
  page.on('pageerror', (error) => failures.push(error.message));
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const ocr = await openScan(page);
  await ocr.getByRole('button', { name: 'Recognize this page', exact: true }).click();
  await expect(ocr.getByRole('status')).toHaveText(
    'Recognized text saved encrypted on this device.',
    { timeout: 100_000 },
  );
  await expect(page.getByRole('heading', { name: 'Recognized text', exact: true })).toBeVisible();
  const text = page.getByRole('region', { name: 'Page 1 text', exact: true });
  await expect(text).toContainText(/silver moon/i);
  await expect(text).toContainText(/Synthetic OCR test/i);
  expect(await rawOcrRecords(page)).toEqual({ count: 1, encrypted: true });
  const panel = page.getByRole('complementary', { name: 'Reading tools', exact: true });
  await panel.getByRole('button', { name: 'Copy text', exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toMatch(/silver moon/i);
  const accessibility = await new AxeBuilder({ page })
    .include('.editor-reading-panel')
    .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
    .analyze();
  expect(accessibility.violations).toEqual([]);
  await ocr.getByRole('button', { name: 'Select recognized text', exact: true }).click();
  const layer = page.getByRole('region', { name: 'Selectable recognized text', exact: true });
  await expect(layer.locator('[data-ocr-word]').first()).toBeAttached();
  await layer.focus();
  await layer.press('Home');
  await layer.press('Shift+ArrowRight');
  await layer.press('Shift+ArrowRight');
  await layer.press('Shift+ArrowRight');
  await expect
    .poll(() => page.evaluate(() => window.getSelection()?.toString()))
    .toMatch(/clearer page/i);
  await ocr.getByRole('button', { name: 'Highlight selection', exact: true }).click();
  await expect(page.locator('.editor-annotation-layer > g')).not.toHaveCount(0);
  await expect(page.getByText('Saved on this device', { exact: true })).toBeVisible();
  await page.reload();
  await unlockWorkspace(page);
  await page.getByRole('button', { name: 'Read aloud', exact: true }).click();
  await expect(text).toContainText(/silver moon/i);
  await expect(page.locator('.editor-annotation-layer > g')).not.toHaveCount(0);
  await page.getByRole('button', { name: 'Find in document', exact: true }).click();
  await page.getByLabel('Search document text', { exact: true }).fill('silver moon');
  await page.getByRole('button', { name: 'Find', exact: true }).click();
  await expect(page.getByText('1 matching page', { exact: false })).toBeVisible();
  await expect(page.locator('.editor-search-results')).toContainText(/silver moon/i);
  await page.getByRole('button', { name: 'Read aloud', exact: true }).click();
  await page.getByRole('spinbutton', { name: 'Current page', exact: true }).fill('3');
  await expect(page.getByRole('region', { name: 'Page 3 text', exact: true })).toContainText(
    'This page has no selectable text.',
  );
  await ocr.getByRole('button', { name: 'Recognize this page', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Page 3 text', exact: true })).toContainText(
    /silver moon/i,
    { timeout: 100_000 },
  );
  await ocr.getByRole('button', { name: 'Select recognized text', exact: true }).click();
  await expect(layer.locator('[data-ocr-word]').first()).toBeAttached();
  expect(
    await layer.evaluate((element) => {
      const page = element.getBoundingClientRect();
      return [...element.querySelectorAll('[data-ocr-word]')].every((word) => {
        const box = word.getBoundingClientRect();
        return (
          box.left >= page.left - 1 &&
          box.top >= page.top - 1 &&
          box.right <= page.right + 3 &&
          box.bottom <= page.bottom + 1
        );
      });
    }),
  ).toBe(true);
  expect(await rawOcrRecords(page)).toEqual({ count: 2, encrypted: true });
  expect(failures).toEqual([]);
});

test('cancelling a delayed public-model download leaves no saved recognized text', async ({
  page,
}) => {
  const ocr = await openScan(page);
  let release!: () => void;
  const delayed = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(`**${ASSET_BASE}lang/eng.traineddata.gz`, async (route) => {
    await delayed;
    await route.abort().catch(() => {});
  });
  try {
    const requested = page.waitForRequest(
      (request) => new URL(request.url()).pathname === `${ASSET_BASE}lang/eng.traineddata.gz`,
    );
    await ocr.getByRole('button', { name: 'Recognize this page', exact: true }).click();
    await requested;
    await ocr.getByRole('button', { name: 'Cancel recognition', exact: true }).click();
    await expect(ocr.getByRole('status')).toHaveText('Recognition cancelled.');
    await expect(
      ocr.getByRole('button', { name: 'Recognize this page', exact: true }),
    ).toBeEnabled();
    expect(await rawOcrRecords(page)).toEqual({ count: 0, encrypted: true });
  } finally {
    release();
    await page.unrouteAll({ behavior: 'wait' });
  }
  await page.reload();
  await unlockWorkspace(page);
  await page.getByRole('button', { name: 'Read aloud', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Page 1 text', exact: true })).toContainText(
    'This page has no selectable text.',
  );
  await expect(page.getByRole('heading', { name: 'Recognized text', exact: true })).toHaveCount(0);
  expect(await rawOcrRecords(page)).toEqual({ count: 0, encrypted: true });
});
