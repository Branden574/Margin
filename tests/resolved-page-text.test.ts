import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PDFDocumentProxy } from 'pdfjs-dist';
vi.mock('../apps/web/src/editor/pageText', () => ({ readPageText: vi.fn() }));
vi.mock('../apps/web/src/lib/storage', () => ({ getPageOcr: vi.fn() }));
import { readPageText } from '../apps/web/src/editor/pageText';
import { getPageOcr } from '../apps/web/src/lib/storage';
import { resolvePageText } from '../apps/web/src/editor/resolvedPageText';
const pdf = {} as PDFDocumentProxy,
  document = { documentId: 'doc', contentRevision: 'revision' };
afterEach(() => vi.resetAllMocks());
describe('shared reading and search OCR resolution', () => {
  it('loads only the matching document revision and preserves copy restrictions', async () => {
    vi.mocked(readPageText).mockResolvedValue({ text: '', canCopy: false });
    vi.mocked(getPageOcr).mockResolvedValue({ text: 'Recognized passage' } as never);
    expect(await resolvePageText(pdf, 3, {}, document)).toEqual({
      text: 'Recognized passage',
      canCopy: false,
      source: 'ocr',
    });
    expect(getPageOcr).toHaveBeenCalledWith('doc', 'revision', 3);
  });
  it('does not read stored text when PDF permission/extraction validation fails', async () => {
    vi.mocked(readPageText).mockRejectedValue(new Error('restricted'));
    await expect(resolvePageText(pdf, 0, {}, document)).rejects.toThrow('restricted');
    expect(getPageOcr).not.toHaveBeenCalled();
  });
  it('uses native text when OCR is missing or revision is not established', async () => {
    vi.mocked(readPageText).mockResolvedValue({ text: 'Original text', canCopy: true });
    vi.mocked(getPageOcr).mockResolvedValue(undefined);
    expect(await resolvePageText(pdf, 0, {}, document)).toEqual({
      text: 'Original text',
      canCopy: true,
      source: 'pdf',
    });
    vi.mocked(getPageOcr).mockClear();
    await resolvePageText(pdf, 0, {}, { ...document, contentRevision: '' });
    expect(getPageOcr).not.toHaveBeenCalled();
  });
  it('discards OCR that finishes reading after a page change aborts extraction', async () => {
    vi.mocked(readPageText).mockResolvedValue({ text: '', canCopy: true });
    const controller = new AbortController();
    vi.mocked(getPageOcr).mockImplementation(async () => {
      controller.abort();
      return { text: 'stale' } as never;
    });
    await expect(
      resolvePageText(pdf, 0, { signal: controller.signal }, document),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });
});
