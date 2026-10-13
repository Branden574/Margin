import { useEffect, useRef, useState } from 'react';
import {
  FeedbackClient,
  readVerifiedReturnedCapture,
  type ReturnedCaptureData,
} from '../lib/assignment-feedback/client';
import type { ReviewProgress } from '../lib/assignment-review/types';
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
/** Captured annotations are fetched only when opened; the editable student draft is never used. */
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
        <ReturnedDocument
          key={`${state.data.capture.snapshotPin}:${release.revision}`}
          data={state.data}
          source={source}
          documentId={documentId}
          contentRevision={contentRevision}
          close={() => setOpened(false)}
        />
      )}
    </section>
  );
}
function ReturnedDocument({
  data,
  source,
  documentId,
  contentRevision,
  close,
}: {
  data: StudentFeedback;
  source: Blob;
  documentId: string;
  contentRevision: string;
  close: () => void;
}) {
  const expected = useRef(data).current;
  const dialog = useRef<HTMLDialogElement>(null);
  const [capture, setCapture] = useState<ReturnedCaptureData | null>(null);
  const [progress, setProgress] = useState<ReviewProgress | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const element = dialog.current;
    element?.showModal();
    return () => {
      element?.close();
      previous?.focus();
    };
  }, []);
  useEffect(() => {
    let active = true;
    const abort = new AbortController(),
      client = new FeedbackClient('student', expected.capture.submissionId, { timeoutMs: 120000 });
    setCapture(null);
    setProgress(null);
    setLoading(true);
    setError('');
    const remove = client.subscribeInvalidation(() => {
      if (active) {
        setCapture(null);
        setProgress(null);
        setLoading(false);
        setError('Feedback access ended. Reopen this assignment from Canvas.');
      }
    });
    void (async () => {
      try {
        const proof = await client.loadReturnedCapture(
          {
            expected,
            source,
            readBinding: async () =>
              (await readAssignmentSnapshot(documentId, contentRevision)).binding,
          },
          {
            signal: abort.signal,
            onProgress: (value) => {
              if (active) setProgress(value);
            },
          },
        );
        const verified = readVerifiedReturnedCapture(proof);
        client.check();
        if (active && !abort.signal.aborted) setCapture(verified);
      } catch (reason) {
        if (active && !abort.signal.aborted) {
          setCapture(null);
          setError(
            reason instanceof Error
              ? reason.message
              : 'The captured submission could not be opened. Try again.',
          );
        }
      } finally {
        if (active) {
          setLoading(false);
          setProgress(null);
        }
      }
    })();
    return () => {
      active = false;
      abort.abort();
      remove();
      client.dispose();
    };
  }, [expected, source, documentId, contentRevision, retry]);
  const shown = capture?.feedback ?? expected;
  return (
    <dialog
      ref={dialog}
      id="returned-feedback-dialog"
      className="returned-feedback-dialog canvas-review"
      aria-labelledby="returned-feedback-title"
      onCancel={close}
    >
      <header className="review-selection-heading">
        <div>
          <h2 id="returned-feedback-title">Returned feedback</h2>
          <p>
            Captured {new Date(shown.capture.frozenAt).toLocaleString()} · Feedback revision{' '}
            {shown.released!.revision}
          </p>
        </div>
        <button className="review-button" onClick={close} autoFocus>
          Close feedback
        </button>
      </header>
      {capture ? (
        <CanvasReviewDocument
          key={capture.detail.snapshotPin}
          source={capture.source}
          pages={capture.detail.pages}
          annotations={capture.annotations}
          feedback={{ annotations: capture.feedback.released!.content.annotations }}
          feedbackPanel={
            <section className="teacher-feedback">
              <h2>Teacher comment</h2>
              <p className="returned-feedback-comment">
                {capture.feedback.released!.content.comment || 'No general comment.'}
              </p>
            </section>
          }
        />
      ) : (
        <div className="review-placeholder">
          {loading ? (
            <p role="status">
              {progress?.stage === 'annotations'
                ? `Verifying captured work (${progress.completed} of ${progress.total})…`
                : progress?.stage === 'source'
                  ? 'Verifying the preserved PDF…'
                  : 'Opening the captured submission…'}
            </p>
          ) : (
            <>
              <h3>Captured work unavailable</h3>
              <p role="alert">{error}</p>
              <button className="button secondary" onClick={() => setRetry((value) => value + 1)}>
                Try opening feedback again
              </button>
            </>
          )}
        </div>
      )}
    </dialog>
  );
}
