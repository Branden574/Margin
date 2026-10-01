'use client';
import { useState } from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import { ArrowRight, Check, FileText, WifiOff, Wifi, RotateCcw } from 'lucide-react';
import { ProductWindow } from './ProductWindow';
const steps = [
  {
    title: 'An assignment. One way in.',
    name: 'Open the assignment',
    copy: 'A student opens a Biology Worksheet in their course. The intended launch opens the right workspace, without juggling files.',
  },
  {
    title: 'A page of their own.',
    name: 'Enter the workspace',
    copy: 'A personal working copy keeps the teacher’s original intact. Student identity and access must be validated on the server.',
  },
  {
    title: 'Room to show the thinking.',
    name: 'Annotate and save',
    copy: 'Highlight a key idea. Add an answer. Draw a diagram. Saving work and submitting an assignment are separate states.',
  },
  {
    title: 'Keep a good thought.',
    name: 'Work through an interruption',
    copy: 'The intended offline workflow keeps editing locally. Its Canvas-linked recovery still requires end-to-end testing.',
  },
  {
    title: 'Reconnect with clarity.',
    name: 'Resume synchronization',
    copy: 'The intended flow checks that the server has the work before it enables a submission. A network icon is not confirmation.',
  },
  {
    title: 'A submission, confirmed.',
    name: 'Submit to Canvas',
    copy: 'Only a real confirmation should produce a Submitted status. Failed requests need a clear retry path without losing saved work.',
  },
  {
    title: 'The next good question.',
    name: 'Review and respond',
    copy: 'Teacher review is intended to bring comments, highlights, rubric feedback, and a score into one focused space.',
  },
  {
    title: 'A grade with a destination.',
    name: 'Return a grade',
    copy: 'Grade passback must be confirmed by Canvas. Until then, a grade should stay visibly pending, with safe retries.',
  },
];
export function CanvasStory({ compact = false }: { compact?: boolean }) {
  const [step, setStep] = useState(0);
  const [answer, setAnswer] = useState('Chloroplasts help the plant turn sunlight into energy.');
  const [grade, setGrade] = useState(18);
  const reduced = useReducedMotion();
  const surface = (
    <div className="canvas-story-surface">
      <ProductWindow title="Canvas → Margin · planned workflow">
        <div className="canvas-panel-title">
          <FileText size={13} />
          <span>Concept preview · no Canvas connection or submission</span>
        </div>
        <div className="canvas-demo">
          <aside className="canvas-context">
            <span className="tiny-brand">m.</span>
            <strong>Biology Worksheet</strong>
            <p>Example course · Chapter 02</p>
            <small>Personal working copy · concept</small>
          </aside>
          <motion.div
            className="canvas-workspace"
            key={step === 0 ? 'assignment' : 'workspace'}
            initial={{ opacity: 1, y: reduced ? 0 : 8 }}
            animate={{ y: 0 }}
            transition={{ duration: 0.35 }}
          >
            <span className="paper-kicker">
              {step === 0
                ? 'COURSE ASSIGNMENT / EXAMPLE'
                : step >= 6
                  ? 'TEACHER REVIEW / EXAMPLE'
                  : 'STUDENT WORKSPACE / EXAMPLE'}
            </span>
            <h3>
              {step === 0
                ? 'A little closer to the living world.'
                : step >= 6
                  ? 'Make the next idea clearer.'
                  : 'Follow the sunlight.'}
            </h3>
            <p>
              Plant cells use{' '}
              <mark className={step >= 2 ? 'revealed' : ''}>
                light energy to make their own food
              </mark>
              .
            </p>
            {step >= 2 && step < 6 ? (
              <label className="canvas-answer">
                <span className="sr-only">Try a sample Canvas assignment answer</span>
                <textarea
                  value={answer}
                  maxLength={180}
                  onChange={(e) => setAnswer(e.target.value)}
                />
              </label>
            ) : (
              <div className="answer-lines">
                <span />
                <span />
                <span />
              </div>
            )}
            {step === 3 && (
              <p className="canvas-status-callout">
                Offline concept — changes kept in this demo’s memory
              </p>
            )}
            {step === 5 && (
              <div className="canvas-transfer">
                <Check size={19} />
                <p>Illustrated submission confirmation</p>
                <small>No work has actually been sent to Canvas.</small>
              </div>
            )}
            {step >= 6 && (
              <div className="canvas-feedback">
                “Can you show how you reached that answer?”
                <label>
                  Example score{' '}
                  <input
                    aria-label="Example teacher score out of twenty"
                    type="number"
                    min={0}
                    max={20}
                    value={grade}
                    onChange={(e) => setGrade(Math.max(0, Math.min(20, Number(e.target.value))))}
                  />{' '}
                  / 20
                </label>
                <small>Prepared feedback · planned rubric workflow</small>
              </div>
            )}
            {step === 7 && (
              <div className="canvas-transfer">
                <strong>{grade} / 20</strong>
                <span>→ Example Canvas gradebook</span>
                <small>Illustrated confirmation · no grade sent</small>
              </div>
            )}
            <div className="canvas-state" aria-live="polite">
              {step === 3 ? (
                <WifiOff size={13} />
              ) : step >= 4 ? (
                <Wifi size={13} />
              ) : (
                <Check size={13} />
              )}{' '}
              {
                [
                  'Ready to open the concept',
                  'Workspace illustration',
                  'Saved in this demo only',
                  'Offline illustration',
                  'Synchronization concept',
                  'Submission confirmation concept',
                  'Teacher review concept',
                  'Grade passback concept',
                ][step]
              }
            </div>
          </motion.div>
        </div>
      </ProductWindow>
      <div className="canvas-controls">
        <span>
          {step + 1} / {steps.length} · {steps[step].name}
        </span>
        <button className="button secondary" onClick={() => setStep((step + 1) % steps.length)}>
          {step === 7 ? 'Replay concept' : 'Next step'}
          {step === 7 ? <RotateCcw size={14} /> : <ArrowRight size={14} />}
        </button>
      </div>
      <p className="canvas-concept-note">
        Planned experience. No LMS login, live sync, assignment submission, or grade passback
        happens in this illustration.
      </p>
    </div>
  );
  return compact ? (
    <div className="canvas-story-compact">
      {surface}
      <div className="canvas-step-list">
        {steps.map((item, index) => (
          <button
            key={item.name}
            aria-current={index === step ? 'step' : undefined}
            onClick={() => setStep(index)}
          >
            <span>0{index + 1}</span>
            {item.name}
          </button>
        ))}
      </div>
    </div>
  ) : (
    <div className="canvas-story-layout">
      {surface}
      <div className="canvas-story-steps">
        {steps.map((item, index) => (
          <motion.article
            key={item.name}
            onViewportEnter={() => setStep(index)}
            viewport={{ amount: 0.85 }}
            className={`story-step ${step === index ? 'active' : ''}`}
          >
            <button
              aria-current={step === index ? 'step' : undefined}
              onClick={() => setStep(index)}
            >
              <span>0{index + 1}</span>
              {item.name}
            </button>
            <h3>{item.title}</h3>
            <p>{item.copy}</p>
          </motion.article>
        ))}
      </div>
    </div>
  );
}
