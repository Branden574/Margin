import { useEffect, useState } from 'react';
import { getDocument, GlobalWorkerOptions, type PDFDocumentProxy } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
GlobalWorkerOptions.workerSrc = workerUrl;

export function usePdf(blob: Blob) {
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let stopped = false,
      task: ReturnType<typeof getDocument> | undefined;
    setLoading(true);
    setPdf(null);
    setError('');
    void blob
      .arrayBuffer()
      .then((data) => {
        if (stopped) return;
        task = getDocument({
          data,
          disableAutoFetch: true,
          disableStream: true,
          useSystemFonts: true,
        });
        return task.promise.then((document) => {
          if (!stopped) {
            setPdf(document);
            setLoading(false);
          }
        });
      })
      .catch((reason) => {
        if (!stopped) {
          setError(reason instanceof Error ? reason.message : 'This PDF could not be opened.');
          setLoading(false);
        }
      });
    return () => {
      stopped = true;
      void task?.destroy();
    };
  }, [blob]);
  return { pdf, error, loading };
}
