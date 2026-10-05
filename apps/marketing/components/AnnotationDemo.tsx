'use client';
import { useState } from 'react';
import {
  Highlighter,
  Pencil,
  Type,
  MessageSquare,
  Square,
  Image,
  PenTool,
  Sigma,
  Check,
  Plus,
  X,
} from 'lucide-react';
import { ProductWindow, CellIllustration } from './ProductWindow';
const tools = [
  { name: 'Highlight', icon: Highlighter },
  { name: 'Draw', icon: Pencil },
  { name: 'Text', icon: Type },
  { name: 'Comment', icon: MessageSquare },
  { name: 'Shapes', icon: Square },
  { name: 'Image', icon: Image, planned: true },
  { name: 'Signature', icon: PenTool },
  { name: 'Equation', icon: Sigma, planned: true },
];
export function AnnotationDemo() {
  const [selected, setSelected] = useState('Highlight');
  const [text, setText] = useState('What do you notice?');
  const [preset, setPreset] = useState('Student');
  const [extra, setExtra] = useState(false);
  const selectedTool = tools.find((tool) => tool.name === selected)!;
  return (
    <div>
      <ProductWindow
        title="Make room for your thinking"
        toolbar={
          <div className="annotation-toolbar" aria-label="Illustrative annotation tools">
            {tools.map(({ name, icon: Icon, planned }) => (
              <button
                key={name}
                title={`${name}${planned ? ' · coming soon concept' : ''}`}
                aria-label={`${name}${planned ? ' — coming soon concept' : ''}`}
                aria-pressed={selected === name}
                className={selected === name ? 'active' : ''}
                onClick={() => setSelected(name)}
              >
                <Icon size={19} />
                <span>{name}</span>
                {planned && <i aria-hidden="true">◐</i>}
              </button>
            ))}
          </div>
        }
      >
        <div className="annotation-paper">
          <div className="paper-kicker">A FEW GOOD QUESTIONS CAN CHANGE EVERYTHING.</div>
          <h3>What makes something alive?</h3>
          <p>
            Start with curiosity.{' '}
            <mark className={selected === 'Highlight' ? 'revealed' : ''}>
              Look for the little things that make a big difference.
            </mark>{' '}
            Each cell has a story to tell.
          </p>
          <div className="annotation-content">
            <CellIllustration />
            {selected === 'Draw' && (
              <svg viewBox="0 0 220 150" className="drawing-example" aria-label="Hand-drawn circle">
                <path
                  d="M55 25C180-10 245 119 115 136S-5 56 62 24"
                  fill="none"
                  stroke="#b64f37"
                  strokeWidth="3"
                  strokeLinecap="round"
                />
              </svg>
            )}
            {selected === 'Shapes' && <span className="shape-example" />}
            {selected === 'Text' && (
              <label className="inline-annotation">
                <span>Your note</span>
                <input value={text} onChange={(e) => setText(e.target.value)} maxLength={90} />
              </label>
            )}
            {selected === 'Comment' && (
              <aside className="inline-comment">
                <strong>One more thought…</strong>
                <textarea
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  aria-label="Illustrative comment"
                  maxLength={180}
                />
                <span>
                  <Check size={12} />
                  Kept in this page’s demo only
                </span>
              </aside>
            )}
            {selected === 'Image' && (
              <div className="concept-image">
                <Image size={32} />
                <span>Image placement concept</span>
              </div>
            )}
            {selected === 'Signature' && <div className="signature-example">Alex Morgan</div>}
            {selected === 'Equation' && (
              <div className="equation-example">6CO₂ + 6H₂O → C₆H₁₂O₆ + 6O₂</div>
            )}
          </div>
          <div className="answer-lines">
            <span />
            <span />
          </div>
        </div>
      </ProductWindow>
      <div className="demo-caption">
        <span>
          Try the tools above.{' '}
          {selectedTool.planned
            ? 'This tool is a coming-soon concept.'
            : selected === 'Signature'
              ? 'Typed and drawn visual signatures are available in the local editor. This preview is illustrative; it does not verify identity or cryptographically sign a PDF.'
              : 'Illustrative preview; changes stay in this demo.'}
        </span>
        <span className="status-stamp">{selectedTool.planned ? 'COMING SOON' : 'LOCAL TOOLS'}</span>
      </div>
      <div className="customize-demo">
        <div>
          <span className="eyebrow">LESS TOOLBAR. MORE DOCUMENT.</span>
          <h3>
            Simple when you want it.
            <br />
            More room when you need it.
          </h3>
          <p>
            Try a toolbar preset concept. Printed English OCR and filling supported existing PDF
            forms work locally. Custom presets, rubrics, form creation, and answer keys are planned.
          </p>
        </div>
        <div>
          <div className="segmented-control" aria-label="Illustrative toolbar presets">
            {['Student', 'Teacher', 'Power user'].map((name) => (
              <button key={name} aria-pressed={preset === name} onClick={() => setPreset(name)}>
                {name}
              </button>
            ))}
          </div>
          <div className="preset-strip">
            {(preset === 'Student'
              ? ['Text', 'Pen', 'Highlight', 'Eraser', 'Comment']
              : preset === 'Teacher'
                ? ['Text', 'Highlight', 'Comment', 'Rubric ◐', 'Answer key ◐']
                : ['Pages', 'English OCR', 'Fill forms', 'Signature']
            ).map((name) => (
              <span key={name}>{name}</span>
            ))}
            {extra && <span>Shapes</span>}
            <button
              className="icon-control"
              aria-label={extra ? 'Remove Shapes from demo toolbar' : 'Add Shapes to demo toolbar'}
              onClick={() => setExtra(!extra)}
            >
              {extra ? <X size={16} /> : <Plus size={16} />}
            </button>
          </div>
          <small>Preset customization concept · ◐ coming soon</small>
        </div>
      </div>
    </div>
  );
}
