import { useEffect, useState, useSyncExternalStore } from 'react';
import type { ReviewData } from '../lib/assignment-review';
import { FeedbackClient } from '../lib/assignment-feedback/client';
import { FeedbackController } from '../lib/assignment-feedback/controller';
import { onBeforeVaultLock } from '../lib/vault';
import { CanvasReviewDocument } from './CanvasReviewDocument';
import './canvas-feedback.css';

interface Props {
  view: ReviewData;
  registerLeaveGuard: (guard: (() => Promise<void>) | null) => void;
}
export function CanvasTeacherFeedback({ view, registerLeaveGuard }: Props) {
  const [controller, setController] = useState<FeedbackController | null>(null);
  useEffect(() => {
    const { detail } = view;
    const next = new FeedbackController(new FeedbackClient('teacher', detail.submission.id), {
      submissionId: detail.submission.id,
      snapshotPin: detail.snapshotPin,
      documentId: detail.documentId,
      versionId: detail.versionId,
      frozenCursor: detail.submission.frozenCursor,
      frozenAt: detail.submission.frozenAt,
      pages: detail.pages,
      source: detail.source,
    });
    setController(next);
    registerLeaveGuard(next.flush);
    const remove = onBeforeVaultLock(next.flush);
    void next.open();
    return () => {
      registerLeaveGuard(null);
      remove();
      next.dispose();
    };
  }, [view, registerLeaveGuard]);
  return controller ? (
    <TeacherDocument view={view} controller={controller} />
  ) : (
    <CanvasReviewDocument
      source={view.source}
      pages={view.detail.pages}
      annotations={view.annotations}
      feedbackPanel={<p role="status">Opening feedback…</p>}
    />
  );
}
function TeacherDocument({
  view,
  controller,
}: {
  view: ReviewData;
  controller: FeedbackController;
}) {
  const state = useSyncExternalStore(controller.subscribe, controller.getState);
  const disabled =
    state.busy || state.pending || state.conflict || state.invalidated || !state.server;
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (state.localSaving || (state.conflict && state.dirty)) {
        event.preventDefault();
        event.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [state.localSaving, state.conflict, state.dirty]);
  const returned = state.server?.released;
  const fullyReturned = returned && returned.revision === state.server?.revision && !state.dirty;
  const panel = (
    <section className="teacher-feedback" aria-label="Teacher feedback">
      <div className="feedback-heading">
        <h2>Teacher feedback</h2>
        <span>{fullyReturned ? 'Returned' : 'Private draft'}</span>
      </div>
      <p className="feedback-description">
        Save your notes, then return them when they are ready for the student.
      </p>
      <label htmlFor="feedback-comment">General comment</label>
      <textarea
        id="feedback-comment"
        value={state.content.comment}
        disabled={disabled}
        maxLength={16000}
        rows={7}
        placeholder="What went well? What should they work on next?"
        onChange={(event) => controller.edit({ ...state.content, comment: event.target.value })}
      />
      <p className="feedback-save-status" role="status">
        {state.invalidated
          ? 'Reopen the assignment to continue.'
          : state.pending
            ? 'Awaiting request confirmation'
            : state.localSaving
              ? 'Saving on this device…'
              : state.conflict
                ? 'Saved feedback changed'
                : state.busy
                  ? 'Checking feedback…'
                  : state.dirty
                    ? 'Saved on this device · not sent'
                    : state.server?.revision
                      ? `Saved revision ${state.server.revision}`
                      : 'No feedback saved yet'}
      </p>
      {state.error && (
        <p className="feedback-error" role="alert">
          {state.error}
        </p>
      )}
      <div className="feedback-actions">
        {state.pending ? (
          <button
            className="button primary"
            disabled={state.busy || state.invalidated}
            onClick={() => void controller.recover()}
          >
            Check saved request
          </button>
        ) : (
          <>
            <button
              className="button secondary"
              disabled={disabled || state.localSaving || (!state.dirty && !!state.server?.revision)}
              onClick={() => void controller.save()}
            >
              Save feedback
            </button>
            <button
              className="button primary"
              disabled={
                disabled ||
                state.localSaving ||
                state.dirty ||
                !state.server?.revision ||
                !!fullyReturned
              }
              onClick={() => void controller.release()}
            >
              Return feedback
            </button>
          </>
        )}
        {state.conflict && !state.pending && (
          <button
            className="review-button"
            disabled={state.busy || state.invalidated}
            onClick={() => {
              if (
                window.confirm('Replace your local feedback draft with the latest saved feedback?')
              )
                void controller.useSaved();
            }}
          >
            Use saved feedback
          </button>
        )}
      </div>
      {returned && (
        <p className="feedback-release-note">
          Revision {returned.revision} returned {new Date(returned.releasedAt).toLocaleString()}.
          {!fullyReturned && ' The student still sees that returned revision.'}
        </p>
      )}
      <p className="feedback-limit">
        Returning makes feedback available in Margin. It does not send a grade to Canvas.
      </p>
    </section>
  );
  return (
    <CanvasReviewDocument
      source={view.source}
      pages={view.detail.pages}
      annotations={view.annotations}
      feedback={{
        annotations: state.content.annotations,
        onChange: (annotations) => controller.edit({ ...state.content, annotations }),
        disabled,
      }}
      feedbackPanel={panel}
    />
  );
}
