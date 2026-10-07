import { getDocument, PDFWorker } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { RequestScope } from './transport';
import { MAX_SOURCE_BYTES } from './types';
import { repositoryError } from './mapping';

/** A dedicated parser worker; neither global editor workers nor their ports are borrowed. */
export async function inspectAssignmentSource(blob: Blob, signal?: AbortSignal) {
  if (
    !(blob instanceof Blob) ||
    blob.type !== 'application/pdf' ||
    blob.size < 8 ||
    blob.size > MAX_SOURCE_BYTES
  )
    return repositoryError('invalid_source', 'The assignment source is not a supported PDF.');
  const scope = new RequestScope(45_000, signal);
  let task: ReturnType<typeof getDocument> | undefined;
  let worker: PDFWorker | undefined;
  let nativeWorker: Worker | undefined;
  let bytes: Uint8Array<ArrayBuffer> | undefined;
  let result: { pages: { index: number; width: number; height: number }[]; sha256: string };
  let terminated = false;
  const terminate = () => {
    if (terminated || (!nativeWorker && !worker)) return;
    terminated = true;
    // PDFDocumentLoadingTask.destroy waits for worker setup/Terminate acknowledgement.
    // Keep the native handle so a stalled parser or startup handshake cannot prevent termination.
    try {
      nativeWorker?.terminate();
    } finally {
      worker?.destroy();
    }
  };
  scope.controller.signal.addEventListener('abort', terminate, { once: true });
  try {
    bytes = new Uint8Array(
      await scope.wait(blob.arrayBuffer(), (late) => new Uint8Array(late).fill(0)),
    );
    const hash = await scope.wait(crypto.subtle.digest('SHA-256', bytes));
    const sha256 = [...new Uint8Array(hash)].map((n) => n.toString(16).padStart(2, '0')).join('');
    scope.check();
    if (typeof Worker !== 'undefined') {
      nativeWorker = new Worker(workerUrl, { type: 'module' });
      worker = PDFWorker.create({ port: nativeWorker });
    } else if (import.meta.env.MODE === 'test' && typeof window === 'undefined') {
      // Node-only parser fixtures; never fall back to main-thread parsing in a browser.
      worker = new PDFWorker();
    } else {
      return repositoryError(
        'worker_unavailable',
        'A dedicated PDF worker is required to inspect this assignment.',
      );
    }
    scope.check();
    task = getDocument({
      data: bytes,
      worker,
      useSystemFonts: false,
      disableFontFace: true,
      disableAutoFetch: true,
      disableStream: true,
      stopAtErrors: true,
    });
    const pdf = await scope.wait(task.promise);
    if (pdf.numPages < 1 || pdf.numPages > 2000)
      return repositoryError('invalid_source', 'The PDF page count is unsupported.');
    const pages: { index: number; width: number; height: number }[] = [];
    for (let index = 0; index < pdf.numPages; index++) {
      const page = await scope.wait(pdf.getPage(index + 1));
      const viewport = page.getViewport({ scale: 1 });
      if (
        ![viewport.width, viewport.height].every((n) => Number.isFinite(n) && n > 0 && n <= 100_000)
      )
        return repositoryError('invalid_source', 'The PDF has unsupported page dimensions.');
      pages.push({ index, width: viewport.width, height: viewport.height });
      page.cleanup();
    }
    scope.check();
    result = { pages, sha256 };
  } finally {
    const cleanup = new RequestScope(1_000, scope.controller.signal);
    try {
      if (task) await cleanup.wait(task.destroy());
    } catch {
      // Graceful teardown is best effort; the owned native worker is always stopped below.
      // RequestScope observes late rejections even when teardown never acknowledges completion.
    } finally {
      cleanup.close();
      try {
        terminate();
      } finally {
        scope.controller.signal.removeEventListener('abort', terminate);
        scope.close();
        if (bytes?.byteLength) bytes.fill(0);
      }
    }
  }
  scope.check();
  return result;
}
