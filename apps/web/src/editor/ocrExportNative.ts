import type { OcrPageRecord } from '@margin/core';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import type { TextItem, TextStyle } from 'pdfjs-dist/types/src/display/api';
import { readPageText } from './pageText';

type Point = [number, number];
interface NativeBox {
  x: number;
  y: number;
  ux: number;
  uy: number;
  width: number;
  bottom: number;
  top: number;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}
const uncertain = () =>
  new Error(
    'This page mixes recognized text with native text whose overlap cannot be determined safely. The original PDF is unchanged.',
  );
const finite = (n: number) => Number.isFinite(n) && Math.abs(n) <= 1_000_000;
/** PDF.js text-layer placement, in PDF user space before page rotation/cropping. */
function nativeBox(item: TextItem, style: TextStyle | undefined): NativeBox {
  const t = item.transform;
  if (
    !Array.isArray(t) ||
    t.length !== 6 ||
    !t.every(finite) ||
    !style ||
    style.vertical ||
    !['ltr', 'rtl'].includes(item.dir) ||
    !finite(item.width) ||
    item.width <= 0 ||
    !Number.isFinite(style.ascent) ||
    !Number.isFinite(style.descent) ||
    style.ascent <= 0 ||
    style.ascent > 2 ||
    style.descent > 0 ||
    style.descent < -1
  )
    throw uncertain();
  const [a, b, c, d, x, y] = t as number[];
  const advance = Math.hypot(a, b),
    height = Math.hypot(c, d);
  // Skewed, mirrored or degenerate native text needs a different geometry model.
  if (
    advance < 0.001 ||
    height < 0.001 ||
    a * d - b * c <= 0 ||
    Math.abs((a * c + b * d) / (advance * height)) > 0.01
  )
    throw uncertain();
  const ux = a / advance,
    uy = b / advance;
  const bottom = height * style.descent,
    top = height * style.ascent;
  const points = [
    [0, bottom],
    [item.width, bottom],
    [item.width, top],
    [0, top],
  ].map(([u, v]) => [x + u * ux - v * uy, y + u * uy + v * ux]);
  return {
    x,
    y,
    ux,
    uy,
    width: item.width,
    bottom,
    top,
    minX: Math.min(...points.map((p) => p[0])),
    minY: Math.min(...points.map((p) => p[1])),
    maxX: Math.max(...points.map((p) => p[0])),
    maxY: Math.max(...points.map((p) => p[1])),
  };
}
function area(points: Point[]): number {
  let sum = 0;
  for (let i = 0; i < points.length; i++) {
    const p = points[i],
      q = points[(i + 1) % points.length];
    sum += p[0] * q[1] - q[0] * p[1];
  }
  return Math.abs(sum) / 2;
}
function clip(points: Point[], axis: 0 | 1, boundary: number, keepAbove: boolean): Point[] {
  const result: Point[] = [];
  for (let i = 0; i < points.length; i++) {
    const a = points[i],
      b = points[(i + 1) % points.length];
    const aIn = keepAbove ? a[axis] >= boundary : a[axis] <= boundary;
    const bIn = keepAbove ? b[axis] >= boundary : b[axis] <= boundary;
    if (aIn) result.push(a);
    if (aIn !== bIn) {
      const ratio = (boundary - a[axis]) / (b[axis] - a[axis]);
      result.push([a[0] + ratio * (b[0] - a[0]), a[1] + ratio * (b[1] - a[1])]);
    }
  }
  return result;
}
function coverage(points: Point[], box: NativeBox): number {
  const local = points.map(
    ([x, y]): Point => [
      (x - box.x) * box.ux + (y - box.y) * box.uy,
      -(x - box.x) * box.uy + (y - box.y) * box.ux,
    ],
  );
  const originalArea = area(local);
  if (originalArea < 0.0001) throw uncertain();
  let clipped = clip(local, 0, 0, true);
  clipped = clip(clipped, 0, box.width, false);
  clipped = clip(clipped, 1, box.bottom, true);
  clipped = clip(clipped, 1, box.top, false);
  return area(clipped) / originalArea;
}
interface Rectangle {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}
function wordGeometry(q: OcrPageRecord['words'][number]['quad']) {
  if (!Array.isArray(q) || q.length !== 8 || !Array.from(q).every(finite)) throw uncertain();
  const ax = q[2] - q[0],
    ay = q[3] - q[1];
  const bx = q[0] - q[6],
    by = q[1] - q[7];
  const width = Math.hypot(ax, ay),
    height = Math.hypot(bx, by);
  const tolerance = Math.max(width, height) * 0.00001;
  if (
    width < 0.001 ||
    height < 0.001 ||
    ax * by - ay * bx <= 0 ||
    Math.abs(ax * bx + ay * by) > width * height * 0.00001 ||
    Math.abs(q[4] - q[6] - ax) > tolerance ||
    Math.abs(q[5] - q[7] - ay) > tolerance
  )
    throw uncertain();
  return {
    x: q[6],
    y: q[7],
    ux: ax / width,
    uy: ay / width,
    vx: bx / height,
    vy: by / height,
    width,
    height,
  };
}
function clippedNativeRectangle(
  word: ReturnType<typeof wordGeometry>,
  points: Point[],
  box: NativeBox,
): Rectangle | undefined {
  const along = box.ux * word.ux + box.uy * word.uy;
  const across = box.ux * word.vx + box.uy * word.vy;
  // Only axis-parallel rectangles have an exact rectangle union in this basis.
  // Check actual polygon intersection before rejecting an unrelated oblique run.
  if (Math.min(Math.abs(along), Math.abs(across)) > 0.00001) {
    if (coverage(points, box) > 0.000001) throw uncertain();
    return undefined;
  }
  const local = [
    [0, box.bottom],
    [box.width, box.bottom],
    [box.width, box.top],
    [0, box.top],
  ].map(([u, v]) => {
    const x = box.x + u * box.ux - v * box.uy - word.x;
    const y = box.y + u * box.uy + v * box.ux - word.y;
    return [x * word.ux + y * word.uy, x * word.vx + y * word.vy];
  });
  const rectangle = {
    x0: Math.max(0, Math.min(...local.map((p) => p[0]))),
    y0: Math.max(0, Math.min(...local.map((p) => p[1]))),
    x1: Math.min(word.width, Math.max(...local.map((p) => p[0]))),
    y1: Math.min(word.height, Math.max(...local.map((p) => p[1]))),
  };
  return rectangle.x1 > rectangle.x0 && rectangle.y1 > rectangle.y0 ? rectangle : undefined;
}
/** Exact union area: x sweep with a compressed-y segment tree, O(n log n). */
function unionArea(rectangles: Rectangle[]): number {
  if (!rectangles.length) return 0;
  const ys = [...new Set(rectangles.flatMap((r) => [r.y0, r.y1]))].sort((a, b) => a - b);
  const indexes = new Map(ys.map((y, i) => [y, i]));
  const events = rectangles
    .flatMap((r) => [
      { x: r.x0, start: indexes.get(r.y0)!, end: indexes.get(r.y1)! - 1, delta: 1 },
      { x: r.x1, start: indexes.get(r.y0)!, end: indexes.get(r.y1)! - 1, delta: -1 },
    ])
    .sort((a, b) => a.x - b.x);
  const counts = new Int32Array(ys.length * 4),
    lengths = new Float64Array(ys.length * 4);
  const update = (
    node: number,
    left: number,
    right: number,
    start: number,
    end: number,
    delta: number,
  ): void => {
    if (start <= left && end >= right) counts[node] += delta;
    else {
      const mid = (left + right) >>> 1;
      if (start <= mid) update(node * 2, left, mid, start, end, delta);
      if (end > mid) update(node * 2 + 1, mid + 1, right, start, end, delta);
    }
    lengths[node] =
      counts[node] > 0
        ? ys[right + 1] - ys[left]
        : left === right
          ? 0
          : lengths[node * 2] + lengths[node * 2 + 1];
  };
  let total = 0,
    previous = events[0].x;
  for (const event of events) {
    total += (event.x - previous) * lengths[1];
    update(1, 0, ys.length - 2, event.start, event.end, event.delta);
    previous = event.x;
  }
  return total;
}
/** Keep image-only words on mixed pages; existing digital glyphs remain authoritative. */
export async function removeNativeOcrOverlap(
  pdf: PDFDocumentProxy,
  record: OcrPageRecord,
  signal?: AbortSignal,
): Promise<OcrPageRecord | undefined> {
  const styles = new Map<string, TextStyle>();
  const boxes: NativeBox[] = [];
  let geometryError: Error | undefined;
  await readPageText(pdf, record.pageIndex, {
    signal,
    onTextChunk(content) {
      for (const [key, style] of Object.entries(content.styles)) {
        styles.set(key, style);
        if (styles.size > 20_000) throw uncertain();
      }
      for (const item of content.items) {
        if (!('str' in item) || !item.str.trim()) continue;
        try {
          boxes.push(nativeBox(item, styles.get(item.fontName)));
        } catch {
          geometryError = uncertain();
        }
      }
    },
  });
  if (geometryError) throw geometryError;
  if (!boxes.length) return record;
  // Spatial buckets bound work on large pages. Reject pathological geometry instead of O(n²).
  const buckets = new Map<string, NativeBox[]>();
  const cells = (minX: number, minY: number, maxX: number, maxY: number): string[] => {
    const left = Math.floor(minX / 128),
      right = Math.floor(maxX / 128);
    const bottom = Math.floor(minY / 128),
      top = Math.floor(maxY / 128);
    if ((right - left + 1) * (top - bottom + 1) > 1024) throw uncertain();
    const result: string[] = [];
    for (let x = left; x <= right; x++)
      for (let y = bottom; y <= top; y++) result.push(`${x},${y}`);
    return result;
  };
  let entries = 0;
  for (const [index, box] of boxes.entries()) {
    if (index % 1000 === 0) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      signal?.throwIfAborted();
    }
    for (const key of cells(box.minX, box.minY, box.maxX, box.maxY)) {
      if (++entries > 100_000) throw uncertain();
      const bucket = buckets.get(key) ?? [];
      bucket.push(box);
      buckets.set(key, bucket);
    }
  }
  let comparisons = 0,
    text = '',
    previousEnd = 0;
  const words: OcrPageRecord['words'] = [];
  for (const [wordIndex, word] of record.words.entries()) {
    if (wordIndex % 256 === 0) await new Promise((resolve) => setTimeout(resolve, 0));
    signal?.throwIfAborted();
    const q = word.quad;
    const geometry = wordGeometry(q);
    const points: Point[] = [
      [q[0], q[1]],
      [q[2], q[3]],
      [q[4], q[5]],
      [q[6], q[7]],
    ];
    const xs = points.map((p) => p[0]),
      ys = points.map((p) => p[1]);
    const minX = Math.min(...xs),
      maxX = Math.max(...xs),
      minY = Math.min(...ys),
      maxY = Math.max(...ys);
    const candidates = new Set(
      cells(minX, minY, maxX, maxY).flatMap((key) => buckets.get(key) ?? []),
    );
    const rectangles: Rectangle[] = [];
    for (const box of candidates) {
      if (++comparisons > 1_000_000) throw uncertain();
      if (box.maxX <= minX || box.minX >= maxX || box.maxY <= minY || box.minY >= maxY) continue;
      const rectangle = clippedNativeRectangle(geometry, points, box);
      if (rectangle) {
        if (rectangles.length >= 1024) throw uncertain();
        rectangles.push(rectangle);
      }
    }
    const overlap = unionArea(rectangles) / (geometry.width * geometry.height);
    if (overlap >= 0.6) continue;
    if (overlap > 0.15) throw uncertain();
    if (words.length) {
      const gap = record.text.slice(previousEnd, word.start);
      text += gap.includes('\n\n') ? '\n\n' : gap.includes('\n') ? '\n' : ' ';
    }
    const start = text.length;
    text += record.text.slice(word.start, word.end);
    words.push({ ...word, start, end: text.length, quad: [...word.quad] });
    previousEnd = word.end;
  }
  signal?.throwIfAborted();
  return words.length ? { ...record, text, words } : undefined;
}
