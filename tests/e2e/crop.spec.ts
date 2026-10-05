import { test, expect, type Page, type Locator } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { readFile } from 'node:fs/promises';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { TEST_PASSPHRASE, unlockWorkspace } from './vault-helpers';

const margins = { Top: '36', Right: '20', Bottom: '48', Left: '24' };
const originalSize = '0 0 612 792';
const croppedSize = '0 0 568 708';

async function fixture(withForm = false) {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const first = pdf.addPage([612, 792]);
  first.drawText('Synthetic crop page one', { x: 72, y: 720, size: 18, font });
  pdf.addPage([500, 700]).drawText('Unchanged second page', { x: 72, y: 620, size: 18, font });
  if (withForm) {
    const form = pdf.getForm();
    const answer = form.createTextField('Answer');
    answer.setText('Original crop answer');
    answer.addToPage(first, { x: 80, y: 460, width: 300, height: 30, font });
    form.createCheckBox('Approved').addToPage(first, {
      x: 80,
      y: 410,
      width: 18,
      height: 18,
    });
    form.updateFieldAppearances(font);
  }
  const bytes = Buffer.from(await pdf.save({ updateFieldAppearances: false }));
  return bytes;
}

async function openFixture(page: Page, name: string, buffer?: Buffer) {
  await page.goto('/#documents');
  await unlockWorkspace(page);
  await page.getByLabel('Choose documents to upload', { exact: true }).setInputFiles({
    name: `${name}.pdf`,
    mimeType: 'application/pdf',
    buffer: buffer ?? (await fixture()),
  });
  await page.getByRole('button', { name: `${name} PDF document`, exact: true }).click();
  await expect(page.locator('.editor-annotation-layer')).toHaveAttribute('viewBox', originalSize);
  await expect(page.getByRole('button', { name: 'Page options', exact: true })).toBeEnabled();
}

async function openCrop(page: Page, number = 1) {
  await page.getByRole('button', { name: 'Page options', exact: true }).click();
  await page.getByRole('button', { name: 'Crop page', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: `Crop page ${number}`, exact: true });
  await expect(dialog).toBeVisible();
  return dialog;
}

async function setMargins(dialog: Locator) {
  for (const [name, value] of Object.entries(margins))
    await dialog.getByRole('spinbutton', { name, exact: true }).fill(value);
  await expect(dialog.getByRole('status')).toContainText('568.0 × 708.0 pt');
}

