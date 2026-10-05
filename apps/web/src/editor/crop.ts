import { PDFArray, PDFName, PDFNumber, type PDFPage } from 'pdf-lib';
import { auditPdfForEditing, loadEditablePdf } from './forms';
import {
  CROP_MAX_DISPLAY_SIZE,
  CROP_MIN_SIZE,
  type CropBox,
  type CropPageInfo,
  type CropRequest,
  type CropResult,
} from './cropTypes';

const MAX_COORDINATE = 1_000_000;
function invalid(message: string): never {
  throw new Error(`${message} The original PDF is unchanged.`);
}
function readBox(array: PDFArray): CropBox {
  if (!(array instanceof PDFArray) || array.size() !== 4)
    invalid('This page has an unsupported page box.');
  const [x0, y0, x1, y1] = [0, 1, 2, 3].map((index) => array.lookup(index, PDFNumber).asNumber());
  if (![x0, y0, x1, y1].every((n) => Number.isFinite(n) && Math.abs(n) <= MAX_COORDINATE))
    invalid('This page exceeds the supported coordinate limits.');
  const box = {
    x: Math.min(x0, x1),
    y: Math.min(y0, y1),
    width: Math.abs(x1 - x0),
    height: Math.abs(y1 - y0),
  };
  if (box.width <= 0 || box.height <= 0) invalid('This page has an empty page box.');
  return box;
}
function intersect(a: CropBox, b: CropBox): CropBox | undefined {
  const x = Math.max(a.x, b.x),
    y = Math.max(a.y, b.y);
  const width = Math.min(a.x + a.width, b.x + b.width) - x;
  const height = Math.min(a.y + a.height, b.y + b.height) - y;
  return width > 0 && height > 0 ? { x, y, width, height } : undefined;
}
function pageInfo(page: PDFPage, pageIndex: number, pageCount: number): CropPageInfo {
  try {
    const mediaBox = readBox(page.node.MediaBox());
    const crop = page.node.CropBox();
    const cropBox = crop ? readBox(crop) : { ...mediaBox };
    // Match PDF.js's effective visible box, including a valid but disjoint CropBox.
    const visibleBox = intersect(mediaBox, cropBox) ?? { ...mediaBox };
    const rawRotation = page.getRotation().angle;
    if (!Number.isSafeInteger(rawRotation) || rawRotation % 90 !== 0)
      invalid('This page has an unsupported rotation.');
    const rotation = (((rawRotation % 360) + 360) % 360) as CropPageInfo['rotation'];
    const unit = page.node.lookupMaybe(PDFName.of('UserUnit'), PDFNumber);
    const userUnit = unit ? unit.asNumber() : 1;
    if (!Number.isFinite(userUnit) || userUnit <= 0 || userUnit > 75_000)
      invalid('This page has an unsupported PDF unit size.');
    const { x, y, width: w, height: h } = visibleBox;
    const width = (rotation % 180 === 0 ? w : h) * userUnit;
    const height = (rotation % 180 === 0 ? h : w) * userUnit;
    if (
      ![width, height].every(
        (n) => Number.isFinite(n) && n >= CROP_MIN_SIZE && n <= CROP_MAX_DISPLAY_SIZE,
      )
    )
      invalid('The visible page must be between 1 and 1,000,000 points on each side.');
    const transform: CropPageInfo['transform'] =
      rotation === 0
        ? [userUnit, 0, 0, -userUnit, -x * userUnit, (y + h) * userUnit]
        : rotation === 90
          ? [0, userUnit, userUnit, 0, -y * userUnit, -x * userUnit]
          : rotation === 180
            ? [-userUnit, 0, 0, userUnit, (x + w) * userUnit, -y * userUnit]
            : [0, -userUnit, -userUnit, 0, (y + h) * userUnit, (x + w) * userUnit];
    for (let i = 0; i < transform.length; i++) if (transform[i] === 0) transform[i] = 0;
    return {
      pageIndex,
      pageCount,
      rotation,
      userUnit,
      mediaBox,
      cropBox,
      visibleBox,
      width,
      height,
      transform,
    };
  } catch (error) {
    if (error instanceof Error && error.message.endsWith('The original PDF is unchanged.'))
      throw error;
    return invalid('This page has malformed or unsupported geometry.');
  }
}
function pdfPoint(info: CropPageInfo, x: number, y: number): [number, number] {
  const [a, b, c, d, e, f] = info.transform;
  const determinant = a * d - b * c;
  return [(d * (x - e) - c * (y - f)) / determinant, (-b * (x - e) + a * (y - f)) / determinant];
}
function requestedBox(info: CropPageInfo, request: CropRequest): CropBox {
  if (!request || (request.kind !== 'margins' && request.kind !== 'reset'))
    invalid('Choose crop margins or reset the page crop.');
  if (request.kind === 'reset') return { ...info.mediaBox };
  const margins = request.margins;
  if (
    !margins ||
    !['top', 'right', 'bottom', 'left'].every((key) => {
      const value = margins[key as keyof typeof margins];
      return typeof value === 'number' && Number.isFinite(value) && value >= 0;
    })
  )
    invalid('Crop margins must be finite, nonnegative numbers.');
  const { top, right, bottom, left } = margins;
  const width = info.width - left - right,
    height = info.height - top - bottom;
  if (width < CROP_MIN_SIZE || height < CROP_MIN_SIZE)
    invalid('Leave at least 1 point of visible page width and height.');
  // A zero-margin action preserves even a source CropBox extending beyond MediaBox.
  if (top === 0 && right === 0 && bottom === 0 && left === 0) return { ...info.cropBox };
  const points = [
    pdfPoint(info, left, top),
    pdfPoint(info, info.width - right, top),
    pdfPoint(info, info.width - right, info.height - bottom),
    pdfPoint(info, left, info.height - bottom),
  ];
  const xs = points.map((p) => p[0]),
    ys = points.map((p) => p[1]);
  const x = Math.min(...xs),
    y = Math.min(...ys);
  const box = { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
  const view = info.visibleBox;
  const tolerance = 0.000001;
  if (
    ![box.x, box.y, box.width, box.height].every(Number.isFinite) ||
    box.width <= 0 ||
    box.height <= 0 ||
    box.x < view.x - tolerance ||
    box.y < view.y - tolerance ||
    box.x + box.width > view.x + view.width + tolerance ||
    box.y + box.height > view.y + view.height + tolerance
  )
    invalid('The crop rectangle must stay inside the displayed page.');
  return box;
}
async function editablePage(blob: Blob, pageIndex: number) {
  if (!Number.isSafeInteger(pageIndex) || pageIndex < 0)
    invalid('Choose a valid PDF page to crop.');
  const pdf = await loadEditablePdf(blob);
  auditPdfForEditing(pdf);
  const pageCount = pdf.getPageCount();
  if (pageIndex >= pageCount) invalid('This PDF page is unavailable.');
  const page = pdf.getPage(pageIndex);
  return { pdf, page, before: pageInfo(page, pageIndex, pageCount) };
}
/** Inspect supported geometry without calling getForm or changing any PDF object. */
export async function inspectPageCrop(blob: Blob, pageIndex: number): Promise<CropPageInfo> {
  return (await editablePage(blob, pageIndex)).before;
}
/**
 * Crop changes the visible page boundary; hidden original content is retained.
 * This is not redaction. Only the page's CropBox changes: widgets, links, content
 * streams, rotation and media/trim/bleed/art boxes retain their PDF coordinates.
 * Caller enforces modification permission and atomically saves the returned PDF
 * with translated display-space annotations. Byte replacement invalidates saved OCR.
 */
export async function applyPageCrop(
  blob: Blob,
  pageIndex: number,
  request: CropRequest,
): Promise<CropResult> {
  const { pdf, page, before } = await editablePage(blob, pageIndex);
  const box = requestedBox(before, request);
  const changed = Object.entries(box).some(
    ([key, value]) => value !== before.cropBox[key as keyof CropBox],
  );
  if (!changed)
    return { blob, before, after: before, annotationOffset: { x: 0, y: 0 }, changed: false };
  page.setCropBox(box.x, box.y, box.width, box.height);
  const after = pageInfo(page, pageIndex, before.pageCount);
  const bytes = await pdf.save({ updateFieldAppearances: false });
  if (bytes.byteLength > 100 * 1024 * 1024)
    invalid('The cropped PDF exceeds the 100 MB document limit.');
  return {
    blob: new Blob([bytes as BlobPart], { type: 'application/pdf' }),
    before,
    after,
    annotationOffset: {
      x: after.transform[4] - before.transform[4],
      y: after.transform[5] - before.transform[5],
    },
    changed: true,
  };
}
