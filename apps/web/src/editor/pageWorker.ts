import type { PdfFormChange, PdfFormInspection } from './formTypes';
import type { PageAction } from './model';
import { removeNativeOcrOverlap } from './ocrExportNative';
import { PermissionFlag } from 'pdfjs-dist';
import type { Annotation, OcrPageRecord } from '@margin/core';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import type { ExportPageView } from './pdf';
/** A short-lived worker keeps parsing, edits and PDF encoding off the UI thread. */
function runWorker<T>(
  message: unknown,
  property: 'blob' | 'form' = 'blob',
  signal?: AbortSignal,
): Promise<T> {
  if (signal?.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./pdfOperations.worker.ts', import.meta.url), {
      type: 'module',
    });
    const finish = () => {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', abort);
      worker.terminate();
    };
    const abort = () => {
      finish();
      reject(signal?.reason ?? new DOMException('Export cancelled.', 'AbortError'));
    };
    signal?.addEventListener('abort', abort, { once: true });
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
  ocrRecords: readonly OcrPageRecord[] = [],
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  let rejectAbort!: (error: unknown) => void;
  const interrupted = new Promise<never>((_, reject) => {
    rejectAbort = reject;
  });
  const abort = () =>
    rejectAbort(signal?.reason ?? new DOMException('Export cancelled.', 'AbortError'));
  signal?.addEventListener('abort', abort, { once: true });
  const work = async () => {
    signal?.throwIfAborted();
    const ocr: OcrPageRecord[] = [];
    if (ocrRecords.length) {
      const permissions = await pdf.getPermissions();
      signal?.throwIfAborted();
      if (
        permissions !== null &&
        (!permissions.has(PermissionFlag.COPY) || !permissions.has(PermissionFlag.MODIFY_CONTENTS))
      )
        throw new Error(
          'This PDF does not allow copying and modifying its text. Searchable export is unavailable.',
        );
      for (const record of ocrRecords) {
        if (extractIndex !== undefined && record.pageIndex !== extractIndex)
          throw new Error('The recognized text does not match the selected export page.');
        const filtered = await removeNativeOcrOverlap(pdf, record, signal);
        if (filtered) ocr.push(filtered);
      }
    }
    const items =
      extractIndex === undefined
        ? annotations
        : annotations.filter((a) => a.pageIndex === extractIndex);
    const views: ExportPageView[] = [];
    for (const index of new Set(items.map((a) => a.pageIndex))) {
      signal?.throwIfAborted();
      const page = await pdf.getPage(index + 1);
      signal?.throwIfAborted();
      views.push({ pageIndex: index, transform: page.getViewport({ scale: 1 }).transform });
    }
    return (
      await runWorker<{ blob: Blob }>(
        {
          operation: 'export',
          ocr,
          blob,
          annotations: items,
          views,
          extractIndex,
          originalPageCount: pdf.numPages,
        },
        'blob',
        signal,
      )
    ).blob;
  };
  try {
    return await Promise.race([work(), interrupted]);
  } finally {
    signal?.removeEventListener('abort', abort);
  }
}

export async function mergePdfInWorker(blob: Blob, incoming: Blob) {
  const result = await runWorker<{ blob: Blob; pageCount: number }>({
    operation: 'merge',
    blob,
    incoming,
  });
  return { blob: result.blob, pageCount: result.pageCount! };
}
