import {
  ArrowRight,
  BookOpen,
  CalendarDays,
  CheckCircle2,
  ClipboardList,
  Plus,
} from 'lucide-react';
import type { Assignment, Preferences } from '@margin/core';
import './role-home.css';

export function RoleHome({
  role,
  name,
  assignments,
  onAssignment,
  onCreate,
  onAssignments,
  onDocuments,
}: {
  role: Preferences['role'];
  name: string;
  assignments: Assignment[];
  onAssignment: (id: string) => void;
  onCreate: () => void;
  onAssignments: () => void;
  onDocuments: () => void;
}) {
  const teacher = role === 'teacher';
  const available = assignments.filter((a) => teacher || a.status !== 'draft');
  const count = (status: Assignment['status']) =>
    available.filter((a) => a.status === status).length;
  const due = (a: Assignment) =>
    /^\d{4}-\d\d-\d\d$/.test(a.dueDate)
      ? Date.parse(a.dueDate + 'T12:00:00')
      : Number.POSITIVE_INFINITY;
  const queue = teacher
    ? available
        .filter((a) => a.status === 'submitted' || a.status === 'draft')
        .sort(
          (a, b) =>
            (a.status === 'submitted' ? 0 : 1) - (b.status === 'submitted' ? 0 : 1) ||
            b.createdAt - a.createdAt,
        )
    : available
        .filter((a) => a.status === 'assigned' || a.status === 'returned')
        .sort(
          (a, b) =>
            (a.status === 'returned' ? 0 : 1) - (b.status === 'returned' ? 0 : 1) ||
            due(a) - due(b) ||
            a.createdAt - b.createdAt,
        );
  const groups = Array.from(new Set(available.map((a) => a.className.trim()).filter(Boolean)));
  return (
    <section
      className={`role-home role-home-${role}`}
      aria-label={`${teacher ? 'Teacher' : 'Student'} dashboard`}
    >
      <div className="page-heading">
        <div>
          <div className="eyebrow">{teacher ? 'YOUR TEACHING DESK' : 'YOUR LEARNING SPACE'}</div>
          <h1>
            {teacher
              ? `Ready for your next lesson, ${name.split(' ')[0]}?`
              : `One step at a time, ${name.split(' ')[0]}.`}
          </h1>
          <p>
            {teacher
              ? 'Prepare assignments, review work, and keep your lessons together.'
              : 'See what is due, revisit feedback, and continue your work.'}
          </p>
        </div>
        <button className="button primary" onClick={teacher ? onCreate : onAssignments}>
          {teacher ? <Plus size={17} /> : <BookOpen size={17} />}
          {teacher ? 'Create assignment' : 'View my assignments'}
        </button>
      </div>
      <div className="role-home-overview" aria-label="Local assignment overview">
        {(teacher
          ? [
              [count('submitted'), 'To review'],
              [count('draft'), 'Drafts'],
              [count('assigned'), 'Ready for students'],
            ]
          : [
              [count('assigned'), 'To do'],
              [count('returned'), 'With feedback'],
              [count('submitted'), 'Submitted locally'],
            ]
        ).map(([amount, label]) => (
          <div key={label}>
            <strong>{amount}</strong>
            <span>{label}</span>
          </div>
        ))}
      </div>
      <div className="role-home-body">
        <section
          className="role-home-queue"
          aria-label={teacher ? 'Teaching priorities' : 'Student priorities'}
        >
          <div className="section-title">
            <h2>{teacher ? 'On your desk' : 'Your next steps'}</h2>
            <button className="text-button" onClick={onAssignments}>
              {teacher ? 'All assignments' : 'My assignments'} <ArrowRight size={14} />
            </button>
          </div>
          {queue.length ? (
            <div className="role-home-rows">
              {queue.slice(0, 4).map((a) => (
                <button key={a.id} className="role-home-row" onClick={() => onAssignment(a.id)}>
                  {teacher ? <ClipboardList size={20} /> : <BookOpen size={20} />}
                  <span>
                    <strong>{a.title}</strong>
                    <small>
                      {a.className || 'Independent work'}
                      {Number.isFinite(due(a))
                        ? ` · Due ${new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric' }).format(due(a))}`
                        : ''}
                    </small>
                  </span>
                  <span className={`status-label status-${a.status}`}>
                    {a.status === 'submitted'
                      ? 'Review work'
                      : a.status === 'returned'
                        ? 'Read feedback'
                        : a.status === 'draft'
                          ? 'Finish draft'
                          : 'Continue'}
                  </span>
                  <ArrowRight size={15} />
                </button>
              ))}
            </div>
          ) : (
            <div className="role-home-empty">
              <CheckCircle2 size={25} />
              <h3>{teacher ? 'Room for your next lesson.' : 'You’re caught up here.'}</h3>
              <p>
                {teacher
                  ? 'Create a local assignment from one of your documents. Work marked as submitted will appear here for review.'
                  : 'Assigned work and teacher feedback will appear here. Your own notes and documents are always available below.'}
              </p>
              <button className="text-button" onClick={teacher ? onCreate : onDocuments}>
                {teacher ? 'Prepare an assignment' : 'Open my documents'} <ArrowRight size={14} />
              </button>
            </div>
          )}
        </section>
        <aside className="role-home-aside">
          <h2>{teacher ? 'Class groups' : 'Your subjects'}</h2>
          <p>
            {teacher
              ? 'Organized from the class names on your local assignments.'
              : 'Subjects from your assignments in this workspace.'}
          </p>
          {groups.length ? (
            <ul>
              {groups.slice(0, 5).map((group) => (
                <li key={group}>
                  <CalendarDays size={15} />
                  <span>{group}</span>
                  <small>
                    {available.filter((a) => a.className.trim() === group).length}{' '}
                    {available.filter((a) => a.className.trim() === group).length === 1
                      ? 'assignment'
                      : 'assignments'}
                  </small>
                </li>
              ))}
            </ul>
          ) : (
            <p className="role-home-no-groups">
              {teacher
                ? 'Add a class name when you create your first assignment.'
                : 'No subjects have been assigned yet.'}
            </p>
          )}
          {teacher && (
            <button className="text-button" onClick={onAssignments}>
              Manage assignments <ArrowRight size={14} />
            </button>
          )}
        </aside>
      </div>
      <p className="role-home-local">
        Local {teacher ? 'teacher' : 'student'} view · assignments stay on this device. Canvas and
        Google Classroom classes are not connected here.
      </p>
    </section>
  );
}
