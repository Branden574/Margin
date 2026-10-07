import { describe, expect, it } from 'vitest';
import type { Annotation, AnnotationTool } from '@margin/core';
import {
  assertAssignmentEdit,
  assignmentToolAllowed,
  type AssignmentEditingPolicy,
} from '../apps/web/src/editor/assignmentEditing';

const policy = (
  allowedTools: readonly AnnotationTool[],
  readOnly = false,
): AssignmentEditingPolicy => ({ allowedTools, readOnly });
const annotation = (partial: Partial<Annotation> = {}): Annotation => ({
  id: '12345678-1234-4000-8000-123456789abc',
  pageIndex: 0,
  type: 'text',
  x: 10,
  y: 20,
  color: '#123456',
  strokeWidth: 2,
  opacity: 1,
  createdAt: 1,
  author: 'You',
  text: 'Retained synthetic draft',
  ...partial,
});

describe('assignment editor policy gates', () => {
  it('leaves ordinary local editing and structural history unrestricted', () => {
    const item = annotation({ type: 'signature', fontSize: 28, lineStyle: 'dashed' });
    expect(() => assertAssignmentEdit([], [item], undefined, true)).not.toThrow();
    expect(assignmentToolAllowed(undefined, 'signature')).toBe(true);
  });
  it('allows selection independently of annotation permissions and read-only state', () => {
    expect(assignmentToolAllowed(policy([], true), 'select')).toBe(true);
    for (const tool of ['text', 'pen', 'eraser'] as const)
      expect(assignmentToolAllowed(policy([tool], true), tool)).toBe(false);
  });
  it.each(['signature', 'stamp', 'arrow'] as const)('never enables unsupported %s', (type) => {
    expect(assignmentToolAllowed(policy(['text', 'pen', 'arrow']), type)).toBe(false);
    const item = annotation({ type });
    expect(() => assertAssignmentEdit([], [item], policy(['text', 'pen', 'arrow']))).toThrow(
      'does not allow',
    );
  });
  it('requires permission for additions, pointer moves, keyboard moves and text edits', () => {
    const item = annotation();
    for (const next of [[item], [{ ...item, x: 11 }], [{ ...item, text: 'Edited' }]]) {
      expect(() =>
        assertAssignmentEdit(next[0] === item ? [] : [item], next, policy(['eraser'])),
      ).toThrow('text tool');
    }
    expect(() =>
      assertAssignmentEdit([item], [{ ...item, x: 11 }], policy(['text'])),
    ).not.toThrow();
  });
  it('requires eraser for delete and undo-of-creation without changing either snapshot', () => {
    const item = Object.freeze(annotation());
    const before = Object.freeze([item]);
    const after = Object.freeze([] as Annotation[]);
    expect(() => assertAssignmentEdit(before, after, policy(['text']))).toThrow('erasing');
    expect(() => assertAssignmentEdit(before, after, policy(['eraser']))).not.toThrow();
    expect(before).toEqual([item]);
    expect(after).toEqual([]);
  });
  it('requires the original tool when undo restores a deletion', () => {
    const original = annotation();
    expect(() => assertAssignmentEdit([], [original], policy(['eraser']))).toThrow('text tool');
    expect(() => assertAssignmentEdit([], [original], policy(['text', 'eraser']))).not.toThrow();
  });
  it('allows unchanged annotations when their tool is unavailable but blocks changing them', () => {
    const original = annotation();
    const next = annotation({ id: crypto.randomUUID(), type: 'rectangle', width: 50, height: 20 });
    expect(() =>
      assertAssignmentEdit([original], [original, next], policy(['rectangle'])),
    ).not.toThrow();
    expect(() =>
      assertAssignmentEdit([original], [{ ...original, x: 99 }, next], policy(['rectangle'])),
    ).toThrow('text tool');
  });
  it('refuses mixed permitted and forbidden edits atomically without simplifying appearance', () => {
    const original = Object.freeze(annotation());
    const second = Object.freeze(
      annotation({
        id: crypto.randomUUID(),
        type: 'line',
        lineStyle: 'dashed',
        points: [
          { x: 1, y: 2 },
          { x: 3, y: 4 },
        ],
      }),
    );
    const next = Object.freeze([{ ...original, text: 'Allowed change' }, second]);
    expect(() => assertAssignmentEdit([original], next, policy(['text', 'line']))).toThrow(
      'solid lines',
    );
    expect(second.lineStyle).toBe('dashed');
    expect(original.text).toBe('Retained synthetic draft');
  });
  it.each([
    { lineStyle: 'dotted' },
    { fontSize: 18 },
    { strokes: [[{ x: 1, y: 2 }]] },
    { text: 'x'.repeat(16_001) },
    { type: 'pen', points: Array.from({ length: 2001 }, () => ({ x: 1, y: 2 })) },
    { rotation: 360 },
    { x: Infinity },
    { unknownAppearance: 'never drop' },
  ] as Partial<Annotation>[])('retains unsupported appearance or oversized draft %j', (change) => {
    const item = annotation(change);
    const original = structuredClone(item);
    expect(() => assertAssignmentEdit([], [item], policy(['text', 'pen']))).toThrow();
    expect(item).toEqual(original);
  });
  it('accepts solid supported shapes and real pressure points without modifying input', () => {
    const item = annotation({
      type: 'pen',
      lineStyle: 'solid',
      text: undefined,
      points: [
        { x: 1, y: 2, pressure: 0.5 },
        { x: 3, y: 4, pressure: 0.7 },
      ],
    });
    const before = structuredClone(item);
    expect(() => assertAssignmentEdit([], [item], policy(['pen']))).not.toThrow();
    expect(item).toEqual(before);
  });
  it('blocks mutations during synchronization while retaining the current and proposed draft', () => {
    const before = annotation();
    const after = { ...before, text: 'Unsaved newer draft' };
    const paused = policy(['text', 'eraser'], true);
    for (const next of [[], [after]])
      expect(() => assertAssignmentEdit([before], next, paused)).toThrow('paused');
    expect(() => assertAssignmentEdit([before], [before], paused)).not.toThrow();
    expect(after.text).toBe('Unsaved newer draft');
  });
  it('blocks page/form/crop/merge history even when annotation content is unchanged', () => {
    const item = annotation();
    expect(() => assertAssignmentEdit([item], [item], policy(['text', 'eraser']), true)).toThrow(
      'pages and form fields',
    );
  });
});
