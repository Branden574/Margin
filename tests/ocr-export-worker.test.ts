import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import type { OcrPageRecord } from '@margin/core';
vi.mock('pdfjs-dist', () => ({ PermissionFlag: { COPY: 16, MODIFY_CONTENTS: 8 } }));
vi.mock('../apps/web/src/editor/ocrExportNative', () => ({
  removeNativeOcrOverlap: vi.fn(async (_pdf, record) => record),
}));
import { exportPdfInWorker } from '../apps/web/src/editor/pageWorker';
import { removeNativeOcrOverlap } from '../apps/web/src/editor/ocrExportNative';
const source = new Blob(['synthetic']);
const record = { pageIndex: 2 } as OcrPageRecord;
const workers: FakeWorker[] = [];
class FakeWorker {
  onmessage?: (event: { data: unknown }) => void;
  onerror?: (event: { message: string }) => void;
  postMessage = vi.fn();
  terminate = vi.fn();
  constructor() {
    workers.push(this);
  }
}
function pdf(permissions: Set<number> | null = null) {
  return {
    numPages: 3,
    getPermissions: vi.fn(async () => permissions),
    getPage: vi.fn(),
  } as unknown as PDFDocumentProxy;
}
async function untilWorker() {
  for (let i = 0; i < 10 && !workers.length; i++) await Promise.resolve();
  expect(workers).toHaveLength(1);
  return workers[0];
}
afterEach(() => {
  workers.length = 0;
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  vi.useRealTimers();
});
describe('searchable export worker lifecycle', () => {
  it.each([new Set(), new Set([16]), new Set([8]), new Set([512, 8])])(
    'does not embed OCR without both copying and content-modification rights',
    async (permissions) => {
      vi.stubGlobal('Worker', FakeWorker);
      await expect(
        exportPdfInWorker(source, [], pdf(permissions), undefined, [record]),
      ).rejects.toThrow('does not allow');
      expect(workers).toHaveLength(0);
      expect(removeNativeOcrOverlap).not.toHaveBeenCalled();
    },
  );
  it('sends filtered OCR and original page indices to the isolated worker', async () => {
    vi.stubGlobal('Worker', FakeWorker);
    const result = exportPdfInWorker(source, [], pdf(new Set([16, 8])), 2, [record]);
    const worker = await untilWorker();
    expect(worker.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: 'export',
        ocr: [record],
        extractIndex: 2,
        originalPageCount: 3,
      }),
    );
    worker.onmessage!({ data: { blob: source } });
    expect(await result).toBe(source);
    expect(worker.terminate).toHaveBeenCalledOnce();
  });
  it('refuses OCR for a different selected page', async () => {
    vi.stubGlobal('Worker', FakeWorker);
    await expect(exportPdfInWorker(source, [], pdf(), 0, [record])).rejects.toThrow('selected');
    expect(workers).toHaveLength(0);
  });
  it('terminates an active worker on vault-lock cancellation', async () => {
    vi.stubGlobal('Worker', FakeWorker);
    const controller = new AbortController();
    const result = exportPdfInWorker(source, [], pdf(), undefined, [], controller.signal);
    const rejection = expect(result).rejects.toMatchObject({ name: 'AbortError' });
    const worker = await untilWorker();
    controller.abort();
    await rejection;
    expect(worker.terminate).toHaveBeenCalledOnce();
  });
  it('cancels a stalled permission request without starting a worker when it later settles', async () => {
    vi.stubGlobal('Worker', FakeWorker);
    let resolve!: (value: null) => void;
    const sourcePdf = pdf();
    sourcePdf.getPermissions = () =>
      new Promise((r) => {
        resolve = r;
      });
    const controller = new AbortController();
    const result = exportPdfInWorker(source, [], sourcePdf, undefined, [record], controller.signal);
    controller.abort();
    await expect(result).rejects.toMatchObject({ name: 'AbortError' });
    resolve(null);
    await Promise.resolve();
    await Promise.resolve();
    expect(workers).toHaveLength(0);
  });
  it('bounds a worker that never replies and terminates it', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('Worker', FakeWorker);
    const result = exportPdfInWorker(source, [], pdf());
    const rejection = expect(result).rejects.toThrow('60 seconds');
    const worker = await untilWorker();
    await vi.advanceTimersByTimeAsync(60_000);
    await rejection;
    expect(worker.terminate).toHaveBeenCalledOnce();
  });
});
