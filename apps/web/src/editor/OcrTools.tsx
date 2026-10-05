import { ScanText, X, Highlighter, MousePointer2 } from 'lucide-react';
import type { usePageOcr } from './usePageOcr';
import './ocr.css';
export function OcrTools({
  ocr,
  disabled,
  selecting,
  onSelecting,
  canSelect,
  canHighlight,
  hasSelection,
  onHighlight,
}: {
  ocr: ReturnType<typeof usePageOcr>;
  disabled: boolean;
  selecting: boolean;
  onSelecting: (value: boolean) => void;
  canSelect: boolean;
  canHighlight: boolean;
  hasSelection: boolean;
  onHighlight: () => void;
}) {
  return (
    <section className="ocr-tools" aria-label="Text recognition">
      <div className="ocr-heading">
        <ScanText size={17} />
        <strong>{ocr.record ? 'Recognized on this device' : 'Make this scan readable'}</strong>
      </div>
      <p>
        Printed English · runs on your device. First use downloads a 23.4 MB recognition pack. Your
        page stays here.
      </p>
      <div className="ocr-actions">
        <button
          className="editor-secondary"
          disabled={disabled || ocr.loading || ocr.active}
          onClick={() => void ocr.recognize()}
        >
          {ocr.record ? 'Recognize again' : 'Recognize this page'}
        </button>
        {ocr.active ? (
          <button className="editor-secondary" onClick={ocr.cancel}>
            <X size={14} />
            Cancel recognition
          </button>
        ) : null}
      </div>
      {ocr.message ? <p role="status">{ocr.message}</p> : null}
      {ocr.error ? (
        <p role="alert" className="ocr-error">
          {ocr.error}
        </p>
      ) : null}
      {ocr.offlineReady === true ? (
        <p>Recognition pack verified and available offline.</p>
      ) : ocr.offlineReady === false ? (
        <p>Recognition pack verified. This development preview still needs its local server.</p>
      ) : null}
      {ocr.record ? (
        <>
          <p>Recognition can make mistakes. Check the original page before relying on this text.</p>
          <button
            className="reading-text-button"
            aria-pressed={selecting}
            disabled={disabled || !canSelect}
            onClick={() => onSelecting(!selecting)}
          >
            <MousePointer2 size={14} />
            {selecting ? 'Finish selecting text' : 'Select recognized text'}
          </button>
          {selecting ? (
            <div className="ocr-selection-actions">
              <p>Drag across words on the page, or focus the text and use Shift + arrow keys.</p>
              <button
                className="editor-secondary"
                disabled={disabled || !hasSelection || !canHighlight}
                onMouseDown={(e) => e.preventDefault()}
                onClick={onHighlight}
              >
                <Highlighter size={14} />
                Highlight selection
              </button>
              {!canHighlight ? <p>This PDF restricts annotation changes.</p> : null}
            </div>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
