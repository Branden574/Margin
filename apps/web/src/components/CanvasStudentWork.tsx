import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { ArrowLeft, Loader2, LockKeyhole, RefreshCw } from 'lucide-react';
import type { AnnotationTool, DocumentRecord } from '@margin/core';
import { Brand } from './Brand';
import { createStudentWorkController } from '../lib/assignment-work/controller';
import type { StudentWorkController } from '../lib/assignment-work/controllerTypes';
import { readAssignmentSnapshot } from '../lib/assignment-work/repository';
import { getDocumentForOcr, getPreferences } from '../lib/storage';
import { createVaultGuard, lockVault } from '../lib/vault';
import type { AnnotationPersistence } from '../editor/useAnnotations';
import './canvas-work.css';

const DocumentEditor = lazy(() => import('../editor/DocumentEditor'));
const message = (error: unknown) =>
  error instanceof Error ? error.message : 'The assignment could not be opened.';
type LoadedWork = { document: DocumentRecord; blob: Blob; cursor: number; epoch: number };

/** The path selects a screen only. Current server launch/session determines every work identity. */
export default function CanvasStudentWork() {
  const [session, setSession] = useState<{ controller: StudentWorkController; key: string } | null>(
    null,
  );
  useEffect(() => {
    const next = createStudentWorkController();
    setSession({ controller: next, key: crypto.randomUUID() });
    return () => next.dispose();
  }, []);
  return session ? (
    <StudentWorkSession key={session.key} controller={session.controller} />
  ) : (
    <Opening />
  );
}

function Opening() {
  return (
    <main className="canvas-work-opening" aria-live="polite">
      <Brand />
      <Loader2 className="spin" aria-hidden="true" />
      <p>Opening your Canvas assignment…</p>
    </main>
  );
}

