import { useEffect, useState } from 'react';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { readPageText } from './pageText';
export interface PageTextState {
  text: string;
  loading: boolean;
  error: string;
  canCopy: boolean;
}
interface Snapshot extends PageTextState {
  pdf: PDFDocumentProxy;
  pageIndex: number;
}
/** No text from the previous identity is exposed even on the render before effect cleanup. */
export function usePageText(pdf: PDFDocumentProxy | null, pageIndex: number): PageTextState {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    if (!pdf) {
      setSnapshot(null);
      return () => controller.abort();
    }
    setSnapshot({ pdf, pageIndex, text: '', loading: true, error: '', canCopy: false });
    void readPageText(pdf, pageIndex, { signal: controller.signal }).then(
      (result) => {
        if (!controller.signal.aborted)
          setSnapshot({ pdf, pageIndex, ...result, loading: false, error: '' });
      },
      (error) => {
        if (!controller.signal.aborted)
          setSnapshot({
            pdf,
            pageIndex,
            text: '',
            canCopy: false,
            loading: false,
            error: error instanceof Error ? error.message : 'Page text could not be read.',
          });
      },
    );
    return () => controller.abort();
  }, [pdf, pageIndex]);
  if (!pdf) return { text: '', loading: false, error: '', canCopy: false };
  if (snapshot?.pdf !== pdf || snapshot.pageIndex !== pageIndex)
    return { text: '', loading: true, error: '', canCopy: false };
  return {
    text: snapshot.text,
    loading: snapshot.loading,
    error: snapshot.error,
    canCopy: snapshot.canCopy,
  };
}
