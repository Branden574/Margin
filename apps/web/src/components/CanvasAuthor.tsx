import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  Check,
  ChevronLeft,
  ChevronRight,
  FileText,
  Loader2,
  LockKeyhole,
  Upload,
} from 'lucide-react';
import { Brand } from './Brand';
import { Modal } from './Modal';
import { createAssignmentAuthorClient, readAuthorContext } from '../lib/assignment-author/client';
import {
  authorTools,
  type AssignmentAuthorClient,
  type AuthorContext,
  type AuthorSourcePage,
  type AuthorTool,
} from '../lib/assignment-author/types';
import {
  authorFormPayload,
  AuthorDraftConflict,
  readAuthorDraft,
  saveAuthorDraft,
  type AuthorDraftValue,
  type AuthorFormDraft,
} from '../lib/assignment-author/draft';
import { createVaultGuard, lockVault, onBeforeVaultLock, onVaultLock } from '../lib/vault';
import { getPreferences } from '../lib/storage';
import {
  AuthorUploadController,
  type AuthorUploadState,
} from '../lib/assignment-author/upload-controller';
import './canvas-author.css';

const labels: Record<AuthorTool, string> = {
  text: 'Text',
  pen: 'Draw',
  highlight: 'Highlight',
  comment: 'Comments',
  rectangle: 'Rectangle',
  ellipse: 'Ellipse',
  line: 'Line',
  eraser: 'Eraser',
};
const empty = (): AuthorDraftValue => ({
  phase: 'editing',
  form: { source: null, title: '', instructions: '', allowedTools: [...authorTools] },
});
const message = (error: unknown) =>
  error instanceof Error
    ? error.message
    : 'Assignment setup could not be completed. Your saved draft is kept.';
const size = (bytes: number) =>
  bytes < 1024 * 1024
    ? `${Math.max(1, Math.round(bytes / 1024))} KB`
    : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;

export default function CanvasAuthor() {
  const [lifecycle, setLifecycle] = useState<{
    client: AssignmentAuthorClient;
    key: string;
  } | null>(null);
  useEffect(() => {
    const client = createAssignmentAuthorClient();
    setLifecycle({ client, key: crypto.randomUUID() });
    return () => client.dispose();
  }, []);
  return lifecycle ? (
    <AuthorSession key={lifecycle.key} client={lifecycle.client} />
  ) : (
    <main className="canvas-author">
      <Brand />
      <p role="status">Opening assignment setup…</p>
    </main>
  );
}

