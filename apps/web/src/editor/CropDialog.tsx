import { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import type { Annotation } from '@margin/core';
import { PdfCanvas } from './PdfCanvas';
import { AnnotationGraphic } from './AnnotationLayer';
import { CROP_MIN_SIZE, type CropMargins, type CropPageInfo, type CropRequest } from './cropTypes';
import './crop.css';

const edges = ['top', 'right', 'bottom', 'left'] as const;
export function CropDialog({
  pdf,
  info,
  annotations,
  busy,
  error,
  onApply,
  onClose,
  onDirtyChange,
}: {
  pdf: PDFDocumentProxy;
  info: CropPageInfo;
  annotations: Annotation[];
  busy: boolean;
  error: string;
  onApply: (request: CropRequest) => Promise<void>;
  onClose: () => void;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [values, setValues] = useState({ top: '0', right: '0', bottom: '0', left: '0' });
  const [mode, setMode] = useState<'margins' | 'reset'>('margins');
  const [discard, setDiscard] = useState(false);
  const margins = Object.fromEntries(
    edges.map((edge) => [edge, values[edge].trim() ? Number(values[edge]) : NaN]),
  ) as unknown as CropMargins;
  const width = info.width - margins.left - margins.right;
  const height = info.height - margins.top - margins.bottom;
  const valid =
    edges.every((edge) => Number.isFinite(margins[edge]) && margins[edge] >= 0) &&
    width >= CROP_MIN_SIZE &&
    height >= CROP_MIN_SIZE;
  const canReset = (['x', 'y', 'width', 'height'] as const).some(
    (key) => info.cropBox[key] !== info.mediaBox[key],
  );
  const dirty = mode === 'reset' ? canReset : edges.some((edge) => values[edge] !== '0');
  const changed = mode === 'reset' ? canReset : valid && edges.some((edge) => margins[edge] > 0);
  const scale = Math.min(310 / info.width, 355 / info.height);
  const fullWidth =
    info.userUnit * (info.rotation % 180 === 0 ? info.mediaBox.width : info.mediaBox.height);
  const fullHeight =
    info.userUnit * (info.rotation % 180 === 0 ? info.mediaBox.height : info.mediaBox.width);
  useEffect(() => {
    onDirtyChange(dirty);
  }, [dirty, onDirtyChange]);
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => {
      element?.close();
    };
  }, []);
  const close = () => {
    if (!busy) {
      if (dirty) setDiscard(true);
      else onClose();
    }
  };
  const chooseMode = (next: 'margins' | 'reset') => {
    setMode(next);
    setDiscard(false);
  };
  return (
    <dialog
      ref={dialog}
      className="editor-dialog crop-dialog"
      aria-labelledby="crop-title"
      onCancel={(event) => {
        event.preventDefault();
        close();
      }}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (!busy && changed)
            void onApply(mode === 'reset' ? { kind: 'reset' } : { kind: 'margins', margins });
        }}
      >
        <div className="editor-dialog-heading">
          <h2 id="crop-title">Crop page {info.pageIndex + 1}</h2>
          <button
            type="button"
            className="editor-icon"
            aria-label="Close crop editor"
            disabled={busy}
            onClick={close}
          >
            <X size={18} />
          </button>
        </div>
        <p>
          Adjust the visible edges of this page. Cropping hides content; it does not remove it from
          the file. You can undo this change or restore the full page.
        </p>
        <div className="crop-layout">
          <figure className="crop-preview">
            <div
              className="crop-preview-paper"
              style={{ width: info.width * scale, aspectRatio: `${info.width} / ${info.height}` }}
            >
              <PdfCanvas pdf={pdf} pageIndex={info.pageIndex} scale={scale} />
              <svg viewBox={`0 0 ${info.width} ${info.height}`} aria-hidden="true">
                {annotations.map((annotation) => (
                  <AnnotationGraphic key={annotation.id} annotation={annotation} />
                ))}
                {mode === 'margins' && valid ? (
                  <>
                    <path
                      className="crop-shade"
                      fillRule="evenodd"
                      d={`M0 0H${info.width}V${info.height}H0Z M${margins.left} ${margins.top}V${info.height - margins.bottom}H${info.width - margins.right}V${margins.top}Z`}
                    />
                    <rect
                      className="crop-boundary"
                      x={margins.left}
                      y={margins.top}
                      width={width}
                      height={height}
                      vectorEffect="non-scaling-stroke"
                    />
                  </>
                ) : null}
              </svg>
            </div>
            <figcaption>
              {mode === 'reset'
                ? 'Current view. Restore full page will also reveal content outside these edges.'
                : 'Shaded edges will be hidden. The outlined area stays visible.'}
            </figcaption>
          </figure>
          <div className="crop-controls">
            <fieldset className="crop-method" disabled={busy}>
              <legend>Visible area</legend>
              <label>
                <input
                  type="radio"
                  name="crop-mode"
                  value="margins"
                  checked={mode === 'margins'}
                  onChange={() => chooseMode('margins')}
                />{' '}
                Adjust edges
              </label>
              <label>
                <input
                  type="radio"
                  name="crop-mode"
                  value="reset"
                  checked={mode === 'reset'}
                  onChange={() => chooseMode('reset')}
                />{' '}
                Restore full page
              </label>
            </fieldset>
            {mode === 'margins' ? (
              <>
                <p className="crop-units" id="crop-units">
                  Trim in points from each current edge. 72 points = 1 inch.
                </p>
                <div className="crop-margins">
                  {edges.map((edge) => (
                    <label key={edge} htmlFor={`crop-${edge}`}>
                      {edge[0].toUpperCase() + edge.slice(1)}
                      <input
                        id={`crop-${edge}`}
                        type="number"
                        min="0"
                        step="any"
                        required
                        value={values[edge]}
                        disabled={busy}
                        aria-describedby="crop-units"
                        onChange={(event) => {
                          setValues((old) => ({ ...old, [edge]: event.target.value }));
                          setDiscard(false);
                        }}
                      />
                    </label>
                  ))}
                </div>
                {!valid ? (
                  <p className="crop-error" role="alert">
                    Use nonnegative margins and leave at least 1 point of width and height.
                  </p>
                ) : null}
              </>
            ) : (
              <p>
                {canReset
                  ? 'Restore the document’s complete page dimensions.'
                  : 'This page already shows its full area.'}
              </p>
            )}
            <div className="crop-dimensions" role="status" aria-live="polite">
              <span>Current size</span>
              <strong>
                {info.width.toFixed(1)} × {info.height.toFixed(1)} pt
              </strong>
              <span>New size</span>
              <strong>
                {mode === 'reset'
                  ? `${fullWidth.toFixed(1)} × ${fullHeight.toFixed(1)} pt`
                  : valid
                    ? `${width.toFixed(1)} × ${height.toFixed(1)} pt`
                    : 'Check margins'}
              </strong>
            </div>
          </div>
        </div>
        {error ? (
          <p className="crop-error" role="alert">
            {error}
          </p>
        ) : null}
        {discard ? (
          <div className="crop-discard" role="alert">
            <p>Discard these crop settings?</p>
            <button
              type="button"
              className="editor-secondary"
              disabled={busy}
              onClick={() => {
                setDiscard(false);
                dialog.current?.querySelector<HTMLInputElement>('input:checked')?.focus();
              }}
            >
              Keep editing
            </button>
            <button
              type="button"
              className="editor-secondary"
              disabled={busy}
              onClick={() => {
                if (!busy) onClose();
              }}
            >
              Discard changes
            </button>
          </div>
        ) : null}
        <div className="editor-dialog-actions">
          <button type="button" className="editor-secondary" disabled={busy} onClick={close}>
            Cancel
          </button>
          <button type="submit" className="editor-primary" disabled={busy || !changed}>
            {busy ? 'Saving page…' : mode === 'reset' ? 'Restore full page' : 'Apply crop'}
          </button>
        </div>
      </form>
    </dialog>
  );
}
