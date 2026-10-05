import fontkit from '@pdf-lib/fontkit';
import type { OcrPageRecord } from '@margin/core';
import {
  beginText,
  endText,
  popGraphicsState,
  pushGraphicsState,
  setCharacterSpacing,
  setCharacterSqueeze,
  setFontAndSize,
  setTextMatrix,
  setTextRenderingMode,
  setTextRise,
  setWordSpacing,
  showText,
  TextRenderingMode,
  type PDFPage,
} from 'pdf-lib';
import { auditPdfForEditing, loadEditablePdf } from './forms';
import { OCR_EXPORT_MAX_PAGES, OCR_EXPORT_MAX_WORDS, OCR_EXPORT_MAX_TEXT } from './ocrExportLimits';
const MAX_PAGE_WORDS = 20_000;
const MAX_PAGE_TEXT = 200_000;
const MAX_FONT_BYTES = 2_000_000;
// Ligature substitution is unnecessary for an invisible English text layer. Disable
// it so extraction preserves independent characters, including ordinary "office".
const FONT_FEATURES = { liga: false, clig: false, kern: false };
function invalid(message: string): never {
  throw new Error(`${message} The original PDF is unchanged.`);
}

function validateRecords(records: readonly OcrPageRecord[]): void {
  if (!Array.isArray(records) || records.length > OCR_EXPORT_MAX_PAGES)
    invalid('Searchable export supports at most 100 recognized pages at a time.');
  const pages = new Set<number>();
  let words = 0;
  let text = 0;
  for (const record of records) {
    if (
      !record ||
      record.schema !== 1 ||
      typeof record.documentId !== 'string' ||
      !record.documentId ||
      typeof record.contentRevision !== 'string' ||
      !record.contentRevision ||
      record.documentId !== records[0].documentId ||
      record.contentRevision !== records[0].contentRevision ||
      !Number.isSafeInteger(record.pageIndex) ||
      record.pageIndex < 0 ||
      pages.has(record.pageIndex) ||
      typeof record.text !== 'string' ||
      !record.text ||
      record.text.length > MAX_PAGE_TEXT ||
      !Array.isArray(record.words) ||
      !record.words.length ||
      record.words.length > MAX_PAGE_WORDS
    )
      invalid('The saved recognition records are inconsistent or exceed the page limits.');
    pages.add(record.pageIndex);
    words += record.words.length;
    text += record.text.length;
    if (words > OCR_EXPORT_MAX_WORDS || text > OCR_EXPORT_MAX_TEXT)
      invalid('Searchable export is limited to 100,000 words and 1,000,000 text characters.');
    if (
      /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/u.test(
        record.text,
      )
    )
      invalid('The recognized text contains unsupported control characters.');
    let end = 0;
    for (const [index, word] of record.words.entries()) {
      if (
        !word ||
        !Number.isSafeInteger(word.start) ||
        !Number.isSafeInteger(word.end) ||
        word.start < end ||
        (index > 0 && word.start === end) ||
        word.end <= word.start ||
        word.end > record.text.length ||
        !Number.isFinite(word.confidence) ||
        word.confidence < 0 ||
        word.confidence > 100 ||
        !/^[ \n]*$/.test(record.text.slice(end, word.start)) ||
        /\s/u.test(record.text.slice(word.start, word.end))
      )
        invalid('The saved recognition text and word offsets do not match.');
      end = word.end;
    }
    if (!/^[ \n]*$/.test(record.text.slice(end)))
      invalid('Some recognized text has no corresponding word coordinates.');
  }
}

function placement(quad: OcrPageRecord['words'][number]['quad'], page: PDFPage) {
  if (
    !Array.isArray(quad) ||
    quad.length !== 8 ||
    quad.some((n) => !Number.isFinite(n) || Math.abs(n) > 1_000_000)
  )
    invalid('A recognized word has invalid coordinates.');
  const [tx, ty, rx, ry, bx, by, lx, ly] = quad;
  const ax = rx - tx;
  const ay = ry - ty;
  const ux = tx - lx;
  const uy = ty - ly;
  const width = Math.hypot(ax, ay);
  const height = Math.hypot(ux, uy);
  const tolerance = Math.max(width, height) * 0.00001;
  if (
    width < 0.001 ||
    height < 0.001 ||
    Math.abs(bx - (lx + ax)) > tolerance ||
    Math.abs(by - (ly + ay)) > tolerance ||
    Math.abs(ax * ux + ay * uy) > width * height * 0.00001 ||
    ax * uy - ay * ux <= 0
  )
    invalid('A recognized word has unsupported orientation or dimensions.');
  const crop = page.getCropBox();
  const media = page.getMediaBox();
  const minX = Math.max(crop.x, media.x) - 0.5;
  const minY = Math.max(crop.y, media.y) - 0.5;
  const maxX = Math.min(crop.x + crop.width, media.x + media.width) + 0.5;
  const maxY = Math.min(crop.y + crop.height, media.y + media.height) + 0.5;
  for (let i = 0; i < 8; i += 2)
    if (quad[i] < minX || quad[i] > maxX || quad[i + 1] < minY || quad[i + 1] > maxY)
      invalid('A recognized word is outside the visible PDF page.');
  return {
    ax: ax / width,
    ay: ay / width,
    ux: ux / height,
    uy: uy / height,
    width,
    height,
    lx,
    ly,
  };
}

