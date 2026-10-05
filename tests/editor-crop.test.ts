import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { createCanvas } from '@napi-rs/canvas';
import { describe, expect, it } from 'vitest';
import {
  PDFArray,
  PDFDocument,
  PDFName,
  PDFNumber,
  PDFRawStream,
  PDFString,
  decodePDFRawStream,
  degrees,
  rgb,
  type PDFPage,
} from 'pdf-lib';
import { getDocument, type PDFDocumentProxy } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { applyPageCrop, inspectPageCrop } from '../apps/web/src/editor/crop';
import type { CropRequest } from '../apps/web/src/editor/cropTypes';
import { applyPdfFormChanges } from '../apps/web/src/editor/forms';

const require = createRequire(import.meta.url);
const standardFontDataUrl = join(
  dirname(require.resolve('pdfjs-dist/package.json')),
  'standard_fonts/',
);
const tasks = new WeakMap<PDFDocumentProxy, ReturnType<typeof getDocument>>();
async function open(blob: Blob) {
  const task = getDocument({
    data: new Uint8Array(await blob.arrayBuffer()),
    standardFontDataUrl,
    useSystemFonts: false,
  });
  const pdf = await task.promise;
  tasks.set(pdf, task);
  return pdf;
}
async function close(pdf: PDFDocumentProxy) {
  await tasks.get(pdf)?.destroy();
}
async function blobOf(pdf: PDFDocument) {
  return new Blob([(await pdf.save({ updateFieldAppearances: false })) as BlobPart], {
    type: 'application/pdf',
  });
}
const n = (value: string) => PDFName.of(value);
const margins = { top: 16, right: 30, bottom: 28, left: 20 };
async function fixture(rotation = 0, userUnit = 1, form = false) {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([360, 480]);
  page.setMediaBox(-40, 60, 360, 480);
  page.setCropBox(-10, 100, 280, 370);
  page.setRotation(degrees(rotation));
  page.node.set(n('UserUnit'), PDFNumber.of(userUnit));
  page.setBleedBox(-30, 70, 340, 460);
  page.setTrimBox(-20, 80, 320, 440);
  page.setArtBox(-15, 90, 290, 400);
  page.drawRectangle({ x: -40, y: 60, width: 360, height: 480, color: rgb(0.92, 0.91, 0.88) });
  page.drawRectangle({ x: 0, y: 170, width: 85, height: 111, color: rgb(0.24, 0.53, 0.32) });
  page.drawCircle({ x: 190, y: 280, size: 38, color: rgb(0.85, 0.34, 0.19) });
  page.drawLine({
    start: { x: -20, y: 150 },
    end: { x: 300, y: 400 },
    thickness: 3,
    color: rgb(0.15, 0.21, 0.37),
  });
  page.drawText('Hidden content is retained', { x: -30, y: 520, size: 10 });
  const other = pdf.addPage([240, 320]);
  other.drawRectangle({ x: 0, y: 0, width: 120, height: 320, color: rgb(0.5, 0.2, 0.7) });
  if (form) {
    const field = pdf.getForm().createTextField('Response');
    field.setText('Original response');
    field.addToPage(page, { x: 30, y: 430, width: 160, height: 24 });
    const check = pdf.getForm().createCheckBox('Consent');
    check.addToPage(page, { x: 210, y: 430, width: 18, height: 18 });
    check.check();
    pdf.getForm().updateFieldAppearances();
  }
  return blobOf(pdf);
}
async function render(pdf: PDFDocumentProxy, index = 1) {
  const page = await pdf.getPage(index),
    viewport = page.getViewport({ scale: 1 });
  const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
  await page.render({
    canvas: canvas as unknown as HTMLCanvasElement,
    canvasContext: canvas.getContext('2d') as unknown as CanvasRenderingContext2D,
    viewport,
  }).promise;
  return canvas;
}
function digest(bytes: Uint8Array | Uint8ClampedArray) {
  return createHash('sha256').update(bytes).digest('hex');
}
function streams(page: PDFPage) {
  const contents = page.node.Contents();
  if (!contents) return [];
  const values = contents instanceof PDFArray ? contents.asArray() : [contents];
  return values.map((value) => {
    const stream = page.doc.context.lookup(value);
    if (!(stream instanceof PDFRawStream))
      throw new Error('Expected a serialized page content stream');
    return Array.from(decodePDFRawStream(stream).decode());
  });
}
function normalAppearance(pdf: PDFDocument) {
  const normal = pdf.getForm().getTextField('Response').acroField.getWidgets()[0].getAppearances()!
    .normal;
  if (!(normal instanceof PDFRawStream)) throw new Error('Expected a form appearance');
  return Array.from(decodePDFRawStream(normal).decode());
}

