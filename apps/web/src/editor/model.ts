import type { Annotation, Point } from '@margin/core';

export type PageAction = 'rotate' | 'duplicate' | 'delete' | 'insert' | 'earlier' | 'later';
export const uid = () => crypto.randomUUID();
export const clamp = (value: number, min: number, max: number) =>
  Math.max(min, Math.min(max, value));
export function arrowHead(points: Point[], strokeWidth: number): Point[] {
  if (points.length < 2) return [];
  const tip = points[points.length - 1],
    start = points[points.length - 2];
  const distance = Math.hypot(tip.x - start.x, tip.y - start.y);
  if (distance < 0.01) return [];
  const length = Math.min(Math.max(10, strokeWidth * 4), distance * 0.5);
  const ux = (tip.x - start.x) / distance,
    uy = (tip.y - start.y) / distance;
  const base = { x: tip.x - ux * length, y: tip.y - uy * length };
  return [
    { x: base.x - uy * length * 0.55, y: base.y + ux * length * 0.55 },
    tip,
    { x: base.x + uy * length * 0.55, y: base.y - ux * length * 0.55 },
  ];
}
export function annotationPaths(a: Annotation): Point[][] {
  if (a.strokes?.length) return a.strokes.filter((stroke) => stroke.length);
  if (!a.points?.length) return [];
  return a.type === 'arrow'
    ? [a.points, arrowHead(a.points, a.strokeWidth)].filter((path) => path.length)
    : [a.points];
}
export function dashPattern(a: Annotation): number[] | undefined {
  return a.lineStyle === 'dashed'
    ? [a.strokeWidth * 3, a.strokeWidth * 2]
    : a.lineStyle === 'dotted'
      ? [0.1, a.strokeWidth * 2]
      : undefined;
}
export const textLike = (a: Annotation) =>
  a.type === 'text' || a.type === 'stamp' || (a.type === 'signature' && !a.strokes?.length);
export function bounds(a: Annotation) {
  const points = annotationPaths(a).flat();
  if (points.length) {
    let minX = Infinity,
      minY = Infinity,
      maxX = -Infinity,
      maxY = -Infinity;
    for (const point of points) {
      minX = Math.min(minX, point.x);
      minY = Math.min(minY, point.y);
      maxX = Math.max(maxX, point.x);
      maxY = Math.max(maxY, point.y);
    }
    return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
  }
  const width = a.width ?? (a.type === 'comment' ? 22 : 160),
    height = a.height ?? (a.type === 'comment' ? 22 : 24);
  if (textLike(a) && a.rotation) {
    const rad = (a.rotation * Math.PI) / 180,
      cos = Math.cos(rad),
      sin = Math.sin(rad);
    const corners = [
      [0, 0],
      [width, 0],
      [0, height],
      [width, height],
    ].map(([x, y]) => ({ x: a.x + x * cos - y * sin, y: a.y + x * sin + y * cos }));
    const xs = corners.map((p) => p.x),
      ys = corners.map((p) => p.y);
    return {
      x: Math.min(...xs),
      y: Math.min(...ys),
      width: Math.max(...xs) - Math.min(...xs),
      height: Math.max(...ys) - Math.min(...ys),
    };
  }
  return { x: a.x, y: a.y, width, height };
}
const segmentDistance = (p: Point, a: Point, b: Point) => {
  const dx = b.x - a.x,
    dy = b.y - a.y;
  const t = clamp(((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy || 1), 0, 1);
  return Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy);
};
export function hitTest(a: Annotation, point: Point, tolerance = 8): boolean {
  const paths = annotationPaths(a);
  if (paths.length)
    return paths.some((path) =>
      path.some(
        (p, i, ps) =>
          segmentDistance(point, ps[Math.max(0, i - 1)], p) <= a.strokeWidth / 2 + tolerance,
      ),
    );
  const b = bounds(a);
  return (
    point.x >= b.x - tolerance &&
    point.x <= b.x + b.width + tolerance &&
    point.y >= b.y - tolerance &&
    point.y <= b.y + b.height + tolerance
  );
}
export function movedAnnotation(a: Annotation, dx: number, dy: number): Annotation {
  return {
    ...a,
    x: a.x + dx,
    y: a.y + dy,
    points: a.points?.map((p) => ({ ...p, x: p.x + dx, y: p.y + dy })),
    strokes: a.strokes?.map((stroke) => stroke.map((p) => ({ ...p, x: p.x + dx, y: p.y + dy }))),
  };
}
export function rotateAnnotation(a: Annotation, pageHeight: number): Annotation {
  if (a.points?.length || a.strokes?.length)
    return {
      ...a,
      x: pageHeight - a.y,
      y: a.x,
      points: a.points?.map((p) => ({ ...p, x: pageHeight - p.y, y: p.x })),
      strokes: a.strokes?.map((stroke) =>
        stroke.map((p) => ({ ...p, x: pageHeight - p.y, y: p.x })),
      ),
    };
  if (textLike(a))
    return { ...a, x: pageHeight - a.y, y: a.x, rotation: ((a.rotation ?? 0) + 90) % 360 };
  if (a.type === 'comment') return { ...a, x: pageHeight - a.y - 24, y: a.x };
  return { ...a, x: pageHeight - a.y - (a.height ?? 0), y: a.x, width: a.height, height: a.width };
}
export function remapAnnotations(
  items: Annotation[],
  action: PageAction,
  pageIndex: number,
  pageHeight: number,
): Annotation[] {
  if (action === 'rotate')
    return items.map((a) => (a.pageIndex === pageIndex ? rotateAnnotation(a, pageHeight) : a));
  if (action === 'delete')
    return items
      .filter((a) => a.pageIndex !== pageIndex)
      .map((a) => (a.pageIndex > pageIndex ? { ...a, pageIndex: a.pageIndex - 1 } : a));
  if (action === 'duplicate' || action === 'insert') {
    const shifted = items.map((a) =>
      a.pageIndex > pageIndex ? { ...a, pageIndex: a.pageIndex + 1 } : a,
    );
    return action === 'duplicate'
      ? [
          ...shifted,
          ...items
            .filter((a) => a.pageIndex === pageIndex)
            .map((a) => ({ ...a, id: uid(), pageIndex: pageIndex + 1 })),
        ]
      : shifted;
  }
  const adjacent = pageIndex + (action === 'earlier' ? -1 : 1);
  return items.map((a) =>
    a.pageIndex === pageIndex
      ? { ...a, pageIndex: adjacent }
      : a.pageIndex === adjacent
        ? { ...a, pageIndex }
        : a,
  );
}
export function pathData(points: Point[]): string {
  return points.map((p, i) => `${i ? 'L' : 'M'} ${p.x.toFixed(2)} ${p.y.toFixed(2)}`).join(' ');
}
