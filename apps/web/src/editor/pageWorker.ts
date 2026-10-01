import type { PageAction } from './model';
import type { Annotation } from '@margin/core';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import type { ExportPageView } from './pdf';
/** A short-lived worker keeps parsing, edits and PDF encoding off the UI thread. */
function runWorker(message: unknown): Promise<{ blob: Blob; pageCount?: number }> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./pdfOperations.worker.ts', import.meta.url), {
      type: 'module',
    });
    worker.onmessage = (
      event: MessageEvent<{ blob?: Blob; error?: string; pageCount?: number }>,
    ) => {
      worker.terminate();
      if (event.data.blob) resolve({ blob: event.data.blob, pageCount: event.data.pageCount });
      else
        reject(new Error(event.data.error ?? 'The document worker did not return an updated PDF.'));
    };
    worker.onerror = (event) => {
      worker.terminate();
      reject(
        new Error(event.message || 'The document worker stopped. Your original file is unchanged.'),
      );
    };
    worker.postMessage(message);
  });
}
export async function transformPageInWorker(blob: Blob, action: PageAction, index: number) {
  return (await runWorker({ operation: 'transform', blob, action, index })).blob;
}
export async function exportPdfInWorker(
  blob: Blob,
  annotations: Annotation[],
  pdf: PDFDocumentProxy,
  extractIndex?: number,
) {
  const items =
    extractIndex === undefined
      ? annotations
      : annotations.filter((a) => a.pageIndex === extractIndex);
  const views: ExportPageView[] = [];
  for (const index of new Set(items.map((a) => a.pageIndex))) {
    const page = await pdf.getPage(index + 1);
    views.push({ pageIndex: index, transform: page.getViewport({ scale: 1 }).transform });
  }
  return (
    await runWorker({
      operation: 'export',
      blob,
      annotations: items,
      views,
      extractIndex,
      originalPageCount: pdf.numPages,
    })
  ).blob;
}
export async function mergePdfInWorker(blob: Blob, incoming: Blob) {
  const result = await runWorker({ operation: 'merge', blob, incoming });
  return { blob: result.blob, pageCount: result.pageCount! };
}
