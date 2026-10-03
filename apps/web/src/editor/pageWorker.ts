import type { PdfFormChange, PdfFormInspection } from './formTypes';
import type { PageAction } from './model';
import type { Annotation } from '@margin/core';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import type { ExportPageView } from './pdf';
/** A short-lived worker keeps parsing, edits and PDF encoding off the UI thread. */
function runWorker<T>(message: unknown, property: 'blob' | 'form' = 'blob'): Promise<T> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./pdfOperations.worker.ts', import.meta.url), {
      type: 'module',
    });
    const finish = () => {
      clearTimeout(timeout);
      worker.terminate();
    };
    const timeout = setTimeout(() => {
      finish();
      reject(
        new Error('The document operation exceeded 60 seconds. Your original PDF is unchanged.'),
      );
    }, 60_000);
    worker.onmessage = (
      event: MessageEvent<{ blob?: Blob; form?: PdfFormInspection; error?: string }>,
    ) => {
      finish();
      if (event.data[property]) resolve(event.data as T);
      else reject(new Error(event.data.error ?? 'The document worker did not return a result.'));
    };
    worker.onerror = (event) => {
      finish();
      reject(
        new Error(event.message || 'The document worker stopped. Your original file is unchanged.'),
      );
    };
    try {
      worker.postMessage(message);
    } catch (error) {
      finish();
      reject(error);
    }
  });
}
export async function inspectPdfFormInWorker(blob: Blob): Promise<PdfFormInspection> {
  return (await runWorker<{ form: PdfFormInspection }>({ operation: 'inspect-form', blob }, 'form'))
    .form;
}
export async function applyPdfFormInWorker(blob: Blob, changes: PdfFormChange[]): Promise<Blob> {
  return (await runWorker<{ blob: Blob }>({ operation: 'apply-form', blob, changes })).blob;
}
export async function transformPageInWorker(blob: Blob, action: PageAction, index: number) {
  return (await runWorker<{ blob: Blob }>({ operation: 'transform', blob, action, index })).blob;
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
    await runWorker<{ blob: Blob }>({
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
  const result = await runWorker<{ blob: Blob; pageCount: number }>({
    operation: 'merge',
    blob,
    incoming,
  });
  return { blob: result.blob, pageCount: result.pageCount! };
}
