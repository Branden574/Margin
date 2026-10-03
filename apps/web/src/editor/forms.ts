import {
  PDFArray,
  PDFCheckBox,
  PDFDict,
  PDFDocument,
  PDFDropdown,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFObject,
  PDFOptionList,
  PDFRadioGroup,
  PDFRef,
  PDFStream,
  PDFString,
  PDFTextField,
  StandardFonts,
  defaultTextFieldAppearanceProvider,
  layoutMultilineText,
  layoutSinglelineText,
  layoutCombedText,
  adjustDimsForRotation,
  type AppearanceProviderFor,
  type PDFField,
} from 'pdf-lib';
import type { PdfFormChange, PdfFormField, PdfFormInspection } from './formTypes';

const MAX_FIELDS = 100;
const MAX_TEXT = 16_000;
const name = (key: string) => PDFName.of(key);
function invalid(detail: string): never {
  throw new Error(`${detail} The original PDF is unchanged.`);
}
function string(value: PDFObject | undefined): string {
  if (!(value instanceof PDFString || value instanceof PDFHexString))
    return invalid('This PDF has a malformed form string.');
  const result = value.decodeText();
  if (result.length > MAX_TEXT || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(result))
    return invalid('This PDF has an unsupported form string.');
  return result;
}

/** No getForm() call is permitted before this audit: pdf-lib silently removes XFA. */
export function auditPdfForEditing(pdf: PDFDocument): { hasFields: boolean; terminals: PDFDict[] } {
  const seen = new Set<PDFObject>();
  const encounteredWidgets = new Set<PDFDict>();
  let visited = 0;
  const disallowed = new Set([
    'XFA',
    'JavaScript',
    'JS',
    'AA',
    'OpenAction',
    'DocMDP',
    'FieldMDP',
    'ByteRange',
  ]);
  const visit = (raw: PDFObject | undefined, depth = 0): void => {
    if (!raw) return;
    if (++visited > 250_000 || depth > 64)
      invalid('This PDF exceeds the supported document inspection limits.');
    const object = raw instanceof PDFRef ? pdf.context.lookup(raw) : raw;
    if (!object) invalid('This PDF contains an unresolved object reference.');
    if (seen.has(object)) return;
    seen.add(object);
    if (object instanceof PDFName) {
      // pdf-lib's name parser only decodes uppercase hex escapes. Reject the remaining
      // escapes rather than interpreting #4aavaScript differently from other readers.
      if (/#[a-f\d]{2}/i.test(object.decodeText()))
        invalid('This PDF uses an unsupported escaped name.');
      if (
        [
          'Sig',
          'DocMDP',
          'FieldMDP',
          'JavaScript',
          'Launch',
          'SubmitForm',
          'ImportData',
          'ResetForm',
        ].includes(object.decodeText())
      )
        invalid('Signed PDFs and PDFs with active actions cannot be edited here.');
    } else if (object instanceof PDFDict) {
      if (object.lookup(name('Subtype')) === name('Widget')) encounteredWidgets.add(object);
      if (object.keys().length > 10_000) invalid('This PDF has an oversized object dictionary.');
      for (const [key, value] of object.entries()) {
        visit(key, depth + 1);
        if (disallowed.has(key.decodeText()))
          invalid(
            'XFA, signed PDFs, and PDFs with scripts or automatic actions cannot be edited here.',
          );
        // /A is a general annotation action. Even benign links are held unchanged;
        // we do not rewrite documents containing actions until preservation is verified.
        if (key.decodeText() === 'A' && pdf.context.lookup(value) instanceof PDFDict)
          invalid('PDFs with interactive actions cannot be edited here.');
        visit(value, depth + 1);
      }
    } else if (object instanceof PDFArray) {
      if (object.size() > 10_000) invalid('This PDF has an oversized object array.');
      for (let i = 0; i < object.size(); i++) visit(object.get(i), depth + 1);
    } else if (object instanceof PDFStream) visit(object.dict, depth + 1);
  };
  // Include indirect objects, not only reachable catalog entries (including compressed
  // object streams after parsing). This is a conservative editing check, not malware scanning.
  const objects = pdf.context.enumerateIndirectObjects();
  if (objects.length > 100_000) invalid('This PDF exceeds the supported object count.');
  visit(pdf.catalog);
  for (const [, object] of objects) visit(object);
  const acro = pdf.catalog.lookup(name('AcroForm'));
  if (!acro) {
    if (encounteredWidgets.size) invalid('This PDF contains widgets without an AcroForm.');
    return { hasFields: false, terminals: [] };
  }
  if (!(acro instanceof PDFDict)) return invalid('This PDF has a malformed AcroForm.');
  const roots = acro.lookup(name('Fields'));
  if (!(roots instanceof PDFArray)) return invalid('This PDF has no valid form field tree.');
  const terminals: PDFDict[] = [];
  const fieldsSeen = new Set<PDFDict>();
  const formWidgets = new Set<PDFDict>();
  const walk = (
    item: PDFObject,
    inheritedType: PDFName | undefined,
    depth: number,
    parent?: PDFDict,
  ): void => {
    if (depth > 32 || fieldsSeen.size >= 1000) invalid('This PDF exceeds the form tree limit.');
    // PDF fields must be indirect. pdf-lib ignores direct entries in the field array.
    if (!(item instanceof PDFRef)) invalid('This PDF has an unsupported direct form field.');
    const dict = pdf.context.lookup(item);
    if (!(dict instanceof PDFDict) || fieldsSeen.has(dict))
      return invalid('This PDF has a malformed or cyclic form field tree.');
    fieldsSeen.add(dict);
    if (dict.lookup(name('Parent')) !== parent)
      invalid('This PDF has an inconsistent field parent.');
    if (!dict.has(name('T')) || !string(dict.lookup(name('T'))))
      invalid('This PDF has an unnamed form field.');
    const flags = dict.lookup(name('Ff'));
    if (
      flags &&
      (!(flags instanceof PDFNumber) ||
        !Number.isSafeInteger(flags.asNumber()) ||
        flags.asNumber() < 0 ||
        flags.asNumber() > 0x7fffffff)
    )
      invalid('This PDF has invalid field flags.');
    const ownType = dict.lookup(name('FT'));
    if (ownType && !(ownType instanceof PDFName)) invalid('This PDF has an invalid field type.');
    const type = ownType instanceof PDFName ? ownType : inheritedType;
    const kids = dict.lookup(name('Kids'));
    if (kids && !(kids instanceof PDFArray)) invalid('This PDF has invalid field children.');
    let childFields = false;
    if (kids instanceof PDFArray) {
      if (!kids.size() || kids.size() > 500)
        invalid('This PDF has unsupported empty or oversized field children.');
      const widgets = kids.asArray().map((kid) => pdf.context.lookup(kid));
      const isWidget = (obj: PDFObject | undefined) =>
        obj instanceof PDFDict &&
        obj.lookup(name('Subtype')) === name('Widget') &&
        !obj.has(name('T')) &&
        !obj.has(name('FT')) &&
        !obj.has(name('Kids'));
      childFields = !widgets.every(isWidget);
      if (childFields && widgets.some(isWidget))
        invalid('This PDF mixes widget and field children.');
      if (childFields) for (const kid of kids.asArray()) walk(kid, type, depth + 1, dict);
      else
        for (const widget of widgets) {
          if (!(widget instanceof PDFDict) || fieldsSeen.has(widget))
            invalid('This PDF reuses a form widget.');
          fieldsSeen.add(widget);
          formWidgets.add(widget);
          if (widget.lookup(name('Parent')) !== dict)
            invalid('This PDF has an inconsistent widget parent.');
        }
    }
    if (!childFields) {
      if (!type || !['Tx', 'Btn', 'Ch'].includes(type.decodeText()))
        invalid('This PDF contains an unsupported form field type.');
      if (!kids && dict.lookup(name('Subtype')) !== name('Widget'))
        invalid('This PDF has a field without a widget.');
      if (!kids) formWidgets.add(dict);
      terminals.push(dict);
      if (terminals.length > MAX_FIELDS)
        invalid(`Only forms with up to ${MAX_FIELDS} fields are supported.`);
    }
  };
  for (const root of roots.asArray()) walk(root, undefined, 0);
  const pageWidgets = new Set<PDFDict>();
  for (const page of pdf.getPages()) {
    const annots = page.node.lookup(name('Annots'));
    if (!annots) continue;
    if (!(annots instanceof PDFArray)) invalid('This PDF has malformed page annotations.');
    for (const raw of annots.asArray()) {
      const widget = pdf.context.lookup(raw);
      if (!(widget instanceof PDFDict) || widget.lookup(name('Subtype')) !== name('Widget'))
        continue;
      if (!formWidgets.has(widget) || pageWidgets.has(widget))
        invalid('This PDF has an unbound or reused page widget.');
      if (widget.has(name('P')) && widget.lookup(name('P')) !== page.node)
        invalid('This PDF has an inconsistent widget page.');
      pageWidgets.add(widget);
    }
  }
  if (encounteredWidgets.size !== formWidgets.size)
    invalid('This PDF contains form widgets outside its field tree.');
  if (pageWidgets.size !== formWidgets.size)
    invalid('This PDF has a form widget missing from its page.');
  return { hasFields: terminals.length > 0, terminals };
}

export async function loadEditablePdf(blob: Blob): Promise<PDFDocument> {
  if (blob.size > 100 * 1024 * 1024) invalid('Choose a PDF no larger than 100 MB.');
  return PDFDocument.load(await blob.arrayBuffer(), {
    throwOnInvalidObject: true,
    updateMetadata: false,
  });
}
function uniqueOptions(options: string[]): string[] {
  if (
    !options.length ||
    options.length > 200 ||
    new Set(options).size !== options.length ||
    options.some((option) => !option || option.length > 1000 || /[\u0000-\u001f]/.test(option))
  )
    invalid('This PDF has empty, duplicate, or oversized choice options.');
  return options;
}
function describeFields(pdf: PDFDocument): { fields: PdfFormField[]; apiFields: PDFField[] } {
  const audit = auditPdfForEditing(pdf);
  if (!audit.hasFields) return { fields: [], apiFields: [] };
  const apiFields = pdf.getForm().getFields();
  if (
    apiFields.length !== audit.terminals.length ||
    apiFields.some((f) => !audit.terminals.includes(f.acroField.dict))
  )
    invalid('Some fields in this PDF cannot be read without losing form data.');
  const names = new Set<string>();
  const fields = apiFields.map((field): PdfFormField => {
    const fieldName = field.getName();
    if (!fieldName || fieldName.length > 1000 || names.has(fieldName))
      invalid('This PDF has empty, duplicate, or oversized field names.');
    names.add(fieldName);
    const tooltip = field.acroField.dict.lookup(name('TU'));
    const flags = field.acroField.getFlags();
    const allowedFlags =
      field instanceof PDFTextField
        ? 7 | (1 << 12) | (1 << 22) | (1 << 23) | (1 << 24)
        : field instanceof PDFCheckBox
          ? 7
          : field instanceof PDFRadioGroup
            ? 7 | (1 << 14) | (1 << 15) | (1 << 25)
            : field instanceof PDFDropdown || field instanceof PDFOptionList
              ? 7 | (1 << 17) | (1 << 18) | (1 << 19) | (1 << 21) | (1 << 22) | (1 << 26)
              : 0;
    if ((flags & ~allowedFlags) !== 0) invalid('This PDF uses unsupported field behavior flags.');
    const base = {
      name: fieldName,
      label: tooltip ? string(tooltip) : fieldName,
      readOnly: field.isReadOnly(),
      required: field.isRequired(),
    };
    if (!field.acroField.getWidgets().length)
      invalid('This PDF has a form field without a visible widget.');
    for (const widget of field.acroField.getWidgets()) {
      const rect = widget.getRectangle();
      if (field instanceof PDFCheckBox || field instanceof PDFRadioGroup) {
        const normal = widget.getAppearances()?.normal;
        const on = widget.getOnValue();
        if (
          !(normal instanceof PDFDict) ||
          !on ||
          normal.keys().length !== 2 ||
          !normal.has(name('Off'))
        )
          invalid('This PDF has unsupported button appearance states.');
        const value = field.acroField.getValue();
        const expected = value === on ? on : name('Off');
        if (widget.getAppearanceState() !== expected)
          invalid('This PDF has a checkbox or radio appearance that disagrees with its value.');
      }
      if (
        ![rect.x, rect.y, rect.width, rect.height].every(Number.isFinite) ||
        rect.width <= 0 ||
        rect.height <= 0
      )
        invalid('This PDF has a malformed or invisible field rectangle.');
    }
    if (field instanceof PDFTextField) {
      if (field.isPassword() || field.isFileSelector() || field.isRichFormatted())
        invalid('Password, file-selection, and rich-text PDF fields are not supported.');
      const rawValue = field.acroField.V();
      if (rawValue) string(rawValue);
      const rawMaxLength = pdf.context.lookup(
        field.acroField.getInheritableAttribute(name('MaxLen')),
      );
      if (rawMaxLength && !(rawMaxLength instanceof PDFNumber))
        invalid('This PDF has a malformed text length limit.');
      const maxLength = rawMaxLength instanceof PDFNumber ? rawMaxLength.asNumber() : undefined;
      if (
        maxLength !== undefined &&
        (!Number.isSafeInteger(maxLength) || maxLength < 1 || maxLength > MAX_TEXT)
      )
        invalid('This PDF has an unsupported text length limit.');
      const value = field.getText() ?? '';
      if (value.length > (maxLength ?? MAX_TEXT))
        invalid('This PDF contains text beyond its field limit.');
      return {
        ...base,
        kind: 'text',
        value,
        multiline: field.isMultiline(),
        maxLength: maxLength ?? MAX_TEXT,
      };
    }
    if (field instanceof PDFCheckBox) {
      if (field.acroField.V() && !(field.acroField.V() instanceof PDFName))
        invalid('This PDF has an invalid checkbox value.');
      const onValues = field.acroField
        .getWidgets()
        .map((widget) => widget.getOnValue()?.decodeText());
      if (onValues.some((value) => !value) || new Set(onValues).size !== 1)
        invalid('This PDF has an unsupported checkbox appearance.');
      const value = field.acroField.getValue().decodeText();
      if (value !== 'Off' && !onValues.includes(value))
        invalid('This PDF has an invalid checkbox value.');
      return { ...base, kind: 'checkbox', value: field.isChecked() };
    }
    if (field instanceof PDFRadioGroup) {
      if (field.acroField.V() && !(field.acroField.V() instanceof PDFName))
        invalid('This PDF has an invalid radio value.');
      const options = uniqueOptions(field.getOptions());
      const value = field.getSelected() ?? '';
      if (value && !options.includes(value)) invalid('This PDF has an invalid radio selection.');
      return { ...base, kind: 'radio', value, options, allowClear: field.isOffToggleable() };
    }
    if (field instanceof PDFDropdown || field instanceof PDFOptionList) {
      const opt = field.acroField.dict.lookup(name('Opt'));
      if (!(opt instanceof PDFArray) || !opt.size() || opt.size() > 200)
        invalid('This PDF has malformed choice options.');
      for (const option of opt.asArray()) {
        const resolved = pdf.context.lookup(option);
        if (resolved instanceof PDFArray) {
          if (resolved.size() !== 2)
            invalid('This PDF has a malformed export/display choice pair.');
          string(resolved.lookup(0));
          string(resolved.lookup(1));
        } else string(resolved);
      }
      const rawValue = field.acroField.V();
      if (rawValue instanceof PDFArray)
        for (const value of rawValue.asArray()) string(pdf.context.lookup(value));
      else if (rawValue) string(rawValue);
      const rawOptions = field.acroField.getOptions();
      if (
        rawOptions.some(
          (option) => option.display && option.display.decodeText() !== option.value.decodeText(),
        )
      )
        invalid(
          'Choice fields with separate export values and display labels are not supported yet.',
        );
      if (field instanceof PDFDropdown && (field.isEditable() || field.isMultiselect()))
        invalid('Editable or multi-selection dropdown fields are not supported yet.');
      const options = uniqueOptions(field.getOptions());
      const values = field.getSelected();
      const multiselect = field.isMultiselect();
      if (
        (!multiselect && values.length > 1) ||
        values.some((v) => !options.includes(v)) ||
        new Set(values).size !== values.length
      )
        invalid('This PDF has an invalid choice selection.');
      return {
        ...base,
        kind: field instanceof PDFDropdown ? 'dropdown' : 'list',
        value: multiselect ? values : (values[0] ?? ''),
        options,
        multiselect,
      };
    }
    return invalid('This PDF contains an unsupported form field.');
  });
  return { fields, apiFields };
}
export async function inspectPdfForm(blob: Blob): Promise<PdfFormInspection> {
  return { fields: describeFields(await loadEditablePdf(blob)).fields };
}
function validateValue(field: PdfFormField, value: unknown): void {
  const fail = (message: string) => invalid(`${field.label}: ${message}`);
  if (field.kind === 'checkbox') {
    if (typeof value !== 'boolean') fail('choose checked or unchecked.');
    if (field.required && !value) fail('this required checkbox must be checked.');
  } else if (field.multiselect) {
    if (
      !Array.isArray(value) ||
      value.length > 200 ||
      new Set(value).size !== value.length ||
      value.some((item) => typeof item !== 'string' || !field.options?.includes(item))
    )
      fail('choose only listed options.');
    if (field.required && !(value as unknown[]).length) fail('choose at least one option.');
  } else {
    if (typeof value !== 'string') return fail('enter a valid value.');
    if (field.required && !value.trim()) fail('this field is required.');
    if (field.kind === 'text') {
      if (value.length > (field.maxLength ?? MAX_TEXT))
        fail(`use at most ${field.maxLength ?? MAX_TEXT} characters.`);
      if (
        /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value) ||
        (!field.multiline && /[\r\n]/.test(value))
      )
        fail('this field contains unsupported control characters or line breaks.');
    } else if (value && !field.options?.includes(value)) fail('choose a listed option.');
    else if (!value && field.kind === 'radio' && !field.allowClear && field.value)
      fail('this radio group does not allow clearing its selection.');
  }
}
/** pdf-lib otherwise reuses a stale fixed /DA size and clips replacement text. */
const fittingTextAppearance: AppearanceProviderFor<PDFTextField> = (field, widget, font) => {
  const rectangle = widget.getRectangle();
  const { width, height } = adjustDimsForRotation(
    rectangle,
    widget.getAppearanceCharacteristics()?.getRotation(),
  );
  const padding = (widget.getBorderStyle()?.getWidth() ?? 0) + (field.isCombed() ? 0 : 1);
  const bounds = {
    x: padding,
    y: padding,
    width: width - padding * 2,
    height: height - padding * 2,
  };
  if (bounds.width <= 0 || bounds.height <= 0)
    invalid(`${field.getName()}: the form field has no space for text.`);
  const appearance =
    widget.getDefaultAppearance() ?? field.acroField.getDefaultAppearance() ?? '0 g';
  const matches = [...appearance.matchAll(/\/[^\s]+\s+(\d*\.\d+|\d+)\s+Tf/g)];
  const previousSize = Number(matches.at(-1)?.[1]);
  const preferred =
    Number.isFinite(previousSize) && previousSize > 0 ? Math.min(72, previousSize) : 12;
  const text = field.getText() ?? '';
  const fits = (fontSize: number): boolean => {
    const options = { font, fontSize, bounds, alignment: field.getAlignment() };
    const lines = field.isMultiline()
      ? layoutMultilineText(text, options).lines
      : field.isCombed()
        ? layoutCombedText(text, { ...options, cellCount: field.getMaxLength()! }).cells
        : [layoutSinglelineText(text, options).line];
    return lines.every(
      (line) =>
        line.x >= bounds.x - 0.01 &&
        line.x + line.width <= bounds.x + bounds.width + 0.01 &&
        line.y - fontSize * 0.25 >= bounds.y - 0.01 &&
        line.y + line.height <= bounds.y + bounds.height + 0.01,
    );
  };
  const minimum = 6;
  let size = Math.max(minimum, preferred);
  if (!fits(size)) {
    if (!fits(minimum))
      invalid(
        `${field.getName()}: this answer does not fit in the PDF field at a readable size. Shorten it or cancel; your draft remains open.`,
      );
    let low = minimum,
      high = size;
    for (let i = 0; i < 12; i++) {
      const middle = (low + high) / 2;
      if (fits(middle)) low = middle;
      else high = middle;
    }
    size = Math.floor(low * 100) / 100;
  }
  // The library reads the last Tf operator. Keep existing color and make this widget's
  // checked size explicit before delegating borders/background/rotation to its provider.
  widget.setDefaultAppearance(`${appearance}\n/Helvetica ${size} Tf`);
  return defaultTextFieldAppearanceProvider(field, widget, font);
};

