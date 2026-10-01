'use client';
import { useState } from 'react';
import { motion } from 'framer-motion';
import {
  Highlighter,
  Pencil,
  Type,
  MessageSquare,
  Plus,
  GripVertical,
  Check,
  Pause,
  Play,
  RotateCcw,
  ArrowRight,
  Upload,
} from 'lucide-react';
import { ProductWindow, CellIllustration } from './ProductWindow';
import { useSequence } from './Motion';
const moments = [
  'Drop a document',
  'Uploading — 12%',
  'Uploading — 38%',
  'Uploading — 72%',
  'Upload complete',
  'Highlight an idea',
  'Make your mark',
  'Start a conversation',
  'Find the right words',
  'Make a little space',
  'Put things in order',
  'Saved',
];
export function HeroDemo() {
  const { ref, step, setStep, playing, setPlaying, reduced } = useSequence(moments.length, 1250);
  const [note, setNote] = useState('A little sunlight goes a long way.');
  const progress = [0, 12, 38, 72, 100][Math.min(step, 4)];
  const tools = [
    { icon: Highlighter, title: 'Highlight', step: 5 },
    { icon: Pencil, title: 'Draw', step: 6 },
    { icon: MessageSquare, title: 'Comment', step: 7 },
    { icon: Type, title: 'Text', step: 8 },
    { icon: Plus, title: 'Insert page', step: 9 },
    { icon: GripVertical, title: 'Reorder pages', step: 10 },
  ];
  return (
    <div className="hero-demo" ref={ref} id="watch-demo">
      <div className="demo-floating-label">
        <span className="live-dot" />A LITTLE LESS FRICTION. A LOT MORE POSSIBILITY.
      </div>
      <ProductWindow
        toolbar={
          <div className="editor-toolbar">
            <span className="toolbar-file">Biology / Chapter 02</span>
            <div className="tools">
              {tools.map(({ icon: Icon, title, step: target }) => (
                <button
                  key={title}
                  title={title}
                  aria-label={`Demo: ${title}`}
                  aria-pressed={step === target}
                  className={step === target ? 'active' : ''}
                  onClick={() => {
                    setStep(target);
                    setPlaying(false);
                  }}
                >
                  <Icon size={17} />
                </button>
              ))}
            </div>
            <span className="demo-save">
              <Check size={13} />
              {step === 11 ? 'Saved' : 'Local preview'}
            </span>
          </div>
        }
      >
        <aside className="page-rail" aria-label="Example pages">
          {(step === 10 ? [2, 1, 3] : step >= 9 ? [1, 2, 3] : [1, 2]).map((page, index) => (
            <motion.div
              layout={!reduced}
              key={page}
              className={`mini-page ${index === 0 ? 'selected' : ''}`}
            >
              <span className="mini-lines" />
              <span>{page}</span>
            </motion.div>
          ))}
          <span className="rail-add" aria-hidden="true">
            +
          </span>
        </aside>
        <div className="hero-paper-stage">
          <article className={`document-paper hero-paper ${step < 4 ? 'paper-waiting' : ''}`}>
            <div className="paper-kicker">
              <span>EXPLORING THE LIVING WORLD</span>
              <span>02 / BIOLOGY</span>
            </div>
            <h3>
              Small cells.
              <br />
              Extraordinary possibilities.
            </h3>
            <p className="paper-lead">
              Every living thing begins with a cell. Let’s look a little closer.
            </p>
            <CellIllustration />
            <div className="paper-rule" />
            <h4>01 / A world inside a wall</h4>
            <p>
              Plant cells use{' '}
              <mark className={step >= 5 ? 'revealed' : ''}>
                light energy to make their own food
              </mark>
              . Chloroplasts transform sunlight into the energy that helps a plant grow.
            </p>
            <div className="answer-lines">
              <span />
              <span />
              <span />
            </div>
            {step >= 6 && (
              <motion.svg
                className="pen-mark"
                viewBox="0 0 170 55"
                aria-label="Hand-drawn underline"
              >
                <motion.path
                  d="M8 33Q65 16 160 28M40 43Q95 35 133 37"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="3"
                  strokeLinecap="round"
                  initial={{ pathLength: reduced ? 1 : 0 }}
                  animate={{ pathLength: 1 }}
                />
              </motion.svg>
            )}
            {step >= 8 && (
              <label className="demo-text">
                <span className="sr-only">Try typing a note in this illustration</span>
                <input
                  value={note}
                  onChange={(e) => {
                    setNote(e.target.value);
                    setPlaying(false);
                  }}
                  maxLength={80}
                />
              </label>
            )}
            <div className="paper-bottom">
              <span>MARGIN / A PLACE TO THINK</span>
              <span>1</span>
            </div>
          </article>
          {step < 4 && (
            <motion.button
              className="drop-file"
              initial={{ y: reduced ? 0 : -25, rotate: reduced ? 0 : -3 }}
              animate={{ y: 0, rotate: -3 }}
              onClick={() => {
                setStep(4);
                setPlaying(false);
              }}
            >
              <Upload size={23} />
              <span>
                <strong>biology-assignment.pdf</strong>
                <small>{progress ? `Uploading — ${progress}%` : 'Drop your next idea here'}</small>
                <span className="thin-progress">
                  <i style={{ width: `${progress}%` }} />
                </span>
              </span>
            </motion.button>
          )}
          {step >= 7 && (
            <motion.aside
              className="paper-comment"
              initial={{ opacity: 0, x: reduced ? 0 : 10 }}
              animate={{ opacity: 1, x: 0 }}
            >
              <span className="comment-avatar">M</span>
              <div>
                <strong>Your margin, your thoughts.</strong>
                <p>What changes when the light goes away?</p>
                <span>Illustrative comment</span>
              </div>
            </motion.aside>
          )}
        </div>
      </ProductWindow>
      <div className="demo-caption">
        <span>Interactive illustration · no file is uploaded</span>
        <div className="sequence-controls">
          <span className="sequence-label">{moments[step]}</span>
          {!reduced && (
            <button
              aria-label={playing ? 'Pause demo' : 'Play demo'}
              onClick={() => {
                if (step === 11) setStep(0);
                setPlaying(!playing);
              }}
            >
              {playing ? <Pause size={15} /> : <Play size={15} />}
            </button>
          )}
          <button
            aria-label="Restart demo"
            onClick={() => {
              setStep(0);
              setPlaying(false);
            }}
          >
            <RotateCcw size={14} />
          </button>
          <button
            aria-label="Next demo step"
            onClick={() => {
              setStep((step + 1) % moments.length);
              setPlaying(false);
            }}
          >
            <ArrowRight size={16} />
          </button>
        </div>
      </div>
    </div>
  );
}
