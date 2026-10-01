import { useEffect, useRef, useState, type PointerEvent } from 'react';
import { X, Undo2, Trash2 } from 'lucide-react';
import type { Point } from '@margin/core';
import { clamp, pathData } from './model';
export type SignatureInput =
  | { kind: 'typed'; text: string }
  | { kind: 'drawn'; strokes: Point[][] };
export function SignatureDialog({
  open,
  disabled,
  ink,
  error,
  onClose,
  onInsert,
}: {
  open: boolean;
  disabled: boolean;
  ink: string;
  error?: string;
  onClose: () => void;
  onInsert: (value: SignatureInput) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [mode, setMode] = useState<'typed' | 'drawn'>('typed');
  const [name, setName] = useState('');
  const [limit, setLimit] = useState('');
  const [strokes, setStrokes] = useState<Point[][]>([]);
  const [current, setCurrent] = useState<Point[]>([]);
  const drawing = useRef<Point[] | null>(null);
  useEffect(() => {
    if (open) {
      setName('');
      setLimit('');
      setStrokes([]);
      setCurrent([]);
      drawing.current = null;
      setMode('typed');
      dialog.current?.showModal();
    } else dialog.current?.close();
  }, [open]);
  const point = (event: PointerEvent<SVGSVGElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return {
      x: clamp(((event.clientX - rect.left) / rect.width) * 400, 0, 400),
      y: clamp(((event.clientY - rect.top) / rect.height) * 150, 0, 150),
    };
  };
  const valid =
    mode === 'typed' ? Boolean(name.trim()) : strokes.some((stroke) => stroke.length > 1);
  return (
    <dialog
      ref={dialog}
      className="editor-dialog signature-dialog"
      aria-labelledby="signature-title"
      onCancel={onClose}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!disabled && valid && !drawing.current)
            onInsert(
              mode === 'typed' ? { kind: 'typed', text: name.trim() } : { kind: 'drawn', strokes },
            );
        }}
      >
        <div className="editor-dialog-heading">
          <h2 id="signature-title">Add a signature</h2>
          <button
            type="button"
            className="editor-icon"
            onClick={onClose}
            aria-label="Close signature editor"
          >
            <X size={18} />
          </button>
        </div>
        <p>
          Add a visual signature to this document. This is not a cryptographic digital signature or
          identity verification.
        </p>
        <div className="signature-modes" aria-label="Signature style">
          <button
            type="button"
            className={mode === 'typed' ? 'is-active' : ''}
            aria-pressed={mode === 'typed'}
            onClick={() => setMode('typed')}
          >
            Type a signature
          </button>
          <button
            type="button"
            className={mode === 'drawn' ? 'is-active' : ''}
            aria-pressed={mode === 'drawn'}
            onClick={() => setMode('drawn')}
          >
            Draw a signature
          </button>
        </div>
        {mode === 'typed' ? (
          <>
            <label className="signature-name">
              Signature name
              <input
                autoFocus
                maxLength={80}
                value={name}
                onChange={(e) => setName(e.target.value.replace(/[\r\n]/g, ' '))}
                placeholder="Your name"
              />
            </label>
            <div
              className="signature-preview"
              style={{ color: ink }}
              aria-label="Typed signature preview"
            >
              {name || 'Your signature'}
            </div>
          </>
        ) : (
          <>
            <svg
              className="signature-pad"
              style={{ color: ink }}
              viewBox="0 0 400 150"
              aria-label="Draw your signature. Use Type a signature for keyboard entry."
              role="img"
              onPointerDown={(event) => {
                if (disabled || event.button !== 0 || drawing.current) return;
                if (strokes.length >= 30) {
                  setLimit(
                    'This signature has reached 30 strokes. Undo a stroke or clear the drawing to continue.',
                  );
                  return;
                }
                setLimit('');
                event.currentTarget.setPointerCapture(event.pointerId);
                drawing.current = [point(event)];
                setCurrent(drawing.current);
              }}
              onPointerMove={(event) => {
                if (!drawing.current) return;
                const next = point(event),
                  last = drawing.current.at(-1)!;
                if (Math.hypot(next.x - last.x, next.y - last.y) < 1) return;
                if (drawing.current.length >= 2000) {
                  setLimit(
                    'This stroke reached its point limit. Lift the pointer, then start a new stroke or undo it.',
                  );
                  return;
                }
                drawing.current = [...drawing.current, next];
                setCurrent(drawing.current);
              }}
              onPointerUp={(event) => {
                if (!drawing.current) return;
                const completed =
                  drawing.current.length >= 2000
                    ? drawing.current
                    : [...drawing.current, point(event)];
                drawing.current = null;
                setStrokes((previous) => [...previous, completed]);
                setCurrent([]);
                if (event.currentTarget.hasPointerCapture(event.pointerId))
                  event.currentTarget.releasePointerCapture(event.pointerId);
              }}
              onPointerCancel={() => {
                drawing.current = null;
                setCurrent([]);
              }}
            >
              {[...strokes, current]
                .filter((stroke) => stroke.length)
                .map((stroke, index) => (
                  <path
                    key={index}
                    d={pathData(stroke)}
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                ))}
            </svg>
            <div className="signature-pad-actions">
              <button
                className="editor-secondary"
                type="button"
                disabled={!strokes.length}
                onClick={() => {
                  setStrokes((previous) => previous.slice(0, -1));
                  setLimit('');
                }}
              >
                <Undo2 size={14} />
                Undo stroke
              </button>
              <button
                className="editor-secondary"
                type="button"
                disabled={!strokes.length}
                onClick={() => {
                  setStrokes([]);
                  setLimit('');
                }}
              >
                <Trash2 size={14} />
                Clear drawing
              </button>
            </div>
          </>
        )}
        {limit && <p role="status">{limit}</p>}
        {error && <p role="alert">{error}</p>}
        <p className="signature-placement">
          Inserted at the center of the current page. Select and drag to reposition, or use arrow
          keys (Shift for larger steps).
        </p>
        <div className="editor-dialog-actions">
          <button type="button" className="editor-secondary" onClick={onClose}>
            Cancel
          </button>
          <button
            className="editor-primary"
            type="submit"
            disabled={disabled || !valid || current.length > 0}
          >
            Insert signature
          </button>
        </div>
      </form>
    </dialog>
  );
}
