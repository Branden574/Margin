import { test, expect, type Page, type Download } from '@playwright/test';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { readFile } from 'node:fs/promises';
import { unlockWorkspace, TEST_PASSPHRASE } from './vault-helpers';
async function openSample(page: Page) {
  await page.goto('/');
  await unlockWorkspace(page);
  await page.getByText('Cell structure & function', { exact: true }).first().click();
  await expect(page.getByRole('button', { name: 'Text', exact: true })).toBeEnabled();
  await expect(page.locator('.editor-paper canvas')).toBeVisible();
}
async function textNote(page: Page, text: string) {
  await page.getByRole('button', { name: 'Text', exact: true }).click();
  await page.locator('.editor-annotation-layer').click({ position: { x: 100, y: 250 } });
  await page.getByLabel('Annotation text', { exact: true }).fill(text);
  await page.getByRole('button', { name: 'Save text', exact: true }).click();
  await expect(page.getByText('Saved on this device', { exact: true })).toBeVisible();
}
async function pageAction(page: Page, name: string) {
  await page.getByRole('button', { name: 'Page options', exact: true }).click();
  await page.getByRole('button', { name, exact: true }).click();
}
async function decryptedExport(page: Page, download: Download) {
  expect(download.suggestedFilename()).toMatch(/^margin-document-.*\.margin$/);
  const path = await download.path();
  if (!path) throw new Error('Encrypted export is missing');
  const encrypted = await readFile(path);
  expect(encrypted.subarray(0, 4).toString()).not.toBe('%PDF');
  const clear = await page.evaluate(
    async ({ data, passphrase }) => {
      const modulePath = '/src/lib/vault.ts';
      const vault = await import(modulePath);
      if ((await vault.vaultStatus()) !== 'unlocked') await vault.unlockVault(passphrase);
      const result = await vault.decryptExport(
        new Blob([new Uint8Array(data)], { type: 'application/vnd.margin.encrypted' }),
        passphrase,
      );
      return Array.from(new Uint8Array(await result.blob.arrayBuffer()));
    },
    { data: Array.from(encrypted), passphrase: TEST_PASSPHRASE },
  );
  return PDFDocument.load(new Uint8Array(clear));
}
async function fixture(pages = 1) {
  const pdf = await PDFDocument.create(),
    font = await pdf.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < pages; i++)
    pdf
      .addPage([612, 792])
      .drawText(`Verification page ${i + 1}`, { x: 50, y: 740, size: 16, font });
  return Buffer.from(await pdf.save());
}

