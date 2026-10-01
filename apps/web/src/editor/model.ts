import type { Annotation, Point } from '@margin/core';

export type PageAction = 'rotate' | 'duplicate' | 'delete' | 'insert' | 'earlier' | 'later';
export const uid = () => crypto.randomUUID();
export const clamp = (value: number, min: number, max: number) =>
  Math.max(min, Math.min(max, value));
export function bounds(a: Annotation) {
  if (a.points?.length) {
    const xs = a.points.map((p) => p.x),
      ys = a.points.map((p) => p.y);
    return {
      x: Math.min(...xs),
      y: Math.min(...ys),
      width: Math.max(...xs) - Math.min(...xs),
      height: Math.max(...ys) - Math.min(...ys),
    };
  }
  const width = a.width ?? (a.type === 'comment' ? 22 : 160),
    height = a.height ?? (a.type === 'comment' ? 22 : 24);
  if (a.type === 'text' && a.rotation) {
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
  if (a.points?.length)
    return a.points.some(
      (p, i, ps) =>
        segmentDistance(point, ps[Math.max(0, i - 1)], p) <= a.strokeWidth / 2 + tolerance,
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
  };
}
export function rotateAnnotation(a: Annotation, pageHeight: number): Annotation {
  if (a.points?.length)
    return {
      ...a,
      x: pageHeight - a.y,
      y: a.x,
      points: a.points.map((p) => ({ ...p, x: pageHeight - p.y, y: p.x })),
    };
  if (a.type === 'text')
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