function StudentWorkSession({ controller }: { controller: StudentWorkController }) {
  const state = useSyncExternalStore(controller.subscribe, controller.getState);
  const [loaded, setLoaded] = useState<LoadedWork | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');
  const [shortcuts, setShortcuts] = useState(true);
  const alive = useRef(true),
    loadGeneration = useRef(0),
    actionActive = useRef(false),
    epoch = useRef(0);
  const leaveGuard = useRef<(() => Promise<void>) | null>(null);
  const registerLeaveGuard = useCallback((guard: (() => Promise<void>) | null) => {
    leaveGuard.current = guard;
  }, []);
  const loadPdf = useCallback(async () => {
    const generation = ++loadGeneration.current;
    const view = controller.getState().view;
    if (!view) {
      if (alive.current) setLoaded(null);
      return;
    }
    const guard = createVaultGuard();
    const fresh = await getDocumentForOcr(view.document.id);
    guard();
    const current = controller.getState().view;
    if (!alive.current || generation !== loadGeneration.current) return;
    if (
      !current ||
      current.document.id !== view.document.id ||
      current.document.contentRevision !== view.document.contentRevision
    ) {
      setLoaded(null);
      return;
    }
    if (!fresh || fresh.record.contentRevision !== current.document.contentRevision)
      throw new Error('The saved assignment PDF changed. Reopen the assignment from Canvas.');
    setLoaded({
      document: fresh.record,
      blob: fresh.blob,
      cursor: current.appliedCursor,
      epoch: ++epoch.current,
    });
  }, [controller]);
  useEffect(() => {
    alive.current = true;
    void (async () => {
      try {
        const preferences = await getPreferences();
        if (!alive.current) return;
        document.documentElement.dataset.theme = preferences.theme;
        document.documentElement.dataset.motion = preferences.reducedMotion ? 'reduced' : 'full';
        document.documentElement.dataset.reading = preferences.dyslexiaFont
          ? 'comfortable'
          : 'standard';
        setShortcuts(preferences.shortcuts);
        await controller.open();
        await loadPdf();
      } catch (reason) {
        if (alive.current) setError(message(reason));
      } finally {
        if (alive.current) setBusy(false);
      }
    })();
    return () => {
      alive.current = false;
      loadGeneration.current++;
    };
  }, [controller, loadPdf]);
  useEffect(() => {
    if (!state.view) {
      loadGeneration.current++;
      setLoaded(null);
    }
  }, [state.view]);

  const perform = useCallback(
    async (action: () => Promise<void>) => {
      if (actionActive.current) return;
      actionActive.current = true;
      setBusy(true);
      setError('');
      let canReload = false;
      try {
        await leaveGuard.current?.();
        await controller.flushLocal();
        canReload = true;
        await action();
      } catch (reason) {
        if (alive.current) setError(message(reason));
      } finally {
        if (canReload && alive.current) {
          try {
            await loadPdf();
          } catch (reason) {
            if (alive.current) {
              setLoaded(null);
              setError(message(reason));
            }
          }
        }
        actionActive.current = false;
        if (alive.current) setBusy(false);
      }
    },
    [controller, loadPdf],
  );

  const identity = loaded ? `${loaded.document.id}:${loaded.document.contentRevision}` : '';
  const persistence = useMemo<AnnotationPersistence>(() => {
    const documentId = loaded?.document.id,
      revision = loaded?.document.contentRevision;
    const assertCurrent = () => {
      const view = controller.getState().view;
      if (
        !documentId ||
        !revision ||
        view?.document.id !== documentId ||
        view.document.contentRevision !== revision
      )
        throw new Error('This assignment view is no longer current. Reopen it from Canvas.');
    };
    return {
      async load(id) {
        assertCurrent();
        if (id !== documentId) throw new Error('The assignment document changed.');
        const snapshot = await readAssignmentSnapshot(id, revision);
        assertCurrent();
        if (snapshot.binding.appliedCursor !== loaded?.cursor)
          throw new Error('Newer saved annotations are available. Refresh before editing.');
        return snapshot.annotations;
      },
      async append(operation) {
        assertCurrent();
        if (operation.documentId !== documentId)
          throw new Error('The assignment document changed.');
        await controller.enqueue(operation, loaded?.cursor);
      },
    };
    // A stable adapter owns one document revision; the editor is remounted after reconciliation.
  }, [controller, identity, loaded?.epoch]);

  const terminal = ['invalidated', 'locked', 'disposed'].includes(state.phase);
  const networkBusy = ['opening', 'catching-up', 'syncing'].includes(state.phase);
  const changed = !!loaded && !!state.view && loaded.cursor !== state.view.appliedCursor;
  const uncertain = state.view?.pending.find(
    (row) => row.status === 'uncertain' || row.status === 'sending',
  );
  const status =
    state.saveStatus === 'conflict'
      ? 'An edit needs conflict resolution. Your local draft is kept.'
      : state.saveStatus === 'uncertain' || state.saveStatus === 'sending'
        ? 'An edit is awaiting confirmation. Its saved copy is kept.'
        : state.saveStatus === 'local-only'
          ? 'Edits saved on this device. Sync to confirm them with the server.'
          : state.saveStatus === 'acknowledged'
            ? 'Server has acknowledged the saved edits.'
            : 'Your private assignment copy';
  const controls = (
    <section className="canvas-work-status" aria-label="Canvas assignment status">
      <div>
        <p role="status">
          {changed && !busy ? 'Newer saved work is available. Refresh before editing.' : status}
        </p>
        <small>Not submitted to Canvas</small>
        {state.view?.assignment.instructions && (
          <details className="canvas-work-instructions">
            <summary>Assignment instructions</summary>
            <p>{state.view.assignment.instructions}</p>
          </details>
        )}
      </div>
      <div className="canvas-work-actions">
        <button
          className="editor-secondary"
          disabled={busy || networkBusy || terminal}
          onClick={() => void perform(() => controller.refresh())}
        >
          <RefreshCw size={14} />
          {state.needsCatchUp ? 'Continue recovery' : 'Refresh'}
        </button>
        {uncertain ? (
          <button
            className="editor-secondary"
            disabled={busy || networkBusy || terminal || state.saveStatus === 'conflict'}
            onClick={() => void perform(() => controller.retry(uncertain.operationId))}
          >
            Retry saved edit
          </button>
        ) : (
          <button
            className="editor-secondary"
            disabled={busy || networkBusy || terminal || state.saveStatus === 'conflict'}
            onClick={() => void perform(() => controller.sync())}
          >
            {busy ? 'Working…' : 'Sync saved edits'}
          </button>
        )}
        <button
          className="editor-icon"
          aria-label="Lock workspace"
          onClick={() => void lockVault().catch((reason) => setError(message(reason)))}
        >
          <LockKeyhole size={17} />
        </button>
      </div>
      {(error || state.error || state.localError) && (
        <p className="canvas-work-error" role="alert">
          {error || state.localError?.message || state.error?.message}
        </p>
      )}
      {state.localError?.code === 'stale_editor_cursor' && (
        <button
          className="editor-secondary"
          disabled={busy || networkBusy}
          onClick={() => {
            const failed = controller.getState().localError;
            if (
              !failed ||
              failed.code !== 'stale_editor_cursor' ||
              !window.confirm(
                'Discard all unsaved changes in this editor and reload saved work? Edits already saved on this device will stay.',
              )
            )
              return;
            void (async () => {
              if (actionActive.current) return;
              actionActive.current = true;
              setBusy(true);
              try {
                await controller.discardStaleDraft(failed.operationId);
                await controller.flushLocal();
                if (alive.current) setLoaded(null);
                await controller.refresh();
                await loadPdf();
                if (alive.current) setError('');
              } catch (reason) {
                if (alive.current) setError(message(reason));
              } finally {
                actionActive.current = false;
                if (alive.current) setBusy(false);
              }
            })();
          }}
        >
          Discard unsaved changes and refresh
        </button>
      )}
    </section>
  );

  if (loaded && state.view?.hydrated && !terminal)
    return (
      <Suspense fallback={<Opening />}>
        <DocumentEditor
          key={`${identity}:${loaded.epoch}`}
          document={loaded.document}
          blob={loaded.blob}
          onClose={() => {
            location.assign('/#home');
          }}
          onDocumentChange={async () => {
            throw new Error('Assignment pages cannot be replaced.');
          }}
          registerLeaveGuard={registerLeaveGuard}
          shortcuts={shortcuts}
          assignment={{
            persistence,
            allowedTools: state.view.assignment.policy.allowedTools as readonly AnnotationTool[],
            readOnly: busy || networkBusy || changed || state.saveStatus === 'conflict',
            controls,
          }}
        />
      </Suspense>
    );

  return (
    <main className="canvas-work-opening">
      <Brand />
      <div className="canvas-work-message">
        {busy && <Loader2 className="spin" aria-hidden="true" />}
        <h1>
          {state.phase === 'provisioning'
            ? 'Your assignment copy is being prepared'
            : terminal
              ? 'Reopen this assignment from Canvas'
              : busy
                ? 'Opening your assignment'
                : state.needsCatchUp
                  ? 'Recovering your saved work'
                  : 'Canvas assignment unavailable'}
        </h1>
        <p>
          {state.phase === 'provisioning'
            ? 'Check again when your private document is ready.'
            : terminal
              ? 'Your encrypted drafts remain on this device. A current Canvas launch is needed to continue.'
              : state.needsCatchUp
                ? 'Continue recovery to load the rest of your saved annotations.'
                : 'Open the assigned Margin activity from your Canvas course.'}
        </p>
        {(error || state.error) && (
          <p role="alert" className="canvas-work-error">
            {error || state.error?.message}
          </p>
        )}
        {!terminal && (
          <button
            className="button primary"
            disabled={busy || networkBusy}
            onClick={() => void perform(() => controller.refresh())}
          >
            <RefreshCw size={16} />
            {state.needsCatchUp ? 'Continue recovery' : 'Check again'}
          </button>
        )}
        <a className="canvas-work-back" href="/#home">
          <ArrowLeft size={15} />
          Local workspace
        </a>
      </div>
    </main>
  );
}