async function applyCrop(page: Page, dialog: Locator) {
  await dialog.getByRole('button', { name: 'Apply crop', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.locator('.editor-annotation-layer')).toHaveAttribute('viewBox', croppedSize);
  await expect(page.getByText('Saved on this device', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Page options', exact: true })).toBeFocused();
}

function note(page: Page, text: string) {
  return page
    .locator('.editor-annotation-layer [data-annotation-type="text"]')
    .filter({ hasText: text })
    .locator('text');
}

async function addNote(page: Page, text: string) {
  await page.getByRole('button', { name: 'Text', exact: true }).click();
  await page.locator('.editor-annotation-layer').click({ position: { x: 150, y: 240 } });
  await page.getByLabel('Annotation text', { exact: true }).fill(text);
  await page.getByRole('button', { name: 'Save text', exact: true }).click();
  await expect(page.getByText('Saved on this device', { exact: true })).toBeVisible();
  const graphic = note(page, text);
  await expect(graphic).toContainText(text);
  return {
    x: Number(await graphic.getAttribute('x')),
    y: Number(await graphic.getAttribute('y')),
  };
}

async function expectPosition(graphic: Locator, position: { x: number; y: number }) {
  await expect
    .poll(async () =>
      Math.max(
        Math.abs(Number(await graphic.getAttribute('x')) - position.x),
        Math.abs(Number(await graphic.getAttribute('y')) - position.y),
      ),
    )
    .toBeLessThan(0.0001);
}

test('crop changes one page and translates annotations through undo, redo, restore and encrypted reload', async ({
  page,
}) => {
  test.setTimeout(90_000);
  const failures: string[] = [];
  page.on('pageerror', (error) => failures.push(error.message));
  await openFixture(page, 'Synthetic crop history');
  const firstPosition = await addNote(page, 'First page crop note');
  await page.getByRole('button', { name: 'Next page', exact: true }).click();
  await expect(page.locator('.editor-annotation-layer')).toHaveAttribute('viewBox', '0 0 500 700');
  const secondPosition = await addNote(page, 'Second page untouched note');
  await page.getByRole('button', { name: 'Previous page', exact: true }).click();
  const dialog = await openCrop(page);
  await expect(dialog.getByRole('status')).toContainText('612.0 × 792.0 pt');
  await expect(dialog.locator('.crop-preview [data-annotation-type="text"]')).toContainText(
    'First page crop note',
  );
  await setMargins(dialog);
  await expect(dialog.locator('.crop-boundary')).toHaveAttribute('x', '24');
  await expect(dialog.locator('.crop-boundary')).toHaveAttribute('y', '36');
  await applyCrop(page, dialog);
  const croppedPosition = { x: firstPosition.x - 24, y: firstPosition.y - 36 };
  await expectPosition(note(page, 'First page crop note'), croppedPosition);
  await expect(page.locator('.editor-count')).toHaveText('2');

  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(page.locator('.editor-annotation-layer')).toHaveAttribute('viewBox', originalSize);
  await expectPosition(note(page, 'First page crop note'), firstPosition);
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  await expect(page.locator('.editor-annotation-layer')).toHaveAttribute('viewBox', croppedSize);
  await expectPosition(note(page, 'First page crop note'), croppedPosition);
  await page.getByRole('button', { name: 'Next page', exact: true }).click();
  await expect(page.locator('.editor-annotation-layer')).toHaveAttribute('viewBox', '0 0 500 700');
  await expectPosition(note(page, 'Second page untouched note'), secondPosition);
  await page.getByRole('button', { name: 'Previous page', exact: true }).click();

  const restore = await openCrop(page);
  await restore.getByRole('radio', { name: 'Restore full page', exact: true }).check();
  await expect(restore.getByRole('status')).toContainText('612.0 × 792.0 pt');
  await restore.getByRole('button', { name: 'Restore full page', exact: true }).click();
  await expect(restore).toHaveCount(0);
  await expect(page.locator('.editor-annotation-layer')).toHaveAttribute('viewBox', originalSize);
  await expect(page.getByRole('button', { name: 'Page options', exact: true })).toBeFocused();
  await expectPosition(note(page, 'First page crop note'), firstPosition);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(page.locator('.editor-annotation-layer')).toHaveAttribute('viewBox', croppedSize);
  await expect(page.getByText('Saved on this device', { exact: true })).toBeVisible();
  await page.reload();
  await unlockWorkspace(page);
  await expect(page.locator('.editor-annotation-layer')).toHaveAttribute('viewBox', croppedSize);
  await expectPosition(note(page, 'First page crop note'), croppedPosition);
  await page.getByRole('button', { name: 'Next page', exact: true }).click();
  await expect(page.locator('.editor-annotation-layer')).toHaveAttribute('viewBox', '0 0 500 700');
  await expectPosition(note(page, 'Second page untouched note'), secondPosition);
  expect(failures).toEqual([]);
});

test('crop validates margins, confirms dirty discard, and exposes accessible controls at desktop and narrow widths', async ({
  page,
}) => {
  test.setTimeout(90_000);
  await openFixture(page, 'Synthetic crop validation');
  const dialog = await openCrop(page);
  await expect(dialog.getByRole('button', { name: 'Apply crop', exact: true })).toBeDisabled();
  await expect(dialog).toContainText('Cropping hides content; it does not remove it');
  const accessibility = () =>
    new AxeBuilder({ page })
      .include('.crop-dialog')
      .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
      .analyze();
  expect((await accessibility()).violations).toEqual([]);
  const left = dialog.getByRole('spinbutton', { name: 'Left', exact: true });
  for (const value of ['-1', '612', '']) {
    await left.fill(value);
    await expect(dialog.getByRole('alert')).toContainText('leave at least 1 point');
    await expect(dialog.getByRole('button', { name: 'Apply crop', exact: true })).toBeDisabled();
  }
  await left.fill('24');
  await left.press('Escape');
  await expect(dialog.getByRole('alert')).toContainText('Discard these crop settings?');
  await dialog.getByRole('button', { name: 'Keep editing', exact: true }).click();
  await expect(left).toHaveValue('24');
  await expect(dialog.getByRole('radio', { name: 'Adjust edges', exact: true })).toBeFocused();

  // Chromium viewport emulation exercises layout; this is not a physical-phone claim.
  await page.setViewportSize({ width: 375, height: 812 });
  await expect
    .poll(() =>
      dialog.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        return (
          rect.left >= 0 &&
          rect.right <= innerWidth &&
          rect.top >= 0 &&
          rect.bottom <= innerHeight &&
          element.scrollWidth <= element.clientWidth + 1
        );
      }),
    )
    .toBe(true);
  for (const control of [
    ...Object.keys(margins).map((name) => dialog.getByRole('spinbutton', { name, exact: true })),
    dialog.getByRole('radio', { name: 'Restore full page', exact: true }),
    dialog.getByRole('button', { name: 'Apply crop', exact: true }),
    dialog.getByRole('button', { name: 'Cancel', exact: true }),
  ]) {
    await control.evaluate((element) =>
      element.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' }),
    );
    // Chromium can round an edge-aligned input's intersection to 0.9984. Check
    // the actual scroll-port bounds within one CSS pixel, then prove clickability.
    await expect
      .poll(() =>
        control.evaluate((element) => {
          const host = element.closest('dialog')!;
          const clip = host.getBoundingClientRect();
          const rect = element.getBoundingClientRect();
          const left = clip.left + host.clientLeft;
          const top = clip.top + host.clientTop;
          return (
            rect.width > 0 &&
            rect.height > 0 &&
            rect.left >= Math.max(0, left) - 1 &&
            rect.right <= Math.min(innerWidth, left + host.clientWidth) + 1 &&
            rect.top >= Math.max(0, top) - 1 &&
            rect.bottom <= Math.min(innerHeight, top + host.clientHeight) + 1
          );
        }),
      )
      .toBe(true);
    await control.click({ trial: true });
  }
  expect((await accessibility()).violations).toEqual([]);
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await dialog.getByRole('button', { name: 'Discard changes', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.locator('.editor-annotation-layer')).toHaveAttribute('viewBox', originalSize);
  await expect(page.getByRole('button', { name: 'Page options', exact: true })).toBeFocused();
  const unchanged = await openCrop(page);
  await expect(unchanged.getByRole('spinbutton', { name: 'Left', exact: true })).toHaveValue('0');
  await unchanged.getByRole('radio', { name: 'Restore full page', exact: true }).check();
  await expect(unchanged).toContainText('This page already shows its full area.');
  await expect(
    unchanged.getByRole('button', { name: 'Restore full page', exact: true }),
  ).toBeDisabled();
  await unchanged.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(unchanged).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Page options', exact: true })).toBeFocused();
});

test('cropped form widgets remain fillable and retain their rectangles through encrypted export and UI reimport', async ({
  page,
}) => {
  test.setTimeout(90_000);
  const source = await fixture(true);
  const original = await PDFDocument.load(source);
  const originalRects = original
    .getForm()
    .getFields()
    .map((field) => ({
      name: field.getName(),
      rectangles: field.acroField.getWidgets().map((widget) => widget.getRectangle()),
    }));
  await openFixture(page, 'Synthetic crop form', source);
  const dialog = await openCrop(page);
  await setMargins(dialog);
  await applyCrop(page, dialog);
  await page.getByRole('button', { name: 'Fill form', exact: true }).click();
  const form = page.getByRole('dialog', { name: 'Fill PDF form', exact: true });
  await expect(form.getByLabel('Answer', { exact: true })).toHaveValue('Original crop answer');
  await form.getByLabel('Answer', { exact: true }).fill('Saved crop answer');
  await form.getByLabel('Approved', { exact: true }).check();
  await form.getByRole('button', { name: 'Save form changes', exact: true }).click();
  await expect(form).toHaveCount(0);
  await expect(page.locator('.editor-annotation-layer')).toHaveAttribute('viewBox', croppedSize);

  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export encrypted file', exact: true }).click();
  const download = await pending;
  try {
    const path = await download.path();
    if (!path) throw new Error('The browser did not deliver the encrypted cropped PDF.');
    const encrypted = await readFile(path);
    expect(encrypted.subarray(0, 8).toString()).toBe('MARGIN1\n');
    expect(encrypted.includes(Buffer.from('Saved crop answer'))).toBe(false);
    // Inspect only this synthetic browser-delivered download; never open a developer vault.
    const clear = await page.evaluate(
      async ({ data, passphrase }) => {
        const modulePath = '/src/lib/vault.ts';
        const vault = await import(modulePath);
        const result = await vault.decryptExport(new Blob([new Uint8Array(data)]), passphrase);
        return Array.from(new Uint8Array(await result.blob.arrayBuffer()));
      },
      { data: Array.from(encrypted), passphrase: TEST_PASSPHRASE },
    );
    const exported = await PDFDocument.load(new Uint8Array(clear));
    expect(exported.getPageCount()).toBe(2);
    expect(exported.getPage(0).getCropBox()).toEqual({ x: 24, y: 48, width: 568, height: 708 });
    expect(exported.getPage(0).getMediaBox()).toEqual({ x: 0, y: 0, width: 612, height: 792 });
    expect(exported.getPage(1).getCropBox()).toEqual({ x: 0, y: 0, width: 500, height: 700 });
    expect(exported.getForm().getTextField('Answer').getText()).toBe('Saved crop answer');
    expect(exported.getForm().getCheckBox('Approved').isChecked()).toBe(true);
    expect(
      exported
        .getForm()
        .getFields()
        .map((field) => ({
          name: field.getName(),
          rectangles: field.acroField.getWidgets().map((widget) => widget.getRectangle()),
        })),
    ).toEqual(originalRects);

    await page.getByRole('button', { name: 'Back to workspace', exact: true }).click();
    await page
      .locator('.sidebar')
      .getByRole('button', { name: 'My documents', exact: true })
      .click();
    await page.getByLabel('Choose documents to upload', { exact: true }).setInputFiles({
      name: download.suggestedFilename(),
      mimeType: 'application/vnd.margin.encrypted',
      buffer: encrypted,
    });
    await page
      .getByRole('button', { name: 'Synthetic crop form — annotated PDF document', exact: true })
      .click();
    await expect(page.locator('.editor-annotation-layer')).toHaveAttribute('viewBox', croppedSize);
    await page.getByRole('button', { name: 'Fill form', exact: true }).click();
    await expect(form.getByLabel('Answer', { exact: true })).toHaveValue('Saved crop answer');
    await expect(form.getByLabel('Approved', { exact: true })).toBeChecked();
    await form.getByRole('button', { name: 'Cancel', exact: true }).click();
    const imported = await openCrop(page);
    await imported.getByRole('radio', { name: 'Restore full page', exact: true }).check();
    await expect(imported.getByRole('status')).toContainText('612.0 × 792.0 pt');
    await imported.getByRole('button', { name: 'Restore full page', exact: true }).click();
    await expect(imported).toHaveCount(0);
    await expect(page.locator('.editor-annotation-layer')).toHaveAttribute('viewBox', originalSize);
  } finally {
    await download.delete();
  }
});
