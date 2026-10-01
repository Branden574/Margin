'use client';
import { useEffect, useRef, useState } from 'react';
import { motion, useInView, useReducedMotion } from 'framer-motion';
import {
  FileText,
  Monitor,
  Layers3,
  Cloud,
  HardDrive,
  LockKeyhole,
  ArrowDown,
  UserRound,
  ShieldCheck,
} from 'lucide-react';
export function Architecture() {
  const ref = useRef<HTMLDivElement>(null);
  const active = useInView(ref, { amount: 0.4 });
  const reduced = useReducedMotion();
  const [paused, setPaused] = useState(false);
  const [visible, setVisible] = useState(true);
  useEffect(() => {
    function changed() {
      setVisible(document.visibilityState === 'visible');
    }
    document.addEventListener('visibilitychange', changed);
    return () => document.removeEventListener('visibilitychange', changed);
  }, []);
  const moving = active && !reduced && !paused && visible;
  const lanes = [
    { icon: Monitor, name: 'Your browser', caption: 'The page you’re working on', available: true },
    {
      icon: Layers3,
      name: 'Background workers',
      caption: 'Heavy work, behind the scenes',
      available: true,
    },
    {
      icon: Cloud,
      name: 'Cloud services',
      caption: 'Production processing · planned',
      available: false,
    },
    {
      icon: HardDrive,
      name: 'Your storage',
      caption: 'Encrypted, local, within reach',
      available: true,
    },
  ];
  return (
    <div className="architecture" ref={ref}>
      <div className="architecture-source">
        <FileText size={27} />
        <strong>
          One document.
          <br />A thoughtful division of work.
        </strong>
      </div>
      <div className="architecture-lanes">
        {lanes.map(({ icon: Icon, name, caption, available }, index) => (
          <div className="architecture-lane" key={name}>
            <div className="chunk-track" aria-hidden="true">
              {[0, 1, 2].map((chunk) => (
                <motion.i
                  key={chunk}
                  animate={
                    moving && available
                      ? { y: [-12, 100], opacity: [0, 1, 1, 0] }
                      : { y: 30, opacity: available ? 0.5 : 0.15 }
                  }
                  transition={{
                    duration: 3.4,
                    delay: index * 0.2 + chunk * 0.7,
                    repeat: moving ? Infinity : 0,
                    ease: 'linear',
                  }}
                />
              ))}
            </div>
            <Icon size={24} strokeWidth={1.3} />
            <h3>{name}</h3>
            <p>{caption}</p>
          </div>
        ))}
      </div>
      {!reduced && (
        <button className="text-button" aria-pressed={paused} onClick={() => setPaused(!paused)}>
          {paused ? 'Play architecture motion' : 'Pause architecture motion'}
        </button>
      )}
      <details className="technical-details">
        <summary>A closer look at the architecture</summary>
        <p>
          The local app renders a bounded set of PDF canvases, moves document operations into
          workers, encrypts IndexedDB records, and caches its application assets for offline use.
          The optional companion API stores encrypted verified upload chunks. Cloud workers,
          production object storage, managed identities, and collaboration services are not
          connected.
        </p>
      </details>
    </div>
  );
}
export function SecurityVisualization() {
  const stages = [
    { icon: FileText, name: 'Your document', detail: 'PDFs and annotations' },
    { icon: LockKeyhole, name: 'Encrypted connection', detail: 'HTTPS · TLS 1.2 or newer' },
    { icon: HardDrive, name: 'Encrypted storage', detail: 'AES-GCM · local vault and API' },
    { icon: ShieldCheck, name: 'Checked access', detail: 'Local API owner and tenant checks' },
    { icon: UserRound, name: 'Your workspace', detail: 'Passphrase unlock · lock on demand' },
  ];
  return (
    <div className="security-flow">
      {stages.map(({ icon: Icon, name, detail }, index) => (
        <div className="security-flow-step" key={name}>
          <div className="security-node">
            <Icon size={24} strokeWidth={1.3} />
            <div>
              <strong>{name}</strong>
              <span>{detail}</span>
            </div>
            <span className="security-number">0{index + 1}</span>
          </div>
          {index < stages.length - 1 && <ArrowDown size={17} aria-hidden="true" />}
        </div>
      ))}
    </div>
  );
}
