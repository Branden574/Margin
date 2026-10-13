import { useEffect, useState } from 'react';
import { FeedbackClient } from '../lib/assignment-feedback/client';
import type { StudentFeedback } from '../lib/assignment-feedback/decode';
import { createReturnedFeedbackReader } from '../lib/assignment-feedback/returned-reader';
import { readAssignmentSnapshot } from '../lib/assignment-work/repository';
import { createVaultGuard } from '../lib/vault';
import { CanvasReviewDocument } from './CanvasReviewDocument';
import './canvas-review.css';
import './canvas-feedback.css';

interface Props {
  submissionId: string;
  documentId: string;
  contentRevision: string;
  source: Blob;
}
/** Uses the immutable source only. The editable student draft is never passed as captured work. */
export function CanvasReturnedFeedback({
  submissionId,
  documentId,
  contentRevision,
  source,
}: Props) {
  const [state, setState] = useState<{
    data: StudentFeedback | null;
    error: string;
    busy: boolean;
  }>({ data: null, error: '', busy: true });
  const [opened, setOpened] = useState(false);
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    let active = true;
    const controller = new AbortController(),
      guard = createVaultGuard(),
      client = new FeedbackClient('student', submissionId);
    const remove = client.subscribeInvalidation(() => {
      if (active) {
        setOpened(false);
        setState({
          data: null,
          error: 'Reopen this assignment from Canvas to read feedback.',
          busy: false,
        });
      }
    });
    setState({ data: null, error: '', busy: true });
    const read = createReturnedFeedbackReader({
      source,
      readFeedback: () => client.student(controller.signal),
      readBinding: async () => (await readAssignmentSnapshot(documentId, contentRevision)).binding,
      check: () => {
        guard();
        client.check();
        if (!active || controller.signal.aborted) throw new Error('Feedback access ended.');
      },
    });
    let checking = false;
    const checkFeedback = async () => {
      if (!active || checking) return;
      checking = true;
      try {
        const data = await read();
        // Recheck after the awaited reader settles, immediately before publishing private data.
        guard();
        client.check();
        if (active) setState({ data, error: '', busy: false });
      } catch (reason) {
        if (active && !controller.signal.aborted) {
          setOpened(false);
          setState({
            data: null,
            error:
              reason instanceof Error ? reason.message : 'Feedback is temporarily unavailable.',
            busy: false,
          });
        }
      } finally {
        checking = false;
      }
    };
    void checkFeedback();
    const revalidate = async () => {
      if (!document.hidden) await checkFeedback();
    };
    const timer = setInterval(() => void revalidate(), 30000);
    const visibility = () => {
      if (!document.hidden) void revalidate();
    };
    document.addEventListener('visibilitychange', visibility);
    return () => {
      active = false;
      controller.abort();
      clearInterval(timer);
      document.removeEventListener('visibilitychange', visibility);
      remove();
      client.dispose();
    };
  }, [submissionId, documentId, contentRevision, source, refresh]);
  useEffect(() => {
    if (!opened) return;
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpened(false);
    };
    document.addEventListener('keydown', key);
    return () => document.removeEventListener('keydown', key);
  }, [opened]);
  const release = state.data?.released;
  return (
    <section className="returned-feedback-summary" aria-label="Returned teacher feedback">
      <div>
        <strong>Teacher feedback</strong>
        <p role="status">
          {state.busy
            ? 'Checking returned feedback…'
            : release
              ? `Returned ${new Date(release.releasedAt).toLocaleString()}`
              : state.error
                ? 'Feedback unavailable'
                : 'No feedback has been returned yet.'}
        </p>
        {state.error && (
          <p className="feedback-error" role="alert">
            {state.error}
          </p>
        )}
        {release?.content.comment && (
          <p className="returned-feedback-comment">{release.content.comment}</p>
        )}
      </div>
      <div className="feedback-actions">
        <button
          className="editor-secondary"
          disabled={state.busy}
          onClick={() => setRefresh((value) => value + 1)}
        >
          Check feedback
        </button>
        {release && (
          <button className="editor-secondary" onClick={() => setOpened(true)}>
            Open returned feedback
          </button>
        )}
      </div>
      {opened && release && state.data && (
        <ReturnedDocument data={state.data} source={source} close={() => setOpened(false)} />
      )}
    </section>
  );
}
function ReturnedDocument({
  data,
  source,
  close,
}: {
  data: StudentFeedback;
  source: Blob;
  close: () => void;
}) {
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const dialog = document.querySelector<HTMLDialogElement>('#returned-feedback-dialog');
    dialog?.showModal();
    return () => {
      dialog?.close();
      previous?.focus();
    };
  }, []);
  return (
    <dialog
      id="returned-feedback-dialog"
      className="returned-feedback-dialog canvas-review"
      aria-labelledby="returned-feedback-title"
      onCancel={close}
    >
      <header className="review-selection-heading">
        <div>
          <h2 id="returned-feedback-title">Returned feedback</h2>
          <p>
            Captured {new Date(data.capture.frozenAt).toLocaleString()} · Feedback revision{' '}
            {data.released!.revision}
          </p>
        </div>
        <button className="review-button" onClick={close} autoFocus>
          Close feedback
        </button>
      </header>
      <CanvasReviewDocument
        source={source}
        pages={data.capture.pages}
        annotations={[]}
        sourceOnly
        feedback={{ annotations: data.released!.content.annotations }}
        feedbackPanel={
          <section className="teacher-feedback">
            <h2>Teacher comment</h2>
            <p className="returned-feedback-comment">
              {data.released!.content.comment || 'No general comment.'}
            </p>
          </section>
        }
      />
    </dialog>
  );
}
