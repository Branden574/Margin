'use client';
import { useEffect, useId, useRef, useState } from 'react';
import {
  ArrowRight,
  Check,
  ChevronLeft,
  ChevronRight,
  Command,
  FileText,
  Highlighter,
  LockKeyhole,
  MessageSquare,
  Monitor,
  Search,
  Send,
  Type,
  Wifi,
  WifiOff,
  X,
} from 'lucide-react';
import { ProductWindow } from './ProductWindow';
import { useSequence } from './Motion';
import { splitMatches } from '../lib/demo-text';

export function PageScrubber() {
  const [page, setPage] = useState(147);
  const pages = [Math.max(1, page - 1), page, Math.min(347, page + 1)];
  return (
    <div className="scrubber-demo">
      <ProductWindow title="347-page textbook.pdf" dark>
        <div className="virtual-pages">
          {pages.map((number, index) => (
            <div
              className={`virtual-page ${index === 1 ? 'current' : ''}`}
              key={`${index}${number}`}
            >
              <span>THE LIVING WORLD / CHAPTER {Math.ceil(number / 18)}</span>
              <h3>{index === 1 ? 'A new perspective.' : 'Keep exploring.'}</h3>
              <div className="text-lines" />
              <div className="page-diagram">
                <i />
                <i />
                <i />
              </div>
              <div className="text-lines" />
              <b>{number}</b>
            </div>
          ))}
        </div>
        <div className="scrubber-controls">
          <label htmlFor="page-scrubber">Jump through the example</label>
          <div>
            <button
              className="icon-control"
              aria-label="Previous example page"
              disabled={page === 1}
              onClick={() => setPage(page - 1)}
            >
              <ChevronLeft size={17} />
            </button>
            <input
              id="page-scrubber"
              type="range"
              min={1}
              max={347}
              value={page}
              onChange={(e) => setPage(Number(e.target.value))}
              aria-valuetext={`Page ${page} of 347`}
            />
            <button
              className="icon-control"
              aria-label="Next example page"
              disabled={page === 347}
              onClick={() => setPage(page + 1)}
            >
              <ChevronRight size={17} />
            </button>
            <output aria-live="polite">{page} / 347</output>
          </div>
          <button className="text-button" onClick={() => setPage(page === 302 ? 147 : 302)}>
            Jump to page {page === 302 ? 147 : 302} <ArrowRight size={14} />
          </button>
        </div>
      </ProductWindow>
      <p className="demo-caption">
        Illustrative navigation · three page previews, not a loaded 347-page PDF. Hardware
        benchmarks are pending.
      </p>
    </div>
  );
}
export function RecoveryDemo() {
  const [text, setText] = useState('Photosynthesis converts light energy into a little more life.');
  const [saved, setSaved] = useState(text);
  const [closed, setClosed] = useState(false);
  const [offline, setOffline] = useState(false);
  const [recovered, setRecovered] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setSaved(text), 400);
    return () => clearTimeout(timer);
  }, [text]);
  return (
    <div>
      <ProductWindow
        title="Your ideas deserve a safe landing"
        toolbar={
          <div className="recovery-toolbar">
            <button
              className="text-button"
              aria-pressed={offline}
              onClick={() => setOffline(!offline)}
            >
              {offline ? <WifiOff size={15} /> : <Wifi size={15} />}{' '}
              {offline ? 'Offline illustration' : 'Online illustration'}
            </button>
            <span aria-live="polite">
              {saved !== text ? (
                'Saving demo…'
              ) : (
                <>
                  <Check size={14} />
                  Saved in this demo
                </>
              )}
            </span>
          </div>
        }
      >
        <div className={closed ? 'recovery-page closed' : 'recovery-page'}>
          {closed ? (
            <>
              <LockKeyhole size={38} strokeWidth={1.2} />
              <h3>A moment away.</h3>
              <p>In Margin, unlock your vault to return to your saved work.</p>
              <button
                className="button primary"
                onClick={() => {
                  setText(saved);
                  setClosed(false);
                  setRecovered(true);
                }}
              >
                Reopen illustration <ArrowRight size={15} />
              </button>
            </>
          ) : (
            <>
              <span className="paper-kicker">MY BIOLOGY NOTES</span>
              <h3>A thought worth keeping.</h3>
              <label>
                <span className="sr-only">Write in the recovery illustration</span>
                <textarea
                  value={text}
                  onChange={(e) => {
                    setText(e.target.value);
                    setRecovered(false);
                  }}
                  maxLength={240}
                />
              </label>
              <p className="recovery-state" role="status">
                {recovered
                  ? 'Your demo note is still here.'
                  : offline
                    ? 'Keep writing. Local editing does not depend on Wi-Fi.'
                    : 'Try writing a note, then simulate closing the window.'}
              </p>
              <button
                className="button secondary"
                disabled={saved !== text}
                onClick={() => setClosed(true)}
              >
                Simulate closing <X size={15} />
              </button>
            </>
          )}
        </div>
      </ProductWindow>
      <div className="demo-caption">
        Illustration held in this page’s memory. The actual app uses encrypted IndexedDB and
        requires unlocking after reload; cloud annotation sync is planned.
      </div>
    </div>
  );
}
export function CollaborationDemo() {
  const [reply, setReply] = useState('I looked at how the chloroplasts use light.');
  const [sent, setSent] = useState(false);
  return (
    <ProductWindow title="A shared thought · coming soon concept">
      <div className="collaboration-demo">
        <div className="presence-list">
          <span>MR</span>
          <span>A</span>
          <span>J</span>
          <span>M</span>
          <small>Fictional participants</small>
        </div>
        <div className="collaboration-paper">
          <span className="paper-kicker">QUESTION 03</span>
          <h3>What would you change?</h3>
          <p>A good question has room for more than one perspective.</p>
          <span className="demo-cursor cursor-alex">↖ Alex</span>
          <span className="demo-cursor cursor-maya">↖ Maya</span>
          <span className="demo-cursor cursor-jordan">↖ Jordan</span>
        </div>
        <div className="collaboration-thread">
          <strong>
            Ms. Rivera <span>Illustrative teacher</span>
          </strong>
          <p>Can you explain how you got this answer?</p>
          {sent ? (
            <div className="student-reply">
              <strong>Alex · sample reply</strong>
              <p>{reply}</p>
              <span>Preview only · not sent</span>
              <button className="text-button" onClick={() => setSent(false)}>
                Edit reply
              </button>
            </div>
          ) : (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                if (reply.trim()) setSent(true);
              }}
            >
              <input
                aria-label="Try a sample collaboration reply"
                value={reply}
                onChange={(e) => setReply(e.target.value)}
                maxLength={120}
              />
              <button aria-label="Preview reply" className="icon-control">
                <Send size={17} />
              </button>
            </form>
          )}
        </div>
      </div>
    </ProductWindow>
  );
}
export function OCRDemo() {
  const [recognized, setRecognized] = useState(false);
  const [query, setQuery] = useState('energy');
  const [translated, setTranslated] = useState(false);
  const text = translated
    ? 'Las plantas convierten la luz en energía. Cada hoja cuenta una historia.'
    : 'Plants turn sunlight into energy. Every leaf tells a story.';
  return (
    <div className="ocr-demo">
      <div className="scan-page">
        <span className="paper-kicker">FIELD NOTES / MONDAY</span>
        <h3>Follow the sunlight.</h3>
        <div
          className={recognized ? 'scan-paragraph recognized' : 'scan-paragraph'}
          aria-label={recognized ? 'Sample recognized text' : 'Illustrative unselectable scan'}
        >
          {recognized && query && !translated ? (
            <>
              {splitMatches(text, query).map((part, index) => (
                <span key={index} className={part.matched ? 'matched-word' : ''}>
                  {part.text}
                </span>
              ))}
            </>
          ) : (
            text
          )}
        </div>
        <div className="scan-sketch" aria-hidden="true">
          ☼<span>↘</span>♧
        </div>
        <div className="text-lines" />
      </div>
      <div className="ocr-actions">
        <span className="status-stamp">ILLUSTRATIVE PREVIEW</span>
        <h3>
          A scan with
          <br />a second life.
        </h3>
        <p>
          This illustration uses prepared text. The local editor recognizes printed English scans,
          one page at a time.
        </p>
        <button className="button primary" onClick={() => setRecognized(!recognized)}>
          {recognized ? 'Reset illustration' : 'Reveal sample text'} <Search size={16} />
        </button>
        {recognized && (
          <>
            <label>
              Search the sample
              <input value={query} onChange={(e) => setQuery(e.target.value)} maxLength={30} />
            </label>
            <button className="button secondary" onClick={() => setTranslated(!translated)}>
              {translated ? 'Show original' : 'Preview Spanish translation'}
            </button>
            <p className="fine-print">
              The Spanish translation is a prepared example. In the local editor, recognized text is
              stored encrypted beside the original PDF for selection, copy, search, highlighting,
              and read aloud with available local voices.
            </p>
          </>
        )}
        <p className="fine-print">
          Batch OCR, translation, other languages, hosted OCR, and searchable-PDF export are
          planned.
        </p>
      </div>
    </div>
  );
}
const readingWords = 'A little more space can make a world of difference to the way we read.'.split(
  ' ',
);
export function AccessibilityDemo() {
  const [contrast, setContrast] = useState(false);
  const [spacing, setSpacing] = useState(false);
  const [ruler, setRuler] = useState(false);
  const [focus, setFocus] = useState(false);
  const sequence = useSequence(readingWords.length, 420);
  return (
    <div className={`accessibility-demo ${contrast ? 'demo-contrast' : ''}`} ref={sequence.ref}>
      <div className="reading-preview">
        <span className="paper-kicker">A WORKSPACE WITH ROOM FOR EVERYONE</span>
        <h3>
          Different minds.
          <br />
          Equal possibility.
        </h3>
        <p
          className={`${spacing ? 'spacious-reading ' : ''}${ruler ? 'reading-ruler ' : ''}${focus ? 'focus-reading' : ''}`}
        >
          {readingWords.map((word, index) => (
            <span key={index} className={sequence.step === index ? 'spoken-word' : ''}>
              {word}{' '}
            </span>
          ))}
        </p>
        <small>Word tracking illustration · no audio is playing.</small>
      </div>
      <div className="reading-controls">
        <label>
          <span>
            High contrast <small>Available locally</small>
          </span>
          <input
            type="checkbox"
            checked={contrast}
            onChange={(e) => setContrast(e.target.checked)}
          />
        </label>
        <label>
          <span>
            Comfortable spacing <small>Local reading preference</small>
          </span>
          <input type="checkbox" checked={spacing} onChange={(e) => setSpacing(e.target.checked)} />
        </label>
        <label>
          <span>
            Reading ruler <small>Coming soon concept</small>
          </span>
          <input type="checkbox" checked={ruler} onChange={(e) => setRuler(e.target.checked)} />
        </label>
        <label>
          <span>
            Focus mode <small>Coming soon concept</small>
          </span>
          <input type="checkbox" checked={focus} onChange={(e) => setFocus(e.target.checked)} />
        </label>
        <button
          className="text-button"
          onClick={() => {
            sequence.setPlaying(false);
            sequence.setStep((sequence.step + 1) % readingWords.length);
          }}
        >
          Next tracking word <ArrowRight size={14} />
        </button>
        {!sequence.reduced && (
          <button
            className="text-button"
            onClick={() => {
              if (sequence.step === readingWords.length - 1) sequence.setStep(0);
              sequence.setPlaying(!sequence.playing);
            }}
          >
            {sequence.playing ? 'Pause word tracking' : 'Play word tracking'}
          </button>
        )}
        <details>
          <summary>What’s still ahead?</summary>
          <p>
            Browser read aloud and single-page printed English OCR are available locally; voices
            vary by device. Speech-to-text, OpenDyslexic, Lexend, translation, and dictionary
            require further implementation. No accessibility conformance claim is made.
          </p>
        </details>
      </div>
    </div>
  );
}
const teacherSteps = [
  'Create assignment',
  'Choose a worksheet',
  'Select example class',
  'Assign locally',
  'Preview submission',
  'Return sample feedback',
];
export function TeacherDashboardDemo() {
  const [step, setStep] = useState(0);
  return (
    <ProductWindow title="From a question to a conversation">
      <div className="teacher-demo">
        <aside>
          <span className="tiny-brand">m.</span>
          <strong>Ms. Rivera</strong>
          <span>Example workspace</span>
          <p>
            Assignments
            <br />
            Documents
            <br />
            Feedback
          </p>
        </aside>
        <div>
          <span className="status-stamp">ILLUSTRATIVE LOCAL WORKFLOW</span>
          <h3>
            Room for the
            <br />
            good part of teaching.
          </h3>
          <div className="assignment-row">
            <FileText size={30} />
            <div>
              <strong>Cell structure & function</strong>
              <span>
                {
                  [
                    'A new idea',
                    'Worksheet selected',
                    'Biology · fictional class',
                    'Assigned in this illustration',
                    'Alex · example submission',
                    'Feedback returned in this illustration',
                  ][step]
                }
              </span>
            </div>
            <span className="assignment-state">
              {step < 3 ? 'Draft' : step === 3 ? 'Assigned' : step === 4 ? 'Submitted' : 'Returned'}
            </span>
          </div>
          {step >= 3 && (
            <div className="fictional-stats">
              <span>
                <b>25</b>example students
              </span>
              <span>
                <b>22</b>example starts
              </span>
              <span>
                <b>18</b>example submissions
              </span>
            </div>
          )}
          {step >= 4 && (
            <blockquote>
              “Can you show one more step in your reasoning?”
              <small>Prepared feedback example, not a testimonial.</small>
            </blockquote>
          )}
          <div className="button-row">
            <button className="button primary" onClick={() => setStep(step === 5 ? 0 : step + 1)}>
              {step === 5 ? 'Replay workflow' : teacherSteps[step]}
              <ArrowRight size={15} />
            </button>
            <span className="fine-print">{step + 1} / 6</span>
          </div>
          <p className="fine-print">
            The current app supports a local assignment sequence. Class delivery, student accounts,
            rubrics, and per-student tool controls are planned.
          </p>
        </div>
      </div>
    </ProductWindow>
  );
}
export function AdminDashboardDemo() {
  const [scope, setScope] = useState('District');
  const [enabled, setEnabled] = useState<Record<string, boolean>>({
    'AI tools': false,
    OCR: true,
    Translation: true,
    'External sharing': false,
    'Offline documents': true,
    'Student collaboration': false,
  });
  return (
    <ProductWindow title="Policy workspace · coming soon concept" dark>
      <div className="admin-demo">
        <aside>
          <span className="eyebrow">ILLUSTRATIVE DISTRICT</span>
          <h3>
            A clear view.
            <br />A steady hand.
          </h3>
          <p>Policy controls shown here do not change any real app settings.</p>
          <div className="admin-links">
            <span>Security policies</span>
            <span>Audit logs ◐</span>
            <span>SSO ◐</span>
            <span>Integrations ◐</span>
            <span>Usage ◐</span>
          </div>
        </aside>
        <div>
          <div className="segmented-control" aria-label="Example policy scope">
            {['District', 'School', 'Class'].map((item) => (
              <button key={item} aria-pressed={scope === item} onClick={() => setScope(item)}>
                {item}
              </button>
            ))}
          </div>
          <p className="policy-context">{scope} policy illustration</p>
          {Object.entries(enabled).map(([name, value]) => (
            <label className="policy-row" key={name}>
              <span>{name}</span>
              <input
                type="checkbox"
                checked={value}
                onChange={(e) => setEnabled({ ...enabled, [name]: e.target.checked })}
              />
              <span>{value ? 'On' : 'Off'}</span>
            </label>
          ))}
          <small>Coming soon · no policy is deployed or enforced</small>
        </div>
      </div>
    </ProductWindow>
  );
}
const commands = [
  { name: 'Insert page', status: 'Local tool' },
  { name: 'Split PDF', status: 'Selected-page export available' },
  { name: 'Export', status: 'Encrypted export available' },
  { name: 'OCR', status: 'Local printed English · one page at a time' },
  { name: 'Read aloud', status: 'Browser voices in web editor' },
  { name: 'Translate', status: 'Coming soon' },
];
export function CommandPaletteDemo() {
  const dialog = useRef<HTMLDialogElement>(null);
  const title = useId();
  const [query, setQuery] = useState('');
  const [pages, setPages] = useState(3);
  const [result, setResult] = useState('An idea away from your next action.');
  function select(name: string) {
    if (name === 'Insert page') {
      setPages(pages + 1);
      setResult('A page was added to this illustration.');
    } else if (name === 'Split PDF') {
      setResult(
        'Selected-page export exists in the web editor. This illustration does not contain a real PDF.',
      );
    } else if (name === 'OCR') {
      setResult(
        'Open the local editor to recognize one printed English page at a time. This illustration uses prepared text.',
      );
    } else if (name === 'Read aloud') {
      setResult(
        'Open the actual web editor to read PDF text with available browser voices. No audio plays in this illustration.',
      );
    } else {
      setResult('Open the actual web editor to export an encrypted .margin document.');
    }
    dialog.current?.close();
  }
  return (
    <div
      className="command-demo"
      tabIndex={0}
      onKeyDown={(e) => {
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
          e.preventDefault();
          dialog.current?.showModal();
        }
      }}
    >
      <div className="command-paper-stack" aria-hidden="true">
        <FileText size={74} strokeWidth={0.8} />
        <span>{pages} example pages</span>
      </div>
      <button className="command-trigger" onClick={() => dialog.current?.showModal()}>
        <Search size={19} />
        Find your next move{' '}
        <kbd>
          <Command size={12} /> K
        </kbd>
      </button>
      <p role="status">{result}</p>
      <small>Focus this demo, then press Ctrl/⌘ + K. Search or choose an action.</small>
      <dialog className="command-dialog" ref={dialog} aria-labelledby={title}>
        <div className="command-search">
          <Search size={20} />
          <label id={title} className="sr-only">
            Search demonstration commands
          </label>
          <input
            autoFocus
            aria-labelledby={title}
            placeholder="Try “Insert page” or “OCR”…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <button
            className="icon-control"
            aria-label="Close command palette"
            onClick={() => dialog.current?.close()}
          >
            <X size={19} />
          </button>
        </div>
        <div className="command-results">
          {commands
            .filter((command) => command.name.toLowerCase().includes(query.toLowerCase()))
            .map((command) => (
              <button
                key={command.name}
                disabled={command.status === 'Coming soon'}
                onClick={() => select(command.name)}
              >
                <span>{command.name}</span>
                <small>{command.status}</small>
                {command.status !== 'Coming soon' && <ArrowRight size={14} />}
              </button>
            ))}
          {!commands.some((command) =>
            command.name.toLowerCase().includes(query.toLowerCase()),
          ) && <p>No matching commands. Try “page”.</p>}
        </div>
        <p className="fine-print">Interactive illustration · planned commands are unavailable.</p>
      </dialog>
    </div>
  );
}
export function BeforeAfterDemo() {
  const [value, setValue] = useState(65);
  return (
    <div className="before-after">
      <div className="comparison-canvas">
        <div className="traditional-workflow">
          <span>TRADITIONAL DOCUMENT WORKFLOW</span>
          <div className="busy-toolbar">
            File · Edit · View · More · Export · Tools · Settings · Advanced
          </div>
          <h3>Where was that tool?</h3>
          <div className="floating-menu">
            Save as…
            <br />
            Document settings
            <br />
            More options
            <br />
            Advanced options
          </div>
          <small>Save status unclear</small>
        </div>
        <div className="modern-workflow" style={{ clipPath: `inset(0 ${100 - value}% 0 0)` }}>
          <span>MARGIN / ILLUSTRATIVE WORKSPACE</span>
          <div className="simple-toolbar">
            <Type size={18} />
            <Highlighter size={18} />
            <MessageSquare size={18} />
            <span>
              <Check size={13} />
              Saved locally
            </span>
          </div>
          <h3>A little more clarity.</h3>
          <p>
            Your page. Your thoughts.
            <br />
            The tools you need, within reach.
          </p>
        </div>
        <span className="comparison-handle" style={{ left: `${value}%` }} aria-hidden="true">
          ↔
        </span>
      </div>
      <label className="slider-label">
        Explore the difference
        <input
          type="range"
          min={5}
          max={95}
          value={value}
          onChange={(e) => setValue(Number(e.target.value))}
          aria-label="Reveal the modern workflow"
          aria-valuetext={`${value}% modern workflow visible`}
        />
      </label>
      <p className="demo-caption">
        An original conceptual comparison. The traditional example is not Kami’s interface or a
        measured competitor result.
      </p>
    </div>
  );
}
