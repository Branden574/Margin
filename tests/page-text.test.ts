import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PDFDocumentProxy } from 'pdfjs-dist';
// These are the installed PDF.js PermissionFlag values; avoid loading its DOM renderer in Node tests.
vi.mock('pdfjs-dist', () => ({ PermissionFlag: { COPY: 16, COPY_FOR_ACCESSIBILITY: 512 } }));
import {
  readPageText,
  PAGE_TEXT_MAX_CHARACTERS,
  PAGE_TEXT_MAX_ITEMS,
  PAGE_TEXT_TIMEOUT_MS,
} from '../apps/web/src/editor/pageText';
const COPY = 16,
  ACCESSIBILITY = 512;
const item = (str: string, hasEOL = false) => ({ str, hasEOL });
function fixture(chunks: unknown[][], permissions: Set<number> | null = null) {
  const cancel = vi.fn();
  let index = 0;
  const streamTextContent = vi.fn(
    () =>
      new ReadableStream({
        pull(c) {
          if (index >= chunks.length) c.close();
          else c.enqueue({ items: chunks[index++], styles: {}, lang: 'en' });
        },
        cancel,
      }),
  );
  const cleanup = vi.fn(() => true);
  const page = { streamTextContent, cleanup };
  const getPage = vi.fn(async () => page),
    getPermissions = vi.fn(async () => permissions);
  const pdf = { numPages: 2, getPage, getPermissions } as unknown as PDFDocumentProxy;
  return { pdf, getPage, getPermissions, streamTextContent, cancel, cleanup };
}
afterEach(() => vi.useRealTimers());
describe('Bounded permission-aware PDF page text', () => {
  it('preserves exact displayed Unicode, line breaks and separators across streamed chunks', async () => {
    const f = fixture([
      [item('A😀')],
      [item('e\u0301', true), item('שלום'), { type: 'beginMarkedContent' }],
      [item('終', true)],
    ]);
    expect(await readPageText(f.pdf, 1)).toEqual({ text: 'A😀 e\u0301\nשלום 終\n', canCopy: true });
    expect(f.getPage).toHaveBeenCalledWith(2);
    expect(f.streamTextContent).toHaveBeenCalledWith({
      includeMarkedContent: false,
      disableNormalization: false,
    });
  });
  it('permits ordinary copying but returns accessibility-only text with copying disabled', async () => {
    expect(await readPageText(fixture([[item('copy')]], new Set([COPY])).pdf, 0)).toEqual({
      text: 'copy ',
      canCopy: true,
    });
    expect(
      await readPageText(fixture([[item('accessible')]], new Set([ACCESSIBILITY])).pdf, 0),
    ).toEqual({ text: 'accessible ', canCopy: false });
  });
  it('denies both restricted flags before page extraction starts', async () => {
    const f = fixture([[item('private')]], new Set());
    await expect(readPageText(f.pdf, 0)).rejects.toMatchObject({ code: 'permission_denied' });
    expect(f.getPage).not.toHaveBeenCalled();
    expect(f.streamTextContent).not.toHaveBeenCalled();
  });
  it('fails closed when permissions cannot be read', async () => {
    const f = fixture([[item('private')]]);
    f.getPermissions.mockRejectedValue(new Error('sensitive provider detail'));
    await expect(readPageText(f.pdf, 0)).rejects.toMatchObject({
      code: 'text_unavailable',
      message: 'Page text could not be read. Try another page or reopen the document.',
    });
    expect(f.getPage).not.toHaveBeenCalled();
  });
  it('allows the exact character bound and rejects an over-limit chunk without returning partial text', async () => {
    const exact = fixture([[item('x'.repeat(PAGE_TEXT_MAX_CHARACTERS - 1))]]);
    expect((await readPageText(exact.pdf, 0)).text.length).toBe(PAGE_TEXT_MAX_CHARACTERS);
    const excessive = fixture([
      [item('safe prefix')],
      [item('x'.repeat(PAGE_TEXT_MAX_CHARACTERS))],
      [item('not read')],
    ]);
    await expect(readPageText(excessive.pdf, 0)).rejects.toMatchObject({ code: 'text_limit' });
    expect(excessive.cancel).toHaveBeenCalledOnce();
  });
  it('bounds text fragments even when their strings are empty', async () => {
    const f = fixture([
      Array.from({ length: PAGE_TEXT_MAX_ITEMS + 1 }, () => item('')),
      [item('unread')],
    ]);
    await expect(readPageText(f.pdf, 0)).rejects.toMatchObject({ code: 'text_limit' });
    expect(f.cancel).toHaveBeenCalledOnce();
  });
  it('bounds empty producer chunks and yields so a ready producer cannot starve cancellation', async () => {
    const f = fixture(Array.from({ length: 102 }, () => []));
    await expect(readPageText(f.pdf, 0)).rejects.toMatchObject({ code: 'text_limit' });
    expect(f.cancel).toHaveBeenCalledOnce();
    const active = fixture(Array.from({ length: 2000 }, () => [item('x')])),
      controller = new AbortController();
    setTimeout(() => controller.abort(), 0);
    await expect(readPageText(active.pdf, 0, { signal: controller.signal })).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(active.cancel).toHaveBeenCalledOnce();
  });
  it('cancels a pending stream on page change and never returns already collected text', async () => {
    const f = fixture([]);
    let pulls = 0;
    const cancel = vi.fn();
    f.streamTextContent.mockImplementation(
      () =>
        new ReadableStream({
          pull(c) {
            if (pulls++ === 0) c.enqueue({ items: [item('old page')], styles: {}, lang: 'en' });
          },
          cancel,
        }),
    );
    const controller = new AbortController(),
      result = readPageText(f.pdf, 0, { signal: controller.signal });
    const rejected = expect(result).rejects.toMatchObject({ name: 'AbortError' });
    for (let i = 0; i < 8; i++) await Promise.resolve();
    controller.abort();
    await rejected;
    expect(cancel).toHaveBeenCalledOnce();
  });
  it('does not start a stream when an abandoned page request resolves later', async () => {
    const f = fixture([[item('late')]]);
    let resolve!: () => void;
    f.getPage.mockImplementation(
      () =>
        new Promise(
          (r) =>
            (resolve = () => r({ streamTextContent: f.streamTextContent, cleanup: f.cleanup })),
        ),
    );
    const controller = new AbortController(),
      pending = readPageText(f.pdf, 0, { signal: controller.signal });
    for (let i = 0; i < 4; i++) await Promise.resolve();
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    resolve();
    for (let i = 0; i < 4; i++) await Promise.resolve();
    expect(f.streamTextContent).not.toHaveBeenCalled();
  });
  it('rejects already aborted requests and invalid page indices without querying PDF content', async () => {
    const f = fixture([]),
      controller = new AbortController();
    controller.abort();
    await expect(readPageText(f.pdf, 0, { signal: controller.signal })).rejects.toMatchObject({
      name: 'AbortError',
    });
    for (const index of [-1, 2, NaN, 0.5])
      await expect(readPageText(f.pdf, index)).rejects.toMatchObject({ code: 'text_unavailable' });
    expect(f.getPermissions).not.toHaveBeenCalled();
  });
  it('times out a stalled stream and cancels it without partial output', async () => {
    vi.useFakeTimers();
    const f = fixture([]),
      cancel = vi.fn();
    f.streamTextContent.mockImplementation(
      () =>
        new ReadableStream({
          start(c) {
            c.enqueue({ items: [item('partial')], styles: {}, lang: 'en' });
          },
          cancel,
        }),
    );
    const result = readPageText(f.pdf, 0).then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
    await vi.advanceTimersByTimeAsync(PAGE_TEXT_TIMEOUT_MS + 1);
    expect(await result).toMatchObject({ error: { code: 'text_timeout' } });
    expect(cancel).toHaveBeenCalledOnce();
  });
  it('includes permissions lookup in the deadline and ignores late permission completion', async () => {
    vi.useFakeTimers();
    const f = fixture([]);
    let finish!: (p: Set<number> | null) => void;
    f.getPermissions.mockImplementation(() => new Promise((resolve) => (finish = resolve)));
    const result = readPageText(f.pdf, 0).then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
    await vi.advanceTimersByTimeAsync(PAGE_TEXT_TIMEOUT_MS + 1);
    expect(await result).toMatchObject({ error: { code: 'text_timeout' } });
    finish(null);
    await vi.advanceTimersByTimeAsync(1);
    expect(f.getPage).not.toHaveBeenCalled();
  });
  it('cleans acquired search pages once on success and permits PDF.js to defer active-render cleanup', async () => {
    const retained = fixture([[item('visible page')]]);
    await readPageText(retained.pdf, 0);
    expect(retained.cleanup).not.toHaveBeenCalled();
    const searched = fixture([[item('search page')]]);
    searched.cleanup.mockReturnValue(false);
    expect(await readPageText(searched.pdf, 0, { cleanup: true })).toEqual({
      text: 'search page ',
      canCopy: true,
    });
    expect(searched.cleanup).toHaveBeenCalledOnce();
  });
  it('cleans acquired search pages on extraction errors and cancellation', async () => {
    const error = fixture([]);
    error.streamTextContent.mockImplementation(() => {
      throw new Error('synthetic extraction failure');
    });
    await expect(readPageText(error.pdf, 0, { cleanup: true })).rejects.toMatchObject({
      code: 'text_unavailable',
    });
    expect(error.cleanup).toHaveBeenCalledOnce();
    const pending = fixture([]);
    pending.streamTextContent.mockImplementation(() => new ReadableStream({ pull() {} }));
    const controller = new AbortController();
    const result = readPageText(pending.pdf, 0, { cleanup: true, signal: controller.signal });
    for (let i = 0; i < 8; i++) await Promise.resolve();
    controller.abort();
    await expect(result).rejects.toMatchObject({ name: 'AbortError' });
    expect(pending.cleanup).toHaveBeenCalledOnce();
  });
  it('cleans a late acquired search page even if cancellation completed before getPage', async () => {
    const f = fixture([[item('late')]]);
    let finish!: () => void;
    f.getPage.mockImplementation(
      () =>
        new Promise(
          (resolve) =>
            (finish = () =>
              resolve({ streamTextContent: f.streamTextContent, cleanup: f.cleanup })),
        ),
    );
    const controller = new AbortController(),
      pending = readPageText(f.pdf, 0, { cleanup: true, signal: controller.signal });
    for (let i = 0; i < 4; i++) await Promise.resolve();
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(f.cleanup).not.toHaveBeenCalled();
    finish();
    for (let i = 0; i < 4; i++) await Promise.resolve();
    expect(f.cleanup).toHaveBeenCalledOnce();
    expect(f.streamTextContent).not.toHaveBeenCalled();
  });
  it('does not mask the reading result if cleanup fails for a destroyed page', async () => {
    const f = fixture([[item('complete')]]);
    f.cleanup.mockImplementation(() => {
      throw new Error('synthetic destroyed page');
    });
    expect(await readPageText(f.pdf, 0, { cleanup: true })).toEqual({
      text: 'complete ',
      canCopy: true,
    });
  });
  it('surfaces stream errors safely and distinguishes them from an empty page', async () => {
    expect(await readPageText(fixture([]).pdf, 0)).toEqual({ text: '', canCopy: true });
    const f = fixture([]);
    f.streamTextContent.mockImplementation(
      () =>
        new ReadableStream({
          start(c) {
            c.error(new Error('private malformed PDF text'));
          },
        }),
    );
    await expect(readPageText(f.pdf, 0)).rejects.toMatchObject({
      code: 'text_unavailable',
      message: 'Page text could not be read. Try another page or reopen the document.',
    });
  });
});
