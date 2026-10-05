import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import {
  Search,
  Command,
  Plus,
  Upload,
  Menu,
  ChevronRight,
  X,
  FileText,
  Check,
  AlertCircle,
  Loader2,
  ArrowUpRight,
  Pause,
  Play,
  HardDrive,
  ExternalLink,
} from 'lucide-react';
import type {
  Assignment,
  DocumentRecord,
  FolderRecord,
  Preferences,
  UploadRecord,
} from '@margin/core';
import { Sidebar, type Page } from './components/Sidebar';
import { Library, type DocumentAction } from './components/Library';
import { Modal } from './components/Modal';
import { Assignments } from './components/Assignments';
import { Settings } from './components/Settings';
import { CommandPalette } from './components/CommandPalette';
import * as db from './lib/storage';
import { lockVault, encryptExport } from './lib/vault';
import { importDocument, createBlankDocument } from './lib/imports';
import {
  syncDocument,
  pauseUpload,
  resumeUpload,
  cancelUpload,
  recoverInterruptedUploads,
} from './lib/uploads';
import { downloadBlob, fileSize } from './lib/format';
import { parseRoute, fetchDocumentBlob } from './lib/navigation';
const DocumentEditor = lazy(() => import('./editor/DocumentEditor'));
type Dialog =
  | { type: 'upload' | 'new' | 'folder' | 'help' }
  | { type: 'rename' | 'move' | 'delete'; doc: DocumentRecord }
  | { type: 'source'; url: string };
