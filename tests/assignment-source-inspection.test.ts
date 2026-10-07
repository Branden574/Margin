import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const pdfjs = vi.hoisted(() => ({
  getDocument: vi.fn(),
  createWorker: vi.fn(),
  sharedEditorWorker: { terminate: vi.fn() },
}));
vi.mock('pdfjs-dist', () => ({
  getDocument: pdfjs.getDocument,
  PDFWorker: class {
    static create = pdfjs.createWorker;
  },
  GlobalWorkerOptions: { workerPort: pdfjs.sharedEditorWorker },
}));
import { inspectAssignmentSource } from '../apps/web/src/lib/assignment-work/sourceInspection';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const nativeWorkers: Array<{ terminate: ReturnType<typeof vi.fn> }> = [];
let wrapped: { destroy: ReturnType<typeof vi.fn> };
let task: { promise: Promise<unknown>; destroy: ReturnType<typeof vi.fn> };
let page: { getViewport: ReturnType<typeof vi.fn>; cleanup: ReturnType<typeof vi.fn> };
const blob = () =>
  new Blob(['%PDF-1.7\nSynthetic parser lifecycle fixture'], { type: 'application/pdf' });
const taskStarted = () => vi.waitFor(() => expect(pdfjs.getDocument).toHaveBeenCalledTimes(1));

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  nativeWorkers.length = 0;
  vi.stubGlobal(
    'Worker',
    class {
      terminate = vi.fn();
      constructor() {
        nativeWorkers.push(this);
      }
    },
  );
  wrapped = { destroy: vi.fn() };
  pdfjs.createWorker.mockImplementation(() => wrapped);
  page = { getViewport: vi.fn(() => ({ width: 612, height: 792 })), cleanup: vi.fn() };
  task = {
    promise: Promise.resolve({ numPages: 1, getPage: async () => page }),
    destroy: vi.fn(async () => {}),
  };
  pdfjs.getDocument.mockImplementation(() => task);
});
afterEach(() => {
  expect(pdfjs.sharedEditorWorker.terminate).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('Dedicated assignment PDF parser lifecycle', () => {
  it('awaits delayed graceful cleanup and terminates only its explicitly owned worker', async () => {
    const cleanup = deferred<void>();
    task.destroy.mockImplementation(() => cleanup.promise);
    let settled = false;
    const work = inspectAssignmentSource(blob()).finally(() => {
      settled = true;
    });
    await taskStarted();
    await vi.waitFor(() => expect(task.destroy).toHaveBeenCalledTimes(1));
    expect(settled).toBe(false);
    expect(pdfjs.createWorker).toHaveBeenCalledWith({ port: nativeWorkers[0] });
    expect(pdfjs.getDocument.mock.calls[0][0].worker).toBe(wrapped);
    expect(nativeWorkers[0].terminate).not.toHaveBeenCalled();
    cleanup.resolve();
    expect(await work).toMatchObject({ pages: [{ index: 0, width: 612, height: 792 }] });
    expect(nativeWorkers[0].terminate).toHaveBeenCalledTimes(1);
    expect(wrapped.destroy).toHaveBeenCalledTimes(1);
    expect(pdfjs.getDocument.mock.calls[0][0].data.every((value: number) => value === 0)).toBe(
      true,
    );
  });
  it('hard-terminates on cancellation even while page parsing and graceful teardown never settle', async () => {
    const pageWork = deferred<never>(),
      cleanup = deferred<void>(),
      controller = new AbortController();
    const getPage = vi.fn(() => pageWork.promise);
    task.promise = Promise.resolve({ numPages: 1, getPage });
    task.destroy.mockImplementation(() => cleanup.promise);
    const work = inspectAssignmentSource(blob(), controller.signal);
    const checked = expect(work).rejects.toMatchObject({ code: 'cancelled' });
    await vi.waitFor(() => expect(getPage).toHaveBeenCalledTimes(1));
    controller.abort();
    expect(nativeWorkers[0].terminate).toHaveBeenCalledTimes(1);
    await checked;
    expect(task.destroy).toHaveBeenCalledTimes(1);
    expect(wrapped.destroy).toHaveBeenCalledTimes(1);
    // Late teardown failure is observed, without keeping the native worker alive.
    cleanup.reject(new Error('Synthetic late cleanup rejection'));
    await Promise.resolve();
  });
  it('terminates a stalled loading/setup task at the parser deadline', async () => {
    task.promise = new Promise(() => {});
    task.destroy.mockImplementation(() => new Promise(() => {}));
    const work = inspectAssignmentSource(blob());
    const checked = expect(work).rejects.toMatchObject({ code: 'timeout' });
    await taskStarted();
    await vi.advanceTimersByTimeAsync(45_000);
    await checked;
    expect(nativeWorkers[0].terminate).toHaveBeenCalledTimes(1);
    expect(wrapped.destroy).toHaveBeenCalledTimes(1);
    expect(task.destroy).toHaveBeenCalledTimes(1);
  });
  it('bounds unacknowledged cleanup after successful parsing and releases the worker', async () => {
    task.destroy.mockImplementation(() => new Promise(() => {}));
    let settled = false;
    const work = inspectAssignmentSource(blob()).finally(() => {
      settled = true;
    });
    await vi.waitFor(() => expect(task.destroy).toHaveBeenCalledTimes(1));
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await work).toMatchObject({ pages: [{ index: 0, width: 612, height: 792 }] });
    expect(nativeWorkers[0].terminate).toHaveBeenCalledTimes(1);
    expect(wrapped.destroy).toHaveBeenCalledTimes(1);
  });
  it('terminates the native worker if the PDF.js wrapper fails during construction', async () => {
    pdfjs.createWorker.mockImplementation(() => {
      throw new Error('Synthetic wrapper failure');
    });
    await expect(inspectAssignmentSource(blob())).rejects.toThrow('Synthetic wrapper failure');
    expect(nativeWorkers[0].terminate).toHaveBeenCalledTimes(1);
    expect(pdfjs.getDocument).not.toHaveBeenCalled();
  });
  it('does not fall back to parsing on the browser main thread when workers are unavailable', async () => {
    vi.stubGlobal('Worker', undefined);
    vi.stubGlobal('window', {});
    await expect(inspectAssignmentSource(blob())).rejects.toMatchObject({
      code: 'worker_unavailable',
    });
    expect(pdfjs.getDocument).not.toHaveBeenCalled();
    expect(nativeWorkers).toHaveLength(0);
  });
});