function AuthorSession({ client }: { client: AssignmentAuthorClient }) {
  const [context, setContext] = useState<AuthorContext | null>(null);
  const [value, setValue] = useState<AuthorDraftValue>(empty);
  const [pages, setPages] = useState<AuthorSourcePage[]>([]);
  const [pageIndex, setPageIndex] = useState(0);
  const [busy, setBusy] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [error, setError] = useState('');
  const [localError, setLocalError] = useState('');
  const [cancelPrompt, setCancelPrompt] = useState(false);
  const [discardPrompt, setDiscardPrompt] = useState(false);
  const [upload, setUpload] = useState<AuthorUploadState>({
    busy: false,
    stage: 'idle',
    error: '',
    paused: false,
  });
  const uploader = useRef<AuthorUploadController | null>(null),
    fileInput = useRef<HTMLInputElement>(null);
  const alive = useRef(true),
    current = useRef<AuthorContext | null>(null),
    draft = useRef<AuthorDraftValue>(empty()),
    revision = useRef<string | null>(null),
    dirty = useRef(false),
    action = useRef(false),
    leaving = useRef(false),
    blocked = useRef(false),
    write = useRef<Promise<void> | null>(null),
    timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showFailure = useCallback((reason: unknown) => {
    if (!alive.current) return;
    setError(message(reason));
    if (reason instanceof AuthorDraftConflict) {
      blocked.current = true;
      setConflict(true);
    }
    if (current.current) {
      try {
        readAuthorContext(current.current);
      } catch {
        setUnavailable(true);
      }
    }
  }, []);
  const flush = useCallback(async () => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    if (write.current) return write.current;
    if (!dirty.current) return;
    const capability = current.current;
    if (!capability || blocked.current)
      throw new Error('Reopen the Canvas selection before saving this draft.');
    const task = (async () => {
      if (alive.current) setSaving(true);
      while (dirty.current) {
        const snapshot = structuredClone(draft.current);
        const record = await saveAuthorDraft(capability, snapshot, revision.current);
        revision.current = record.revision;
        if (JSON.stringify(draft.current) === JSON.stringify(snapshot)) dirty.current = false;
      }
      if (alive.current) {
        setLocalError('');
        setSaved(true);
      }
    })();
    write.current = task;
    try {
      await task;
    } catch (reason) {
      if (alive.current) setLocalError(message(reason));
      showFailure(reason);
      throw reason;
    } finally {
      if (write.current === task) write.current = null;
      if (alive.current) setSaving(false);
    }
  }, [showFailure]);
  const replace = useCallback((next: AuthorDraftValue) => {
    draft.current = structuredClone(next);
    dirty.current = true;
    setValue(draft.current);
    setSaved(false);
    setLocalError('');
  }, []);
  const edit = (change: Partial<AuthorFormDraft>) => {
    if (action.current || blocked.current || draft.current.phase !== 'editing' || !current.current)
      return;
    try {
      readAuthorContext(current.current);
    } catch (reason) {
      showFailure(reason);
      return;
    }
    replace({ phase: 'editing', form: { ...draft.current.form, ...change } });
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      timer.current = null;
      void flush().catch(() => {});
    }, 180);
  };
  useEffect(() => {
    alive.current = true;
    const vaultGuard = createVaultGuard();
    void (async () => {
      try {
        const preferences = await getPreferences();
        vaultGuard();
        if (!alive.current) return;
        document.documentElement.dataset.theme = preferences.theme;
        document.documentElement.dataset.motion = preferences.reducedMotion ? 'reduced' : 'full';
        const verified = await client.open();
        vaultGuard();
        if (!alive.current) return;
        current.current = verified;
        const stored = await readAuthorDraft(verified);
        vaultGuard();
        if (!alive.current) return;
        if (stored) {
          const { revision: savedRevision, ...restored } = stored;
          revision.current = savedRevision;
          draft.current = restored;
          setValue(restored);
          setSaved(true);
        }
        setContext(verified);
        setPages([await client.sources()]);
      } catch (reason) {
        if (alive.current) {
          showFailure(reason);
          if (!current.current) setUnavailable(true);
        }
      } finally {
        if (alive.current) setBusy(false);
      }
    })();
    return () => {
      alive.current = false;
      if (timer.current) clearTimeout(timer.current);
    };
  }, [client, showFailure]);
  useEffect(() => {
    const offBefore = onBeforeVaultLock(async () => {
      uploader.current?.cancel();
      await flush();
    });
    const offLock = onVaultLock(() => {
      uploader.current?.dispose();
      client.dispose();
      current.current = null;
    });
    const warn = (event: BeforeUnloadEvent) => {
      if (!leaving.current && dirty.current) {
        event.preventDefault();
        event.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', warn);
    return () => {
      offBefore();
      offLock();
      window.removeEventListener('beforeunload', warn);
    };
  }, [client, flush]);
  useEffect(() => {
    if (!context) return;
    const deadline = Math.min(context.session.expiresAt, context.selection.expiresAt);
    const timeout = setTimeout(
      () => {
        if (alive.current) {
          setUnavailable(true);
          setError(
            'This Canvas selection expired. Reopen assignment setup from Canvas. Your encrypted draft is kept.',
          );
        }
      },
      Math.max(0, deadline - Date.now()),
    );
    return () => clearTimeout(timeout);
  }, [context]);
  useEffect(() => {
    if (!context) return;
    let controller: AuthorUploadController;
    try {
      controller = new AuthorUploadController(
        context,
        client,
        (next) => {
          if (alive.current) setUpload(next);
        },
        async () => {
          const refreshed = await client.sources();
          readAuthorContext(context);
          if (alive.current && current.current === context) {
            setPages([refreshed]);
            setPageIndex(0);
          }
        },
        () => {
          if (alive.current) {
            setUnavailable(true);
            setError(
              'The teacher selection or workspace changed. Reopen assignment setup from Canvas. Your encrypted upload and draft are kept.',
            );
          }
        },
      );
    } catch (reason) {
      showFailure(reason);
      return;
    }
    uploader.current = controller;
    void controller.restore();
    return () => {
      controller.dispose();
      if (uploader.current === controller) uploader.current = null;
    };
  }, [client, context, showFailure]);

  async function perform(run: () => Promise<void>) {
    if (action.current) return;
    action.current = true;
    setBusy(true);
    setError('');
    try {
      await run();
    } catch (reason) {
      showFailure(reason);
    } finally {
      action.current = false;
      if (alive.current) setBusy(false);
    }
  }
  async function create() {
    await perform(async () => {
      await flush();
      const capability = current.current;
      if (!capability) throw new Error('Reopen assignment setup from Canvas.');
      if (draft.current.phase === 'editing') {
        const request = {
          requestId: crypto.randomUUID(),
          draft: authorFormPayload(draft.current.form),
        };
        replace({ phase: 'prepared', form: draft.current.form, request });
        await flush();
      }
      const pending = draft.current;
      if (pending.phase === 'editing') return;
      const assignment = await client.create(pending.request.draft, pending.request.requestId);
      if (!alive.current) return;
      replace({ phase: 'created', form: pending.form, request: pending.request, assignment });
      await flush();
      setConfirmed(true);
    });
  }
  async function finish(cancel: boolean) {
    await perform(async () => {
      await flush();
      const snapshot = draft.current;
      if (!cancel && (snapshot.phase !== 'created' || !confirmed))
        throw new Error('Confirm the saved assignment before returning to Canvas.');
      if (snapshot.phase === 'prepared' || (snapshot.phase === 'created' && !confirmed))
        throw new Error('Confirm the saved request before returning to Canvas.');
      const result = await client.prepareReturn(
        cancel ? null : snapshot.phase === 'created' ? snapshot.assignment.id : null,
      );
      if (!alive.current || !current.current) return;
      readAuthorContext(current.current);
      const url = new URL(result.action, location.href);
      if (
        url.origin !== location.origin ||
        url.protocol !== 'https:' ||
        url.username ||
        url.password ||
        url.search ||
        url.hash ||
        url.pathname !== `/api/assignments/selections/${current.current.selection.id}/return`
      )
        throw new Error('The Canvas return address is invalid.');
      const form = document.createElement('form');
      form.method = 'POST';
      form.action = url.href;
      form.enctype = 'application/x-www-form-urlencoded';
      form.target = '_top';
      form.hidden = true;
      for (const [name, value] of Object.entries(result.fields)) {
        const input = document.createElement('input');
        input.type = 'hidden';
        input.name = name;
        input.value = value;
        form.append(input);
      }
      document.body.append(form);
      leaving.current = true;
      try {
        form.requestSubmit();
      } catch (reason) {
        leaving.current = false;
        form.remove();
        throw reason;
      }
    });
  }
  const goBack = () =>
    void perform(async () => {
      await flush();
      leaving.current = true;
      location.assign('/');
    });
  const frozen = busy || unavailable || conflict || value.phase !== 'editing';
  const page = pages[pageIndex];
  const source = value.form.source;
  const uploadStatus = upload.task?.upload?.status;
  const uploadTerminal = uploadStatus === 'ready' || uploadStatus === 'rejected';
  const uploadLabel = upload.busy
    ? {
        saving: 'Saving encrypted recovery copy…',
        reserving: 'Preparing upload…',
        checking: 'Checking upload status…',
        sending: 'Uploading PDF…',
        idle: 'Opening upload…',
      }[upload.stage]
    : uploadStatus === 'quarantined'
      ? 'Waiting for document checks'
      : uploadStatus === 'ready'
        ? 'Document ready'
        : uploadStatus === 'rejected'
          ? 'Document rejected'
          : upload.task
            ? upload.paused
              ? 'Transfer paused — recovery copy saved'
              : 'Upload saved — ready to resume'
            : 'PDF · up to 100 MB';
  return (
    <main className="canvas-author app-shell">
      <header className="canvas-author-header">
        <Brand />
        <span className="canvas-author-breadcrumb">
          Canvas <span aria-hidden="true">/</span> Assignment setup
        </span>
        <div className="canvas-author-header-actions">
          <button className="button secondary" disabled={busy || upload.busy} onClick={goBack}>
            <ArrowLeft size={15} />
            Workspace
          </button>
          <button
            className="button secondary"
            disabled={busy}
            onClick={() => void lockVault().catch(showFailure)}
          >
            <LockKeyhole size={15} />
            Lock
          </button>
        </div>
      </header>
      <div className="canvas-author-body">
        <div className="canvas-author-heading">
          <div>
            <p className="canvas-author-eyebrow">TEACHER WORKSPACE</p>
            <h1>Set up an assignment</h1>
            <p>Choose a document and the tools your students can use.</p>
          </div>
          <p className="canvas-author-save" role="status">
            {saving
              ? 'Saving draft…'
              : localError
                ? 'Draft not saved'
                : saved
                  ? 'Draft saved on this device'
                  : 'Draft stays on this device'}
          </p>
        </div>
        {error && (
          <p className="canvas-author-error" role="alert">
            {error}
          </p>
        )}
        {localError && (
          <button
            className="button secondary"
            disabled={busy || conflict || unavailable}
            onClick={() => void flush().catch(() => {})}
          >
            Retry saving draft
          </button>
        )}
        {(conflict || localError) && (
          <button
            className="button secondary"
            disabled={busy || saving}
            onClick={() => setDiscardPrompt(true)}
          >
            Discard unsaved changes and reload
          </button>
        )}
        {unavailable ? (
          <section className="canvas-author-unavailable">
            <FileText size={32} aria-hidden="true" />
            <h2>Reopen assignment setup from Canvas</h2>
            <p>
              A current teacher selection is required. Existing encrypted drafts are kept on this
              device.
            </p>
          </section>
        ) : !context ? (
          <p className="canvas-author-loading" role="status">
            <Loader2 className="spin" size={20} />
            Verifying your teacher selection…
          </p>
        ) : (
          <>
            <div className="canvas-author-layout">
              <section className="canvas-author-sources" aria-labelledby="source-heading">
                <h2 id="source-heading">1. Choose a document</h2>
                <p>
                  Approved documents owned by your account. Availability is checked when you create
                  the assignment.
                </p>
                <div
                  className="canvas-author-upload"
                  role="group"
                  aria-label="Upload an assignment document"
                  aria-busy={upload.busy}
                >
                  <input
                    ref={fileInput}
                    type="file"
                    accept="application/pdf,.pdf"
                    hidden
                    disabled={frozen || upload.busy || (!!upload.task && !uploadTerminal)}
                    onChange={(event) => {
                      const file = event.target.files?.[0];
                      event.target.value = '';
                      if (file && !frozen && !upload.busy) void uploader.current?.start(file);
                    }}
                  />
                  <div className="canvas-author-upload-heading">
                    <div className="canvas-author-upload-summary">
                      <strong>{upload.task?.intent.metadata.name ?? 'Add a document'}</strong>
                      <p role="status">
                        {upload.busy && <Loader2 size={13} className="spin" aria-hidden="true" />}
                        {uploadLabel}
                      </p>
                    </div>
                    {(!upload.task || uploadTerminal) && (
                      <button
                        className="button secondary"
                        disabled={frozen || upload.busy}
                        onClick={() => fileInput.current?.click()}
                      >
                        <Upload size={14} aria-hidden="true" />
                        {upload.task ? 'Upload another PDF' : 'Upload PDF'}
                      </button>
                    )}
                  </div>
                  {upload.task && !uploadTerminal && (
                    <p className="canvas-author-upload-note">
                      {uploadStatus === 'quarantined'
                        ? 'This PDF becomes available only after document checks finish. Check its status to continue.'
                        : 'The original PDF and request are saved encrypted on this device. You can cancel the transfer and resume it here.'}
                    </p>
                  )}
                  {uploadStatus === 'ready' && (
                    <p className="canvas-author-upload-note">
                      Choose this document from the approved list below.
                    </p>
                  )}
                  {uploadStatus === 'rejected' && (
                    <p className="canvas-author-upload-note">
                      This PDF cannot be used for an assignment. You can choose another file.
                    </p>
                  )}
                  {upload.error && (
                    <p className="canvas-author-upload-error" role="alert">
                      {upload.error}
                    </p>
                  )}
                  {(upload.busy || (upload.task && (!uploadTerminal || !!upload.error))) && (
                    <div className="canvas-author-upload-actions">
                      {upload.busy ? (
                        <button
                          className="button secondary"
                          onClick={() => uploader.current?.cancel()}
                        >
                          Cancel transfer
                        </button>
                      ) : (
                        <button
                          className="button secondary"
                          disabled={busy || unavailable || conflict}
                          onClick={() => void uploader.current?.resume()}
                        >
                          {uploadStatus === 'quarantined' || uploadStatus === 'ready'
                            ? 'Check upload status'
                            : upload.error
                              ? 'Retry saved upload'
                              : 'Resume saved upload'}
                        </button>
                      )}
                    </div>
                  )}
                </div>
                <div
                  className="canvas-author-source-list"
                  role="group"
                  aria-label="Approved documents"
                >
                  {page?.sources.slice(0, 5).map((item) => {
                    const chosen =
                      source?.documentId === item.documentId && source.versionId === item.versionId;
                    return (
                      <button
                        key={`${item.documentId}:${item.versionId}`}
                        className={`canvas-author-source ${chosen ? 'selected' : ''}`}
                        aria-pressed={chosen}
                        disabled={frozen}
                        onClick={() =>
                          edit({
                            source: item,
                            title:
                              value.form.title ||
                              (item.name.replace(/\.pdf$/i, '').length <= 200
                                ? item.name.replace(/\.pdf$/i, '')
                                : ''),
                          })
                        }
                      >
                        <FileText size={23} aria-hidden="true" />
                        <span>
                          <strong>{item.name}</strong>
                          <small>
                            {item.pageCount} {item.pageCount === 1 ? 'page' : 'pages'} ·{' '}
                            {size(item.bytes)}
                          </small>
                        </span>
                        {chosen && <Check size={18} aria-hidden="true" />}
                      </button>
                    );
                  })}
                  {page && !page.sources.length && (
                    <div className="canvas-author-empty">
                      <FileText size={27} aria-hidden="true" />
                      <h3>No approved documents yet</h3>
                      <p>
                        Upload a PDF above. It will appear here after document checks approve it.
                      </p>
                    </div>
                  )}
                  {!page && (
                    <p>No document list is available. Reopen the selection to try again.</p>
                  )}
                </div>
                {page && (
                  <nav className="canvas-author-pagination" aria-label="Document pages">
                    <button
                      className="button secondary"
                      disabled={busy || pageIndex === 0}
                      onClick={() => setPageIndex((index) => index - 1)}
                    >
                      <ChevronLeft size={14} />
                      Previous
                    </button>
                    <span>Page {pageIndex + 1}</span>
                    <button
                      className="button secondary"
                      disabled={busy || unavailable || !page.nextCursor}
                      onClick={() =>
                        void perform(async () => {
                          if (pages[pageIndex + 1]) {
                            setPageIndex((index) => index + 1);
                            return;
                          }
                          const next = await client.sources(page.nextCursor!);
                          if (alive.current) {
                            setPages((all) => [...all, next]);
                            setPageIndex((index) => index + 1);
                          }
                        })
                      }
                    >
                      Next
                      <ChevronRight size={14} />
                    </button>
                  </nav>
                )}
              </section>
              <section className="canvas-author-details" aria-labelledby="details-heading">
                <h2 id="details-heading">2. Assignment details</h2>
                <div className="canvas-author-selected">
                  <span>Selected document</span>
                  <strong>{source?.name ?? 'Choose a document to begin'}</strong>
                  {source && (
                    <small>
                      {source.pageCount} {source.pageCount === 1 ? 'page' : 'pages'} · checked again
                      on creation
                    </small>
                  )}
                </div>
                <label className="canvas-author-field">
                  Assignment title
                  <input
                    value={value.form.title}
                    maxLength={200}
                    disabled={frozen}
                    onChange={(event) => edit({ title: event.target.value })}
                    placeholder="e.g. Reading response"
                  />
                </label>
                <label className="canvas-author-field">
                  Instructions <span className="canvas-author-optional">optional</span>
                  <textarea
                    value={value.form.instructions}
                    maxLength={10000}
                    rows={5}
                    disabled={frozen}
                    onChange={(event) => edit({ instructions: event.target.value })}
                    placeholder="What should your students work on?"
                  />
                </label>
                <fieldset className="canvas-author-tools" disabled={frozen}>
                  <legend>Student tools</legend>
                  <div>
                    {authorTools.map((tool) => (
                      <label key={tool}>
                        <input
                          type="checkbox"
                          checked={value.form.allowedTools.includes(tool)}
                          onChange={(event) =>
                            edit({
                              allowedTools: authorTools.filter((candidate) =>
                                candidate === tool
                                  ? event.target.checked
                                  : value.form.allowedTools.includes(candidate),
                              ),
                            })
                          }
                        />
                        {labels[tool]}
                      </label>
                    ))}
                  </div>
                </fieldset>
                <p className="canvas-author-policy">
                  Students can export, copy text and use read aloud. Assessment restrictions are not
                  available.
                </p>
              </section>
            </div>
            <section className="canvas-author-footer" aria-label="Assignment actions">
              <div>
                <h2>
                  {value.phase === 'created' && confirmed
                    ? 'Ready for Canvas review'
                    : value.phase !== 'editing'
                      ? 'Confirm your saved request'
                      : 'Create, then return to Canvas'}
                </h2>
                <p>
                  {value.phase === 'created' && confirmed
                    ? 'The assignment is saved in Margin. Canvas will review the selection when you return.'
                    : value.phase !== 'editing'
                      ? 'The original details are kept. Retry to confirm the outcome. If the request cannot be accepted, reopen setup from Canvas; this saved request stays unchanged.'
                      : 'Creating saves the assignment in Margin. You choose when to return it to Canvas.'}
                </p>
              </div>
              <div className="canvas-author-footer-actions">
                <button
                  className="button secondary"
                  disabled={busy || upload.busy || (value.phase !== 'editing' && !confirmed)}
                  onClick={() => setCancelPrompt(true)}
                >
                  Cancel selection
                </button>
                {value.phase === 'created' && confirmed ? (
                  <button
                    className="button primary"
                    disabled={busy || upload.busy || conflict}
                    onClick={() => void finish(false)}
                  >
                    Return to Canvas
                    <ArrowRight size={16} />
                  </button>
                ) : (
                  <button
                    className="button primary"
                    disabled={
                      busy ||
                      upload.busy ||
                      conflict ||
                      (value.phase === 'editing' &&
                        (!source || !value.form.title.trim() || !value.form.allowedTools.length))
                    }
                    onClick={() => void create()}
                  >
                    {busy && <Loader2 size={15} className="spin" />}
                    {value.phase === 'editing' ? 'Create assignment' : 'Confirm saved assignment'}
                    <ArrowRight size={16} />
                  </button>
                )}
              </div>
            </section>
          </>
        )}
      </div>
      {discardPrompt && (
        <Modal
          title="Discard unsaved changes?"
          description="Only changes that have not reached encrypted storage will be discarded. Saved drafts and exact pending requests remain on this device."
          onClose={() => setDiscardPrompt(false)}
        >
          <div className="canvas-author-dialog-actions">
            <button className="button secondary" onClick={() => setDiscardPrompt(false)}>
              Keep changes
            </button>
            <button
              className="button primary"
              onClick={() => {
                if (write.current || action.current) return;
                if (timer.current) clearTimeout(timer.current);
                dirty.current = false;
                leaving.current = true;
                location.reload();
              }}
            >
              Discard unsaved changes and reload
            </button>
          </div>
        </Modal>
      )}
      {cancelPrompt && (
        <Modal
          title="Cancel this selection?"
          description="Return to Canvas without selecting an assignment. Your encrypted draft remains on this device; this selection may no longer be available."
          onClose={() => setCancelPrompt(false)}
        >
          <div className="canvas-author-dialog-actions">
            <button className="button secondary" onClick={() => setCancelPrompt(false)}>
              Keep editing
            </button>
            <button
              className="button primary"
              onClick={() => {
                setCancelPrompt(false);
                void finish(true);
              }}
            >
              Return without selection
            </button>
          </div>
        </Modal>
      )}
    </main>
  );
}
