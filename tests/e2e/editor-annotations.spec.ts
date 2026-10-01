import { test, expect, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { PDFDocument, PDFArray, PDFRawStream, decodePDFRawStream } from 'pdf-lib';
import { TEST_PASSPHRASE, unlockWorkspace } from './vault-helpers';
async function openSample(page: Page) {
  await page.goto('/');
  await unlockWorkspace(page);
  await page.getByText('Cell structure & function', { exact: true }).first().click();
  await expect(page.getByRole('button', { name: 'Add signature', exact: true })).toBeEnabled();
}
async function saved(page: Page) {
  await expect(page.getByText('Saved on this device', { exact: true })).toBeVisible();
}
async function decodedExport(page: Page) {
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export encrypted file', exact: true }).click();
  const download = await pending;
  expect(download.suggestedFilename()).toMatch(/\.margin$/);
  const filepath = await download.path();
  if (!filepath) throw new Error('Missing encrypted export');
  const encrypted = await readFile(filepath);
  expect(encrypted.subarray(0, 4).toString()).not.toBe('%PDF');
  const clear = await page.evaluate(
    async ({ bytes, passphrase }) => {
      const modulePath = '/src/lib/vault.ts';
      const vault = await import(modulePath);
      const result = await vault.decryptExport(new Blob([new Uint8Array(bytes)]), passphrase);
      return Array.from(new Uint8Array(await result.blob.arrayBuffer()));
    },
    { bytes: Array.from(encrypted), passphrase: TEST_PASSPHRASE },
  );
  return PDFDocument.load(new Uint8Array(clear));
}
function stream(pdf: PDFDocument) {
  const contents = pdf.getPage(0).node.Contents();
  if (!(contents instanceof PDFArray)) throw new Error('Missing PDF content');
  return Array.from({ length: contents.size() }, (_, index) =>
    Buffer.from(
      decodePDFRawStream(pdf.context.lookup(contents.get(index), PDFRawStream)).decode(),
    ).toString(),
  ).join('\n');
}

test('keyboard-created signature and dashed arrow save, undo, reload and export as real PDF content', async ({
  page,
}) => {
  await openSample(page);
  await page.getByRole('button', { name: 'Add signature', exact: true }).focus();
  await page.keyboard.press('Enter');
  await page.getByLabel('Signature name', { exact: true }).fill('Alex Rivera');
  await page.getByRole('button', { name: 'Insert signature', exact: true }).click();
  const signature = page.locator('[data-annotation-type="signature"]');
  await expect(signature).toContainText('Alex Rivera');
  const before = await signature.locator('text').getAttribute('x');
  await page.keyboard.press('Shift+ArrowRight');
  await expect(signature.locator('text')).not.toHaveAttribute('x', before!);
  await page.getByRole('button', { name: 'Shapes', exact: true }).click();
  await page.getByRole('button', { name: 'Arrow', exact: true }).click();
  await page.getByLabel('Line style', { exact: true }).selectOption('dashed');
  await page.getByRole('button', { name: 'Insert arrow at center', exact: true }).click();
  await expect(page.locator('[data-annotation-type="arrow"] path')).toHaveCount(2);
  await expect(page.locator('[data-annotation-type="arrow"] path').first()).toHaveAttribute(
    'stroke-dasharray',
    /\d/,
  );
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(page.locator('[data-annotation-type="arrow"]')).toHaveCount(0);
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  await expect(page.locator('[data-annotation-type="arrow"]')).toHaveCount(1);
  await page.getByRole('button', { name: 'Shapes', exact: true }).click();
  await page.getByRole('button', { name: 'Reviewed stamp', exact: true }).click();
  await expect(page.locator('[data-annotation-type="stamp"]')).toContainText('REVIEWED');
  await saved(page);
  await page.reload();
  await unlockWorkspace(page);
  await expect(page.locator('[data-annotation-type="signature"]')).toContainText('Alex Rivera');
  await expect(page.locator('[data-annotation-type="arrow"] path')).toHaveCount(2);
  await expect(page.locator('[data-annotation-type="stamp"]')).toContainText('REVIEWED');
  const exported = await decodedExport(page),
    content = stream(exported);
  expect(content).toContain(Buffer.from('Alex Rivera').toString('hex').toUpperCase());
  expect(content).toContain('<5245564945574544>');
  expect(content).toContain('[7.5 5] 0 d');
  expect(exported.getPage(0).node.Resources()?.toString()).toContain('Times-Italic');
});

test('drawn signature retains pen lifts and a pending signature blocks browser Back', async ({
  page,
}) => {
  await openSample(page);
  const editorUrl = page.url();
  await page.getByRole('button', { name: 'Add signature', exact: true }).click();
  await page.getByLabel('Signature name', { exact: true }).fill('Pending signature');
  await page.goBack();
  await expect(page).toHaveURL(editorUrl);
  await expect(page.getByLabel('Signature name', { exact: true })).toHaveValue('Pending signature');
  await page.getByRole('button', { name: 'Draw a signature', exact: true }).click();
  const pad = page.locator('.signature-pad');
  const box = await pad.boundingBox();
  if (!box) throw new Error('Missing signature pad');
  for (const [y, offset] of [
    [30, 0],
    [75, 20],
  ]) {
    await page.mouse.move(box.x + 30 + offset, box.y + y);
    await page.mouse.down();
    await page.mouse.move(box.x + 110 + offset, box.y + y + 25, { steps: 6 });
    await page.mouse.up();
  }
  await expect(pad.locator('path')).toHaveCount(2);
  await page.getByRole('button', { name: 'Insert signature', exact: true }).click();
  await expect(page.locator('[data-annotation-type="signature"] path')).toHaveCount(2);
  await saved(page);
  await page.reload();
  await unlockWorkspace(page);
  await expect(page.locator('[data-annotation-type="signature"] path')).toHaveCount(2);
  const exported = await decodedExport(page);
  expect((stream(exported).match(/\nm\n| m\n/g) || []).length).toBeGreaterThanOrEqual(2);
});