/**
 * Append invisible searchable words in PDF coordinates. The caller must bind the
 * records to the current source revision, enforce PDF copy/modification permissions,
 * and remove OCR words already covered by original native text. Run after annotation
 * flattening and before page extraction. No source Blob or saved record is modified.
 * Paragraph whitespace remains reader-inferred from word positions; Unicode word
 * content and reading order are retained. This does not create a tagged/accessibility PDF.
 */
export async function addOcrTextLayer(
  blob: Blob,
  records: readonly OcrPageRecord[],
  fontBytes: Uint8Array,
): Promise<Blob> {
  validateRecords(records);
  if (!records.length) return blob;
  if (!(fontBytes instanceof Uint8Array) || !fontBytes.length || fontBytes.length > MAX_FONT_BYTES)
    invalid('The bundled searchable-export font is unavailable.');
  const pdf = await loadEditablePdf(blob);
  auditPdfForEditing(pdf);
  let sourceFont: ReturnType<typeof fontkit.create>;
  try {
    sourceFont = fontkit.create(fontBytes);
  } catch {
    return invalid('The bundled searchable-export font could not be read.');
  }
  const span = sourceFont.ascent - sourceFont.descent;
  if (
    !Number.isFinite(span) ||
    span <= 0 ||
    !Number.isFinite(sourceFont.unitsPerEm) ||
    sourceFont.unitsPerEm <= 0
  )
    invalid('The searchable-export font has unsupported metrics.');
  // A single glyph cannot have two different ToUnicode values in a subset. Check
  // shaped glyph mappings before writing so unsupported shaping never drops text.
  const unicodeByGlyph = new Map<number, string>();
  const pages = pdf.getPages();
  for (const record of records) {
    if (!pages[record.pageIndex]) invalid('A recognized page is missing from this PDF.');
    for (const word of record.words) {
      placement(word.quad, pages[record.pageIndex]);
      const text = record.text.slice(word.start, word.end);
      for (const character of text)
        if (!sourceFont.hasGlyphForCodePoint(character.codePointAt(0)!))
          invalid(
            'The recognized text contains a character the local export font cannot represent.',
          );
      const glyphs = sourceFont.layout(text, FONT_FEATURES).glyphs;
      let reconstructed = '';
      for (const glyph of glyphs) {
        const value = String.fromCodePoint(...glyph.codePoints);
        if (
          !glyph.id ||
          !value ||
          (unicodeByGlyph.has(glyph.id) && unicodeByGlyph.get(glyph.id) !== value)
        )
          invalid('The recognized text requires unsupported Unicode shaping.');
        unicodeByGlyph.set(glyph.id, value);
        reconstructed += value;
      }
      if (reconstructed !== text)
        invalid('The recognized text requires unsupported Unicode shaping.');
    }
  }
  pdf.registerFontkit(fontkit);
  const font = await pdf.embedFont(fontBytes, { subset: true, features: FONT_FEATURES });
  for (const record of [...records].sort((a, b) => a.pageIndex - b.pageIndex)) {
    const page = pages[record.pageIndex];
    const resource = page.node.newFontDictionary(font.name, font.ref);
    const operators = [
      pushGraphicsState(),
      beginText(),
      setTextRenderingMode(TextRenderingMode.Invisible),
      setCharacterSpacing(0),
      setWordSpacing(0),
      setCharacterSqueeze(100),
      setTextRise(0),
    ];
    for (const [index, word] of record.words.entries()) {
      const text = record.text.slice(word.start, word.end);
      const p = placement(word.quad, page);
      const size = (p.height * sourceFont.unitsPerEm) / span;
      const textWidth = font.widthOfTextAtSize(text, size);
      if (!Number.isFinite(textWidth) || textWidth <= 0)
        invalid('A recognized word has no usable text width.');
      const horizontalScale = p.width / textWidth;
      const baseline = (-sourceFont.descent / span) * p.height;
      operators.push(
        setFontAndSize(resource, size),
        setTextMatrix(
          p.ax * horizontalScale,
          p.ay * horizontalScale,
          p.ux,
          p.uy,
          p.lx + p.ux * baseline,
          p.ly + p.uy * baseline,
        ),
        showText(font.encodeText(text)),
      );
      // PDF readers infer whitespace from geometry and may otherwise concatenate
      // neighboring words whose OCR boxes touch. An explicit separator preserves
      // their canonical boundary; the next absolute matrix restores its exact box.
      if (index + 1 < record.words.length) operators.push(showText(font.encodeText(' ')));
      // Avoid large spread argument lists even at the per-page word limit.
      if (operators.length > 1000) {
        page.pushOperators(...operators);
        operators.length = 0;
      }
    }
    operators.push(endText(), popGraphicsState());
    page.pushOperators(...operators);
  }
  const bytes = await pdf.save({ updateFieldAppearances: false });
  return new Blob([bytes as BlobPart], { type: 'application/pdf' });
}
