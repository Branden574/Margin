import { describe, it, expect } from 'vitest';
import {
  hitTest,
  remapAnnotations,
  rotateAnnotation,
  movedAnnotation,
} from '../apps/web/src/editor/model';
import type { Annotation } from '../packages/core/src/types';
const annotation = (changes: Partial<Annotation> = {}): Annotation => ({
  id: 'one',
  pageIndex: 1,
  type: 'rectangle',
  x: 10,
  y: 20,
  width: 40,
  height: 30,
  color: '#292925',
  strokeWidth: 2,
  opacity: 1,
  createdAt: 1,
  author: 'You',
  ...changes,
});
describe('annotation geometry and document page integrity', () => {
  it('only hits pen strokes near the actual path, not its bounding rectangle', () => {
    const a = annotation({
      type: 'pen',
      points: [
        { x: 0, y: 0 },
        { x: 100, y: 100 },
      ],
    });
    expect(hitTest(a, { x: 50, y: 50 })).toBe(true);
    expect(hitTest(a, { x: 10, y: 80 })).toBe(false);
  });
  it('removes deleted-page notes and shifts later notes', () => {
    const result = remapAnnotations(
      [
        annotation(),
        annotation({ id: 'two', pageIndex: 2 }),
        annotation({ id: 'zero', pageIndex: 0 }),
      ],
      'delete',
      1,
      800,
    );
    expect(result.map((a) => [a.id, a.pageIndex])).toEqual([
      ['two', 1],
      ['zero', 0],
    ]);
  });
  it('duplicates annotations with new ids and shifts subsequent pages', () => {
    const result = remapAnnotations(
      [annotation(), annotation({ id: 'two', pageIndex: 2 })],
      'duplicate',
      1,
      800,
    );
    expect(result).toHaveLength(3);
    expect(result[1].pageIndex).toBe(3);
    expect(result[2].pageIndex).toBe(2);
    expect(result[2].id).not.toBe('one');
  });
  it('swaps notes with their corresponding pages during reordering', () => {
    const result = remapAnnotations(
      [annotation(), annotation({ id: 'two', pageIndex: 2 })],
      'later',
      1,
      800,
    );
    expect(result.map((a) => a.pageIndex)).toEqual([2, 1]);
  });
  it('rotates rectangle and pen coordinates with the PDF page', () => {
    expect(rotateAnnotation(annotation(), 800)).toMatchObject({
      x: 750,
      y: 10,
      width: 30,
      height: 40,
    });
    expect(
      rotateAnnotation(annotation({ type: 'pen', points: [{ x: 10, y: 20 }] }), 800).points,
    ).toEqual([{ x: 780, y: 10 }]);
  });
  it('keeps text orientation when page rotates', () => {
    expect(rotateAnnotation(annotation({ type: 'text' }), 800)).toMatchObject({
      x: 780,
      y: 10,
      rotation: 90,
    });
  });
  it('moves immutable pen coordinates without touching the original', () => {
    const a = annotation({ type: 'pen', points: [{ x: 10, y: 20 }] });
    const moved = movedAnnotation(a, 5, -5);
    expect(moved.points).toEqual([{ x: 15, y: 15 }]);
    expect(a.points).toEqual([{ x: 10, y: 20 }]);
  });
});
