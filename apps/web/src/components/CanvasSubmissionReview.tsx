import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ArrowLeft,
  ChevronLeft,
  ChevronRight,
  FileCheck2,
  Loader2,
  LockKeyhole,
  RefreshCw,
} from 'lucide-react';
import { Brand } from './Brand';
import { CanvasReviewDocument } from './CanvasReviewDocument';
import {
  createAssignmentReviewClient,
  readVerifiedReviewSnapshot,
  type ReviewContext,
  type ReviewData,
  type ReviewPage,
  type ReviewProgress,
} from '../lib/assignment-review';
import { lockVault } from '../lib/vault';
import { getPreferences } from '../lib/storage';
import './canvas-review.css';

const message = (reason: unknown) =>
  reason instanceof Error ? reason.message : 'Review is temporarily unavailable. Try again.';
const reference = (id: string) => id.slice(-8).toUpperCase();
const date = (value: string) =>
  new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  }).format(new Date(value));
const preparation = (state: ReviewPage['submissions'][number]['preparation']) =>
  state === 'ready' ? 'Ready to review' : state === 'failed' ? 'Preparation failed' : 'Preparing';
type ReviewClient = ReturnType<typeof createAssignmentReviewClient>;

export default function CanvasSubmissionReview() {
  const [session, setSession] = useState<{ client: ReviewClient; key: string } | null>(null);
  useEffect(() => {
    const next = createAssignmentReviewClient();
    setSession({ client: next, key: crypto.randomUUID() });
    return () => next.dispose();
  }, []);
  return session ? (
    <ReviewSession key={session.key} client={session.client} />
  ) : (
    <main className="app-loading">
      <Brand />
      <p role="status">Opening teacher review…</p>
    </main>
  );
}

