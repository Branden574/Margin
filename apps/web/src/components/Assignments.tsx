import { useEffect, useState } from 'react';
import {
  Plus,
  GraduationCap,
  FileText,
  CalendarDays,
  ArrowUpRight,
  CheckCircle2,
  Send,
  BookOpen,
} from 'lucide-react';
import type { Assignment, DocumentRecord, Preferences } from '@margin/core';
import { Modal } from './Modal';
interface Props {
  assignments: Assignment[];
  documents: DocumentRecord[];
  role: Preferences['role'];
  request?: { id?: string; create?: boolean; key: number };
  onRequestHandled?: () => void;
  boundCopyIds?: ReadonlySet<string>;
  onSave: (a: Assignment) => Promise<void>;
  onOpen: (d: DocumentRecord) => void;
}
export function Assignments({
  assignments,
  documents,
  role,
  request,
  onRequestHandled,
  boundCopyIds,
  onSave,
  onOpen,
}: Props) {
  const [creating, setCreating] = useState(false);
  const [detail, setDetail] = useState<Assignment | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [filter, setFilter] = useState('all');
  const usable = documents.filter((d) => !d.trashed);
  const selectable = usable.filter((d) => !boundCopyIds?.has(d.id));
  const accessible = assignments.filter((a) => role === 'teacher' || a.status !== 'draft');
  const visible = accessible.filter((a) => filter === 'all' || a.status === filter);
  useEffect(() => {
    setCreating(false);
    setDetail(null);
    setFilter('all');
  }, [role]);
  useEffect(() => {
    if (!request?.key) return;
    if (request.create && role === 'teacher') setCreating(true);
    else if (request.id)
      setDetail(
        assignments.find(
          (a) => a.id === request.id && (role === 'teacher' || a.status !== 'draft'),
        ) ?? null,
      );
    onRequestHandled?.();
  }, [request, role, assignments, onRequestHandled]);
  async function save(a: Assignment) {
    setBusy(true);
    setError('');
    try {
      await onSave(a);
      setCreating(false);
      setDetail(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save this assignment. Try again.');
    } finally {
      setBusy(false);
    }
  }
  function create(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (role !== 'teacher') return;
    const form = new FormData(e.currentTarget);
    void save({
      id: crypto.randomUUID(),
      title: String(form.get('title')).trim(),
      instructions: String(form.get('instructions')).trim(),
      documentId: String(form.get('document')),
      className: String(form.get('class')).trim(),
      dueDate: String(form.get('due')),
      status: 'draft',
      createdAt: Date.now(),
    });
  }
  return (
    <div className="library-page">
      <div className="page-heading">
        <div>
          <div className="eyebrow">
            {role === 'teacher' ? 'THE TEACHER’S DESK' : 'YOUR LEARNING SPACE'}
          </div>
          <h1>Assignments</h1>
          <p>
            {role === 'teacher'
              ? 'Prepare a lesson. Leave room for discovery.'
              : 'Open your work, take your time, and make it yours.'}
          </p>
        </div>
        {role === 'teacher' && (
          <button className="button primary" onClick={() => setCreating(true)}>
            <Plus size={16} />
            Create assignment
          </button>
        )}
      </div>
      <div className="info-banner">
        <BookOpen size={18} />
        <span>
          Local classroom workspace. Assignments and submissions stay in this browser; sharing with
          a class requires a connected school service.
        </span>
      </div>
      <div className="file-tabs assignment-tabs">
        {(role === 'teacher'
          ? ['all', 'draft', 'assigned', 'submitted', 'returned']
          : ['all', 'assigned', 'submitted', 'returned']
        ).map((f) => (
          <button key={f} className={filter === f ? 'active' : ''} onClick={() => setFilter(f)}>
            {f === 'all' ? 'All assignments' : f.charAt(0).toUpperCase() + f.slice(1)}{' '}
            <span>{accessible.filter((a) => f === 'all' || a.status === f).length}</span>
          </button>
        ))}
      </div>
      {visible.length ? (
        <div className="assignment-list">
          {visible.map((a) => (
            <button className="assignment-row" key={a.id} onClick={() => setDetail(a)}>
              <span className="assignment-icon">
                <GraduationCap size={23} />
              </span>
              <span className="assignment-name">
                <strong>{a.title}</strong>
                <small>
                  {a.className} ·{' '}
                  {documents.find((d) => d.id === a.documentId)?.name ?? 'Document unavailable'}
                </small>
              </span>
              <span className="assignment-due">
                <CalendarDays size={14} />
                {a.dueDate
                  ? new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric' }).format(
                      new Date(a.dueDate + 'T12:00:00'),
                    )
                  : 'No due date'}
              </span>
              <span className={`status-label status-${a.status}`}>{a.status}</span>
              <ArrowUpRight size={17} />
            </button>
          ))}
        </div>
      ) : (
        <div className="empty-state assignment-empty">
          <span>
            <GraduationCap size={38} strokeWidth={1.2} />
          </span>
          <h3>
            {filter === 'all'
              ? role === 'teacher'
                ? 'Good lessons start with a blank page.'
                : 'No assigned work yet.'
              : 'No ' + filter + ' assignments yet.'}
          </h3>
          <p>
            {role === 'teacher'
              ? 'Turn a document into an assignment with instructions and a due date.'
              : 'Assignments created in this local workspace will appear here.'}
          </p>
          {role === 'teacher' && (
            <button className="button secondary" onClick={() => setCreating(true)}>
              <Plus size={15} />
              Create your first assignment
            </button>
          )}
        </div>
      )}
      {creating && (
        <Modal
          title="Create an assignment"
          description="Prepare a document and instructions in your local workspace."
          onClose={() => !busy && setCreating(false)}
        >
          <form onSubmit={create} className="form-stack">
            <label>
              Assignment title
              <input
                required
                maxLength={160}
                name="title"
                placeholder="e.g. Exploring cell structure"
                autoFocus
              />
            </label>
            <label>
              Document
              <select name="document" required defaultValue="">
                <option value="" disabled>
                  Choose a document
                </option>
                {selectable.map((d) => (
                  <option value={d.id} key={d.id}>
                    {d.name}
                  </option>
                ))}
              </select>
            </label>
            <div className="form-columns">
              <label>
                Class
                <input
                  required
                  name="class"
                  placeholder="e.g. Biology · Period 2"
                  maxLength={100}
                />
              </label>
              <label>
                Due date
                <input type="date" name="due" required />
              </label>
            </div>
            <label>
              Instructions
              <textarea
                name="instructions"
                rows={4}
                maxLength={5000}
                placeholder="What should students work on?"
              />
            </label>
            {error && <p className="form-error">{error}</p>}
            <div className="modal-actions">
              <button type="button" className="button secondary" onClick={() => setCreating(false)}>
                Cancel
              </button>
              <button className="button primary" disabled={busy || !selectable.length}>
                {busy ? 'Saving…' : 'Save draft'}
              </button>
            </div>
          </form>
        </Modal>
      )}
      {detail && (
        <Modal
          title={detail.title}
          description={`${detail.className} · ${detail.status}`}
          onClose={() => !busy && setDetail(null)}
        >
          <div className="assignment-detail">
            <p>{detail.instructions || 'No additional instructions.'}</p>
            {detail.dueDate && <p className="muted">Due {detail.dueDate}</p>}
            <button
              className="button secondary full-width"
              disabled={!usable.some((d) => d.id === detail.documentId)}
              onClick={() => {
                const d = usable.find((d) => d.id === detail.documentId);
                if (d) onOpen(d);
              }}
            >
              <FileText size={17} />
              Open assignment document
              <ArrowUpRight size={15} />
            </button>
            {detail.feedback && (
              <div className="feedback-box">
                <strong>Teacher feedback</strong>
                <p>{detail.feedback}</p>
              </div>
            )}
            {error && <p className="form-error">{error}</p>}
            {role === 'teacher' && detail.status === 'submitted' ? (
              <form
                className="form-stack"
                onSubmit={(e) => {
                  e.preventDefault();
                  const f = new FormData(e.currentTarget);
                  void save({ ...detail, status: 'returned', feedback: String(f.get('feedback')) });
                }}
              >
                <label>
                  Return feedback
                  <textarea name="feedback" rows={3} required maxLength={3000} />
                </label>
                <button className="button primary" disabled={busy}>
                  <Send size={15} />
                  Return with feedback
                </button>
              </form>
            ) : (
              <div className="modal-actions">
                {role === 'teacher' && detail.status === 'draft' && (
                  <button
                    className="button primary"
                    disabled={busy}
                    onClick={() => void save({ ...detail, status: 'assigned' })}
                  >
                    <Send size={15} />
                    Mark ready for students
                  </button>
                )}
                {role === 'student' && ['assigned', 'returned'].includes(detail.status) && (
                  <button
                    className="button primary"
                    disabled={busy}
                    onClick={() => void save({ ...detail, status: 'submitted' })}
                  >
                    <CheckCircle2 size={15} />
                    Mark as submitted locally
                  </button>
                )}
                {role === 'student' && detail.status === 'submitted' && (
                  <p className="success-text">
                    <CheckCircle2 size={16} />
                    Submitted in this workspace
                  </p>
                )}
              </div>
            )}
          </div>
        </Modal>
      )}
    </div>
  );
}
