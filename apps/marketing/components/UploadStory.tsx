'use client';
import { useState } from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import { FileText, WifiOff, Wifi, Check, ArrowUpRight, RotateCcw } from 'lucide-react';
import { ProductWindow } from './ProductWindow';
const steps = [
  {
    name: 'Drop',
    title: 'One document. All yours.',
    copy: 'Import a PDF into your encrypted local vault. Your original stays available on this device.',
  },
  {
    name: 'Upload',
    title: 'A little at a time.',
    copy: 'The optional HTTPS companion server accepts verified chunks, with an explicit progress state.',
  },
  {
    name: 'Interruption',
    title: 'The connection can stop. You don’t have to.',
    copy: 'Pause the illustration at 68%. Already accepted chunks are kept so the upload can resume.',
  },
  {
    name: 'Recovery',
    title: 'Pick up from 68%.',
    copy: 'Reconnect and continue from verified chunks. The upload does not need to start from zero.',
  },
  {
    name: 'Ready',
    title: 'Stored. Status clear.',
    copy: 'The current server keeps encrypted uploads in quarantine pending a connected scanner. Keep editing your local document.',
  },
];
export function UploadStory() {
  const [step, setStep] = useState(0);
  const reduced = useReducedMotion();
  const progress = [0, 38, 68, 86, 100][step];
  return (
    <section className="upload-story section-wrap" id="recovery">
      <div className="section-heading">
        <span className="eyebrow">02 / KEEP YOUR PLACE</span>
        <h2>
          Bad Wi-Fi shouldn’t
          <br />
          mean starting over.
        </h2>
        <p>Small interruptions deserve small consequences.</p>
      </div>
      <div className="sticky-layout">
        <div className="sticky-scene">
          <ProductWindow title="Your work stays with you">
            <div className="upload-simulation">
              <div className="upload-orbit">
                <FileText size={50} strokeWidth={1} />
                <span className={step === 2 ? 'connection interrupted' : 'connection'}>
                  {step === 2 ? (
                    <WifiOff size={18} />
                  ) : step === 4 ? (
                    <Check size={18} />
                  ) : (
                    <Wifi size={18} />
                  )}
                </span>
              </div>
              <strong>biology-assignment.pdf</strong>
              <p aria-live="polite">
                {step === 2
                  ? 'Connection lost. Your local document is safe.'
                  : step === 3
                    ? 'Resuming from 68%…'
                    : step === 4
                      ? 'Encrypted copy stored · pending scan'
                      : step === 0
                        ? 'Ready when you are.'
                        : `Uploading — ${progress}%`}
              </p>
              <div className="chunk-grid" aria-hidden="true">
                {Array.from({ length: 25 }, (_, i) => (
                  <motion.span
                    key={i}
                    className={i < Math.floor(progress / 4) ? 'complete' : ''}
                    animate={{ opacity: i < Math.floor(progress / 4) ? 1 : 0.2 }}
                    transition={{ duration: reduced ? 0 : 0.2, delay: reduced ? 0 : i * 0.008 }}
                  />
                ))}
              </div>
              <div className="upload-meter">
                <span style={{ width: `${progress}%` }} />
              </div>
              <div className="upload-percentage">
                <span>Verified progress</span>
                <strong>{progress}%</strong>
              </div>
              <div className="button-row">
                <button
                  className="button primary"
                  onClick={() => setStep(step === 4 ? 0 : step + 1)}
                >
                  {
                    [
                      'Start illustration',
                      'Simulate interruption',
                      'Reconnect',
                      'Finish upload',
                      'Replay illustration',
                    ][step]
                  }
                  {step === 4 ? <RotateCcw size={15} /> : <ArrowUpRight size={15} />}
                </button>
              </div>
              <small>Illustrative sequence. No network upload takes place here.</small>
            </div>
          </ProductWindow>
        </div>
        <div className="story-steps">
          {steps.map((item, index) => (
            <motion.article
              key={item.name}
              onViewportEnter={() => setStep(index)}
              viewport={{ amount: 0.8 }}
              className={step === index ? 'story-step active' : 'story-step'}
            >
              <button
                onClick={() => setStep(index)}
                aria-current={step === index ? 'step' : undefined}
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
    </section>
  );
}