test('annotation save/reload, shape undo/redo and page export use real PDF data', async ({
  page,
}) => {
  const failures: string[] = [];
  page.on('pageerror', (error) => failures.push(error.message));
  await openSample(page);
  await textNote(page, 'Persistent annotation evidence');
  await page.reload();
  await unlockWorkspace(page);
  await expect(page.getByText('Persistent annotation evidence', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Shapes', exact: true }).click();
  await page.getByRole('button', { name: 'Rectangle', exact: true }).click();
  const box = await page.locator('.editor-annotation-layer').boundingBox();
  if (!box) throw new Error('Missing document canvas');
  await page.mouse.move(box.x + 75, box.y + 145);
  await page.mouse.down();
  await page.mouse.move(box.x + 210, box.y + 195, { steps: 6 });
  await page.mouse.up();
  await expect(page.locator('.editor-annotation-layer > g')).toHaveCount(2);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(page.locator('.editor-annotation-layer > g')).toHaveCount(1);
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  await expect(page.locator('.editor-annotation-layer > g')).toHaveCount(2);
  await pageAction(page, 'Duplicate page');
  await expect(page.locator('.editor-count')).toHaveText('4');
  await expect(
    page.getByRole('button', { name: 'Export encrypted file', exact: true }),
  ).toBeEnabled();
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(page.locator('.editor-count')).toHaveText('3');
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  await expect(page.locator('.editor-count')).toHaveText('4');
  await page.getByRole('button', { name: 'Find in document', exact: true }).click();
  await page.getByLabel('Search document text', { exact: true }).fill('cell');
  await page.getByRole('button', { name: 'Find', exact: true }).click();
  await expect(page.getByText(/matching pages/)).toBeVisible();
  await page.getByRole('button', { name: 'Close panel', exact: true }).click();
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export encrypted file', exact: true }).click();
  const download = await downloadPromise;
  expect((await decryptedExport(page, download)).getPageCount()).toBe(4);
  await page.reload();
  await unlockWorkspace(page);
  await expect(page.locator('.editor-count')).toHaveText('4');
  await expect(page.getByText('Persistent annotation evidence', { exact: true })).toBeVisible();
  expect(failures).toEqual([]);
});

test('merges a second PDF and extracts a real standalone page', async ({ page }) => {
  await openSample(page);
  await page
    .getByLabel('Choose PDF to merge', { exact: true })
    .setInputFiles({ name: 'Appendix.pdf', mimeType: 'application/pdf', buffer: await fixture(2) });
  await expect(page.locator('.editor-count')).toHaveText('5');
  await expect(page.getByRole('button', { name: 'Page options', exact: true })).toBeEnabled();
  const downloadPromise = page.waitForEvent('download');
  await pageAction(page, 'Extract encrypted page');
  expect((await decryptedExport(page, await downloadPromise)).getPageCount()).toBe(1);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(page.locator('.editor-count')).toHaveText('3');
});

test('prevents two local editors from silently overwriting the same PDF', async ({
  page,
  context,
}) => {
  await openSample(page);
  await textNote(page, 'Protected local annotation');
  const second = await context.newPage();
  await second.goto(page.url());
  await unlockWorkspace(second);
  await expect(second.getByText(/This document is open for editing in another tab/)).toBeVisible();
  await expect(second.getByRole('button', { name: 'Text', exact: true })).toBeDisabled();
  await page.close();
  await second.getByRole('button', { name: 'Retry editing', exact: true }).click();
  await expect(second.getByRole('button', { name: 'Text', exact: true })).toBeEnabled();
  await expect(second.getByText(/This document is open for editing in another tab/)).toHaveCount(0);
  await expect(second.getByLabel('Workspace passphrase', { exact: true })).toHaveCount(0);
  await expect(second.getByText('Protected local annotation', { exact: true })).toBeVisible();
  await textNote(second, 'Saved after the editing lock transferred');
  await second.reload();
  await unlockWorkspace(second);
  await expect(second.getByText('Protected local annotation', { exact: true })).toBeVisible();
  await expect(
    second.getByText('Saved after the editing lock transferred', { exact: true }),
  ).toBeVisible();
});

test('500-page synthetic PDF keeps at most six canvases and navigates to the final page', async ({
  page,
}) => {
  await page.goto('/#documents');
  await unlockWorkspace(page);
  await page.getByLabel('Choose documents to upload').setInputFiles({
    name: 'Large synthetic document.pdf',
    mimeType: 'application/pdf',
    buffer: await fixture(500),
  });
  await expect(
    page.getByRole('button', { name: 'Actions for Large synthetic document', exact: true }),
  ).toBeVisible();
  await page
    .getByRole('button', { name: 'Large synthetic document PDF document', exact: true })
    .click();
  await expect(page.locator('.editor-count')).toHaveText('500');
  await expect(page.getByRole('button', { name: 'Text', exact: true })).toBeEnabled();
  expect(await page.locator('canvas').count()).toBeLessThanOrEqual(6);
  await page.getByRole('spinbutton', { name: 'Current page', exact: true }).fill('499');
  await expect(page.getByText('PAGE 499 OF 500', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Next page', exact: true }).click();
  await expect(page.getByText('PAGE 500 OF 500', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Next page', exact: true })).toBeDisabled();
  expect(await page.locator('canvas').count()).toBeLessThanOrEqual(6);
  await page.getByRole('button', { name: 'View page text', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Page 500 text', exact: true })).toContainText(
    'Verification page 500',
  );
});

test('encrypted export retains long Unicode comments across a complete notes appendix', async ({
  page,
}) => {
  await openSample(page);
  await page.getByRole('button', { name: 'Comment', exact: true }).click();
  await page.locator('.editor-annotation-layer').click({ position: { x: 160, y: 300 } });
  const text = Array.from(
    { length: 90 },
    (_, index) =>
      `Observation ${index + 1}: β-cells and café notes — this complete line is retained.`,
  ).join('\n');
  await page.getByLabel('Comment text', { exact: true }).fill(text);
  await page.getByRole('button', { name: 'Save comment', exact: true }).click();
  await expect(page.getByText('Saved on this device', { exact: true })).toBeVisible();
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export encrypted file', exact: true }).click();
  const exported = await decryptedExport(page, await downloadPromise);
  expect(exported.getPageCount()).toBeGreaterThanOrEqual(6);
  await page.reload();
  await unlockWorkspace(page);
  await page.getByRole('button', { name: 'Show comments', exact: true }).click();
  await expect(page.locator('.editor-comment p')).toHaveText(text);
});

test('cross-tab vault lock refuses an unfinished draft and preserves saved annotations before clearing keys', async ({
  page,
  context,
}) => {
  await openSample(page);
  await page.getByRole('button', { name: 'Text', exact: true }).click();
  await page.locator('.editor-annotation-layer').click({ position: { x: 100, y: 250 } });
  await page.getByLabel('Annotation text', { exact: true }).fill('Saved before all tabs lock');
  const home = await context.newPage();
  await home.goto('/');
  await unlockWorkspace(home);
  await home.getByRole('button', { name: 'Lock workspace', exact: true }).click();
  await expect(
    home.getByText(/Another tab could not save|Save failed|Couldn't save|Retry saving/),
  ).toBeVisible();
  await expect(page.getByLabel('Annotation text', { exact: true })).toHaveValue(
    'Saved before all tabs lock',
  );
  await page.getByRole('button', { name: 'Save text', exact: true }).click();
  await home.getByRole('button', { name: 'Lock workspace', exact: true }).click();
  await expect(home.getByLabel('Workspace passphrase', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Workspace passphrase', { exact: true })).toBeVisible();
  await unlockWorkspace(page);
  await expect(page.getByText('Saved before all tabs lock', { exact: true })).toBeVisible();
});

test('browser Back refuses an unfinished annotation and succeeds after saving it', async ({
  page,
}) => {
  await openSample(page);
  const editorUrl = page.url();
  await page.getByRole('button', { name: 'Text', exact: true }).click();
  await page.locator('.editor-annotation-layer').click({ position: { x: 110, y: 270 } });
  await page
    .getByLabel('Annotation text', { exact: true })
    .fill('Keep this draft when Back is pressed');
  await page.goBack();
  await expect(page).toHaveURL(editorUrl);
  await expect(page.getByLabel('Annotation text', { exact: true })).toHaveValue(
    'Keep this draft when Back is pressed',
  );
  await expect(page.getByRole('dialog')).toContainText(
    'Save or cancel the pending annotation or form changes before leaving or locking.',
  );
  await page.getByRole('button', { name: 'Save text', exact: true }).click();
  await page.goBack();
  await expect(page.getByRole('navigation', { name: 'Main navigation' })).toBeVisible();
  await page.getByText('Cell structure & function', { exact: true }).first().click();
  await expect(
    page.getByText('Keep this draft when Back is pressed', { exact: true }),
  ).toBeVisible();
});

test('browser Back retains an annotation after quota failure until retry commits it', async ({
  page,
}) => {
  await openSample(page);
  const editorUrl = page.url();
  await page.evaluate(() => {
    const original = IDBObjectStore.prototype.put;
    let blocked = true;
    Object.assign(window, {
      recoverEditorQuota: () => {
        blocked = false;
      },
    });
    IDBObjectStore.prototype.put = function (value: unknown, key?: IDBValidKey) {
      if (blocked && this.name === 'records')
        throw new DOMException('Synthetic browser quota exhaustion', 'QuotaExceededError');
      return original.call(this, value, key);
    };
  });
  await page.getByRole('button', { name: 'Text', exact: true }).click();
  await page.locator('.editor-annotation-layer').click({ position: { x: 110, y: 270 } });
  await page
    .getByLabel('Annotation text', { exact: true })
    .fill('Recover this unsaved quota-limited note');
  await page.getByRole('button', { name: 'Save text', exact: true }).click();
  await expect(page.locator('.editor-save')).toContainText('Not saved');
  await page.goBack();
  await expect(page).toHaveURL(editorUrl);
  await expect(
    page.getByText('Recover this unsaved quota-limited note', { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Text', exact: true })).toBeEnabled();
  await page.evaluate(() => {
    (window as Window & { recoverEditorQuota: () => void }).recoverEditorQuota();
  });
  await page.getByRole('button', { name: 'Retry save', exact: true }).click();
  await expect(page.locator('.editor-save')).toContainText('Saved on this device');
  await page.goBack();
  await expect(page.getByRole('navigation', { name: 'Main navigation' })).toBeVisible();
  await page.getByText('Cell structure & function', { exact: true }).first().click();
  await expect(
    page.getByText('Recover this unsaved quota-limited note', { exact: true }),
  ).toBeVisible();
});

test('abandoned cross-tab lock preparation expires and restores editing without clearing saved work', async ({
  page,
}) => {
  await openSample(page);
  await textNote(page, 'Preserved through abandoned lock');
  await page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('margin-vault-v1');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const configuration = await new Promise<{ vaultId: string }>((resolve, reject) => {
      const request = database.transaction('public').objectStore('public').get('vault');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    database.close();
    const channel = new BroadcastChannel('margin-vault-lock-v1');
    channel.postMessage({
      type: 'prepare-lock',
      sender: crypto.randomUUID(),
      requestId: crypto.randomUUID(),
      vaultId: configuration.vaultId,
    });
    // Simulate a tab disappearing before it can commit or abort its lock request.
    channel.close();
  });
  await expect(page.locator('.vault-locking-overlay')).toBeVisible();
  await expect(page.locator('[inert] .document-editor')).toBeVisible();
  await expect(
    page.getByText('The lock request from another tab expired.', { exact: false }),
  ).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('.vault-locking-overlay')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Text', exact: true })).toBeEnabled();
  await expect(page.getByText('Preserved through abandoned lock', { exact: true })).toBeVisible();
  await textNote(page, 'Editing works after lock timeout');
  await page.reload();
  await unlockWorkspace(page);
  await expect(page.getByText('Preserved through abandoned lock', { exact: true })).toBeVisible();
  await expect(page.getByText('Editing works after lock timeout', { exact: true })).toBeVisible();
});
