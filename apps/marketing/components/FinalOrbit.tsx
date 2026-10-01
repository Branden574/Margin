'use client';
import { motion, useReducedMotion } from 'framer-motion';
/** A one-shot convergence; the static reduced-motion version keeps every label visible. */
export function FinalOrbit() {
  const reduced = useReducedMotion();
  return (
    <motion.div
      className="orbit-labels"
      role="img"
      aria-label="One document workspace envisioned for students, teachers, classrooms, schools, and districts"
      initial={{ x: '-50%', scale: 1, opacity: 1 }}
      whileInView={{ x: '-50%', scale: reduced ? 1 : 0.28, opacity: reduced ? 1 : 0 }}
      viewport={{ once: true, amount: 0.85 }}
      transition={{
        duration: reduced ? 0 : 1.5,
        delay: reduced ? 0 : 0.4,
        ease: [0.22, 1, 0.36, 1],
      }}
    >
      {['Student', 'Teacher', 'Classroom', 'School', 'District'].map((label) => (
        <span key={label}>{label}</span>
      ))}
    </motion.div>
  );
}