function ReviewSession({ client }: { client: ReviewClient }) {
  const [context, setContext] = useState<ReviewContext | null>(null);
  const [listing, setListing] = useState<ReviewPage | null>(null);
  const [selection, setSelection] = useState('');
  const [view, setView] = useState<ReviewData | null>(null);
  const [progress, setProgress] = useState<ReviewProgress | null>(null);
  const [busy, setBusy] = useState(true);
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState('');
  const [invalidated, setInvalidated] = useState(false);
  const [pageIndex, setPageIndex] = useState(0);
  const alive = useRef(true),
    generation = useRef(0),
    request = useRef<AbortController | null>(null);
  const cursors = useRef<Array<string | undefined>>([undefined]);
  const lastContext = useRef<ReviewContext | null>(null);

  const clearView = useCallback(() => {
    generation.current++;
    request.current?.abort();
    request.current = null;
    client.clearSelection();
    setView(null);
    setProgress(null);
    setOpening(false);
  }, [client]);
  const select = useCallback(
    async (id: string, summary: ReviewPage['submissions'][number]) => {
      clearView();
      setSelection(id);
      setError('');
      if (summary.preparation !== 'ready') return;
      const current = generation.current;
      const controller = new AbortController();
      request.current = controller;
      setOpening(true);
      try {
        const proof = await client.loadSubmission(id, {
          signal: controller.signal,
          onProgress: (value) => {
            if (alive.current && generation.current === current) setProgress(value);
          },
        });
        if (!alive.current || generation.current !== current) return;
        setView(readVerifiedReviewSnapshot(proof));
      } catch (reason) {
        if (alive.current && generation.current === current && !controller.signal.aborted)
          setError(message(reason));
      } finally {
        if (alive.current && generation.current === current) {
          setOpening(false);
          setProgress(null);
        }
      }
    },
    [client, clearView],
  );
  const loadList = useCallback(
    async (index: number, after?: string, selectLast = false) => {
      clearView();
      setSelection('');
      setListing(null);
      setBusy(true);
      setError('');
      const current = generation.current;
      const controller = new AbortController();
      request.current = controller;
      try {
        const currentContext = await client.loadContext({ signal: controller.signal });
        if (!alive.current || current !== generation.current) return;
        lastContext.current = currentContext;
        setContext(currentContext);
        const page = await client.list(after ? { after } : {}, { signal: controller.signal });
        if (!alive.current || current !== generation.current) return;
        cursors.current = [...cursors.current.slice(0, index), after];
        setPageIndex(index);
        setListing(page);
        setBusy(false);
        const first = page.submissions[selectLast ? page.submissions.length - 1 : 0];
        if (first) void select(first.id, first);
      } catch (reason) {
        if (alive.current && current === generation.current && !controller.signal.aborted)
          setError(message(reason));
      } finally {
        if (alive.current && current === generation.current) setBusy(false);
      }
    },
    [client, clearView, select],
  );

  useEffect(() => {
    alive.current = true;
    const unsubscribe = client.subscribeInvalidation((reason, displayMessage) => {
      if (!alive.current) return;
      generation.current++;
      request.current?.abort();
      lastContext.current = null;
      setView(null);
      setContext(null);
      setListing(null);
      setSelection('');
      setOpening(false);
      setBusy(false);
      setInvalidated(true);
      setError(
        displayMessage ||
          (reason === 'vault_locked'
            ? 'The workspace was locked. Unlock it to reopen review.'
            : reason === 'session_expired'
              ? 'Your Canvas session expired. Launch this assignment again.'
              : 'Teacher access could not be verified. Launch this assignment again from Canvas.'),
      );
    });
    void getPreferences()
      .then((preferences) => {
        if (!alive.current) return;
        document.documentElement.dataset.theme = preferences.theme;
        document.documentElement.dataset.motion = preferences.reducedMotion ? 'reduced' : 'full';
        document.documentElement.dataset.reading = preferences.dyslexiaFont
          ? 'comfortable'
          : 'standard';
      })
      .catch(() => {});
    void loadList(0);
    // Current launch access is rechecked while viewing, not just when selecting a submission.
    let checking = false;
    const check = async () => {
      if (checking || !lastContext.current || document.hidden) return;
      checking = true;
      const current = generation.current;
      try {
        await client.revalidateSelection();
      } catch (reason) {
        if (alive.current && generation.current === current) {
          clearView();
          setError(message(reason));
        }
      } finally {
        checking = false;
      }
    };
    const visibility = () => {
      if (!document.hidden) void check();
    };
    const timer = setInterval(() => void check(), 30_000);
    document.addEventListener('visibilitychange', visibility);
    return () => {
      alive.current = false;
      generation.current++;
      request.current?.abort();
      clearInterval(timer);
      document.removeEventListener('visibilitychange', visibility);
      unsubscribe();
      client.clearSelection();
    };
  }, [client, loadList, clearView]);

  const selectedIndex = listing?.submissions.findIndex((item) => item.id === selection) ?? -1;
  const selected = selectedIndex >= 0 ? listing!.submissions[selectedIndex] : null;
  const previous = () => {
    if (!listing || busy) return;
    const item = listing.submissions[selectedIndex - 1];
    if (item) void select(item.id, item);
    else if (pageIndex > 0) void loadList(pageIndex - 1, cursors.current[pageIndex - 1], true);
  };
  const next = () => {
    if (!listing || busy) return;
    const item = listing.submissions[selectedIndex + 1];
    if (item) void select(item.id, item);
    else if (listing.nextCursor) void loadList(pageIndex + 1, listing.nextCursor);
  };
  const loadingText =
    progress?.stage === 'annotations'
      ? `Checking annotation data ${progress.completed} of ${progress.total}…`
      : progress?.stage === 'source'
        ? 'Opening the preserved PDF…'
        : progress?.stage === 'verifying'
          ? 'Verifying this submission…'
          : 'Opening frozen submission…';
  return (
    <main className="canvas-review">
      <header className="review-header">
        <a href="/#home" className="review-brand-link" aria-label="Margin local workspace">
          <Brand />
        </a>
        <div className="review-assignment">
          <span>CANVAS · TEACHER REVIEW</span>
          <h1>{context?.assignment.title ?? 'Submission review'}</h1>
        </div>
        <div className="review-header-actions">
          <button
            className="review-button"
            disabled={busy || invalidated}
            onClick={() => void loadList(0)}
          >
            <RefreshCw size={15} />
            Refresh
          </button>
          <button
            className="review-icon"
            aria-label="Lock workspace"
            onClick={() => void lockVault().catch((reason) => setError(message(reason)))}
          >
            <LockKeyhole size={18} />
          </button>
        </div>
      </header>
      {invalidated ? (
        <section className="review-unavailable">
          <LockKeyhole size={28} />
          <h2>Reopen this assignment from Canvas</h2>
          <p role="alert">{error || 'The teacher launch is no longer current.'}</p>
          <a href="/#home">
            <ArrowLeft size={15} />
            Local workspace
          </a>
        </section>
      ) : (
        <div className="review-layout">
          <aside className="review-sidebar" aria-label="Captured submissions">
            <div className="review-sidebar-heading">
              <h2>Submissions</h2>
              <span>
                {listing?.submissions.length ?? '—'}
                {listing?.nextCursor ? '+' : ''}
              </span>
            </div>
            <p className="review-sidebar-caption">Captured versions in Margin</p>
            {busy && (
              <p className="review-sidebar-status" role="status">
                Loading submissions…
              </p>
            )}
            {listing && !listing.submissions.length && (
              <p className="review-sidebar-status">No captured submissions yet.</p>
            )}
            <ol className="review-submissions">
              {listing?.submissions.map((item, index) => (
                <li key={item.id}>
                  <button
                    aria-current={selection === item.id ? 'true' : undefined}
                    onClick={() => void select(item.id, item)}
                  >
                    <span className="review-list-number" aria-hidden="true">
                      {String(index + 1).padStart(2, '0')}
                    </span>
                    <span className="review-submission-copy">
                      <strong>Submission {reference(item.id)}</strong>
                      <time dateTime={item.frozenAt}>{date(item.frozenAt)}</time>
                      <span className={`review-preparation is-${item.preparation}`}>
                        {preparation(item.preparation)}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ol>
            {(pageIndex > 0 || listing?.nextCursor) && (
              <nav className="review-list-pagination" aria-label="Submission list pages">
                <button
                  className="review-icon"
                  aria-label="Previous submissions"
                  disabled={busy || pageIndex === 0}
                  onClick={() => void loadList(pageIndex - 1, cursors.current[pageIndex - 1])}
                >
                  <ChevronLeft size={16} />
                </button>
                <span>Page {pageIndex + 1}</span>
                <button
                  className="review-icon"
                  aria-label="More submissions"
                  disabled={busy || !listing?.nextCursor}
                  onClick={() => {
                    if (listing?.nextCursor) void loadList(pageIndex + 1, listing.nextCursor);
                  }}
                >
                  <ChevronRight size={16} />
                </button>
              </nav>
            )}
            <div className="review-sidebar-foot">
              <FileCheck2 size={18} />
              <p>
                Names will appear when a verified class roster is connected. References identify
                each saved submission.
              </p>
            </div>
            {context?.assignment.instructions && (
              <details className="review-instructions">
                <summary>Assignment instructions</summary>
                <p>{context.assignment.instructions}</p>
              </details>
            )}
          </aside>
          <section className="review-workspace" aria-label="Submission review">
            <div className="review-selection-heading">
              <div>
                <h2>
                  {selected ? `Submission ${reference(selected.id)}` : 'Captured student work'}
                </h2>
                <p>
                  {selected
                    ? `Captured ${date(selected.frozenAt)}`
                    : 'Select a preserved submission to begin.'}
                </p>
              </div>
              <nav className="review-selection-nav" aria-label="Submission navigation">
                <button
                  className="review-button"
                  disabled={busy || selectedIndex < 0 || (selectedIndex === 0 && pageIndex === 0)}
                  onClick={previous}
                >
                  <ChevronLeft size={16} />
                  <span>Previous submission</span>
                </button>
                <button
                  className="review-button"
                  disabled={
                    busy ||
                    selectedIndex < 0 ||
                    (selectedIndex === (listing?.submissions.length ?? 0) - 1 &&
                      !listing?.nextCursor)
                  }
                  onClick={next}
                >
                  <span>Next submission</span>
                  <ChevronRight size={16} />
                </button>
              </nav>
            </div>
            {error && (
              <div className="review-error">
                <p role="alert">{error}</p>
                {selected && (
                  <button
                    className="review-button"
                    onClick={() => void select(selected.id, selected)}
                  >
                    Try again
                  </button>
                )}
              </div>
            )}
            {view ? (
              <CanvasReviewDocument
                key={`${view.detail.submission.id}:${view.detail.snapshotPin}`}
                source={view.source}
                pages={view.detail.pages}
                annotations={view.annotations}
              />
            ) : (
              <div className="review-placeholder">
                {opening || busy ? (
                  <>
                    <Loader2 size={28} className="spin" aria-hidden="true" />
                    <p role="status">
                      {opening ? loadingText : 'Checking the Canvas teacher launch…'}
                    </p>
                  </>
                ) : selected?.preparation === 'failed' ? (
                  <>
                    <FileCheck2 size={32} />
                    <h3>This submission needs preparation</h3>
                    <p>The capture is preserved. Its document is not ready to review.</p>
                  </>
                ) : selected?.preparation === 'preparing' ? (
                  <>
                    <Loader2 size={28} />
                    <h3>Preparing the captured version</h3>
                    <p>Refresh to check whether its document is ready.</p>
                  </>
                ) : (
                  <>
                    <FileCheck2 size={36} />
                    <h3>{error ? 'Review unavailable' : 'A place for each submission'}</h3>
                    <p>
                      {error
                        ? 'Refresh or reopen the assignment from Canvas.'
                        : 'Student work will appear here after it has been captured and prepared.'}
                    </p>
                  </>
                )}
              </div>
            )}
            <footer className="review-status">
              <span>Frozen submission · read-only</span>
              <span>Canvas submission confirmation is not available yet.</span>
            </footer>
          </section>
        </div>
      )}
    </main>
  );
}
