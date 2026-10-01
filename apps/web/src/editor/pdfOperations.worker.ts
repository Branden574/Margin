import {
  transformPage,
  exportAnnotatedPdf,
  mergePdf,
  extractPdfPage,
  type ExportPageView,
} from './pdf';
import type { PageAction } from './model';
import type { Annotation } from '@margin/core';
type Request =
  | { operation: 'transform'; blob: Blob; action: PageAction; index: number }
  | {
      operation: 'export';
      blob: Blob;
      annotations: Annotation[];
      views: ExportPageView[];
      extractIndex?: number;
      originalPageCount: number;
    }
  | { operation: 'merge'; blob: Blob; incoming: Blob };
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
    let output = await exportAnnotatedPdf(data.blob, data.annotations, data.views);
    if (data.extractIndex !== undefined) {
      // Retain the selected annotated page and its complete notes appendix.
      output = await extractPdfPage(output, data.extractIndex, data.originalPageCount);
    }
    self.postMessage({ blob: output });
  } catch (error) {
    self.postMessage({ error: error instanceof Error ? error.message : String(error) });
  }
};