export async function applyPdfFormChanges(blob: Blob, changes: PdfFormChange[]): Promise<Blob> {
  if (!Array.isArray(changes) || changes.length > MAX_FIELDS) invalid('Too many form changes.');
  const pdf = await loadEditablePdf(blob);
  const { fields, apiFields } = describeFields(pdf);
  const changesByName = new Map<string, PdfFormChange>();
  for (const change of changes) {
    if (
      !change ||
      typeof change.name !== 'string' ||
      changesByName.has(change.name) ||
      Object.keys(change).some((key) => key !== 'name' && key !== 'value')
    )
      invalid('Invalid or duplicate form change.');
    const field = fields.find((f) => f.name === change.name);
    if (!field) invalid('A changed field does not exist in this form.');
    if (field.readOnly) invalid(`${field.label}: this field is read-only.`);
    changesByName.set(change.name, change);
  }
  const changed = fields.filter(
    (field) =>
      changesByName.has(field.name) &&
      JSON.stringify(field.value) !== JSON.stringify(changesByName.get(field.name)!.value),
  );
  if (!changed.length) return blob;
  // Validate all writable required fields together, without silently changing any field flags.
  for (const field of fields)
    if (!field.readOnly)
      validateValue(
        field,
        changesByName.has(field.name) ? changesByName.get(field.name)!.value : field.value,
      );
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  for (const field of changed) {
    const value = changesByName.get(field.name)!.value;
    const textValues =
      field.kind === 'dropdown' || field.kind === 'list'
        ? field.options!
        : typeof value === 'string'
          ? [value]
          : Array.isArray(value)
            ? value
            : [];
    try {
      for (const text of field.kind === 'radio' ? [] : textValues)
        font.encodeText(text.replace(/[\r\n]/g, ''));
    } catch {
      invalid(
        `${field.label}: this PDF's supported form font cannot represent some characters. Your draft remains open; use supported characters or cancel.`,
      );
    }
  }
  for (const descriptor of changed) {
    const field = apiFields.find((f) => f.getName() === descriptor.name)!;
    const value = changesByName.get(descriptor.name)!.value;
    if (field instanceof PDFTextField) {
      const inheritedMaxLength = pdf.context.lookup(
        field.acroField.getInheritableAttribute(name('MaxLen')),
      );
      if (inheritedMaxLength instanceof PDFNumber && !field.acroField.dict.has(name('MaxLen')))
        field.setMaxLength(inheritedMaxLength.asNumber());
      field.setText(value as string);
      field.updateAppearances(font, fittingTextAppearance);
    } else if (field instanceof PDFCheckBox) {
      if (value) field.check();
      else field.uncheck();
      field.updateAppearances();
    } else if (field instanceof PDFRadioGroup) {
      if (value) field.select(value as string);
      else field.clear();
      field.updateAppearances();
    } else if (field instanceof PDFDropdown || field instanceof PDFOptionList) {
      if (value === '' || (Array.isArray(value) && !value.length)) field.clear();
      else field.select(value as string | string[]);
      field.updateAppearances(font);
    }
  }
  // Do not ask pdf-lib to regenerate untouched fields (their fonts may be Unicode/custom).
  const bytes = await pdf.save({ updateFieldAppearances: false });
  if (bytes.byteLength > 100 * 1024 * 1024)
    invalid('The filled PDF exceeds the 100 MB document limit.');
  return new Blob([bytes as BlobPart], { type: 'application/pdf' });
}
