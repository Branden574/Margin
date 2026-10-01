import { useState, useEffect, useRef } from 'react';
import {
  Search,
  FileText,
  ArrowUpRight,
  Upload,
  Plus,
  Star,
  Settings2,
  Home,
  GraduationCap,
} from 'lucide-react';
import type { DocumentRecord } from '@margin/core';
import type { Page } from './Sidebar';
import { Modal } from './Modal';
export function CommandPalette({
  documents,
  onOpen,
  onNavigate,
  onUpload,
  onNew,
  onClose,
}: {
  documents: DocumentRecord[];
  onOpen: (d: DocumentRecord) => void;
  onNavigate: (p: Page) => void;
  onUpload: () => void;
  onNew: () => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState('');
  const [index, setIndex] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const actions = [
    { label: 'Upload a document', icon: Upload, run: onUpload },
    { label: 'Create a blank document', icon: Plus, run: onNew },
    { label: 'Go to Home', icon: Home, run: () => onNavigate('home') },
    { label: 'Open starred documents', icon: Star, run: () => onNavigate('starred') },
    { label: 'View assignments', icon: GraduationCap, run: () => onNavigate('assignments') },
    { label: 'Workspace settings', icon: Settings2, run: () => onNavigate('settings') },
    ...documents
      .filter((d) => !d.trashed)
      .map((d) => ({ label: d.name, icon: FileText, run: () => onOpen(d) })),
  ].filter((a) => a.label.toLowerCase().includes(query.toLowerCase()));
  useEffect(() => {
    input.current?.focus();
  }, []);
  function run(i: number) {
    const a = actions[i];
    if (a) {
      onClose();
      a.run();
    }
  }
  return (
    <Modal title="Go anywhere, do anything." onClose={onClose}>
      <div className="command-search">
        <Search size={19} />
        <input
          aria-label="Search commands and documents"
          ref={input}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setIndex(0);
          }}
          placeholder="Search documents or type a command…"
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              setIndex((i) => Math.min(i + 1, actions.length - 1));
            }
            if (e.key === 'ArrowUp') {
              e.preventDefault();
              setIndex((i) => Math.max(0, i - 1));
            }
            if (e.key === 'Enter') {
              e.preventDefault();
              run(index);
            }
          }}
        />
      </div>
      <div className="command-list">
        {actions.map((a, i) => (
          <button
            key={a.label + i}
            className={index === i ? 'active' : ''}
            onMouseEnter={() => setIndex(i)}
            onClick={() => run(i)}
          >
            <a.icon size={17} />
            <span>{a.label}</span>
            <ArrowUpRight size={14} />
          </button>
        ))}
        {!actions.length && <p className="muted">No matching documents or commands.</p>}
      </div>
      <div className="command-footer">
        <span>
          <kbd>↑</kbd> <kbd>↓</kbd> to navigate
        </span>
        <span>
          <kbd>↵</kbd> to open
        </span>
        <span>
          <kbd>esc</kbd> to close
        </span>
      </div>
    </Modal>
  );
}