const defaults: Preferences = {
  name: 'Alex Morgan',
  role: 'teacher',
  theme: 'light',
  dyslexiaFont: false,
  reducedMotion: false,
  shortcuts: true,
};
function readRoute() {
  return parseRoute(location.hash);
}
export default function App() {
  const [page, setPage] = useState<Page>(readRoute().page);
  const [documents, setDocuments] = useState<DocumentRecord[]>([]);
  const [folders, setFolders] = useState<FolderRecord[]>([]);
  const [assignments, setAssignments] = useState<Assignment[]>([]);
  const [preferences, setPreferences] = useState(defaults);
  const [loading, setLoading] = useState(true);
  const [fatal, setFatal] = useState('');
  const [opened, setOpened] = useState<{ document: DocumentRecord; blob: Blob } | null>(null);
  const [opening, setOpening] = useState(false);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [command, setCommand] = useState(false);
  const [search, setSearch] = useState('');
  const [toast, setToast] = useState<{ message: string; error: boolean } | null>(null);
  const [online, setOnline] = useState(navigator.onLine);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [uploads, setUploads] = useState<UploadRecord[]>([]);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState('');
  const [exportPassphrase, setExportPassphrase] = useState('');
  const [dragging, setDragging] = useState(false);
  const [token, setToken] = useState('');
  const uploadInput = useRef<HTMLInputElement>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sourceShown = useRef(false);
  const refreshGeneration = useRef(0);
  const refresh = useCallback(async () => {
    const request = ++refreshGeneration.current;
    const [d, f, a, p, u] = await Promise.all([
      db.listDocuments(),
      db.listFolders(),
      db.listAssignments(),
      db.getPreferences(),
      db.listUploadRecords(),
    ]);
    if (request !== refreshGeneration.current) return;
    setDocuments(d);
    setFolders(f);
    setAssignments(a);
    setPreferences(p);
    setUploads(u.filter((v) => v.status !== 'complete' && v.status !== 'cancelled'));
  }, []);
  function notify(message: string, error = false) {
    setToast({ message, error });
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), error ? 9000 : 4000);
  }
  const leaveGuard = useRef<(() => Promise<void>) | null>(null);
  const activeDocumentId = useRef<string | null>(null);
  const navigationGeneration = useRef(0);
  const acceptedHash = useRef(readRoute().documentId ? '#home' : `#${readRoute().page}`);
  const registerLeaveGuard = useCallback((guard: (() => Promise<void>) | null) => {
    leaveGuard.current = guard;
  }, []);
  useEffect(
    () => () => {
      navigationGeneration.current++;
      leaveGuard.current = null;
      activeDocumentId.current = null;
    },
    [],
  );
  const transitionTo = useCallback(async (route: ReturnType<typeof readRoute>, push = false) => {
    const request = ++navigationGeneration.current;
    const targetHash = route.documentId
      ? `#document/${encodeURIComponent(route.documentId)}`
      : `#${route.page}`;
    if (route.documentId && route.documentId === activeDocumentId.current) {
      setOpening(false);
      return;
    }
    setOpening(Boolean(route.documentId));
    try {
      // Keep the current editor mounted and editable while the destination loads.
      // Its guard runs after all destination I/O, directly before committing the route.
      let target: { document: DocumentRecord; blob: Blob } | null = null;
      if (route.documentId) {
        const [document, blob] = await Promise.all([
          db.getDocument(route.documentId),
          db.getDocumentBlob(route.documentId),
        ]);
        if (request !== navigationGeneration.current) return;
        if (!document || !blob || document.trashed)
          throw new Error('This document is unavailable. It may have been moved to Trash.');
        target = { document, blob };
      }
      if (activeDocumentId.current) await leaveGuard.current?.();
      if (request !== navigationGeneration.current) return;
      if (push && location.hash !== targetHash) history.pushState(null, '', targetHash);
      else if (!push && location.hash !== targetHash) history.replaceState(null, '', targetHash);
      acceptedHash.current = targetHash;
      activeDocumentId.current = route.documentId;
      leaveGuard.current = null;
      setOpened(target);
      setPage(route.page);
      setSearch('');
      setMobileOpen(false);
    } catch (error) {
      if (request !== navigationGeneration.current) return;
      // Push the retained editor back onto a popped target so Back can be retried
      // after saving. pushState emits no hashchange and never remounts the editor.
      if (location.hash !== acceptedHash.current) history.pushState(null, '', acceptedHash.current);
      setToast({
        message:
          error instanceof Error
            ? error.message
            : 'This page could not be opened. Your current document remains open.',
        error: true,
      });
    } finally {
      if (request === navigationGeneration.current) setOpening(false);
    }
  }, []);
  useEffect(() => {
    let mounted = true;
    void recoverInterruptedUploads()
      .then(async () => {
        if (!(await db.isWorkspaceSeeded())) await (await import('./lib/seed')).seedWorkspace();
      })
      .then(refresh)
      .then(() => {
        if (!mounted) return;
        setLoading(false);
        const r = readRoute();
        if (r.documentId) void transitionTo(r);
        const source = new URL(location.href).searchParams.get('source');
        if (source && !sourceShown.current) {
          sourceShown.current = true;
          try {
            const url = new URL(source);
            if (url.protocol === 'https:') setDialog({ type: 'source', url: url.href });
          } catch {
            /* invalid extension handoff ignored */
          }
        }
      })
      .catch((e) => {
        setFatal(
          e instanceof Error
            ? e.message
            : 'Could not open browser storage. Enable site storage and reload.',
        );
        setLoading(false);
      });
    const onChange = () =>
      void refresh().catch((e) => setToast({ message: String(e), error: true }));
    window.addEventListener('margin-data-change', onChange);
    return () => {
      mounted = false;
      window.removeEventListener('margin-data-change', onChange);
    };
  }, [refresh, transitionTo]);
  useEffect(() => {
    const listener = () => {
      void transitionTo(readRoute());
    };
    window.addEventListener('hashchange', listener);
    return () => window.removeEventListener('hashchange', listener);
  }, [transitionTo]);
  useEffect(() => {
    const on = () => setOnline(navigator.onLine);
    window.addEventListener('online', on);
    window.addEventListener('offline', on);
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', on);
    };
  }, []);
  useEffect(() => {
    document.documentElement.dataset.theme = preferences.theme;
    document.documentElement.dataset.motion = preferences.reducedMotion ? 'reduced' : 'full';
    document.documentElement.dataset.reading = preferences.dyslexiaFont
      ? 'comfortable'
      : 'standard';
  }, [preferences]);
  useEffect(() => {
    const handle = (e: KeyboardEvent) => {
      if (!preferences.shortcuts || opened) return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setCommand((v) => !v);
      }
      if (
        e.key === '?' &&
        !(e.target instanceof HTMLInputElement) &&
        !(e.target instanceof HTMLTextAreaElement)
      )
        setDialog({ type: 'help' });
    };
    window.addEventListener('keydown', handle);
    return () => window.removeEventListener('keydown', handle);
  }, [preferences.shortcuts, opened]);
  function navigate(next: Page) {
    void transitionTo({ page: next, documentId: null }, true);
  }
  function show(d: Dialog) {
    setFormError('');
    setExportPassphrase('');
    setDialog(d);
  }
  function open(doc: DocumentRecord) {
    void transitionTo({ page: 'home', documentId: doc.id }, true);
  }
  function updateUpload(u: UploadRecord) {
    setUploads((prev) => [u, ...prev.filter((p) => p.id !== u.id)]);
  }
  async function importFiles(files: FileList | File[]) {
    if (!files.length) return;
    setBusy(true);
    setFormError('');
    let count = 0;
    for (const file of Array.from(files)) {
      try {
        const record = await importDocument(file, updateUpload, exportPassphrase || undefined);
        if (page.startsWith('folder:'))
          await db.patchDocument(record.id, { folderId: page.slice(7) });
        count++;
      } catch (e) {
        const message = e instanceof Error ? e.message : 'The file could not be imported.';
        setFormError(message);
        notify(message, true);
      }
    }
    await refresh();
    setBusy(false);
    if (count) {
      setDialog(null);
      setExportPassphrase('');
      notify(
        `${count === 1 ? 'Document' : count + ' documents'} imported and saved to this browser.`,
      );
    }
    if (uploadInput.current) uploadInput.current.value = '';
  }
  async function savePreferences(p: Partial<Preferences>) {
    setPreferences(await db.savePreferences(p));
  }
  async function star(doc: DocumentRecord) {
    try {
      await db.patchDocument(doc.id, { starred: !doc.starred });
      await refresh();
    } catch (e) {
      notify(String(e), true);
    }
  }
  async function action(action: DocumentAction, doc: DocumentRecord) {
    try {
      if (['rename', 'move', 'delete'].includes(action)) {
        show({ type: action as 'rename' | 'move' | 'delete', doc });
        return;
      }
      if (action === 'trash' || action === 'restore') {
        await db.patchDocument(doc.id, { trashed: action === 'trash' });
        await refresh();
        notify(action === 'trash' ? 'Document moved to Trash.' : 'Document restored.');
      } else if (action === 'duplicate') {
        const blob = await db.getDocumentBlob(doc.id);
        if (!blob) throw new Error('The original file is missing.');
        const copy = {
          ...doc,
          id: crypto.randomUUID(),
          name: doc.name + ' (copy)',
          source: 'created' as const,
          starred: false,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        };
        await db.saveDocumentWithBlob(copy, blob);
        for (const a of await db.loadAnnotations(doc.id)) {
          const annotation = { ...a, id: crypto.randomUUID() };
          await db.appendAnnotationOperation({
            id: crypto.randomUUID(),
            documentId: copy.id,
            timestamp: Date.now(),
            kind: 'put',
            annotationId: annotation.id,
            annotation,
          });
        }
        await refresh();
        notify('Document and annotations copied.');
      } else if (action === 'download') {
        const blob = await db.getDocumentBlob(doc.id);
        if (!blob) throw new Error('The source document is missing.');
        const protectedFile = await encryptExport(blob, {
          name: doc.name + '.pdf',
          mimeType: 'application/pdf',
        });
        downloadBlob(protectedFile, `margin-document-${Date.now()}.margin`);
        notify('Encrypted original downloaded. Reopen the .margin file in Margin.');
      } else if (action === 'sync') {
        if (!token) {
          navigate('settings');
          notify('Add the access token from your local API server to upload an encrypted copy.');
          return;
        }
        void syncDocument(doc.id, { token }, updateUpload)
          .then((outcome) => {
            if (outcome === 'complete')
              notify('Encrypted upload stored in quarantine pending a scan.');
            void refresh();
          })
          .catch((e) =>
            notify(
              e instanceof Error
                ? e.message
                : 'Upload interrupted. Retry when the server is available.',
              true,
            ),
          );
      }
    } catch (e) {
      notify(e instanceof Error ? e.message : 'This action could not be completed.', true);
    }
  }
  async function submitDialog(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!dialog) return;
    setBusy(true);
    setFormError('');
    const f = new FormData(e.currentTarget);
    try {
      if (dialog.type === 'new') {
        const d = await createBlankDocument(
          String(f.get('name')).trim(),
          page.startsWith('folder:') ? page.slice(7) : undefined,
        );
        await refresh();
        open(d);
      } else if (dialog.type === 'folder') {
        await db.saveFolder({
          id: crypto.randomUUID(),
          name: String(f.get('name')).trim(),
          color: String(f.get('color')),
        });
        await refresh();
      } else if (dialog.type === 'rename') {
        await db.patchDocument(dialog.doc.id, {
          name: String(f.get('name')).trim(),
        });
        await refresh();
      } else if (dialog.type === 'move') {
        await db.patchDocument(dialog.doc.id, {
          folderId: String(f.get('folder')) || null,
        });
        await refresh();
      } else if (dialog.type === 'delete') {
        await db.deleteDocument(dialog.doc.id);
        await refresh();
        notify('Document permanently deleted from this browser.');
      }
      setDialog(null);
    } catch (e) {
      setFormError(e instanceof Error ? e.message : 'Could not save. Please try again.');
    } finally {
      setBusy(false);
    }
  }
  async function useTemplate(doc: DocumentRecord) {
    try {
      const blob = await db.getDocumentBlob(doc.id);
      if (!blob) throw new Error('Template file is unavailable.');
      const copy = {
        ...doc,
        id: crypto.randomUUID(),
        name: doc.name + ' (my copy)',
        source: 'created' as const,
        starred: false,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      await db.saveDocumentWithBlob(copy, blob);
      await refresh();
      open(copy);
    } catch (e) {
      notify(String(e), true);
    }
  }
  async function importSource(url: string) {
    setBusy(true);
    setFormError('');
    try {
      const blob = await fetchDocumentBlob(url);
      const name = decodeURIComponent(
        new URL(url).pathname.split('/').pop() || 'Linked document.pdf',
      );
      await importFiles([new File([blob], name, { type: blob.type })]);
    } catch (e) {
      setFormError(
        `The website did not allow this import. Download the PDF, then upload it here. ${e instanceof Error ? e.message : ''}`,
      );
    } finally {
      setBusy(false);
    }
  }
  const documentChanged = async (changes: { blob: Blob; document: DocumentRecord }) => {
    if (activeDocumentId.current !== changes.document.id) return;
    // The editor already atomically committed the bytes, revision, and annotations.
    setOpened((current) =>
      current?.document.id === changes.document.id
        ? { document: changes.document, blob: changes.blob }
        : current,
    );
    await refresh();
  };
  const breadcrumb = page.startsWith('folder:')
    ? folders.find((f) => f.id === page.slice(7))?.name
    : (
        {
          home: 'Home',
          documents: 'My documents',
          starred: 'Starred',
          assignments: 'Assignments',
          templates: 'Templates',
          trash: 'Trash',
          settings: 'Settings',
        } as Record<string, string>
      )[page] || 'Home';
  if (loading || (opening && !opened))
    return (
      <div className="app-loading">
        <span className="loading-logo">m.</span>
        <Loader2 className="spin" size={22} />
        <p>{opening ? 'Opening your document…' : 'Making room for your ideas…'}</p>
      </div>
    );
  if (fatal)
    return (
      <div className="app-loading">
        <AlertCircle size={28} />
        <h2>Workspace could not open</h2>
        <p>{fatal}</p>
        <button className="button primary" onClick={() => location.reload()}>
          Try again
        </button>
      </div>
    );
  return (
    <>
      <input
        ref={uploadInput}
        type="file"
        className="sr-only"
        aria-label="Choose documents to upload"
        accept="application/pdf,image/png,image/jpeg,.margin"
        multiple
        onChange={(e) => e.target.files && void importFiles(e.target.files)}
      />
      {opened ? (
        <Suspense
          fallback={
            <div className="app-loading">
              <Loader2 className="spin" />
              <p>Loading document tools…</p>
            </div>
          }
        >
          <DocumentEditor
            key={opened.document.id}
            document={opened.document}
            blob={opened.blob}
            onClose={() => navigate('home')}
            onDocumentChange={documentChanged}
            shortcuts={preferences.shortcuts}
            registerLeaveGuard={registerLeaveGuard}
          />
        </Suspense>
      ) : (
        <div
          className="app-shell"
          onDragOver={(e) => {
            if (e.dataTransfer.types.includes('Files')) {
              e.preventDefault();
              setDragging(true);
            }
          }}
        >
          <Sidebar
            onLock={() =>
              void lockVault().catch((e) =>
                notify(e instanceof Error ? e.message : String(e), true),
              )
            }
            page={page}
            onNavigate={navigate}
            folders={folders}
            preferences={preferences}
            onCreateFolder={() => show({ type: 'folder' })}
            onHelp={() => show({ type: 'help' })}
            online={online}
            mobileOpen={mobileOpen}
            onClose={() => setMobileOpen(false)}
          />
          <div className="main-shell">
            <header className="topbar">
              <div className="breadcrumbs">
                <button
                  className="icon-button mobile-only"
                  aria-label="Open navigation"
                  onClick={() => setMobileOpen(true)}
                >
                  <Menu size={20} />
                </button>
                <span>My workspace</span>
                <ChevronRight size={12} />
                <strong>{breadcrumb}</strong>
              </div>
              <div className="topbar-actions">
                <div className="global-search">
                  <Search size={16} />
                  <input
                    aria-label="Search documents"
                    placeholder="Search anything…"
                    value={search}
                    onChange={(e) => {
                      setSearch(e.target.value);
                      if (page === 'settings' || page === 'assignments') setPage('documents');
                    }}
                  />
                  <button aria-label="Open command palette" onClick={() => setCommand(true)}>
                    <Command size={11} /> K
                  </button>
                </div>
                <span className={`topbar-save ${online ? '' : 'offline'}`}>
                  <span className="connection-dot" />
                  {online ? 'Saved on this device' : 'Offline · saved locally'}
                </span>
                <button
                  className="topbar-avatar"
                  aria-label="Your profile"
                  onClick={() => navigate('settings')}
                >
                  {preferences.name
                    .split(' ')
                    .map((s) => s[0])
                    .slice(0, 2)
                    .join('')}
                </button>
              </div>
            </header>
            <main id="main-content">
              {page === 'assignments' ? (
                <Assignments
                  assignments={assignments}
                  documents={documents}
                  role={preferences.role}
                  onSave={async (a) => {
                    await db.saveAssignment(a);
                    await refresh();
                  }}
                  onOpen={open}
                />
              ) : page === 'settings' ? (
                <Settings
                  preferences={preferences}
                  onSave={savePreferences}
                  documents={documents}
                  token={token}
                  onToken={setToken}
                  onHelp={() => show({ type: 'help' })}
                />
              ) : (
                <Library
                  page={page}
                  documents={documents}
                  folders={folders}
                  search={search}
                  name={preferences.name}
                  onOpen={open}
                  onUpload={() => show({ type: 'upload' })}
                  onNew={() => show({ type: 'new' })}
                  onFolder={() => show({ type: 'folder' })}
                  onNavigate={navigate}
                  onStar={(d) => void star(d)}
                  onAction={(a, d) => void action(a, d)}
                  onTemplate={(d) => void useTemplate(d)}
                />
              )}
            </main>
          </div>
          {dragging && (
            <div
              className="drop-overlay"
              onDragLeave={() => setDragging(false)}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                setDragging(false);
                void importFiles(e.dataTransfer.files);
              }}
            >
              <Upload size={45} />
              <h2>Drop your next idea here.</h2>
              <p>PDF, PNG, JPEG, or .margin · up to 100 MB each</p>
            </div>
          )}
        </div>
      )}
      {dialog && (
        <Modal
          title={
            dialog.type === 'upload'
              ? 'Make room for a new document.'
              : dialog.type === 'new'
                ? 'Start with a blank page.'
                : dialog.type === 'folder'
                  ? 'A place for related ideas.'
                  : dialog.type === 'rename'
                    ? 'Rename document'
                    : dialog.type === 'move'
                      ? 'Move to a folder'
                      : dialog.type === 'delete'
                        ? 'Permanently delete this document?'
                        : dialog.type === 'source'
                          ? 'Open a document from the web'
                          : 'A few useful things to know.'
          }
          description={
            dialog.type === 'upload'
              ? 'Your file stays on this device. You can get to work right away.'
              : dialog.type === 'delete'
                ? 'The PDF, its annotations, and any linked local assignments will be removed from this browser. This cannot be undone.'
                : undefined
          }
          onClose={() => {
            if (!busy) {
              setDialog(null);
              setExportPassphrase('');
            }
          }}
          wide={dialog.type === 'help'}
        >
          {dialog.type === 'upload' ? (
            <>
              <button
                className="upload-dropzone"
                onClick={() => uploadInput.current?.click()}
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => {
                  e.preventDefault();
                  void importFiles(e.dataTransfer.files);
                }}
                disabled={busy}
              >
                <span className="upload-symbol">
                  <Upload size={30} strokeWidth={1.4} />
                </span>
                <strong>{busy ? 'Preparing your document…' : 'Drop files here, or browse'}</strong>
                <span>PDF, PNG, JPEG, .margin · up to 100 MB each</span>
              </button>
              <div className="upload-privacy">
                <HardDrive size={15} />
                Encrypted locally. No cloud account needed.
              </div>
              <label className="package-passphrase">
                Export passphrase (for another workspace)
                <input
                  type="password"
                  autoComplete="off"
                  value={exportPassphrase}
                  onChange={(e) => setExportPassphrase(e.target.value)}
                  placeholder="Only for .margin files from another vault"
                />
              </label>
              <p className="field-note">
                Office and Google Workspace files: export to PDF first. Direct format conversion is
                not connected yet.
              </p>
              {formError && (
                <p className="form-error" role="alert">
                  {formError}
                </p>
              )}
            </>
          ) : dialog.type === 'help' ? (
            <div className="help-content">
              <p>Read, mark up, and organize documents in your own local workspace.</p>
              <div className="shortcut-grid">
                {[
                  ['⌘ / Ctrl + K', 'Find a document or command'],
                  ['V', 'Select annotations'],
                  ['T', 'Add text'],
                  ['P', 'Draw with the pen'],
                  ['H', 'Highlight'],
                  ['E', 'Erase annotations'],
                  ['C', 'Add a comment'],
                  ['⌘ / Ctrl + Z', 'Undo'],
                  ['⌘ / Ctrl + Shift + Z', 'Redo'],
                ].map(([k, v]) => (
                  <div key={k}>
                    <span>{v}</span>
                    <kbd>{k}</kbd>
                  </div>
                ))}
              </div>
              <h3>Your work is saved on this device.</h3>
              <p>
                Edits are encrypted in your browser as you work. Export an encrypted .margin file
                from the editor to keep a separate copy. Reopen it with your vault passphrase.
                Browser storage is not cloud storage.
              </p>
              <h3>Add Margin to Chrome</h3>
              <p>
                Open <code>chrome://extensions</code>, enable Developer mode, select “Load
                unpacked,” and choose the <code>apps/extension</code> folder in this project. The
                extension opens PDF links in your local Margin workspace.
              </p>
              <button
                className="button secondary"
                onClick={() => {
                  setDialog(null);
                  navigate('settings');
                }}
              >
                Workspace & accessibility settings <ArrowUpRight size={15} />
              </button>
            </div>
          ) : dialog.type === 'source' ? (
            <>
              <p className="source-url">{dialog.url}</p>
              <p className="field-note">
                Import works when the source website permits cross-origin access. Otherwise,
                download the file and upload it here.
              </p>
              {formError && <p className="form-error">{formError}</p>}
              <div className="modal-actions">
                <button className="button secondary" onClick={() => show({ type: 'upload' })}>
                  Upload a downloaded file
                </button>
                <button
                  className="button primary"
                  disabled={busy}
                  onClick={() => void importSource(dialog.url)}
                >
                  {busy ? 'Importing…' : 'Import linked document'}
                </button>
              </div>
            </>
          ) : (
            <form className="form-stack" onSubmit={submitDialog}>
              {(dialog.type === 'new' || dialog.type === 'rename' || dialog.type === 'folder') && (
                <label>
                  {dialog.type === 'folder' ? 'Folder name' : 'Document name'}
                  <input
                    name="name"
                    autoFocus
                    required
                    maxLength={160}
                    placeholder={
                      dialog.type === 'folder'
                        ? 'e.g. Creative writing'
                        : 'e.g. A fresh perspective'
                    }
                    defaultValue={dialog.type === 'rename' ? dialog.doc.name : ''}
                  />
                </label>
              )}
              {dialog.type === 'folder' && (
                <label>
                  Folder color
                  <select name="color" defaultValue="#71856b">
                    <option value="#71856b">Sage green</option>
                    <option value="#9a829d">Soft lavender</option>
                    <option value="#6f91a6">Slate blue</option>
                    <option value="#bd8d57">Warm amber</option>
                  </select>
                </label>
              )}
              {dialog.type === 'move' && (
                <label>
                  Choose a folder
                  <select name="folder" defaultValue={dialog.doc.folderId ?? ''}>
                    <option value="">My documents (no folder)</option>
                    {folders.map((f) => (
                      <option key={f.id} value={f.id}>
                        {f.name}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              {dialog.type === 'delete' && (
                <p>
                  <strong>{dialog.doc.name}</strong>
                </p>
              )}
              {formError && (
                <p className="form-error" role="alert">
                  {formError}
                </p>
              )}
              <div className="modal-actions">
                <button
                  type="button"
                  className="button secondary"
                  onClick={() => setDialog(null)}
                  disabled={busy}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className={`button ${dialog.type === 'delete' ? 'danger' : 'primary'}`}
                  disabled={busy}
                >
                  {busy
                    ? 'Saving…'
                    : dialog.type === 'new'
                      ? 'Create document'
                      : dialog.type === 'folder'
                        ? 'Create folder'
                        : dialog.type === 'delete'
                          ? 'Delete permanently'
                          : 'Save changes'}
                </button>
              </div>
            </form>
          )}
        </Modal>
      )}
      {command && (
        <CommandPalette
          documents={documents}
          onOpen={open}
          onNavigate={navigate}
          onUpload={() => show({ type: 'upload' })}
          onNew={() => show({ type: 'new' })}
          onClose={() => setCommand(false)}
        />
      )}
      {uploads.filter((u) => u.status !== 'complete' && u.status !== 'cancelled').length > 0 && (
        <div className="upload-tray" aria-label="Upload status">
          {uploads
            .filter((u) => u.status !== 'complete' && u.status !== 'cancelled')
            .slice(0, 3)
            .map((u) => (
              <div className="upload-item" key={u.id}>
                <div>
                  <FileText size={18} />
                  <strong>{u.name}</strong>
                  {u.id.startsWith('sync:') && (
                    <>
                      <button
                        className="icon-button"
                        aria-label={u.status === 'paused' ? 'Resume upload' : 'Pause upload'}
                        onClick={() => {
                          if (u.status === 'paused' || u.status === 'error')
                            void resumeUpload(u.id, { token }, updateUpload).catch((e) =>
                              notify(String(e), true),
                            );
                          else pauseUpload(u.id);
                        }}
                      >
                        {u.status === 'paused' || u.status === 'error' ? (
                          <Play size={14} />
                        ) : (
                          <Pause size={14} />
                        )}
                      </button>
                      <button
                        className="icon-button"
                        aria-label="Cancel upload"
                        onClick={() =>
                          void cancelUpload(u.id, { token })
                            .then(refresh)
                            .catch((e) => notify(String(e), true))
                        }
                      >
                        <X size={14} />
                      </button>
                    </>
                  )}
                  {!u.id.startsWith('sync:') && u.status === 'error' && (
                    <button
                      className="icon-button"
                      aria-label="Dismiss failed import"
                      onClick={() =>
                        void db.saveUploadRecord({ ...u, status: 'cancelled' }).then(refresh)
                      }
                    >
                      <X size={14} />
                    </button>
                  )}
                </div>
                <p>
                  {u.status === 'error'
                    ? u.error
                    : u.status === 'paused'
                      ? 'Upload paused · original safe in your vault'
                      : u.status === 'processing'
                        ? 'Processing document…'
                        : u.status === 'uploading'
                          ? `Uploading · ${Math.round(u.progress)}%`
                          : 'Preparing…'}
                </p>
                <progress max={100} value={u.progress} />
              </div>
            ))}
        </div>
      )}
      {toast && (
        <div
          className={`toast ${toast.error ? 'toast-error' : ''}`}
          role={toast.error ? 'alert' : 'status'}
        >
          {toast.error ? <AlertCircle size={17} /> : <Check size={17} />}
          <span>{toast.message}</span>
          <button
            className="icon-button"
            onClick={() => setToast(null)}
            aria-label="Dismiss notification"
          >
            <X size={15} />
          </button>
        </div>
      )}
    </>
  );
}
