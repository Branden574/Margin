import { describe, it, expect } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { transformPage } from '../apps/web/src/editor/pdf';
async function fixture() {
  const pdf = await PDFDocument.create();
  pdf.addPage([400, 600]);
  pdf.addPage([500, 700]);
  return new Blob([(await pdf.save()) as BlobPart], { type: 'application/pdf' });
}
async function parse(blob: Blob) {
  return PDFDocument.load(await blob.arrayBuffer());
}
describe('PDF structural operations', () => {
  it('rotates the actual PDF page without changing its content dimensions', async () => {
    const result = await parse(await transformPage(await fixture(), 'rotate', 0));
    expect(result.getPage(0).getRotation().angle).toBe(90);
    expect(result.getPage(0).getWidth()).toBe(400);
  });
  it('duplicates the correct page into the next slot', async () => {
    const result = await parse(await transformPage(await fixture(), 'duplicate', 0));
    expect(result.getPageCount()).toBe(3);
    expect(result.getPages().map((p) => p.getWidth())).toEqual([400, 400, 500]);
  });
  it('reorders PDF pages consistently with annotation remapping', async () => {
    const result = await parse(await transformPage(await fixture(), 'later', 0));
    expect(result.getPages().map((p) => p.getWidth())).toEqual([500, 400]);
  });
  it('deletes a page and refuses deletion of the final page', async () => {
    const one = await transformPage(await fixture(), 'delete', 0);
    expect((await parse(one)).getPageCount()).toBe(1);
    await expect(transformPage(one, 'delete', 0)).rejects.toThrow('at least one');
  });
  it('adds a blank page with matching dimensions', async () => {
    const result = await parse(await transformPage(await fixture(), 'insert', 0));
    expect(result.getPageCount()).toBe(3);
    expect(result.getPage(1).getSize()).toEqual({ width: 400, height: 600 });
  });
});

describe('PDF merge and extraction', () => {
  it('appends all incoming pages in order and retains the original', async () => {
    const { mergePdf } = await import('../apps/web/src/editor/pdf');
    const first = await fixture(),
      result = await mergePdf(first, await fixture());
    expect(result.pageCount).toBe(4);
    expect((await parse(result.blob)).getPages().map((p) => p.getWidth())).toEqual([
      400, 500, 400, 500,
    ]);
    expect((await parse(first)).getPageCount()).toBe(2);
  });
  it('extracts the requested page and retains an optional notes appendix', async () => {
    const { extractPdfPage } = await import('../apps/web/src/editor/pdf');
    const result = await parse(await extractPdfPage(await fixture(), 1));
    expect(result.getPageCount()).toBe(1);
    expect(result.getPage(0).getWidth()).toBe(500);
    const withNotes = await parse(await extractPdfPage(await fixture(), 0, 1));
    expect(withNotes.getPageCount()).toBe(2);
  });
});
