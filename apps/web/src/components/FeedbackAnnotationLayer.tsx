import { useRef, useState, type PointerEvent } from 'react';
import type { Annotation, Point } from '@margin/core';
import { AnnotationGraphic } from '../editor/AnnotationLayer';
import { clamp, hitTest } from '../editor/model';

export type FeedbackTool =
  | 'select'
  | 'pen'
  | 'highlight'
  | 'text'
  | 'comment'
  | 'rectangle'
  | 'ellipse'
  | 'line'
  | 'stamp';
export interface FeedbackDrawing {
  annotations: readonly Annotation[];
  onChange?: (annotations: Annotation[]) => void;
  disabled?: boolean;
  tool: FeedbackTool;
  color: string;
  text: string;
}
interface Props extends FeedbackDrawing {
  pageIndex: number;
  width: number;
  height: number;
  scale: number;
}
const textTool = (tool: FeedbackTool) => ['text', 'comment', 'stamp'].includes(tool);
export function FeedbackAnnotationLayer({
  annotations,
  onChange,
  disabled,
  tool,
  color,
  text,
  pageIndex,
  width,
  height,
  scale,
}: Props) {
  const [preview, setPreview] = useState<Annotation | null>(null);
  const [selected, setSelected] = useState('');
  const drawing = useRef<{ pointer: number; start: Point; value: Annotation } | null>(null);
  const editable = !!onChange && !disabled;
  const page = annotations.filter((a) => a.pageIndex === pageIndex);
  const point = (event: PointerEvent<SVGSVGElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return {
      x: clamp((event.clientX - rect.left) / scale, 0, width),
      y: clamp((event.clientY - rect.top) / scale, 0, height),
    };
  };
  const make = (start: Point): Annotation | null => {
    if (tool === 'select' || annotations.length >= 500 || (textTool(tool) && !text.trim()))
      return null;
    const boxWidth = tool === 'comment' ? 24 : tool === 'stamp' ? 160 : 200;
    const boxHeight = tool === 'comment' ? 24 : tool === 'stamp' ? 36 : 50;
    const located = textTool(tool)
      ? {
          x: clamp(start.x, 0, Math.max(0, width - boxWidth)),
          y: clamp(start.y, 0, Math.max(0, height - boxHeight)),
        }
      : start;
    return {
      id: crypto.randomUUID(),
      pageIndex,
      type: tool,
      ...located,
      color,
      strokeWidth: tool === 'pen' ? 2 : 1.5,
      opacity: tool === 'highlight' ? 0.28 : 1,
      author: 'Teacher',
      createdAt: Date.now(),
      ...(textTool(tool)
        ? {
            text: text.trim().slice(0, tool === 'stamp' ? 160 : 1000),
            width: Math.min(boxWidth, width),
            height: Math.min(boxHeight, height),
          }
        : tool === 'pen' || tool === 'line'
          ? { points: [start] }
          : { width: 0, height: 0 }),
    };
  };
  const append = (annotation: Annotation) => {
    if (editable) {
      onChange!([...annotations, annotation]);
      setSelected(annotation.id);
    }
  };
  const move = (event: PointerEvent<SVGSVGElement>) => {
    const active = drawing.current;
    if (!active || active.pointer !== event.pointerId || !editable) return;
    const end = point(event),
      { start } = active;
    const value: Annotation =
      tool === 'pen'
        ? { ...active.value, points: [...(active.value.points ?? []).slice(0, 1998), end] }
        : tool === 'line'
          ? { ...active.value, points: [start, end] }
          : {
              ...active.value,
              x: Math.min(start.x, end.x),
              y: Math.min(start.y, end.y),
              width: Math.abs(end.x - start.x),
              height: Math.abs(end.y - start.y),
            };
    active.value = value;
    setPreview(value);
  };
  return (
    <>
      <svg
        className={`feedback-annotation-layer ${editable ? 'is-editable' : ''}`}
        width={width * scale}
        height={height * scale}
        viewBox={`0 0 ${width} ${height}`}
        role={editable ? 'application' : undefined}
        aria-label={
          editable
            ? 'Teacher feedback drawing area. Enter adds the selected mark at the page center; Delete removes the selected feedback mark.'
            : undefined
        }
        aria-hidden={!editable || undefined}
        tabIndex={editable ? 0 : undefined}
        onKeyDown={(event) => {
          if (!editable) return;
          if (event.key === 'Escape') {
            drawing.current = null;
            setPreview(null);
            setSelected('');
          }
          if (event.key === 'Delete' || event.key === 'Backspace') {
            if (selected) {
              event.preventDefault();
              onChange!(annotations.filter((a) => a.id !== selected));
              setSelected('');
            }
          }
          if (event.key === 'Enter' && tool !== 'select') {
            event.preventDefault();
            const mark = make({ x: width / 3, y: height / 3 });
            if (mark) {
              if (!textTool(tool)) {
                if (tool === 'pen' || tool === 'line')
                  mark.points = [
                    { x: width / 3, y: height / 3 },
                    { x: Math.min(width, width / 3 + 100), y: Math.min(height, height / 3 + 30) },
                  ];
                else {
                  mark.width = Math.min(120, width / 3);
                  mark.height = Math.min(45, height / 3);
                }
              }
              append(mark);
            }
          }
        }}
        onPointerDown={(event) => {
          if (!editable || event.button !== 0) return;
          const start = point(event);
          if (tool === 'select') {
            setSelected([...page].reverse().find((a) => hitTest(a, start))?.id ?? '');
            return;
          }
          const value = make(start);
          if (!value) return;
          event.preventDefault();
          event.currentTarget.focus();
          if (textTool(tool)) {
            append(value);
            return;
          }
          event.currentTarget.setPointerCapture(event.pointerId);
          drawing.current = { pointer: event.pointerId, start, value };
          setPreview(value);
        }}
        onPointerMove={move}
        onPointerUp={(event) => {
          const active = drawing.current;
          if (!active || active.pointer !== event.pointerId) return;
          move(event);
          const value = drawing.current?.value;
          drawing.current = null;
          setPreview(null);
          if (event.currentTarget.hasPointerCapture(event.pointerId))
            event.currentTarget.releasePointerCapture(event.pointerId);
          if (value) append(value);
        }}
        onPointerCancel={() => {
          drawing.current = null;
          setPreview(null);
        }}
      >
        {page.map((a) => (
          <AnnotationGraphic key={a.id} annotation={a} selected={editable && selected === a.id} />
        ))}
        {preview && editable && <AnnotationGraphic annotation={preview} />}
      </svg>
    </>
  );
}
