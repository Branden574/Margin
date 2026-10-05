import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { createCanvas } from '@napi-rs/canvas';
import { describe, expect, it } from 'vitest';
import { PDFDocument, PDFName, PDFNumber, PDFString, StandardFonts, degrees, rgb } from 'pdf-lib';
import type { OcrPageRecord } from '@margin/core';
import { getDocument, type PDFDocumentProxy, type TextItem } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { addOcrTextLayer } from '../apps/web/src/editor/ocrPdfExport';
import { extractPdfPage } from '../apps/web/src/editor/pdf';
import { removeNativeOcrOverlap } from '../apps/web/src/editor/ocrExportNative';

const fontBytes = new Uint8Array(
  readFileSync(new URL('../apps/web/src/assets/fonts/NotoSans-Regular.ttf', import.meta.url)),
);
const require = createRequire(import.meta.url);
const standardFontDataUrl = join(
  dirname(require.resolve('pdfjs-dist/package.json')),
  'standard_fonts/',
);
const loadingTasks = new WeakMap<PDFDocumentProxy, ReturnType<typeof getDocument>>();
async function close(pdf: PDFDocumentProxy) {
  await loadingTasks.get(pdf)?.destroy();
}
async function parse(blob: Blob) {
  const task = getDocument({
    data: new Uint8Array(await blob.arrayBuffer()),
    standardFontDataUrl,
    useSystemFonts: false,
  });
  const pdf = await task.promise;
  loadingTasks.set(pdf, task);
  return pdf;
}
async function pdfBlob(pdf: PDFDocument) {
  return new Blob([(await pdf.save({ updateFieldAppearances: false })) as BlobPart], {
    type: 'application/pdf',
  });
}
async function fixture(rotation = 0) {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([440, 640]);
  page.setCropBox(20, 30, 400, 580);
  page.setRotation(degrees(rotation));
  const canvas = createCanvas(300, 100);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#efece7';
  ctx.fillRect(0, 0, 300, 100);
  ctx.fillStyle = '#20372e';
  ctx.font = '24px sans-serif';
  ctx.fillText('Synthetic printed page', 10, 50);
  const image = await pdf.embedPng(canvas.toBuffer('image/png'));
  page.drawImage(image, { x: 40, y: 400, width: 340, height: 114 });
  page.drawRectangle({ x: 55, y: 50, width: 100, height: 25, color: rgb(0.3, 0.4, 0.8) });
  pdf
    .addPage([440, 640])
    .drawText('Original native text stays intact.', { x: 25, y: 550, size: 13 });
  return pdfBlob(pdf);
}
async function recordsFor(blob: Blob, text = '“Café” office—today\ne\u0301 £12.50') {
  const pdf = await parse(blob);
  try {
    const viewport = (await pdf.getPage(1)).getViewport({ scale: 1 });
    const words: OcrPageRecord['words'] = [];
    let column = 0;
    let line = 0;
    for (const match of text.matchAll(/\S+/gu)) {
      if (text.slice(words.at(-1)?.end ?? 0, match.index).includes('\n')) {
        line++;
        column = 0;
      }
      const x = 20 + column * 150;
      const y = 55 + line * 35;
      const quad = [
        [x, y],
        [x + 120, y],
        [x + 120, y + 22],
        [x, y + 22],
      ].flatMap(([a, b]) =>
        viewport.convertToPdfPoint(a, b),
      ) as OcrPageRecord['words'][number]['quad'];
      words.push({
        start: match.index!,
        end: match.index! + match[0].length,
        confidence: 98,
        quad,
      });
      column++;
    }
    return [
      {
        schema: 1,
        documentId: 'synthetic-document',
        contentRevision: 'synthetic-revision',
        pageIndex: 0,
        engine: 'tesseract.js/7.0.0',
        language: 'eng/1.0.0',
        text,
        words,
        createdAt: '2026-10-05T00:00:00.000Z',
      },
    ] satisfies OcrPageRecord[];
  } finally {
    await close(pdf);
  }
}
async function pixels(pdf: PDFDocumentProxy, index: number) {
  const page = await pdf.getPage(index);
  const viewport = page.getViewport({ scale: 0.7 });
  const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
  await page.render({
    canvas: canvas as unknown as HTMLCanvasElement,
    canvasContext: canvas.getContext('2d') as unknown as CanvasRenderingContext2D,
    viewport,
  }).promise;
  return Buffer.from(canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data);
}

