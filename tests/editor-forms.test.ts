import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import {
  PDFDocument,
  PDFName,
  PDFArray,
  PDFHexString,
  PDFString,
  PDFNumber,
  PDFDict,
  PDFRawStream,
  decodePDFRawStream,
} from 'pdf-lib';
import { applyPdfFormChanges, inspectPdfForm } from '../apps/web/src/editor/forms';
import {
  extractPdfPage,
  exportAnnotatedPdf,
  mergePdf,
  transformPage,
} from '../apps/web/src/editor/pdf';
import type { PdfFormChange } from '../apps/web/src/editor/formTypes';
const n = (key: string) => PDFName.of(key);
async function fixture() {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([612, 792]);
  pdf.addPage([612, 792]);
  const form = pdf.getForm();
  const text = form.createTextField('Student.Name');
  text.setMaxLength(80);
  text.setText('Original student');
  text.enableRequired();
  text.addToPage(page, { x: 30, y: 700, width: 200, height: 30 });
  const notes = form.createTextField('Notes');
  notes.enableMultiline();
  notes.setText('First line\nSecond line');
  notes.addToPage(page, { x: 30, y: 570, width: 300, height: 90 });
  const readonly = form.createTextField('Class');
  readonly.setText('BIO 101');
  readonly.enableReadOnly();
  readonly.addToPage(page, { x: 30, y: 515, width: 200, height: 30 });
  const check = form.createCheckBox('Consent');
  check.addToPage(page, { x: 30, y: 470, width: 18, height: 18 });
  const radio = form.createRadioGroup('Preference');
  radio.addOptionToPage('Morning', page, { x: 30, y: 425, width: 18, height: 18 });
  radio.addOptionToPage('Afternoon', page, { x: 100, y: 425, width: 18, height: 18 });
  radio.select('Morning');
  const dropdown = form.createDropdown('Color');
  dropdown.setOptions(['Blue', 'Green']);
  dropdown.select('Blue');
  dropdown.addToPage(page, { x: 30, y: 360, width: 140, height: 30 });
  const list = form.createOptionList('Interests');
  list.setOptions(['Reading', 'Science', 'Art']);
  list.enableMultiselect();
  list.select(['Reading']);
  list.addToPage(page, { x: 30, y: 230, width: 140, height: 100 });
  return pdf;
}
const blob = async (pdf: PDFDocument) =>
  new Blob([(await pdf.save({ updateFieldAppearances: false })) as BlobPart], {
    type: 'application/pdf',
  });
const parse = async (value: Blob) => PDFDocument.load(await value.arrayBuffer());
const values = async (value: Blob) =>
  Object.fromEntries(
    (await inspectPdfForm(value)).fields.map((field) => [field.name, field.value]),
  );
