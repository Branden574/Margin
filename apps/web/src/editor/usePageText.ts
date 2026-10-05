import { useEffect, useState } from 'react';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { resolvePageText, type TextDocument } from './resolvedPageText';
export interface PageTextState {
  text: string;
  loading: boolean;
  error: string;
  canCopy: boolean;
  source?: 'pdf' | 'ocr';
}
interface Snapshot extends PageTextState {
  pdf: PDFDocumentProxy;
  pageIndex: number;
  revision?: string;
  refresh?: number;
}
/** No text from the previous identity is exposed even on the render before effect cleanup. */
export function usePageText(
  pdf: PDFDocumentProxy | null,
  pageIndex: number,
  document?: TextDocument,
): PageTextState {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    if (!pdf) {
      setSnapshot(null);
      return () => controller.abort();
    }
    const identity = {
      pdf,
      pageIndex,
      revision: document?.contentRevision,
      refresh: document?.refresh,
    };
    setSnapshot({ ...identity, text: '', loading: true, error: '', canCopy: false });
    void resolvePageText(pdf, pageIndex, { signal: controller.signal }, document).then(
      (result) => {
        if (!controller.signal.aborted)
          setSnapshot({ ...identity, ...result, loading: false, error: '' });
      },
      (error) => {
        if (!controller.signal.aborted)
          setSnapshot({
            ...identity,
            text: '',
            canCopy: false,
            loading: false,
            error: error instanceof Error ? error.message : 'Page text could not be read.',
          });
      },
    );
    return () => controller.abort();
  }, [pdf, pageIndex, document?.documentId, document?.contentRevision, document?.refresh]);
  if (!pdf) return { text: '', loading: false, error: '', canCopy: false };
  if (
    snapshot?.pdf !== pdf ||
    snapshot.pageIndex !== pageIndex ||
    snapshot.revision !== document?.contentRevision ||
    snapshot.refresh !== document?.refresh
  )
    return { text: '', loading: true, error: '', canCopy: false };
  return {
    text: snapshot.text,
    loading: snapshot.loading,
    error: snapshot.error,
    canCopy: snapshot.canCopy,
    source: snapshot.source,
  };
}
