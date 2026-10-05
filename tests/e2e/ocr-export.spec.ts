import { test, expect, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { TEST_PASSPHRASE, unlockWorkspace } from './vault-helpers';
const { createOcrPdfFixture } = (await import(
  new URL('../helpers/ocr-fixture.mjs', import.meta.url).href
)) as { createOcrPdfFixture(): Promise<Buffer> };

async function encryptedOcrCount(page: Page) {
  return page.evaluate(async () => {
    const open = indexedDB.open('margin-vault-v1');
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(open.error);
    });
    try {
      const request = db
        .transaction('records')
        .objectStore('records')
        .index('by-store')
        .count('ocr');
      return await new Promise<number>((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    } finally {
      db.close();
    }
  });
}

test('real OCR exports as encrypted searchable PDF and imports into a separate vault without companion records', async ({
  page,
  browser,
}) => {
  test.setTimeout(180_000);
  const failures: string[] = [];
  page.on('pageerror', (error) => failures.push(error.message));
  await page.goto('/#documents');
  await unlockWorkspace(page);
  await page.getByLabel('Choose documents to upload', { exact: true }).setInputFiles({
    name: 'Searchable OCR round trip.pdf',
    mimeType: 'application/pdf',
    buffer: await createOcrPdfFixture(),
  });
  await page
    .getByRole('button', { name: 'Searchable OCR round trip PDF document', exact: true })
    .click();
  await page.getByRole('button', { name: 'Read aloud', exact: true }).click();
  const ocr = page.getByRole('region', { name: 'Text recognition', exact: true });
  for (const number of [1, 3]) {
    await page.getByRole('spinbutton', { name: 'Current page', exact: true }).fill(String(number));
    await expect(
      page.getByRole('region', { name: `Page ${number} text`, exact: true }),
    ).toContainText('This page has no selectable text.');
    await ocr.getByRole('button', { name: 'Recognize this page', exact: true }).click();
    await expect(ocr.getByRole('status')).toHaveText(
      'Recognized text saved encrypted on this device.',
      { timeout: 100_000 },
    );
    await expect(
      page.getByRole('region', { name: `Page ${number} text`, exact: true }),
    ).toContainText(/silver moon/i);
  }
  expect(await encryptedOcrCount(page)).toBe(2);
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export encrypted file', exact: true }).click();
  const download = await pending;
  const importedContext = await browser.newContext({
    ignoreHTTPSErrors: true,
    viewport: { width: 1440, height: 1000 },
  });
  try {
    expect(download.suggestedFilename()).toMatch(/^margin-document-.*\.margin$/);
    const path = await download.path();
    if (!path) throw new Error('The browser did not deliver the encrypted OCR export.');
    const encrypted = await readFile(path);
    expect(encrypted.subarray(0, 8).toString()).toBe('MARGIN1\n');
    expect(encrypted.subarray(0, 5).toString()).not.toBe('%PDF-');
    expect(encrypted.includes(Buffer.from('silver moon'))).toBe(false);
    expect(await encryptedOcrCount(page)).toBe(2);

    const imported = await importedContext.newPage();
    imported.on('pageerror', (error) => failures.push(error.message));
    await imported.goto(`${new URL(page.url()).origin}/#documents`);
    await unlockWorkspace(imported);
    expect(await encryptedOcrCount(imported)).toBe(0);
    await imported.getByRole('button', { name: 'Upload document', exact: true }).click();
    const exportPassphrase = imported.getByLabel('Export passphrase (for another workspace)', {
      exact: true,
    });
    await exportPassphrase.fill('synthetic-wrong-export-passphrase');
    await imported.getByLabel('Choose documents to upload', { exact: true }).setInputFiles({
      name: download.suggestedFilename(),
      mimeType: 'application/vnd.margin.encrypted',
      buffer: encrypted,
    });
    await expect(imported.getByRole('dialog').getByRole('alert')).toContainText(
      'could not be authenticated',
    );
    await expect(
      imported.getByRole('button', {
        name: 'Searchable OCR round trip — annotated PDF document',
        exact: true,
      }),
    ).toHaveCount(0);
    await exportPassphrase.fill(TEST_PASSPHRASE);
    await imported.getByLabel('Choose documents to upload', { exact: true }).setInputFiles({
      name: download.suggestedFilename(),
      mimeType: 'application/vnd.margin.encrypted',
      buffer: encrypted,
    });
    await imported
      .getByRole('button', {
        name: 'Searchable OCR round trip — annotated PDF document',
        exact: true,
      })
      .click();
    await imported.getByRole('button', { name: 'Read aloud', exact: true }).click();
    for (const number of [1, 3]) {
      await imported
        .getByRole('spinbutton', { name: 'Current page', exact: true })
        .fill(String(number));
      await expect(
        imported.getByRole('region', { name: `Page ${number} text`, exact: true }),
      ).toContainText(/silver moon/i);
      await expect(imported.getByRole('heading', { name: 'Page text', exact: true })).toBeVisible();
      await expect(
        imported.getByRole('heading', { name: 'Recognized text', exact: true }),
      ).toHaveCount(0);
    }
    await imported.getByRole('spinbutton', { name: 'Current page', exact: true }).fill('2');
    await expect(imported.getByRole('region', { name: 'Page 2 text', exact: true })).toContainText(
      'This page has no selectable text.',
    );
    await imported.getByRole('button', { name: 'Find in document', exact: true }).click();
    await imported.getByLabel('Search document text', { exact: true }).fill('silver moon');
    await imported.getByRole('button', { name: 'Find', exact: true }).click();
    await expect(imported.getByText('2 matching pages', { exact: true })).toBeVisible();
    expect(await encryptedOcrCount(imported)).toBe(0);
    await imported.reload();
    await unlockWorkspace(imported);
    await imported.getByRole('button', { name: 'Read aloud', exact: true }).click();
    await expect(imported.getByRole('region', { name: 'Page 1 text', exact: true })).toContainText(
      /silver moon/i,
    );
    expect(await encryptedOcrCount(imported)).toBe(0);
    expect(failures).toEqual([]);
  } finally {
    await importedContext.close();
    await download.delete();
  }
});
