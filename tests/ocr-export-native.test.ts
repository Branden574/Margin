import { describe, expect, it, vi } from 'vitest';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import type { TextContent, TextItem, TextStyle } from 'pdfjs-dist/types/src/display/api';
import type { OcrPageRecord } from '@margin/core';
vi.mock('pdfjs-dist', () => ({ PermissionFlag: { COPY: 16, COPY_FOR_ACCESSIBILITY: 512 } }));
import { removeNativeOcrOverlap } from '../apps/web/src/editor/ocrExportNative';

const style: TextStyle = { ascent: 0.8, descent: -0.2, vertical: false, fontFamily: 'test' };
const native = (x: number, y: number, width = 100, transform = [20, 0, 0, 20, x, y]): TextItem => ({
  str: 'Native text',
  dir: 'ltr',
  transform,
  width,
  height: 20,
  fontName: 'font',
  hasEOL: true,
});
const quad = (x: number, y: number): OcrPageRecord['words'][number]['quad'] => [
  x,
  y + 15,
  x + 80,
  y + 15,
  x + 80,
  y,
  x,
  y,
];
const record = (): OcrPageRecord => ({
  schema: 1,
  documentId: 'test',
  contentRevision: 'revision',
  engine: 'test',
  language: 'eng',
  pageIndex: 0,
  text: 'Native\n\nScanned',
  createdAt: '2026-10-05T00:00:00.000Z',
  words: [
    { start: 0, end: 6, confidence: 90, quad: quad(50, 700) },
    { start: 8, end: 15, confidence: 90, quad: quad(50, 400) },
  ],
});
function pdf(items: TextItem[], textStyle = style, permissions: Set<number> | null = null) {
  return {
    numPages: 1,
    getPermissions: async () => permissions,
    getPage: async () => ({
      streamTextContent: () =>
        new ReadableStream<TextContent>({
          start(controller) {
            controller.enqueue({ items, styles: { font: textStyle }, lang: 'en' });
            controller.close();
          },
        }),
    }),
  } as unknown as PDFDocumentProxy;
}
describe('searchable export native-text overlap', () => {
  it('retains all OCR on image-only pages', async () => {
    const source = record();
    expect(await removeNativeOcrOverlap(pdf([]), source)).toBe(source);
  });
  it('keeps the scanned paragraph on mixed pages, with canonical offsets and no duplicated footer', async () => {
    const source = record();
    const result = await removeNativeOcrOverlap(pdf([native(50, 700)]), source);
    expect(result?.text).toBe('Scanned');
    expect(result?.words).toEqual([{ ...source.words[1], start: 0, end: 7 }]);
    expect(source.text).toBe('Native\n\nScanned');
  });
  it('omits OCR when all words already have native glyphs', async () => {
    expect(
      await removeNativeOcrOverlap(pdf([native(50, 700), native(50, 400)]), record()),
    ).toBeUndefined();
  });
  it('unions many small fragments that collectively cover one OCR word', async () => {
    const result = await removeNativeOcrOverlap(
      pdf(Array.from({ length: 8 }, (_, i) => native(50 + i * 10, 700, 10))),
      record(),
    );
    expect(result?.text).toBe('Scanned');
  });
  it('does not double-count overlapping native fragments', async () => {
    await expect(
      removeNativeOcrOverlap(pdf(Array.from({ length: 20 }, () => native(50, 700, 20))), record()),
    ).rejects.toThrow('overlap');
    const result = await removeNativeOcrOverlap(
      pdf([native(50, 700, 30), native(70, 700, 30)]),
      record(),
    );
    expect(result?.text).toBe('Scanned');
  });
  it('refuses ambiguous aggregate overlap even when each fragment covers less than 15 percent', async () => {
    await expect(
      removeNativeOcrOverlap(pdf([native(50, 700, 8), native(122, 700, 8)]), record()),
    ).rejects.toThrow('overlap');
  });
  it('refuses intersecting native runs oblique to the OCR word', async () => {
    const angle = Math.PI / 4;
    await expect(
      removeNativeOcrOverlap(
        pdf([
          native(0, 0, 100, [
            20 * Math.cos(angle),
            20 * Math.sin(angle),
            -20 * Math.sin(angle),
            20 * Math.cos(angle),
            50,
            700,
          ]),
        ]),
        record(),
      ),
    ).rejects.toThrow('overlap');
  });
  it('bounds overlapping fragments before calculating their union', async () => {
    await expect(
      removeNativeOcrOverlap(
        pdf(Array.from({ length: 1025 }, () => native(50, 700, 10))),
        record(),
      ),
    ).rejects.toThrow('overlap');
  });
  it('delivers cancellation even when every processed word is omitted as native', async () => {
    const controller = new AbortController();
    const source = record();
    source.text = Array(20_000).fill('Native').join(' ');
    source.words = Array.from({ length: 20_000 }, (_, i) => ({
      ...source.words[0],
      start: i * 7,
      end: i * 7 + 6,
    }));
    const timer = setTimeout(() => controller.abort(), 0);
    try {
      await expect(
        removeNativeOcrOverlap(pdf([native(50, 700)]), source, controller.signal),
      ).rejects.toMatchObject({ name: 'AbortError' });
    } finally {
      clearTimeout(timer);
    }
  });
  it('handles cropped pages in PDF user coordinates and arbitrary orthogonal text rotations', async () => {
    const source = record();
    const transform = (x: number, y: number) => [30 - y, 40 + x];
    for (const word of source.words) {
      const points: number[] = [];
      for (let i = 0; i < 8; i += 2) points.push(...transform(word.quad[i], word.quad[i + 1]));
      word.quad = points as typeof word.quad;
    }
    const result = await removeNativeOcrOverlap(
      pdf([native(0, 0, 100, [0, 20, -20, 0, -670, 90])]),
      source,
    );
    expect(result?.text).toBe('Scanned');
  });
  it('fails explicitly for ambiguous overlap rather than dropping or duplicating recognized words', async () => {
    await expect(removeNativeOcrOverlap(pdf([native(90, 700)]), record())).rejects.toThrow(
      'overlap',
    );
  });
  it.each([
    { ...style, vertical: true },
    { ...style, ascent: NaN },
    { ...style, descent: undefined },
  ])('rejects native text with unsupported font geometry', async (s) => {
    await expect(
      removeNativeOcrOverlap(pdf([native(50, 700)], s as TextStyle), record()),
    ).rejects.toThrow('overlap');
  });
  it('rejects skewed or mirrored native geometry', async () => {
    for (const t of [
      [20, 0, 10, 20, 50, 700],
      [-20, 0, 0, 20, 50, 700],
    ])
      await expect(
        removeNativeOcrOverlap(pdf([native(50, 700, 100, t)]), record()),
      ).rejects.toThrow('overlap');
  });
  it('bounds extreme native text before building spatial buckets', async () => {
    await expect(removeNativeOcrOverlap(pdf([native(0, 0, 900_000)]), record())).rejects.toThrow(
      'overlap',
    );
  });
  it('honors cancellation and PDF text permissions before processing glyphs', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      removeNativeOcrOverlap(pdf([]), record(), controller.signal),
    ).rejects.toMatchObject({ name: 'AbortError' });
    await expect(removeNativeOcrOverlap(pdf([], style, new Set()), record())).rejects.toMatchObject(
      { code: 'permission_denied' },
    );
  });
});