async function readyFixture() {
  const pdf = await fixture();
  pdf.getForm().updateFieldAppearances();
  return blob(pdf);
}
function appearance(pdf: PDFDocument, fieldName: string): number[] {
  const field = pdf.getForm().getField(fieldName),
    widget = field.acroField.getWidgets()[0];
  const ap = widget.getAppearances()!.normal;
  if (!(ap instanceof PDFRawStream)) throw new Error('Expected text appearance');
  return Array.from(decodePDFRawStream(ap).decode());
}
describe('bounded AcroForm inspection and filling', () => {
  it('describes text, required/read-only, checkbox, radio and choice values without changing the input', async () => {
    const original = await readyFixture(),
      bytes = await original.arrayBuffer();
    const result = await inspectPdfForm(original);
    expect(result.fields).toHaveLength(7);
    expect(result.fields.find((f) => f.name === 'Student.Name')).toMatchObject({
      kind: 'text',
      value: 'Original student',
      maxLength: 80,
      required: true,
    });
    expect(result.fields.find((f) => f.name === 'Class')).toMatchObject({ readOnly: true });
    expect(result.fields.find((f) => f.name === 'Interests')).toMatchObject({
      multiselect: true,
      value: ['Reading'],
    });
    expect(await original.arrayBuffer()).toEqual(bytes);
  });
  it('saves all supported field kinds and retains untouched appearances, flags, pages and input bytes', async () => {
    const original = await readyFixture(),
      before = await parse(original);
    const changes: PdfFormChange[] = [
      { name: 'Student.Name', value: 'Taylor Example' },
      { name: 'Notes', value: 'A new response\nWith two lines' },
      { name: 'Consent', value: true },
      { name: 'Preference', value: 'Afternoon' },
      { name: 'Color', value: 'Green' },
      { name: 'Interests', value: ['Science', 'Art'] },
    ];
    const result = await applyPdfFormChanges(original, changes),
      after = await parse(result);
    expect(await values(result)).toEqual({
      'Student.Name': 'Taylor Example',
      Notes: 'A new response\nWith two lines',
      Class: 'BIO 101',
      Consent: true,
      Preference: 'Afternoon',
      Color: 'Green',
      Interests: ['Science', 'Art'],
    });
    expect(after.getPageCount()).toBe(2);
    expect(appearance(after, 'Class')).toEqual(appearance(before, 'Class'));
    expect(after.getForm().getTextField('Student.Name').isRequired()).toBe(true);
    expect(after.getForm().getTextField('Class').isReadOnly()).toBe(true);
    expect((await values(original))['Student.Name']).toBe('Original student');
    expect(await applyPdfFormChanges(result, [{ name: 'Consent', value: true }])).toBe(result);
  });
  it('rejects unknown, duplicate, read-only and wrong-type changes and enforces required/max length/choice constraints', async () => {
    const original = await readyFixture();
    const bad: [PdfFormChange[], RegExp][] = [
      [[{ name: 'Missing', value: 'x' }], /does not exist/],
      [
        [
          { name: 'Color', value: 'Blue' },
          { name: 'Color', value: 'Green' },
        ],
        /duplicate/,
      ],
      [[{ name: 'Class', value: 'Overwrite' }], /read-only/],
      [[{ name: 'Student.Name', value: '' }], /required/],
      [[{ name: 'Student.Name', value: 'x'.repeat(81) }], /80 characters/],
      [[{ name: 'Student.Name', value: 'name\nsecond' }], /line breaks/],
      [[{ name: 'Consent', value: 'true' }], /checked or unchecked/],
      [[{ name: 'Preference', value: 'Evening' }], /listed option/],
      [[{ name: 'Color', value: ['Blue', 'Green'] }], /valid value/],
      [[{ name: 'Interests', value: ['Science', 'Science'] }], /listed options/],
    ];
    for (const [changes, error] of bad)
      await expect(applyPdfFormChanges(original, changes)).rejects.toThrow(error);
    expect((await values(original))['Student.Name']).toBe('Original student');
  });
  it('does not turn null or missing checkbox values into unchecked state', async () => {
    const original = await applyPdfFormChanges(await readyFixture(), [
      { name: 'Consent', value: true },
    ]);
    for (const value of [null, undefined]) {
      await expect(
        applyPdfFormChanges(original, [{ name: 'Consent', value } as unknown as PdfFormChange]),
      ).rejects.toThrow('checked or unchecked');
    }
    expect((await values(original)).Consent).toBe(true);
  });
  it('leaves Unicode draft input intact and preserves an unchanged existing Unicode field', async () => {
    const pdf = await fixture();
    pdf.getForm().updateFieldAppearances();
    pdf.getForm().getTextField('Notes').acroField.setValue(PDFHexString.fromText('東京'));
    const original = await blob(pdf);
    const changes = [{ name: 'Student.Name', value: '東京' }];
    await expect(applyPdfFormChanges(original, changes)).rejects.toThrow('draft remains open');
    expect(changes[0].value).toBe('東京');
    const result = await applyPdfFormChanges(original, [{ name: 'Consent', value: true }]);
    expect((await values(result)).Notes).toBe('東京');
    expect(appearance(await parse(result), 'Notes')).toEqual(
      appearance(await parse(original), 'Notes'),
    );
  });
  it('fits every explicit and wrapped multiline row inside the actual PDF widget', async () => {
    const pdf = await PDFDocument.create();
    const page = pdf.addPage([612, 792]);
    const field = pdf.getForm().createTextField('worksheet.observation');
    field.enableMultiline();
    field.setText('Original observation.');
    field.addToPage(page, { x: 42, y: 543, width: 390, height: 72 });
    field.setFontSize(32);
    field.updateAppearances(await pdf.embedFont((await import('pdf-lib')).StandardFonts.Helvetica));
    const original = await blob(pdf);
    const answer = 'Synthetic manual form check.\nSecond line retained.';
    const result = await applyPdfFormChanges(original, [
      { name: 'worksheet.observation', value: answer },
    ]);
    const parsed = await parse(result);
    const stream = Buffer.from(appearance(parsed, 'worksheet.observation')).toString();
    const size = Number([...stream.matchAll(/\/Helvetica\S* (\d+(?:\.\d+)?) Tf/g)].at(-1)?.[1]);
    expect(size).toBeGreaterThanOrEqual(6);
    expect(size).toBeLessThan(32);
    const baselines = [...stream.matchAll(/1 0 0 1 ([\d.-]+) ([\d.-]+) Tm/g)].map((match) =>
      Number(match[2]),
    );
    expect(baselines.length).toBeGreaterThanOrEqual(2);
    const widget = parsed.getForm().getTextField('worksheet.observation').acroField.getWidgets()[0];
    const inset = (widget.getBorderStyle()?.getWidth() ?? 0) + 1;
    expect(Math.min(...baselines) - size * 0.25).toBeGreaterThanOrEqual(inset - 0.01);
    expect((await values(result))['worksheet.observation']).toBe(answer);
    // A fitting existing size is kept; a huge response is refused instead of clipped.
    const shorter = await applyPdfFormChanges(original, [
      { name: 'worksheet.observation', value: 'Fits.' },
    ]);
    expect(
      Buffer.from(appearance(await parse(shorter), 'worksheet.observation')).toString(),
    ).toMatch(/32 Tf/);
    await expect(
      applyPdfFormChanges(original, [
        { name: 'worksheet.observation', value: 'verylongunbrokenword'.repeat(300) },
      ]),
    ).rejects.toThrow('does not fit');
  });
  it('honors inherited text length constraints and rejects malformed limits', async () => {
    const pdf = await fixture();
    const field = pdf.getForm().getTextField('Student.Name');
    field.acroField.dict.delete(n('MaxLen'));
    field.acroField.dict.lookup(n('Parent'), PDFDict).set(n('MaxLen'), PDFNumber.of(20));
    const original = await blob(pdf);
    expect(
      (await inspectPdfForm(original)).fields.find((f) => f.name === 'Student.Name')?.maxLength,
    ).toBe(20);
    await expect(
      applyPdfFormChanges(original, [{ name: 'Student.Name', value: 'x'.repeat(21) }]),
    ).rejects.toThrow('20 characters');
    const result = await applyPdfFormChanges(original, [
      { name: 'Student.Name', value: 'Inherited maximum' },
    ]);
    expect((await values(result))['Student.Name']).toBe('Inherited maximum');
    field.acroField.dict.set(n('MaxLen'), n('Invalid'));
    await expect(inspectPdfForm(await blob(pdf))).rejects.toThrow('malformed text length');
  });
  it.each(['Consent', 'Preference'])(
    'rejects inconsistent appearance versus stored value for %s',
    async (fieldName) => {
      const pdf = await fixture();
      pdf.getForm().updateFieldAppearances();
      const field = pdf.getForm().getField(fieldName);
      field.acroField
        .getWidgets()[0]
        .setAppearanceState(n(fieldName === 'Consent' ? 'Yes' : 'Off'));
      await expect(inspectPdfForm(await blob(pdf))).rejects.toThrow('disagrees with its value');
    },
  );
  it('clears optional values without changing radio or multiselect field flags', async () => {
    const pdf = await fixture();
    pdf.getForm().getRadioGroup('Preference').enableOffToggling();
    pdf.getForm().updateFieldAppearances();
    const original = await blob(pdf);
    const result = await applyPdfFormChanges(original, [
      { name: 'Color', value: '' },
      { name: 'Preference', value: '' },
      { name: 'Interests', value: [] },
    ]);
    expect(await values(result)).toMatchObject({ Color: '', Preference: '', Interests: [] });
    expect((await parse(result)).getForm().getDropdown('Color').isMultiselect()).toBe(false);
  });
  it('keeps widget references and values bound to their pages after rotation and blank insertion', async () => {
    const original = await readyFixture();
    const rotated = await transformPage(original, 'rotate', 0);
    const inserted = await transformPage(rotated, 'insert', 0);
    expect(await values(inserted)).toEqual(await values(original));
    const pdf = await parse(inserted);
    expect(pdf.getPageCount()).toBe(3);
    expect(pdf.getPage(0).getRotation().angle).toBe(90);
    const field = pdf.getForm().getField('Student.Name');
    expect(field.acroField.getWidgets()[0].dict.lookup(n('P'))).toBe(pdf.getPage(0).node);
    const result = await applyPdfFormChanges(inserted, [
      { name: 'Student.Name', value: 'After rotation' },
    ]);
    expect((await values(result))['Student.Name']).toBe('After rotation');
  });
  it('refuses form page copy/delete/reorder, merge and extraction without changing the input', async () => {
    const original = await readyFixture();
    for (const action of ['duplicate', 'delete', 'earlier', 'later'] as const)
      await expect(transformPage(original, action, 0)).rejects.toThrow('form fields');
    await expect(mergePdf(original, original)).rejects.toThrow('form fields');
    await expect(extractPdfPage(original, 0)).rejects.toThrow('form fields');
    expect((await inspectPdfForm(original)).fields).toHaveLength(7);
  });
  it('preserves fillable values and appearances in annotated export', async () => {
    const original = await applyPdfFormChanges(await readyFixture(), [
      { name: 'Student.Name', value: 'Export sample' },
    ]);
    const output = await exportAnnotatedPdf(original, [], []);
    expect(await values(output)).toEqual(await values(original));
    expect(appearance(await parse(output), 'Student.Name')).toEqual(
      appearance(await parse(original), 'Student.Name'),
    );
  });
});
describe('forms fail closed before destructive library normalization', () => {
  it.each(['XFA', 'Sig', 'DocMDP', 'JavaScript', 'AA', 'OpenAction'])(
    'refuses %s',
    async (kind) => {
      const pdf = await fixture();
      if (kind === 'XFA')
        pdf.catalog
          .lookup(n('AcroForm'), (await import('pdf-lib')).PDFDict)
          .set(n('XFA'), PDFString.of('unsupported'));
      else if (kind === 'Sig')
        pdf.getForm().getTextField('Student.Name').acroField.dict.set(n('FT'), n('Sig'));
      else pdf.catalog.set(n(kind), pdf.context.obj({ S: kind === 'AA' ? 'JavaScript' : kind }));
      const original = await blob(pdf);
      await expect(inspectPdfForm(original)).rejects.toThrow(/cannot be edited/);
      await expect(applyPdfFormChanges(original, [])).rejects.toThrow(/cannot be edited/);
      await expect(transformPage(original, 'rotate', 0)).rejects.toThrow(/cannot be edited/);
    },
  );
  it('rejects lowercase name escapes inside compressed object dictionaries', async () => {
    const pdf = await fixture();
    pdf.catalog.set(n('#4aavaScript'), pdf.context.obj({ S: '#4aavaScript' }));
    await expect(inspectPdfForm(await blob(pdf))).rejects.toThrow('escaped name');
  });
  it.each([
    'unknown-type',
    'cycle',
    'duplicate-name',
    'bad-value',
    'bad-option',
    'display-export',
    'editable-dropdown',
    'direct-field',
    'too-many',
  ])('rejects %s instead of ignoring fields', async (kind) => {
    const pdf = await fixture();
    const form = pdf.getForm();
    const field = form.getTextField('Notes').acroField;
    if (kind === 'unknown-type') field.dict.set(n('FT'), n('Unknown'));
    if (kind === 'cycle') field.dict.set(n('Parent'), field.ref);
    if (kind === 'duplicate-name') field.setPartialName('Class');
    if (kind === 'bad-value') field.dict.set(n('V'), n('NotText'));
    if (kind === 'bad-option')
      form.getDropdown('Color').acroField.dict.set(n('Opt'), pdf.context.obj([42]));
    if (kind === 'display-export')
      form
        .getDropdown('Color')
        .acroField.setOptions([{ value: PDFString.of('b'), display: PDFString.of('Blue') }]);
    if (kind === 'editable-dropdown') form.getDropdown('Color').enableEditing();
    if (kind === 'direct-field') {
      const fields = form.acroForm.dict.lookup(n('Fields'), PDFArray);
      fields.push(field.dict);
    }
    if (kind === 'too-many')
      for (let i = 0; i < 101; i++)
        form
          .createTextField(`extra${i}`)
          .addToPage(pdf.getPage(0), { x: 1, y: 1, width: 1, height: 1 });
    await expect(inspectPdfForm(await blob(pdf))).rejects.toThrow(/original PDF is unchanged/);
  });
});

