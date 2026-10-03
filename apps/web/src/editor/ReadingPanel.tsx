import { useEffect, useId, useRef, useState, type ClipboardEvent } from 'react';
import { Copy, Focus, Pause, Play, RotateCcw, Square, Volume2 } from 'lucide-react';
import { useReadAloud } from './useReadAloud';
import './reading.css';

export type ReadingTint = 'none' | 'sepia' | 'blue' | 'rose' | 'mint';
export interface ReadingAppearance {
  tint: ReadingTint;
  ruler: boolean;
  rulerPosition: number;
  rulerHeight: number;
}
export const defaultReadingAppearance: ReadingAppearance = {
  tint: 'none',
  ruler: false,
  rulerPosition: 25,
  rulerHeight: 80,
};

interface Props {
  text: string;
  contextKey: string;
  pageNumber: number;
  loading: boolean;
  extractionError: string;
  canCopy: boolean;
  focusMode: boolean;
  onFocusMode: (value: boolean) => void;
  appearance: ReadingAppearance;
  onAppearance: (value: ReadingAppearance) => void;
  onNotice: (message: string) => void;
  onError: (message: string) => void;
}

export function ReadingPanel({
  text,
  contextKey,
  pageNumber,
  loading,
  extractionError,
  canCopy,
  focusMode,
  onFocusMode,
  appearance,
  onAppearance,
  onNotice,
  onError,
}: Props) {
  const reader = useReadAloud(text, contextKey);
  const copyNoticeId = useId();
  const [textSize, setTextSize] = useState(100);
  const [follow, setFollow] = useState(true);
  const textArea = useRef<HTMLDivElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const active = reader.status === 'playing' || reader.status === 'starting';
  const paused = reader.status === 'paused';
  const canPlay = !!text.trim() && !loading && !extractionError && reader.voices.length > 0;
  useEffect(() => heading.current?.focus(), []);
  useEffect(() => {
    const area = textArea.current;
    if (!follow || !area) return;
    const current =
      area.querySelector('[data-reading-word]') ?? area.querySelector('[data-reading-sentence]');
    if (!current) return;
    const line = current.getBoundingClientRect(),
      box = area.getBoundingClientRect();
    if (line.top < box.top || line.bottom > box.bottom) area.scrollTop += line.top - box.top - 24;
  }, [follow, reader.sentence, reader.word]);

  const sentence = reader.sentence;
  const word =
    reader.word &&
    sentence &&
    reader.word.start >= sentence.start &&
    reader.word.end <= sentence.end
      ? reader.word
      : null;
  const speechMessage =
    reader.error ||
    (!reader.supported
      ? 'Read aloud is unavailable in this browser. You can still use the reading view.'
      : !reader.voices.length
        ? 'No local voices are available. Enable a voice on your device, then refresh the list.'
        : '');
  const restrictClipboard = (event: ClipboardEvent<HTMLDivElement>) => {
    if (canCopy) return;
    // Honor the document's ordinary clipboard restriction without hiding accessible text.
    // This is a user-interface restriction, not protection against privileged DOM access.
    event.preventDefault();
    event.clipboardData.clearData();
    onNotice('Copying text is restricted by this PDF.');
  };

  return (
    <div
      className="reading-panel"
      onKeyDown={(event) => {
        if (event.key === 'Escape' && focusMode && !event.defaultPrevented) {
          event.preventDefault();
          event.stopPropagation();
          onFocusMode(false);
        }
      }}
    >
      <div className="reading-intro">
        <div>
          <span>PAGE {pageNumber}</span>
          <h2 ref={heading} tabIndex={-1}>
            Read this page
          </h2>
        </div>
        <Volume2 size={23} aria-hidden="true" />
      </div>
      <div className="reading-playback" role="group" aria-label="Read aloud controls">
        <button
          className="editor-primary"
          disabled={!canPlay}
          onClick={() => (active ? reader.pause() : reader.play())}
        >
          {active ? <Pause size={16} /> : <Play size={16} />}
          {active ? 'Pause reading' : paused ? 'Resume reading' : 'Play page'}
        </button>
        <button className="editor-secondary" disabled={!active && !paused} onClick={reader.stop}>
          <Square size={14} />
          Stop
        </button>
        <span className="reading-status" role="status">
          {loading
            ? 'Loading text'
            : extractionError
              ? 'Text unavailable'
              : !text.trim()
                ? 'No text'
                : reader.error || !reader.supported || !reader.voices.length
                  ? 'Read aloud unavailable'
                  : reader.status === 'starting'
                    ? 'Starting…'
                    : active
                      ? 'Reading'
                      : paused
                        ? 'Paused'
                        : 'Ready'}
        </span>
      </div>
      <div className="reading-voice-controls">
        <label>
          Voice on this device
          <select
            aria-label="Reading voice"
            value={reader.voiceURI}
            disabled={!reader.voices.length}
            onChange={(e) => reader.setVoiceURI(e.target.value)}
          >
            {!reader.voices.length ? (
              <option value="">No local voices</option>
            ) : !reader.voiceURI ? (
              <option value="" disabled>
                Choose a local voice
              </option>
            ) : null}
            {reader.voices.map((voice) => (
              <option key={voice.voiceURI} value={voice.voiceURI}>
                {voice.name} · {voice.lang}
              </option>
            ))}
          </select>
        </label>
        <label>
          Speed
          <select
            aria-label="Reading speed"
            value={reader.rate}
            onChange={(e) => reader.setRate(+e.target.value)}
          >
            {[0.5, 0.75, 1, 1.25, 1.5, 2].map((speed) => (
              <option key={speed} value={speed}>
                {speed}×
              </option>
            ))}
          </select>
        </label>
      </div>
      {speechMessage ? (
        <p className="reading-message" role={reader.error ? 'alert' : undefined}>
          {speechMessage}
        </p>
      ) : null}
      {!reader.voices.length && reader.supported ? (
        <button className="reading-text-button" onClick={reader.refreshVoices}>
          <RotateCcw size={13} />
          Refresh voices
        </button>
      ) : null}
      <p className="reading-caption">
        Uses a local device voice. Changing voice or speed restarts the current sentence.
      </p>
      <details className="reading-appearance">
        <summary>Reading appearance</summary>
        <div className="reading-appearance-controls">
          <button
            className="editor-secondary"
            aria-pressed={focusMode}
            onClick={() => onFocusMode(!focusMode)}
          >
            <Focus size={15} />
            Focus mode
          </button>
          <div className="reading-voice-controls">
            <label>
              Color overlay
              <select
                aria-label="Reading color overlay"
                value={appearance.tint}
                onChange={(e) =>
                  onAppearance({ ...appearance, tint: e.target.value as ReadingTint })
                }
              >
                <option value="none">None</option>
                <option value="sepia">Warm cream</option>
                <option value="blue">Soft blue</option>
                <option value="rose">Rose</option>
                <option value="mint">Mint</option>
              </select>
            </label>
            <label>
              Text size
              <select
                aria-label="Reading text size"
                value={textSize}
                onChange={(e) => setTextSize(+e.target.value)}
              >
                <option value="100">100%</option>
                <option value="125">125%</option>
                <option value="150">150%</option>
              </select>
            </label>
          </div>
          <label className="reading-check">
            <input
              type="checkbox"
              checked={appearance.ruler}
              onChange={(e) => onAppearance({ ...appearance, ruler: e.target.checked })}
            />
            Reading ruler on the PDF
          </label>
          {appearance.ruler ? (
            <>
              <label className="reading-range">
                Ruler position <output>{appearance.rulerPosition}%</output>
                <input
                  aria-label="Reading ruler position"
                  type="range"
                  min="0"
                  max="100"
                  step="1"
                  value={appearance.rulerPosition}
                  onChange={(e) => onAppearance({ ...appearance, rulerPosition: +e.target.value })}
                />
              </label>
              <label>
                Ruler height
                <select
                  aria-label="Reading ruler height"
                  value={appearance.rulerHeight}
                  onChange={(e) => onAppearance({ ...appearance, rulerHeight: +e.target.value })}
                >
                  <option value="48">One line</option>
                  <option value="80">A few lines</option>
                  <option value="120">A paragraph</option>
                </select>
              </label>
            </>
          ) : null}
          <p className="reading-caption">Appearance changes apply to this view.</p>
        </div>
      </details>
      <div className="reading-text-heading">
        <h3>Page text</h3>
        <button
          className="reading-text-button"
          disabled={!text || !canCopy}
          title={!canCopy ? 'Copying text is restricted by this PDF.' : 'Copy page text'}
          onClick={() =>
            void navigator.clipboard
              .writeText(text)
              .then(() => onNotice('Page text copied.'))
              .catch(() => onError('Clipboard permission was denied.'))
          }
        >
          <Copy size={13} />
          Copy text
        </button>
      </div>
      {text && !canCopy ? (
        <p id={copyNoticeId} className="reading-copy-notice">
          Copying is restricted by this PDF. The reading view remains available for accessibility.
        </p>
      ) : null}
      <label className="reading-check reading-follow">
        <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} />
        Follow spoken text
      </label>
      <div
        ref={textArea}
        className={`reading-page-text reading-tint-${appearance.tint}`}
        style={{ fontSize: `${(16 * textSize) / 100}px` }}
        tabIndex={0}
        role="region"
        aria-label={`Page ${pageNumber} text`}
        aria-describedby={text && !canCopy ? copyNoticeId : undefined}
        aria-busy={loading}
        onCopy={restrictClipboard}
        onCut={restrictClipboard}
      >
        {loading ? (
          <p className="reading-empty" role="status">
            Reading page text…
          </p>
        ) : extractionError ? (
          <p className="reading-empty" role="alert">
            {extractionError}
          </p>
        ) : !text.trim() ? (
          <p className="reading-empty">
            This page has no selectable text. Scanned pages need OCR, which is not connected in this
            workspace.
          </p>
        ) : sentence ? (
          <>
            {text.slice(0, sentence.start)}
            <span data-reading-sentence="true" className="reading-current-sentence">
              {word ? (
                <>
                  {text.slice(sentence.start, word.start)}
                  <mark data-reading-word="true">{text.slice(word.start, word.end)}</mark>
                  {text.slice(word.end, sentence.end)}
                </>
              ) : (
                text.slice(sentence.start, sentence.end)
              )}
            </span>
            {text.slice(sentence.end)}
          </>
        ) : (
          text
        )}
      </div>
      <p className="reading-caption reading-tracking-note">
        Word tracking depends on the selected voice. Extracted text order may differ from the page
        layout.
      </p>
    </div>
  );
}

export function ReadingPageOverlay({
  appearance,
  pageHeight,
}: {
  appearance: ReadingAppearance;
  pageHeight: number;
}) {
  const height = Math.min(appearance.rulerHeight, pageHeight);
  return (
    <div className={`reading-page-overlay reading-tint-${appearance.tint}`} aria-hidden="true">
      {appearance.ruler ? (
        <div
          className="reading-ruler"
          style={{
            height,
            top: (Math.max(0, pageHeight - height) * appearance.rulerPosition) / 100,
          }}
        />
      ) : null}
    </div>
  );
}
