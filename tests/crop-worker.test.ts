import { afterEach, describe, expect, it, vi } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import type { CropPageInfo, CropRequest, CropResult } from '../apps/web/src/editor/cropTypes';
vi.mock('pdfjs-dist', () => ({
  PermissionFlag: { COPY: 16, MODIFY_CONTENTS: 8, COPY_FOR_ACCESSIBILITY: 512 },
}));
import { inspectPageCropInWorker, applyPageCropInWorker } from '../apps/web/src/editor/pageWorker';

const source = new Blob(['synthetic']);
const info: CropPageInfo = {
  pageIndex: 2,
  pageCount: 3,
  rotation: 90,
  userUnit: 2,
  mediaBox: { x: 20, y: 30, width: 400, height: 500 },
  cropBox: { x: 20, y: 30, width: 400, height: 500 },
  visibleBox: { x: 20, y: 30, width: 400, height: 500 },
  width: 1000,
  height: 800,
  transform: [0, 2, 2, 0, -60, -40],
};
const request: CropRequest = {
  kind: 'margins',
  margins: { top: 20, right: 30, bottom: 40, left: 50 },
};
const workers: FakeWorker[] = [];
class FakeWorker {
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: { message: string }) => void) | null = null;
  onmessageerror: (() => void) | null = null;
  postMessage = vi.fn();
  terminate = vi.fn();
  constructor(
    public url: URL,
    public options: WorkerOptions,
  ) {
    workers.push(this);
  }
}
afterEach(() => {
  workers.length = 0;
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe('crop worker lifecycle and transport', () => {
  it('returns typed inspection geometry and terminates without starting a font fetch', async () => {
    vi.stubGlobal('Worker', FakeWorker);
    const pending = inspectPageCropInWorker(source, 2),
      worker = workers[0];
    expect(worker.options).toEqual({ type: 'module' });
    expect(worker.url.pathname).toMatch(/pdfOperations\.worker\.ts$/);
    expect(worker.postMessage).toHaveBeenCalledWith({
      operation: 'inspect-crop',
      blob: source,
      index: 2,
    });
    worker.onmessage!({ data: { crop: info } });
    expect(await pending).toBe(info);
    expect(worker.terminate).toHaveBeenCalledOnce();
  });
  it.each([true, false])(
    'returns the complete crop result including no-op changed=%s',
    async (changed) => {
      vi.stubGlobal('Worker', FakeWorker);
      const pending = applyPageCropInWorker(source, 2, request),
        worker = workers[0];
      expect(worker.postMessage).toHaveBeenCalledWith({
        operation: 'apply-crop',
        blob: source,
        index: 2,
        request,
      });
      const result: CropResult = {
        blob: source,
        before: info,
        after: info,
        annotationOffset: { x: changed ? -50 : 0, y: changed ? -20 : 0 },
        changed,
      };
      worker.onmessage!({ data: { crop: result } });
      expect(await pending).toBe(result);
      expect(worker.terminate).toHaveBeenCalledOnce();
    },
  );
  it.each(['inspect', 'apply'] as const)(
    'does not allocate a worker for pre-cancelled %s',
    async (operation) => {
      vi.stubGlobal('Worker', FakeWorker);
      const controller = new AbortController();
      controller.abort();
      await expect(
        operation === 'inspect'
          ? inspectPageCropInWorker(source, 2, controller.signal)
          : applyPageCropInWorker(source, 2, request, controller.signal),
      ).rejects.toMatchObject({ name: 'AbortError' });
      expect(workers).toHaveLength(0);
    },
  );
  it.each(['inspect', 'apply'] as const)(
    'terminates active %s and ignores queued callbacks after cancellation',
    async (operation) => {
      vi.useFakeTimers();
      vi.stubGlobal('Worker', FakeWorker);
      const controller = new AbortController();
      const pending =
        operation === 'inspect'
          ? inspectPageCropInWorker(source, 2, controller.signal)
          : applyPageCropInWorker(source, 2, request, controller.signal);
      const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
      const worker = workers[0],
        message = worker.onmessage!,
        error = worker.onerror!;
      controller.abort();
      message({ data: { crop: info } });
      error({ message: 'late failure' });
      await rejected;
      await vi.advanceTimersByTimeAsync(60_001);
      expect(worker.terminate).toHaveBeenCalledOnce();
      expect(worker.onmessage).toBeNull();
    },
  );
  it('terminates inspection at its deadline and releases the abort subscription', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('Worker', FakeWorker);
    const controller = new AbortController();
    const pending = inspectPageCropInWorker(source, 2, controller.signal),
      rejected = expect(pending).rejects.toThrow('60 seconds');
    await vi.advanceTimersByTimeAsync(60_000);
    await rejected;
    controller.abort();
    expect(workers[0].terminate).toHaveBeenCalledOnce();
  });
  it.each(['error', 'messageerror', 'missing-result', 'null-result', 'worker-error'] as const)(
    'rejects %s without leaving a worker alive',
    async (kind) => {
      vi.stubGlobal('Worker', FakeWorker);
      const pending = applyPageCropInWorker(source, 2, request),
        rejected = expect(pending).rejects.toThrow();
      const worker = workers[0];
      if (kind === 'error') worker.onerror!({ message: 'synthetic failure' });
      else if (kind === 'messageerror') worker.onmessageerror!();
      else
        worker.onmessage!({
          data:
            kind === 'worker-error'
              ? { error: 'original unchanged' }
              : kind === 'null-result'
                ? null
                : { blob: source },
        });
      await rejected;
      expect(worker.terminate).toHaveBeenCalledOnce();
    },
  );
  it('terminates when request serialization fails before the worker can receive a PDF', async () => {
    class BrokenWorker extends FakeWorker {
      postMessage = vi.fn(() => {
        throw new DOMException('Synthetic clone failure', 'DataCloneError');
      });
    }
    vi.stubGlobal('Worker', BrokenWorker);
    await expect(inspectPageCropInWorker(source, 2)).rejects.toMatchObject({
      name: 'DataCloneError',
    });
    expect(workers[0].terminate).toHaveBeenCalledOnce();
  });
  it('dispatches actual inspect/apply handlers to the PDF core with no network request', async () => {
    const messages: unknown[] = [];
    const scope = {
      onmessage: null as ((event: MessageEvent) => Promise<void>) | null,
      postMessage: (message: unknown) => messages.push(message),
    };
    vi.stubGlobal('self', scope);
    const fetch = vi.fn(() => {
      throw new Error('Crop must not fetch assets');
    });
    vi.stubGlobal('fetch', fetch);
    await import('../apps/web/src/editor/pdfOperations.worker');
    const pdf = await PDFDocument.create();
    pdf.addPage([400, 600]);
    const blob = new Blob([(await pdf.save()) as BlobPart], { type: 'application/pdf' });
    await scope.onmessage!({ data: { operation: 'inspect-crop', blob, index: 0 } } as MessageEvent);
    expect(messages[0]).toMatchObject({ crop: { pageIndex: 0, width: 400, height: 600 } });
    await scope.onmessage!({
      data: { operation: 'apply-crop', blob, index: 0, request },
    } as MessageEvent);
    const result = (messages[1] as { crop: CropResult }).crop;
    expect(result.after.width).toBe(320);
    expect(result.after.height).toBe(540);
    expect(result.annotationOffset).toEqual({ x: -50, y: -20 });
    expect(result.blob).toBeInstanceOf(Blob);
    await scope.onmessage!({
      data: {
        operation: 'apply-crop',
        blob,
        index: 0,
        request: { kind: 'margins', margins: { top: 600, right: 0, bottom: 0, left: 0 } },
      },
    } as MessageEvent);
    expect(messages[2]).toMatchObject({
      error: expect.stringContaining('original PDF is unchanged'),
    });
    expect(fetch).not.toHaveBeenCalled();
  });
});
