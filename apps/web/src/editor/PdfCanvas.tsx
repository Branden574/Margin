import { useEffect, useRef, useState } from 'react';
import type { PDFDocumentProxy, RenderTask } from 'pdfjs-dist';

interface Props {
  pdf: PDFDocumentProxy;
  pageIndex: number;
  scale: number;
  thumbnail?: boolean;
  onSize?: (size: { width: number; height: number }) => void;
}
export function PdfCanvas({ pdf, pageIndex, scale, thumbnail = false, onSize }: Props) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let stopped = false,
      render: RenderTask | undefined;
    setError('');
    const draw = async () => {
      const page = await pdf.getPage(pageIndex + 1);
      if (stopped || !canvas.current) return;
      const base = page.getViewport({ scale: 1 });
      onSize?.({ width: base.width, height: base.height });
      const view = page.getViewport({ scale });
      // Cap the one active surface to 12M pixels; thumbnails use a single device pixel.
      const pixelRatio = thumbnail
        ? Math.min(1, Math.sqrt(150_000 / (view.width * view.height)))
        : Math.min(
            window.devicePixelRatio || 1,
            2,
            Math.sqrt(12_000_000 / (view.width * view.height)),
          );
      canvas.current.width = Math.ceil(view.width * pixelRatio);
      canvas.current.height = Math.ceil(view.height * pixelRatio);
      canvas.current.style.width = `${view.width}px`;
      canvas.current.style.height = `${view.height}px`;
      const context = canvas.current.getContext('2d', { alpha: false });
      if (!context) throw new Error('Canvas rendering is unavailable in this browser.');
      render = page.render({
        canvas: canvas.current,
        canvasContext: context,
        viewport: view,
        transform: pixelRatio === 1 ? undefined : [pixelRatio, 0, 0, pixelRatio, 0, 0],
      });
      await render.promise;
      page.cleanup();
    };
    void draw().catch((reason) => {
      if (!stopped && reason?.name !== 'RenderingCancelledException')
        setError(reason instanceof Error ? reason.message : 'Page could not be rendered.');
    });
    return () => {
      stopped = true;
      render?.cancel();
    };
  }, [pdf, pageIndex, scale, thumbnail, onSize]);
  return (
    <>
      {error ? (
        <div className="editor-page-error" role="alert">
          This page could not render: {error}
        </div>
      ) : null}
      <canvas ref={canvas} aria-label={`Page ${pageIndex + 1}`} />
    </>
  );
}
