'use client';
import dynamic from 'next/dynamic';
import { useRef } from 'react';
import { useInView } from 'framer-motion';
const demos = {
  pages: dynamic(() => import('./LowerDemos').then((module) => module.PageScrubber)),
  recovery: dynamic(() => import('./LowerDemos').then((module) => module.RecoveryDemo)),
  collaboration: dynamic(() => import('./LowerDemos').then((module) => module.CollaborationDemo)),
  ocr: dynamic(() => import('./LowerDemos').then((module) => module.OCRDemo)),
  accessibility: dynamic(() => import('./LowerDemos').then((module) => module.AccessibilityDemo)),
  teacher: dynamic(() => import('./LowerDemos').then((module) => module.TeacherDashboardDemo)),
  admin: dynamic(() => import('./LowerDemos').then((module) => module.AdminDashboardDemo)),
  command: dynamic(() => import('./LowerDemos').then((module) => module.CommandPaletteDemo)),
  comparison: dynamic(() => import('./LowerDemos').then((module) => module.BeforeAfterDemo)),
};
export function LazyDemo({ name, label }: { name: keyof typeof demos; label: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const ready = useInView(ref, { once: true, margin: '400px' });
  const Demo = demos[name];
  return (
    <div ref={ref} className={`lazy-demo lazy-${name}`}>
      {ready ? (
        <Demo />
      ) : (
        <div className="demo-placeholder">
          <span className="tiny-brand">m.</span>
          <p>{label}</p>
          <span>Interactive illustration loads as you approach.</span>
        </div>
      )}
    </div>
  );
}