describe('current-page crop preserves source content and PDF geometry', () => {
  it.each([0, 90, 180, 270])(
    'crops a scanned bitmap without changing visible pixels at rotation %i',
    async (rotation) => {
      const canvas = createCanvas(128, 96),
        ctx = canvas.getContext('2d');
      const colors = ['#e2dab8', '#8bb4aa', '#7f94c6'];
      for (let y = 0; y < 96; y += 4)
        for (let x = 0; x < 128; x += 4) {
          ctx.fillStyle = colors[(x / 4 + y / 4) % 3];
          ctx.fillRect(x, y, 4, 4);
        }
      const source = await PDFDocument.create(),
        page = source.addPage([128, 96]);
      page.drawImage(await source.embedPng(canvas.toBuffer('image/png')), {
        x: 0,
        y: 0,
        width: 128,
        height: 96,
      });
      page.setCropBox(8, 4, 112, 88);
      page.setRotation(degrees(rotation));
      const original = await blobOf(source),
        margins = { top: 8, right: 12, bottom: 4, left: 16 };
      const result = await applyPageCrop(original, 0, { kind: 'margins', margins });
      const before = await open(original),
        after = await open(result.blob);
      try {
        const a = await render(before),
          b = await render(after);
        expect(digest(b.getContext('2d').getImageData(0, 0, b.width, b.height).data)).toBe(
          digest(
            a.getContext('2d').getImageData(margins.left, margins.top, b.width, b.height).data,
          ),
        );
      } finally {
        await close(before);
        await close(after);
      }
    },
  );
  it.each([0, 90, 180, 270].flatMap((rotation) => [1, 2].map((unit) => [rotation, unit])))(
    'matches actual PDF.js viewport and cropped pixels at rotation %i, UserUnit %i',
    async (rotation, unit) => {
      const original = await fixture(rotation, unit),
        bytes = await original.arrayBuffer();
      const beforeDoc = await open(original);
      const result = await applyPageCrop(original, 0, { kind: 'margins', margins });
      const afterDoc = await open(result.blob);
      try {
        const beforePage = await beforeDoc.getPage(1),
          afterPage = await afterDoc.getPage(1);
        const beforeView = beforePage.getViewport({ scale: 1 }),
          afterView = afterPage.getViewport({ scale: 1 });
        expect(result.changed).toBe(true);
        expect(result.before.transform).toEqual(beforeView.transform);
        result.after.transform.forEach((value, i) =>
          expect(value).toBeCloseTo(afterView.transform[i], 8),
        );
        expect(result.before.width).toBe(beforeView.width);
        expect(result.before.height).toBe(beforeView.height);
        expect(result.after.width).toBeCloseTo(beforeView.width - margins.left - margins.right, 8);
        expect(result.after.height).toBeCloseTo(
          beforeView.height - margins.top - margins.bottom,
          8,
        );
        expect(result.annotationOffset.x).toBeCloseTo(-margins.left, 8);
        expect(result.annotationOffset.y).toBeCloseTo(-margins.top, 8);
        expect(afterPage.rotate).toBe(rotation);
        expect(afterPage.userUnit).toBe(unit);
        expect(afterDoc.numPages).toBe(beforeDoc.numPages);
        for (const [x, y] of [
          [0, 0],
          [50, 100],
          [beforeView.width, beforeView.height],
        ]) {
          const point = beforeView.convertToPdfPoint(x, y);
          const moved = afterView.convertToViewportPoint(...(point as [number, number]));
          expect(moved[0]).toBeCloseTo(x + result.annotationOffset.x, 8);
          expect(moved[1]).toBeCloseTo(y + result.annotationOffset.y, 8);
        }
        const renderedBefore = await render(beforeDoc),
          renderedAfter = await render(afterDoc);
        const expected = renderedBefore
          .getContext('2d')
          .getImageData(margins.left, margins.top, renderedAfter.width, renderedAfter.height).data;
        const actual = renderedAfter
          .getContext('2d')
          .getImageData(0, 0, renderedAfter.width, renderedAfter.height).data;
        // Cropping changes Skia's clipping origin and can slightly alter vector
        // edge antialiasing. Require unchanged geometry/content plus a tightly
        // bounded raster difference; a shifted or scaled shape exceeds this bound.
        let changedPixels = 0,
          maxDifference = 0,
          totalDifference = 0;
        for (let i = 0; i < actual.length; i += 4) {
          let changed = false;
          for (let channel = 0; channel < 4; channel++) {
            const difference = Math.abs(actual[i + channel] - expected[i + channel]);
            changed ||= difference !== 0;
            maxDifference = Math.max(maxDifference, difference);
            totalDifference += difference;
          }
          if (changed) changedPixels++;
        }
        expect(maxDifference).toBeLessThanOrEqual(64);
        expect(totalDifference / actual.length).toBeLessThan(0.1);
        expect(changedPixels / (actual.length / 4)).toBeLessThan(0.012);
        expect((await afterDoc.getPage(2)).view).toEqual((await beforeDoc.getPage(2)).view);
      } finally {
        await close(beforeDoc);
        await close(afterDoc);
      }
      const before = await PDFDocument.load(bytes),
        after = await PDFDocument.load(await result.blob.arrayBuffer());
      expect(streams(after.getPage(0))).toEqual(streams(before.getPage(0)));
      expect(streams(after.getPage(1))).toEqual(streams(before.getPage(1)));
      for (const key of [
        'MediaBox',
        'Rotate',
        'UserUnit',
        'BleedBox',
        'TrimBox',
        'ArtBox',
        'Annots',
      ])
        expect(after.getPage(0).node.get(n(key))?.toString()).toBe(
          before.getPage(0).node.get(n(key))?.toString(),
        );
      expect(await original.arrayBuffer()).toEqual(bytes);
    },
  );
  it.each([0, 90, 180, 270])(
    'reset reveals the full normalized MediaBox and preserves annotation PDF positions at rotation %i',
    async (rotation) => {
      const source = await fixture(rotation, 2);
      const cropped = await applyPageCrop(source, 0, { kind: 'margins', margins });
      const reset = await applyPageCrop(cropped.blob, 0, { kind: 'reset' });
      expect(reset.after.cropBox).toEqual(reset.before.mediaBox);
      expect(reset.after.visibleBox).toEqual(reset.before.mediaBox);
      const previous = await open(cropped.blob),
        current = await open(reset.blob);
      try {
        const a = (await previous.getPage(1)).getViewport({ scale: 1 }),
          b = (await current.getPage(1)).getViewport({ scale: 1 });
        for (const point of [
          [-25, -10],
          [30, 40],
        ]) {
          const pdfPoint = a.convertToPdfPoint(...(point as [number, number]));
          const projected = b.convertToViewportPoint(...(pdfPoint as [number, number]));
          expect(projected[0]).toBeCloseTo(point[0] + reset.annotationOffset.x, 8);
          expect(projected[1]).toBeCloseTo(point[1] + reset.annotationOffset.y, 8);
        }
        expect((await current.getPage(1)).view).toEqual([-40, 60, 320, 540]);
      } finally {
        await close(previous);
        await close(current);
      }
      const second = await applyPageCrop(reset.blob, 0, { kind: 'reset' });
      expect(second.changed).toBe(false);
      expect(second.blob).toBe(reset.blob);
    },
  );
  it('supports fractional physical-point margins and the exact minimum visible size', async () => {
    const source = await fixture(270, 0.5);
    const request = {
      kind: 'margins',
      margins: { top: 1.25, right: 1.5, bottom: 0.75, left: 2.25 },
    } as const;
    const result = await applyPageCrop(source, 0, request);
    expect(result.after.width).toBeCloseTo(result.before.width - 3.75, 8);
    expect(result.after.height).toBeCloseTo(result.before.height - 2, 8);
    expect(result.annotationOffset).toEqual({ x: -2.25, y: -1.25 });
    const onePoint = await applyPageCrop(source, 0, {
      kind: 'margins',
      margins: { top: 0, bottom: 0, left: 0, right: result.before.width - 1 },
    });
    expect(onePoint.after.width).toBe(1);
  });
  it('retains all fillable values, widget bindings/coordinates and appearance bytes, even when crop hides them', async () => {
    const original = await fixture(0, 1, true),
      before = await PDFDocument.load(await original.arrayBuffer());
    const result = await applyPageCrop(original, 0, {
      kind: 'margins',
      margins: { top: 300, right: 0, bottom: 0, left: 0 },
    });
    const after = await PDFDocument.load(await result.blob.arrayBuffer());
    expect(after.getForm().getTextField('Response').getText()).toBe('Original response');
    expect(after.getForm().getCheckBox('Consent').isChecked()).toBe(true);
    const oldWidget = before.getForm().getTextField('Response').acroField.getWidgets()[0],
      newWidget = after.getForm().getTextField('Response').acroField.getWidgets()[0];
    expect(newWidget.getRectangle()).toEqual(oldWidget.getRectangle());
    expect(newWidget.dict.lookup(n('P'))).toBe(after.getPage(0).node);
    expect(normalAppearance(after)).toEqual(normalAppearance(before));
    const edited = await PDFDocument.load(
      await (
        await applyPdfFormChanges(result.blob, [{ name: 'Response', value: 'Still editable' }])
      ).arrayBuffer(),
    );
    expect(edited.getForm().getTextField('Response').getText()).toBe('Still editable');
  });
  it('normalizes inherited/reversed boxes and preserves a noncanonical Rotate entry', async () => {
    const pdf = await PDFDocument.create(),
      page = pdf.addPage([400, 600]);
    page.node.delete(n('MediaBox'));
    page.node.delete(n('Rotate'));
    const parent = page.node.Parent()!;
    parent.set(n('MediaBox'), pdf.context.obj([360, 640, -40, 40]));
    parent.set(n('CropBox'), pdf.context.obj([300, 580, 0, 80]));
    parent.set(n('Rotate'), PDFNumber.of(450));
    const source = await blobOf(pdf),
      info = await inspectPageCrop(source, 0),
      parsed = await open(source);
    try {
      expect(info.transform).toEqual((await parsed.getPage(1)).getViewport({ scale: 1 }).transform);
    } finally {
      await close(parsed);
    }
    expect(info.rotation).toBe(90);
    expect(info.mediaBox).toEqual({ x: -40, y: 40, width: 400, height: 600 });
    const result = await applyPageCrop(source, 0, { kind: 'margins', margins });
    const after = await PDFDocument.load(await result.blob.arrayBuffer());
    expect(after.getPage(0).getRotation().angle).toBe(450);
    expect(after.getPage(0).node.get(n('MediaBox'))).toBeUndefined();
  });
  it.each([
    [-90, 80, 360, 430],
    [900, 900, 50, 80],
  ])(
    'matches PDF.js effective box when original CropBox exceeds or misses MediaBox (%j)',
    async (x, y, width, height) => {
      const doc = await PDFDocument.load(await (await fixture()).arrayBuffer());
      doc.getPage(0).setCropBox(x, y, width, height);
      const source = await blobOf(doc),
        parsed = await open(source);
      try {
        expect((await inspectPageCrop(source, 0)).transform).toEqual(
          (await parsed.getPage(1)).getViewport({ scale: 1 }).transform,
        );
      } finally {
        await close(parsed);
      }
      const same = await applyPageCrop(source, 0, {
        kind: 'margins',
        margins: { top: 0, right: 0, bottom: 0, left: 0 },
      });
      expect(same.changed).toBe(false);
      expect(same.blob).toBe(source);
      const reset = await applyPageCrop(source, 0, { kind: 'reset' });
      expect(reset.after.cropBox).toEqual(reset.after.mediaBox);
    },
  );
  it.each([
    { kind: 'margins', margins: { ...margins, left: -1 } },
    { kind: 'margins', margins: { ...margins, left: NaN } },
    { kind: 'margins', margins: { ...margins, top: Infinity } },
    { kind: 'margins', margins: { ...margins, right: 280 } },
    { kind: 'margins', margins: { top: 370, right: 0, bottom: 0, left: 0 } },
    { kind: 'margins', margins: { ...margins, right: 259.5 } },
    { kind: 'margins', margins: null },
    { kind: 'margins' },
    { kind: 'resize' },
    null,
  ])('refuses invalid or empty crop requests without mutating bytes (%#)', async (request) => {
    const source = await fixture(),
      bytes = await source.arrayBuffer();
    await expect(applyPageCrop(source, 0, request as CropRequest)).rejects.toThrow(
      'The original PDF is unchanged.',
    );
    expect(await source.arrayBuffer()).toEqual(bytes);
  });
  it.each([-1, 0.5, 2, NaN, Infinity])('refuses unavailable page index %s', async (index) => {
    await expect(inspectPageCrop(await fixture(), index)).rejects.toThrow(
      'The original PDF is unchanged.',
    );
  });
  it.each([
    ['CropBox', [0, 0, 0, 10]],
    ['CropBox', [0, 0, 10]],
    ['MediaBox', [0, 0, 2_000_000, 10]],
    ['UserUnit', 0],
    ['UserUnit', -1],
    ['UserUnit', 75001],
    ['UserUnit', 0.00000001],
    ['Rotate', 45],
  ])('refuses unsupported source geometry %s %j', async (key, value) => {
    const pdf = await PDFDocument.load(await (await fixture()).arrayBuffer());
    pdf.getPage(0).node.set(n(key as string), pdf.context.obj(value));
    await expect(inspectPageCrop(await blobOf(pdf), 0)).rejects.toThrow(
      'The original PDF is unchanged.',
    );
  });
  it.each(['OpenAction', 'DocMDP', 'ByteRange', 'XFA'])(
    'retains existing safety refusal for %s documents',
    async (key) => {
      const pdf = await PDFDocument.load(await (await fixture()).arrayBuffer());
      pdf.catalog.set(n(key), PDFString.of('synthetic guarded entry'));
      const source = await blobOf(pdf),
        bytes = await source.arrayBuffer();
      await expect(inspectPageCrop(source, 0)).rejects.toThrow(/cannot be edited/);
      await expect(applyPageCrop(source, 0, { kind: 'reset' })).rejects.toThrow(/cannot be edited/);
      expect(await source.arrayBuffer()).toEqual(bytes);
    },
  );
});
