import { test, expect, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { PDFDocument, PDFDict, PDFName, StandardFonts } from 'pdf-lib';
import { TEST_PASSPHRASE, unlockWorkspace } from './vault-helpers';

// Each test receives Playwright's isolated browser context and synthetic vault.
// Fixtures stay in memory; the runner tears down the context (including IndexedDB).
async function formFixture(xfa = false) {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([612, 792]);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const form = pdf.getForm();
  const title = form.createTextField('Title');
  title.enableRequired();
  title.setMaxLength(48);
  title.setText('Original worksheet');
  title.addToPage(page, { x: 42, y: 700, width: 390, height: 27, font });
  const observation = form.createTextField('Observation');
  observation.enableMultiline();
  observation.setMaxLength(240);
  observation.setText('Original observation.\nOriginal second row.');
  observation.addToPage(page, { x: 42, y: 600, width: 390, height: 72, font });
  const check = form.createCheckBox('Reviewed');
  check.addToPage(page, { x: 42, y: 555, width: 18, height: 18 });
  const radio = form.createRadioGroup('Example');
  radio.addOptionToPage('Plant', page, { x: 42, y: 510, width: 18, height: 18 });
  radio.addOptionToPage('Animal', page, { x: 150, y: 510, width: 18, height: 18 });
  radio.select('Plant');
  const dropdown = form.createDropdown('Topic');
  dropdown.setOptions(['Cells', 'Energy']);
  dropdown.select('Cells');
  dropdown.addToPage(page, { x: 42, y: 455, width: 240, height: 28, font });
  const list = form.createOptionList('Materials');
  list.setOptions(['Paper', 'Pencil', 'Ruler', 'Notebook']);
  list.enableMultiselect();
  list.select(['Paper', 'Pencil']);
  list.addToPage(page, { x: 42, y: 340, width: 240, height: 90, font });
  const optional = form.createTextField('Optional answer');
  optional.addToPage(page, { x: 42, y: 280, width: 390, height: 27, font });
  const id = form.createTextField('Fixture ID');
  id.setText('SYNTHETIC-FORM-E2E');
  id.enableReadOnly();
  id.addToPage(page, { x: 42, y: 225, width: 300, height: 27, font });
  form.updateFieldAppearances(font);
  if (xfa) {
    const packet = pdf.context.flateStream('<xdp><template name="SyntheticUnsupported" /></xdp>');
    pdf.catalog
      .lookup(PDFName.of('AcroForm'), PDFDict)
      .set(PDFName.of('XFA'), pdf.context.register(packet));
  }
  return Buffer.from(await pdf.save({ updateFieldAppearances: false }));
}
async function importAndOpen(page: Page, name: string, buffer: Buffer) {
  await page.getByRole('button', { name: 'Upload document', exact: true }).click();
  await page.getByLabel('Choose documents to upload').setInputFiles({
    name: `${name}.pdf`,
    mimeType: 'application/pdf',
    buffer,
  });
  await expect(
    page.getByRole('button', { name: `Actions for ${name}`, exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: `${name} PDF document`, exact: true }).click();
  await expect(page.getByRole('button', { name: 'Fill form', exact: true })).toBeEnabled();
}
async function openForm(page: Page) {
  await page.getByRole('button', { name: 'Fill form', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Fill PDF form', exact: true });
  await expect(dialog).toBeVisible();
  return dialog;
}
async function verifyFields(page: Page, filled: boolean) {
  const dialog = await openForm(page);
  await expect(dialog.getByLabel('Title (required)', { exact: true })).toHaveValue(
    filled ? 'Filled worksheet' : 'Original worksheet',
  );
  await expect(dialog.getByLabel('Observation', { exact: true })).toHaveValue(
    filled
      ? 'Synthetic manual form check.\nSecond line retained.'
      : 'Original observation.\nOriginal second row.',
  );
  await expect(dialog.getByLabel('Reviewed', { exact: true })).toBeChecked({ checked: filled });
  await expect(dialog.getByLabel('Example', { exact: true })).toHaveValue(
    filled ? 'Animal' : 'Plant',
  );
  await expect(dialog.getByLabel('Topic', { exact: true })).toHaveValue(
    filled ? 'Energy' : 'Cells',
  );
  await expect(dialog.getByLabel('Materials', { exact: true })).toHaveValues(
    filled ? ['Ruler', 'Notebook'] : ['Paper', 'Pencil'],
  );
  await expect(dialog.getByLabel('Optional answer', { exact: true })).toHaveValue(
    filled ? 'Optional saved answer' : '',
  );
  await expect(dialog.getByLabel('Fixture ID · read-only', { exact: true })).toBeDisabled();
  await expect(dialog.getByLabel('Fixture ID · read-only', { exact: true })).toHaveValue(
    'SYNTHETIC-FORM-E2E',
  );
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(dialog).toBeHidden();
}
async function exportedForm(page: Page) {
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export encrypted file', exact: true }).click();
  const download = await pending;
  try {
    expect(download.suggestedFilename()).toMatch(/\.margin$/);
    const filepath = await download.path();
    if (!filepath) throw new Error('Missing encrypted form export');
    const encrypted = await readFile(filepath);
    expect(encrypted.subarray(0, 4).toString()).not.toBe('%PDF');
    const bytes = await page.evaluate(
      async ({ data, passphrase }) => {
        const modulePath = '/src/lib/vault.ts';
        const vault = await import(modulePath);
        const decrypted = await vault.decryptExport(new Blob([new Uint8Array(data)]), passphrase);
        return Array.from(new Uint8Array(await decrypted.blob.arrayBuffer()));
      },
      { data: Array.from(encrypted), passphrase: TEST_PASSPHRASE },
    );
    return PDFDocument.load(new Uint8Array(bytes));
  } finally {
    // Remove only this test's temporary download; never alter the developer's local vault.
    await download.delete();
  }
}

test('PDF form drafts validate, save as one undo step, survive reload, and export real field values', async ({
  page,
}) => {
  test.setTimeout(90_000);
  await page.goto('/#documents');
  await unlockWorkspace(page);
  await importAndOpen(page, 'Synthetic form regression', await formFixture());
  await verifyFields(page, false);
  const dialog = await openForm(page);
  const title = dialog.getByLabel('Title (required)', { exact: true });
  const save = dialog.getByRole('button', { name: 'Save form changes', exact: true });
  await title.fill('');
  await save.click();
  await expect(dialog.getByRole('alert')).toContainText('required');
  await expect(title).toHaveValue('');
  await title.fill('Filled worksheet');
  await dialog
    .getByLabel('Observation', { exact: true })
    .fill('Synthetic manual form check.\nSecond line retained.');
  await dialog.getByLabel('Reviewed', { exact: true }).check();
  await dialog.getByLabel('Example', { exact: true }).selectOption('Animal');
  await dialog.getByLabel('Topic', { exact: true }).selectOption('Energy');
  await dialog.getByLabel('Materials', { exact: true }).selectOption(['Ruler', 'Notebook']);
  const optional = dialog.getByLabel('Optional answer', { exact: true });
  await optional.fill('東京');
  await save.click();
  await expect(dialog.getByRole('alert')).toContainText('cannot represent some characters');
  await expect(optional).toHaveValue('東京');
  await expect(title).toHaveValue('Filled worksheet');
  await optional.fill('Optional saved answer');
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(dialog.getByRole('button', { name: 'Discard changes', exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: 'Keep editing', exact: true }).click();
  await expect(optional).toHaveValue('Optional saved answer');
  await save.click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText('Saved on this device', { exact: true })).toBeVisible();
  await verifyFields(page, true);

  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await verifyFields(page, false);
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  await verifyFields(page, true);
  await page.reload();
  await unlockWorkspace(page);
  await verifyFields(page, true);

  const exported = await exportedForm(page);
  expect(exported.getPageCount()).toBe(1);
  const form = exported.getForm();
  expect(form.getFields()).toHaveLength(8);
  expect(form.getTextField('Title').getText()).toBe('Filled worksheet');
  expect(form.getTextField('Title').isRequired()).toBe(true);
  expect(form.getTextField('Observation').getText()).toBe(
    'Synthetic manual form check.\nSecond line retained.',
  );
  expect(form.getCheckBox('Reviewed').isChecked()).toBe(true);
  expect(form.getRadioGroup('Example').getSelected()).toBe('Animal');
  expect(form.getDropdown('Topic').getSelected()).toEqual(['Energy']);
  expect(form.getOptionList('Materials').getSelected()).toEqual(['Ruler', 'Notebook']);
  expect(form.getTextField('Optional answer').getText()).toBe('Optional saved answer');
  expect(form.getTextField('Fixture ID').isReadOnly()).toBe(true);
  expect(form.getTextField('Fixture ID').getText()).toBe('SYNTHETIC-FORM-E2E');

  await page.getByRole('button', { name: 'Page options', exact: true }).click();
  await page.getByRole('button', { name: 'Duplicate page', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('form fields is not supported');
  await expect(page.locator('.editor-count')).toHaveText('1');
  await page.getByRole('button', { name: 'Back to workspace', exact: true }).click();
  await importAndOpen(page, 'Synthetic unsupported XFA', await formFixture(true));
  await page.getByRole('button', { name: 'Fill form', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('XFA');
  await expect(page.getByRole('dialog', { name: 'Fill PDF form', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Fill form', exact: true })).toBeEnabled();
});