describe('saved OCR becomes an invisible, Unicode-searchable PDF layer', () => {
  it('uses the pinned local font rather than a network dependency', () => {
    expect(createHash('sha256').update(fontBytes).digest('hex')).toBe(
      'b85c38ecea8a7cfb39c24e395a4007474fa5a4fc864f6ee33309eb4948d232d5',
    );
  });
  it.each([0, 90, 180, 270])(
    'preserves rendered pixels, native text, crop and word geometry at rotation %i',
    async (rotation) => {
      const original = await fixture(rotation);
      const originalBytes = await original.arrayBuffer();
      const records = await recordsFor(original);
      const recordsBefore = structuredClone(records);
      const result = await addOcrTextLayer(original, records, fontBytes);
      const before = await parse(original);
      const after = await parse(result);
      try {
        expect(after.numPages).toBe(2);
        const page = await after.getPage(1);
        expect(page.rotate).toBe(rotation);
        expect(page.view).toEqual([20, 30, 420, 610]);
        const content = await page.getTextContent({ disableNormalization: true });
        const items = content.items.filter(
          (item): item is TextItem => 'str' in item && item.str.trim().length > 0,
        );
        expect(items.map((item) => item.str)).toEqual([
          '“Café”',
          'office—today',
          'e\u0301',
          '£12.50',
        ]);
        expect(items.map((item) => item.hasEOL)).toEqual([false, true, false, false]);
        for (let i = 0; i < items.length; i++) {
          const item = items[i];
          const style = content.styles[item.fontName];
          const [a, b, c, d, e, f] = item.transform;
          const width = Math.hypot(a, b);
          const expected = records[0].words[i].quad;
          const actual = [
            e + c * style.ascent!,
            f + d * style.ascent!,
            e + c * style.ascent! + (a / width) * item.width,
            f + d * style.ascent! + (b / width) * item.width,
            e + c * style.descent! + (a / width) * item.width,
            f + d * style.descent! + (b / width) * item.width,
            e + c * style.descent!,
            f + d * style.descent!,
          ];
          actual.forEach((n, index) => expect(n).toBeCloseTo(expected[index], 3));
        }
        expect(await pixels(after, 1)).toEqual(await pixels(before, 1));
        const nativeBefore = await (await before.getPage(2)).getTextContent();
        const nativeAfter = await (await after.getPage(2)).getTextContent();
        const withoutFontIds = (items: typeof nativeAfter.items) =>
          items.map((item) => {
            if (!('str' in item)) return item;
            const { fontName: _fontName, ...rest } = item;
            return rest;
          });
        expect(withoutFontIds(nativeAfter.items)).toEqual(withoutFontIds(nativeBefore.items));
        expect(Object.values(nativeAfter.styles)).toEqual(Object.values(nativeBefore.styles));
        expect(await pixels(after, 2)).toEqual(await pixels(before, 2));
      } finally {
        await close(before);
        await close(after);
      }
      expect(await original.arrayBuffer()).toEqual(originalBytes);
      expect(records).toEqual(recordsBefore);
    },
  );
  it('retains searchable content when the exported page is extracted afterward', async () => {
    const source = await fixture(180);
    const withText = await addOcrTextLayer(
      source,
      await recordsFor(source, 'Saved recognition'),
      fontBytes,
    );
    const extracted = await parse(await extractPdfPage(withText, 0));
    try {
      expect(extracted.numPages).toBe(1);
      expect(
        (await (await extracted.getPage(1)).getTextContent()).items
          .filter((i): i is TextItem => 'str' in i)
          .map((i) => i.str)
          .join(''),
      ).toBe('Saved recognition');
    } finally {
      await close(extracted);
    }
  });
  it('retains word boundaries even when neighboring recognition boxes touch', async () => {
    const source = await fixture();
    const records = await recordsFor(source, 'Saved recognition');
    const q = records[0].words[1].quad;
    for (let i = 0; i < 8; i += 2) q[i] -= 30;
    const pdf = await parse(await addOcrTextLayer(source, records, fontBytes));
    try {
      const content = await (await pdf.getPage(1)).getTextContent();
      expect(
        content.items
          .filter((i): i is TextItem => 'str' in i)
          .map((i) => i.str)
          .join(''),
      ).toBe('Saved recognition');
    } finally {
      await close(pdf);
    }
  });
  it('filters already native words while retaining recognized paragraphs on a mixed page', async () => {
    const source = await fixture();
    const first = await recordsFor(source, 'Scanned paragraph');
    const document = await PDFDocument.load(await source.arrayBuffer());
    document.getPage(0).drawText('Footer', { x: 70, y: 100, size: 14 });
    const mixed = await pdfBlob(document);
    const pdf = await parse(mixed);
    try {
      const content = await (await pdf.getPage(1)).getTextContent();
      const item = content.items.find((i): i is TextItem => 'str' in i && i.str === 'Footer')!;
      const style = content.styles[item.fontName];
      const top = item.transform[5] + item.transform[3] * style.ascent!;
      const bottom = item.transform[5] + item.transform[3] * style.descent!;
      const x = item.transform[4];
      const nativeOnly: OcrPageRecord = {
        ...first[0],
        text: 'Footer',
        words: [
          {
            start: 0,
            end: 6,
            confidence: 99,
            quad: [x, top, x + item.width, top, x + item.width, bottom, x, bottom],
          },
        ],
      };
      expect(await removeNativeOcrOverlap(pdf, nativeOnly)).toBeUndefined();
      const text = `${first[0].text}\nFooter`;
      const record = {
        ...first[0],
        text,
        words: [
          ...first[0].words,
          { ...nativeOnly.words[0], start: text.length - 6, end: text.length },
        ],
      };
      const filtered = await removeNativeOcrOverlap(pdf, record);
      expect(filtered).toEqual(first[0]);
      const result = await parse(await addOcrTextLayer(mixed, [filtered!], fontBytes));
      try {
        const exported = (await (await result.getPage(1)).getTextContent()).items
          .filter((i): i is TextItem => 'str' in i)
          .map((i) => i.str)
          .join('');
        expect(exported.match(/Footer/g)).toHaveLength(1);
        expect(exported).toContain('Scanned paragraph');
        expect(await pixels(result, 1)).toEqual(await pixels(pdf, 1));
      } finally {
        await close(result);
      }
    } finally {
      await close(pdf);
    }
  });
  it('does not duplicate a real native word split into eight PDF.js font fragments', async () => {
    const source = await PDFDocument.create();
    const page = source.addPage([600, 800]);
    const fonts = await Promise.all([
      source.embedFont(StandardFonts.Helvetica),
      source.embedFont(StandardFonts.HelveticaBold),
    ]);
    let x = 50;
    for (const [index, character] of [...'DOCUMENT'].entries()) {
      const font = fonts[index % 2];
      page.drawText(character, { x, y: 500, size: 16, font });
      x += font.widthOfTextAtSize(character, 16);
    }
    const pdf = await parse(await pdfBlob(source));
    try {
      const content = await (await pdf.getPage(1)).getTextContent();
      expect(content.items.filter((i): i is TextItem => 'str' in i).map((i) => i.str)).toEqual([
        ...'DOCUMENT',
      ]);
      const record: OcrPageRecord = {
        schema: 1,
        documentId: 'synthetic',
        contentRevision: 'synthetic',
        pageIndex: 0,
        engine: 'test',
        language: 'eng',
        text: 'DOCUMENT',
        words: [{ start: 0, end: 8, confidence: 99, quad: [50, 510, x, 510, x, 500, 50, 500] }],
        createdAt: '2026-10-05T00:00:00.000Z',
      };
      expect(await removeNativeOcrOverlap(pdf, record)).toBeUndefined();
    } finally {
      await close(pdf);
    }
  });
  it('leaves a document without recognition byte-identical and requires no font', async () => {
    const source = await fixture();
    expect(await addOcrTextLayer(source, [], new Uint8Array())).toBe(source);
  });
  it.each(['Hello 🦄', 'bad\ud800', 'ab\u202ecd'])(
    'refuses unsupported characters or controls without substituting %j',
    async (text) => {
      const source = await fixture();
      const bytes = await source.arrayBuffer();
      await expect(
        addOcrTextLayer(source, await recordsFor(source, text), fontBytes),
      ).rejects.toThrow(/original PDF is unchanged/);
      expect(await source.arrayBuffer()).toEqual(bytes);
    },
  );
  it.each([
    (r: OcrPageRecord[]) => {
      r[0].words[0].end = 2;
    },
    (r: OcrPageRecord[]) => {
      r[0].words[1].start = 0;
    },
    (r: OcrPageRecord[]) => {
      r[0].words[0].quad[0] = Infinity;
    },
    (r: OcrPageRecord[]) => {
      r[0].words[0].quad[0] = -50;
    },
    (r: OcrPageRecord[]) => {
      r[0].words[0].quad[4] += 12;
    },
    (r: OcrPageRecord[]) => {
      r[0].words[0].confidence = NaN;
    },
    (r: OcrPageRecord[]) => {
      r[0].pageIndex = 20;
    },
    (r: OcrPageRecord[]) => {
      r.push(structuredClone(r[0]));
    },
    (r: OcrPageRecord[]) => {
      r.push({ ...structuredClone(r[0]), pageIndex: 1, contentRevision: 'different' });
    },
    (r: OcrPageRecord[]) => {
      r[0].words = [];
    },
    (r: OcrPageRecord[]) => {
      r[0].text = 'a'.repeat(200_001);
    },
  ])('refuses malformed, stale or out-of-bounds records (%#)', async (mutate) => {
    const source = await fixture();
    const records = await recordsFor(source);
    mutate(records);
    await expect(addOcrTextLayer(source, records, fontBytes)).rejects.toThrow(
      /original PDF is unchanged/,
    );
  });
  it('bounds aggregate page, word and text work before writing PDF objects', async () => {
    const source = await fixture();
    const [record] = await recordsFor(source, 'word');
    const many = Array.from({ length: 101 }, (_, pageIndex) => ({ ...record, pageIndex }));
    await expect(addOcrTextLayer(source, many, fontBytes)).rejects.toThrow('100 recognized pages');
    const wordCountRecord = {
      ...record,
      text: Array(20_000).fill('a').join(' '),
      words: Array.from({ length: 20_000 }, (_, i) => ({
        ...record.words[0],
        start: i * 2,
        end: i * 2 + 1,
      })),
    };
    await expect(
      addOcrTextLayer(
        source,
        Array.from({ length: 6 }, (_, pageIndex) => ({ ...wordCountRecord, pageIndex })),
        fontBytes,
      ),
    ).rejects.toThrow('100,000 words');
    const textCountRecord = {
      ...record,
      text: 'a'.repeat(200_000),
      words: [{ ...record.words[0], end: 200_000 }],
    };
    await expect(
      addOcrTextLayer(
        source,
        Array.from({ length: 6 }, (_, pageIndex) => ({ ...textCountRecord, pageIndex })),
        fontBytes,
      ),
    ).rejects.toThrow('1,000,000 text characters');
  });
  it('refuses signed and scripted documents before embedding a font', async () => {
    const source = await fixture();
    const records = await recordsFor(source);
    const pdf = await PDFDocument.load(await source.arrayBuffer());
    pdf.catalog.set(
      PDFName.of('OpenAction'),
      pdf.context.obj({ S: PDFName.of('JavaScript'), JS: PDFString.of('synthetic') }),
    );
    await expect(addOcrTextLayer(await pdfBlob(pdf), records, fontBytes)).rejects.toThrow(
      /original PDF is unchanged/,
    );
    pdf.catalog.delete(PDFName.of('OpenAction'));
    pdf.catalog.set(PDFName.of('DocMDP'), PDFNumber.of(1));
    await expect(addOcrTextLayer(await pdfBlob(pdf), records, fontBytes)).rejects.toThrow(
      /original PDF is unchanged/,
    );
  });
  it('refuses absent and corrupt local font assets', async () => {
    const source = await fixture();
    const records = await recordsFor(source);
    await expect(addOcrTextLayer(source, records, new Uint8Array())).rejects.toThrow(
      'font is unavailable',
    );
    await expect(addOcrTextLayer(source, records, new Uint8Array([1, 2, 3, 4]))).rejects.toThrow(
      'font could not be read',
    );
  });
});
