import { PermissionFlag, type PDFDocumentProxy, type RenderTask } from 'pdfjs-dist';
import type { OcrPageRecord } from '@margin/core';

export const OCR_RASTER_MAX_PIXELS = 4_000_000;
export const OCR_RASTER_MAX_SIDE = 4096;
type Transform = readonly number[];
export function rasterSize(width: number, height: number) {
  if (![width, height].every((n) => Number.isFinite(n) && n > 0))
    throw new Error('This page has unsupported dimensions.');
  // Floor instead of ceil: rounding must never exceed either allocation limit.
  const scale = Math.min(
    200 / 72,
    OCR_RASTER_MAX_SIDE / width,
    OCR_RASTER_MAX_SIDE / height,
    Math.sqrt(OCR_RASTER_MAX_PIXELS / width / height),
  );
  const pixelWidth = Math.max(1, Math.floor(width * scale));
  const pixelHeight = Math.max(1, Math.floor(height * scale));
  if (
    pixelWidth * pixelHeight > OCR_RASTER_MAX_PIXELS ||
    pixelWidth > OCR_RASTER_MAX_SIDE ||
    pixelHeight > OCR_RASTER_MAX_SIDE
  )
    throw new Error('This page exceeds local recognition limits.');
  const boundedScale = Math.min(pixelWidth / width, pixelHeight / height);
  if (!Number.isFinite(boundedScale) || boundedScale <= 0)
    throw new Error('This page has unsupported dimensions.');
  return {
    width: pixelWidth,
    height: pixelHeight,
    scale: boundedScale,
  };
}
function transformPoint(t: Transform, x: number, y: number): [number, number] {
  if (t.length !== 6 || !t.every(Number.isFinite)) throw new Error('Invalid page transform.');
  return [t[0] * x + t[2] * y + t[4], t[1] * x + t[3] * y + t[5]];
}
export function pixelBoxToPdfQuad(
  box: { x0: number; y0: number; x1: number; y1: number },
  t: Transform,
): OcrPageRecord['words'][number]['quad'] {
  const determinant = t[0] * t[3] - t[1] * t[2];
  if (!Number.isFinite(determinant) || Math.abs(determinant) < 1e-16)
    throw new Error('Invalid page transform.');
  const inverse = [
    t[3] / determinant,
    -t[1] / determinant,
    -t[2] / determinant,
    t[0] / determinant,
    (t[2] * t[5] - t[3] * t[4]) / determinant,
    (t[1] * t[4] - t[0] * t[5]) / determinant,
  ];
  return [
    ...transformPoint(inverse, box.x0, box.y0),
    ...transformPoint(inverse, box.x1, box.y0),
    ...transformPoint(inverse, box.x1, box.y1),
    ...transformPoint(inverse, box.x0, box.y1),
  ];
}
export function pdfQuadToRect(quad: OcrPageRecord['words'][number]['quad'], transform: Transform) {
  const points = [0, 2, 4, 6].map((i) => transformPoint(transform, quad[i], quad[i + 1]));
  const x = Math.min(...points.map((p) => p[0])),
    y = Math.min(...points.map((p) => p[1]));
  return {
    x,
    y,
    width: Math.max(...points.map((p) => p[0])) - x,
    height: Math.max(...points.map((p) => p[1])) - y,
  };
}
export async function rasterizeOcrPage(
  pdf: PDFDocumentProxy,
  pageIndex: number,
  signal: AbortSignal,
) {
  if (!Number.isSafeInteger(pageIndex) || pageIndex < 0 || pageIndex >= pdf.numPages)
    throw new Error('This page is unavailable.');
  let render: RenderTask | undefined;
  let canvas: HTMLCanvasElement | undefined;
  let stopped = false;
  let rejectStop!: (error: Error) => void;
  const interruption = new Promise<never>((_, reject) => {
    rejectStop = reject;
  });
  const stop = (reason: Error) => {
    stopped = true;
    render?.cancel();
    rejectStop(reason);
  };
  const abort = () => stop(new DOMException('Recognition cancelled.', 'AbortError'));
  const wait = <T>(promise: Promise<T>) => Promise.race([promise, interruption]);
  if (signal.aborted) throw new DOMException('Recognition cancelled.', 'AbortError');
  signal.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(
    () => stop(new Error('Preparing this page took too long. Try a smaller page.')),
    30_000,
  );
  try {
    const permissions = await wait(pdf.getPermissions());
    if (
      permissions !== null &&
      !permissions.has(PermissionFlag.COPY) &&
      !permissions.has(PermissionFlag.COPY_FOR_ACCESSIBILITY)
    )
      throw new Error('This PDF does not allow copying or accessibility text extraction.');
    const page = await wait(pdf.getPage(pageIndex + 1));
    if (stopped) throw new DOMException('Recognition cancelled.', 'AbortError');
    const base = page.getViewport({ scale: 1 });
    const size = rasterSize(base.width, base.height);
    const viewport = page.getViewport({ scale: size.scale });
    canvas = document.createElement('canvas');
    canvas.width = size.width;
    canvas.height = size.height;
    const context = canvas.getContext('2d', { alpha: false });
    if (!context) throw new Error('Page rendering is unavailable.');
    render = page.render({
      canvas,
      canvasContext: context,
      viewport,
      background: 'rgb(255,255,255)',
    });
    await wait(render.promise);
    const image = await wait(
      new Promise<Blob>((resolve, reject) =>
        canvas!.toBlob(
          (blob) => (blob ? resolve(blob) : reject(new Error('This page could not be prepared.'))),
          'image/png',
        ),
      ),
    );
    return { image, width: size.width, height: size.height, transform: viewport.transform };
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', abort);
    render?.cancel();
    if (canvas) {
      canvas.width = 0;
      canvas.height = 0;
    }
  }
}