describe('filled form document lifecycle', () => {
  it('persists an encrypted form revision with annotations, reopens after vault lock, restores one prior snapshot and exports encrypted bytes', async () => {
    const { openDB } = await import('idb');
    const vault = await import('../apps/web/src/lib/vault');
    const storage = await import('../apps/web/src/lib/storage');
    await vault.vaultStatus();
    const db = await openDB(vault.VAULT_DATABASE, 1);
    await db.clear('public');
    await db.clear('records');
    db.close();
    const passphrase = 'synthetic-form-test-only-passphrase';
    await vault.createVault(passphrase);
    try {
      const original = await readyFixture();
      const id = crypto.randomUUID();
      const record = {
        id,
        name: 'Synthetic form',
        mimeType: 'application/pdf',
        size: original.size,
        pageCount: 2,
        createdAt: 1,
        updatedAt: 1,
        folderId: null,
        starred: false,
        trashed: false,
        cover: 'blank' as const,
        source: 'created' as const,
      };
      await storage.saveDocumentWithBlob(record, original);
      const annotation = {
        id: crypto.randomUUID(),
        pageIndex: 0,
        type: 'text' as const,
        text: 'Form review note',
        x: 350,
        y: 100,
        color: '#292925',
        strokeWidth: 2,
        opacity: 1,
        createdAt: 1,
        author: 'Test',
      };
      const filled = await applyPdfFormChanges(original, [
        { name: 'Student.Name', value: 'Private form response' },
      ]);
      await storage.replaceDocumentWithAnnotations(id, filled, 2, [annotation]);
      await vault.lockVault();
      await vault.unlockVault(passphrase);
      const restored = (await storage.getDocumentBlob(id))!;
      expect((await values(restored))['Student.Name']).toBe('Private form response');
      expect(await storage.loadAnnotations(id)).toEqual([annotation]);
      const disk = await openDB(vault.VAULT_DATABASE, 1);
      expect(JSON.stringify(await disk.getAll('records'))).not.toContain('Private form response');
      disk.close();
      const exported = await exportAnnotatedPdf(
        restored,
        [annotation],
        [{ pageIndex: 0, transform: [1, 0, 0, -1, 0, 792] }],
      );
      const encrypted = await vault.encryptExport(exported, {
        name: 'Synthetic filled form.pdf',
        mimeType: 'application/pdf',
      });
      expect(await encrypted.slice(0, 4).text()).not.toBe('%PDF');
      const decrypted = await vault.decryptExport(encrypted, passphrase);
      expect((await values(decrypted.blob))['Student.Name']).toBe('Private form response');
      // The editor's one history entry restores the immutable original PDF with the same annotation snapshot.
      await storage.replaceDocumentWithAnnotations(id, original, 2, [annotation]);
      expect((await values((await storage.getDocumentBlob(id))!))['Student.Name']).toBe(
        'Original student',
      );
      expect(await storage.loadAnnotations(id)).toEqual([annotation]);
    } finally {
      await vault.lockVault();
    }
  });
});
