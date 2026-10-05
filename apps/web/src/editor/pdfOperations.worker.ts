import {
  transformPage,
  exportAnnotatedPdf,
  mergePdf,
  extractPdfPage,
  type ExportPageView,
} from './pdf';
import { inspectPdfForm, applyPdfFormChanges } from './forms';
import type { PdfFormChange } from './formTypes';
import type { PageAction } from './model';
import { addOcrTextLayer } from './ocrPdfExport';
import ocrFontUrl from '../assets/fonts/NotoSans-Regular.ttf?url';
import type { Annotation, OcrPageRecord } from '@margin/core';
type Request =
  | { operation: 'transform'; blob: Blob; action: PageAction; index: number }
  | {
      operation: 'export';
      blob: Blob;
      annotations: Annotation[];
      ocr: OcrPageRecord[];
      views: ExportPageView[];
      extractIndex?: number;
      originalPageCount: number;
    }
  | { operation: 'merge'; blob: Blob; incoming: Blob }
  | { operation: 'inspect-form'; blob: Blob }
  | { operation: 'apply-form'; blob: Blob; changes: PdfFormChange[] };
self.onmessage = async (event: MessageEvent<Request>) => {
  try {
    const data = event.data;
    if (data.operation === 'transform') {
      self.postMessage({ blob: await transformPage(data.blob, data.action, data.index) });
      return;
    }
    if (data.operation === 'merge') {
      self.postMessage(await mergePdf(data.blob, data.incoming));
      return;
    }
    if (data.operation === 'inspect-form') {
      self.postMessage({ form: await inspectPdfForm(data.blob) });
      return;
    }
    if (data.operation === 'apply-form') {
      self.postMessage({ blob: await applyPdfFormChanges(data.blob, data.changes) });
      return;
    }
    let output = await exportAnnotatedPdf(data.blob, data.annotations, data.views);
    if (data.ocr.length) {
      const response = await fetch(ocrFontUrl, { credentials: 'same-origin', redirect: 'error' });
      if (!response.ok)
        throw new Error(
          'The bundled text font is unavailable. Reopen Margin while online and retry.',
        );
      const font = new Uint8Array(await response.arrayBuffer());
      if (font.byteLength !== 569208) throw new Error('The bundled text font is invalid.');
      const digest = Array.from(
        new Uint8Array(await crypto.subtle.digest('SHA-256', font)),
        (byte) => byte.toString(16).padStart(2, '0'),
      ).join('');
      if (digest !== 'b85c38ecea8a7cfb39c24e395a4007474fa5a4fc864f6ee33309eb4948d232d5')
        throw new Error('The bundled text font could not be verified.');
      output = await addOcrTextLayer(output, data.ocr, font);
    }
    if (data.extractIndex !== undefined) {
      // Retain the selected annotated page and its complete notes appendix.
      output = await extractPdfPage(output, data.extractIndex, data.originalPageCount);
    }
    self.postMessage({ blob: output });
  } catch (error) {
    self.postMessage({ error: error instanceof Error ? error.message : String(error) });
  }
};
