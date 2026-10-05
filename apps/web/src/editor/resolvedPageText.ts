import type { PDFDocumentProxy } from 'pdfjs-dist';
import { getPageOcr } from '../lib/storage';
import { readPageText, type PageTextResult } from './pageText';
export interface TextDocument {
  documentId: string;
  contentRevision: string;
  refresh?: number;
}
export async function resolvePageText(
  pdf: PDFDocumentProxy,
  pageIndex: number,
  options: Parameters<typeof readPageText>[2] = {},
  document?: TextDocument,
): Promise<PageTextResult & { source: 'pdf' | 'ocr' }> {
  // Permission validation must precede reading the encrypted OCR companion, too.
  const native = await readPageText(pdf, pageIndex, options);
  if (options.signal?.aborted) throw new DOMException('Text reading cancelled.', 'AbortError');
  const ocr = document?.contentRevision
    ? await getPageOcr(document.documentId, document.contentRevision, pageIndex)
    : undefined;
  if (options.signal?.aborted) throw new DOMException('Text reading cancelled.', 'AbortError');
  return ocr
    ? { text: ocr.text, canCopy: native.canCopy, source: 'ocr' }
    : { ...native, source: 'pdf' };
}
