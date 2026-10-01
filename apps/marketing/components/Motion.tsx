'use client';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { motion, useInView, useReducedMotion, useScroll, useSpring } from 'framer-motion';
export function Reveal({ children, className = '' }: { children: ReactNode; className?: string }) {
  const reduced = useReducedMotion();
  return (
    <motion.div
      className={className}
      initial={{ y: reduced ? 0 : 20 }}
      whileInView={{ y: 0 }}
      viewport={{ once: true, amount: 0.12 }}
      transition={{ duration: 0.65, ease: [0.22, 1, 0.36, 1] }}
    >
      {children}
    </motion.div>
  );
}
export function ScrollProgress() {
  const { scrollYProgress } = useScroll();
  const scaleX = useSpring(scrollYProgress, { stiffness: 140, damping: 30 });
  return <motion.div aria-hidden="true" className="reading-progress" style={{ scaleX }} />;
}
export function StickyScene({
  children,
  className = '',
}: {
  children: ReactNode;
  className?: string;
}) {
  return <div className={`sticky-scene ${className}`}>{children}</div>;
}
export function useSequence(length: number, interval = 1500) {
  const ref = useRef<HTMLDivElement>(null);
  const inView = useInView(ref, { amount: 0.3 });
  const reduced = useReducedMotion();
  const [step, setStep] = useState(0);
  const [playing, setPlaying] = useState(true);
  const [visible, setVisible] = useState(true);
  useEffect(() => {
    const change = () => setVisible(!document.hidden);
    change();
    document.addEventListener('visibilitychange', change);
    return () => document.removeEventListener('visibilitychange', change);
  }, []);
  useEffect(() => {
    if (!inView || !visible || !playing || reduced || step >= length - 1) return;
    const timer = setTimeout(() => setStep((value) => Math.min(value + 1, length - 1)), interval);
    return () => clearTimeout(timer);
  }, [inView, visible, playing, reduced, step, length, interval]);
  return { ref, step, setStep, playing, setPlaying, reduced };
}
