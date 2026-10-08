import { useEffect, useState } from 'react';
import { getDocument, GlobalWorkerOptions, type PDFDocumentProxy } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
GlobalWorkerOptions.workerSrc = workerUrl;

export function usePdf(blob: Blob) {
  const [snapshot, setSnapshot] = useState<{
    blob: Blob;
    pdf: PDFDocumentProxy | null;
    error: string;
    loading: boolean;
  } | null>(null);
  useEffect(() => {
    let stopped = false,
      task: ReturnType<typeof getDocument> | undefined;
    setSnapshot({ blob, pdf: null, error: '', loading: true });
    void blob
      .arrayBuffer()
      .then((data) => {
        if (stopped) {
          new Uint8Array(data).fill(0);
          return;
        }
        task = getDocument({
          data,
          disableAutoFetch: true,
          disableStream: true,
          useSystemFonts: true,
        });
        return task.promise.then((document) => {
          if (!stopped) {
            setSnapshot({ blob, pdf: document, error: '', loading: false });
          }
        });
      })
      .catch((reason) => {
        if (!stopped) {
          setSnapshot({
            blob,
            pdf: null,
            error: reason instanceof Error ? reason.message : 'This PDF could not be opened.',
            loading: false,
          });
        }
      });
    return () => {
      stopped = true;
      void task?.destroy();
    };
  }, [blob]);
  // A replaced file must never expose the previous revision to reading or editing,
  // including the render before the loading effect has run.
  return snapshot?.blob === blob
    ? { pdf: snapshot.pdf, error: snapshot.error, loading: snapshot.loading }
    : { pdf: null, error: '', loading: true };
}
