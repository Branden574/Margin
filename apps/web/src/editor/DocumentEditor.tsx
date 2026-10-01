import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import {
  ArrowLeft,
  ArrowDown,
  ArrowUp,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Circle,
  Command,
  Copy,
  Download,
  Eraser,
  FilePlus2,
  Highlighter,
  Loader2,
  Maximize2,
  MessageSquare,
  Minus,
  MousePointer2,
  PanelLeftClose,
  PanelLeftOpen,
  PenLine,
  Plus,
  Redo2,
  RotateCw,
  Search,
  Square,
  Trash2,
  Type,
  Undo2,
  Volume2,
  VolumeX,
  WifiOff,
  X,
} from 'lucide-react';
import type { Annotation, AnnotationTool, DocumentRecord, Point } from '@margin/core';
import { getDocument, getDocumentBlob, replaceDocumentWithAnnotations } from '../lib/storage';
import { useAnnotations } from './useAnnotations';
import { usePdf } from './usePdf';
import { PdfCanvas } from './PdfCanvas';
import { AnnotationGraphic } from './AnnotationLayer';
import { clamp, hitTest, movedAnnotation, remapAnnotations, uid, type PageAction } from './model';
import { downloadBlob } from './pdf';
import { transformPageInWorker, exportPdfInWorker, mergePdfInWorker } from './pageWorker';
import { useDocumentLock } from './useDocumentLock';
import { encryptExport, onBeforeVaultLock } from '../lib/vault';
import './editor.css';

interface Props {
  document: DocumentRecord;
  blob: Blob;
  onClose: () => void;
  onDocumentChange: (changes: { blob?: Blob; pageCount?: number; name?: string }) => Promise<void>;
  shortcuts?: boolean;
  registerLeaveGuard?: (guard: (() => Promise<void>) | null) => void;
}
interface Snapshot {
  annotations: Annotation[];
  blob: Blob;
  pageIndex: number;
  pageCount: number;
}
interface HistoryEntry {
  before: Snapshot;
  after: Snapshot;
}
interface Draft {
  tool: AnnotationTool;
  start: Point;
  points: Point[];
  original?: Annotation;
}
const colors = ['#b85d3c', '#eab83e', '#66846c', '#52759a', '#9a6fa5', '#292925'];
const tools = [
  { id: 'select', label: 'Select', key: 'V', Icon: MousePointer2 },
  { id: 'text', label: 'Text', key: 'T', Icon: Type },
  { id: 'pen', label: 'Draw', key: 'P', Icon: PenLine },
  { id: 'highlight', label: 'Highlight', key: 'H', Icon: Highlighter },
  { id: 'eraser', label: 'Erase', key: 'E', Icon: Eraser },
  { id: 'comment', label: 'Comment', key: 'C', Icon: MessageSquare },
] as const;
const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

export default function DocumentEditor({
  document: record,
  blob,
  onClose,
  onDocumentChange,
  shortcuts = true,
  registerLeaveGuard,
}: Props) {
  const [workingBlob, setWorkingBlob] = useState(blob);
  const { lockStatus } = useDocumentLock(record.id);
  const [lockInitialized, setLockInitialized] = useState(false),
    [vaultLocking, setVaultLocking] = useState(false),
    [leaving, setLeaving] = useState(false);
  const { pdf, error: pdfError, loading } = usePdf(workingBlob);
  const {
    annotations,
    current,
    replace,
    flush,
    saveState,
    saveError,
    loaded,
    reload,
    syncTimestamp,
  } = useAnnotations(record.id, record.updatedAt);
  const [pageIndex, setPageIndex] = useState(0),
    [zoom, setZoom] = useState(0.95),
    [pageSize, setPageSize] = useState({ width: 612, height: 792 });
  const [tool, setTool] = useState<AnnotationTool>('select'),
    [color, setColor] = useState(colors[0]),
    [strokeWidth, setStrokeWidth] = useState(2.5),
    [opacity, setOpacity] = useState(0.32);
  const [sidebar, setSidebar] = useState(true),
    [panel, setPanel] = useState<'comments' | 'search' | 'text' | null>(null),
    [pageMenu, setPageMenu] = useState(false),
    [shapeMenu, setShapeMenu] = useState(false);
  const [draftAnnotation, setDraftAnnotation] = useState<Annotation | null>(null),
    [selected, setSelected] = useState<string | null>(null);
  const [editing, setEditing] = useState<{
    point: Point;
    type: 'text' | 'comment';
    text: string;
    id?: string;
  } | null>(null);
  const [busy, setBusy] = useState(''),
    [notice, setNotice] = useState(''),
    [error, setError] = useState('');
  const [online, setOnline] = useState(navigator.onLine),
    [speaking, setSpeaking] = useState(false),
    [readSpeed, setReadSpeed] = useState(1),
    [pageText, setPageText] = useState('');
  const [search, setSearch] = useState(''),
    [searching, setSearching] = useState(false),
    [searchProgress, setSearchProgress] = useState(0),
    [searchResults, setSearchResults] = useState<{ page: number; snippet: string }[]>([]);
  const [commandOpen, setCommandOpen] = useState(false),
    [commandQuery, setCommandQuery] = useState('');
  const [history, setHistory] = useState<HistoryEntry[]>([]),
    [future, setFuture] = useState<HistoryEntry[]>([]);
  const draft = useRef<Draft | null>(null),
    canvasArea = useRef<HTMLDivElement>(null),
    searchGeneration = useRef(0),
    editDialog = useRef<HTMLDialogElement>(null),
    commandDialog = useRef<HTMLDialogElement>(null),
    mergeInput = useRef<HTMLInputElement>(null);
  const transition = useRef<Promise<void> | null>(null),
    transitionState = useRef({ busy, editing });
  transitionState.current = { busy, editing };
  const currentPageAnnotations = annotations.filter((a) => a.pageIndex === pageIndex);
  const pageCount = pdf?.numPages ?? record.pageCount;
  const ready =
    !!pdf &&
    loaded &&
    lockStatus === 'owned' &&
    lockInitialized &&
    !vaultLocking &&
    !leaving &&
    !busy;
  const onSize = useCallback(
    (size: { width: number; height: number }) =>
      setPageSize((previous) =>
        previous.width === size.width && previous.height === size.height ? previous : size,
      ),
    [],
  );
  useEffect(() => {
    if (lockStatus !== 'owned') return;
    let active = true;
    void Promise.all([getDocumentBlob(record.id), getDocument(record.id), reload()])
      .then(([freshBlob, freshRecord]) => {
        if (!active) return;
        if (!freshBlob || !freshRecord)
          throw new Error('This document was removed in another tab. Return to the workspace.');
        setWorkingBlob(freshBlob);
        syncTimestamp(freshRecord.updatedAt);
        setLockInitialized(true);
      })
      .catch((reason) => {
        if (active) setError(`Editing is paused: ${errorMessage(reason)}`);
      });
    return () => {
      active = false;
    };
  }, [lockStatus, record.id, reload]);
  useEffect(() => {
    const change = (event: Event) =>
      setVaultLocking(Boolean((event as CustomEvent<{ locking: boolean }>).detail.locking));
    window.addEventListener('margin-vault-locking', change);
    return () => window.removeEventListener('margin-vault-locking', change);
  }, []);
  const leaveGuard = useCallback(async () => {
    if (transition.current) return transition.current;
    const state = transitionState.current;
    const refusal = state.busy
      ? 'Wait for the current PDF operation to finish before leaving or locking.'
      : draft.current || state.editing?.text.trim()
        ? 'Finish or cancel the pending annotation before leaving or locking.'
        : '';
    if (refusal) {
      setError(refusal);
      throw new Error(refusal);
    }
    setLeaving(true);
    const pending = flush()
      .catch((reason) => {
        const message = `Your latest edits have not saved. Retry saving before leaving: ${errorMessage(reason)}`;
        setError(message);
        throw new Error(message);
      })
      .finally(() => {
        transition.current = null;
        setLeaving(false);
      });
    transition.current = pending;
    return pending;
  }, [flush]);
  useEffect(() => onBeforeVaultLock(leaveGuard), [leaveGuard]);
  useEffect(() => {
    registerLeaveGuard?.(leaveGuard);
    return () => registerLeaveGuard?.(null);
  }, [registerLeaveGuard, leaveGuard]);
  useEffect(() => {
    const change = () => setOnline(navigator.onLine);
    window.addEventListener('online', change);
    window.addEventListener('offline', change);
    return () => {
      window.removeEventListener('online', change);
      window.removeEventListener('offline', change);
    };
  }, []);
  useEffect(() => {
    if (editing) editDialog.current?.showModal();
    else editDialog.current?.close();
  }, [editing]);
  useEffect(() => {
    if (commandOpen) commandDialog.current?.showModal();
    else commandDialog.current?.close();
  }, [commandOpen]);
  useEffect(() => {
    if (!notice) return;
    const id = setTimeout(() => setNotice(''), 4500);
    return () => clearTimeout(id);
  }, [notice]);
  useEffect(() => {
    setSelected(null);
    setDraftAnnotation(null);
    draft.current = null;
  }, [pageIndex, tool]);
  useEffect(() => {
    searchGeneration.current++;
    setSearching(false);
    setSearchResults([]);
  }, [pdf]);
  useEffect(() => {
    if ('speechSynthesis' in window) window.speechSynthesis.cancel();
    setSpeaking(false);
  }, [pageIndex, workingBlob]);
  useEffect(
    () => () => {
      searchGeneration.current++;
      if ('speechSynthesis' in window) window.speechSynthesis.cancel();
    },
    [],
  );
  useEffect(() => {
    let stale = false;
    setPageText('');
    if (pdf)
      void pdf
        .getPage(pageIndex + 1)
        .then((page) => page.getTextContent())
        .then((content) => {
          if (!stale)
            setPageText(
              content.items
                .map((item) => ('str' in item ? item.str + (item.hasEOL ? '\n' : ' ') : ''))
                .join(''),
            );
        })
        .catch(() => {});
    return () => {
      stale = true;
    };
  }, [pdf, pageIndex]);
  function pushHistory(before: Snapshot, after: Snapshot) {
    setHistory((entries) => {
      const next = [...entries, { before, after }].slice(-40);
      // History shares immutable blobs and evicts old page revisions above 96 MB.
      while (next.length > 1) {
        const blobs = new Set(next.flatMap((e) => [e.before.blob, e.after.blob]));
        if ([...blobs].reduce((sum, b) => sum + b.size, 0) <= 96 * 1024 * 1024) break;
        next.shift();
      }
      return next;
    });
    setFuture([]);
  }
  function commit(next: Annotation[]) {
    if (transition.current) return;
    pushHistory(
      { annotations: current.current, blob: workingBlob, pageIndex, pageCount },
      { annotations: next, blob: workingBlob, pageIndex, pageCount },
    );
    replace(next);
  }
  async function restore(snapshot: Snapshot) {
    if (snapshot.blob !== workingBlob) {
      await flush();
      const saved = await replaceDocumentWithAnnotations(
        record.id,
        snapshot.blob,
        snapshot.pageCount,
        snapshot.annotations,
      );
      syncTimestamp(saved.updatedAt);
      replace(snapshot.annotations, false);
      setWorkingBlob(snapshot.blob);
      await onDocumentChange({ blob: snapshot.blob, pageCount: snapshot.pageCount });
    } else replace(snapshot.annotations);
    setPageIndex(snapshot.pageIndex);
    setSelected(null);
  }
  async function undo() {
    const entry = history.at(-1);
    if (!entry || busy || transition.current) return;
    setBusy('Undoing');
    try {
      await restore(entry.before);
      setHistory((v) => v.slice(0, -1));
      setFuture((v) => [...v, entry]);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy('');
    }
  }
  async function redo() {
    const entry = future.at(-1);
    if (!entry || busy || transition.current) return;
    setBusy('Redoing');
    try {
      await restore(entry.after);
      setFuture((v) => v.slice(0, -1));
      setHistory((v) => [...v, entry]);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy('');
    }
  }
  const chooseTool = (next: AnnotationTool) => {
    setTool(next);
    setShapeMenu(false);
    if (next === 'highlight' && color === colors[0]) setColor(colors[1]);
  };
  function removeSelected() {
    if (selected) {
      commit(current.current.filter((a) => a.id !== selected));
      setSelected(null);
    }
  }
  useEffect(() => {
    if (!shortcuts) return;
    const keydown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target.closest('input,textarea,[contenteditable="true"],dialog')) return;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setCommandOpen(true);
        return;
      }
      if (!ready) return;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        void (e.shiftKey ? redo() : undo());
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const match = tools.find((t) => t.key.toLowerCase() === e.key.toLowerCase());
      if (match) {
        e.preventDefault();
        chooseTool(match.id);
      }
      if ((e.key === 'Delete' || e.key === 'Backspace') && selected) {
        e.preventDefault();
        removeSelected();
      }
      if (e.key === 'Escape') {
        setSelected(null);
        setPageMenu(false);
        setShapeMenu(false);
      }
      if (e.key === 'ArrowRight') setPageIndex((i) => Math.min(pageCount - 1, i + 1));
      if (e.key === 'ArrowLeft') setPageIndex((i) => Math.max(0, i - 1));
    };
    window.addEventListener('keydown', keydown);
    return () => window.removeEventListener('keydown', keydown);
  });
  function position(
    event: Pick<ReactPointerEvent<SVGSVGElement>, 'currentTarget' | 'clientX' | 'clientY'> & {
      pressure?: number;
    },
  ): Point {
    const box = event.currentTarget.getBoundingClientRect();
    return {
      x: clamp((event.clientX - box.left) / zoom, 0, pageSize.width),
      y: clamp((event.clientY - box.top) / zoom, 0, pageSize.height),
      pressure: event.pressure,
    };
  }
  function baseAnnotation(type: Annotation['type'], point: Point): Annotation {
    return {
      id: uid(),
      pageIndex,
      type,
      x: point.x,
      y: point.y,
      color,
      strokeWidth,
      opacity: type === 'highlight' ? opacity : 1,
      createdAt: Date.now(),
      author: 'You',
    };
  }
  function pointerDown(event: ReactPointerEvent<SVGSVGElement>) {
    if (!ready || transition.current || event.button !== 0) return;
    const point = position(event);
    event.currentTarget.setPointerCapture(event.pointerId);
    if (tool === 'text' || tool === 'comment') {
      setEditing({ point, type: tool, text: '' });
      return;
    }
    const hit = [...currentPageAnnotations].reverse().find((a) => hitTest(a, point));
    if (tool === 'eraser') {
      if (hit) commit(current.current.filter((a) => a.id !== hit.id));
      return;
    }
    if (tool === 'select') {
      setSelected(hit?.id ?? null);
      if (hit?.type === 'comment') {
        setPanel('comments');
      }
      if (hit) draft.current = { tool, start: point, points: [], original: hit };
      return;
    }
    draft.current = { tool, start: point, points: [point] };
    setDraftAnnotation({
      ...baseAnnotation(tool, point),
      ...(tool === 'pen' || tool === 'line' ? { points: [point] } : { width: 0, height: 0 }),
    });
  }
  function pointerMove(event: ReactPointerEvent<SVGSVGElement>) {
    const gesture = draft.current;
    if (!gesture) return;
    const point = position(event);
    if (gesture.tool === 'select' && gesture.original) {
      setDraftAnnotation(
        movedAnnotation(gesture.original, point.x - gesture.start.x, point.y - gesture.start.y),
      );
      return;
    }
    if (gesture.tool === 'pen') {
      const last = gesture.points.at(-1)!;
      if (Math.hypot(point.x - last.x, point.y - last.y) < 0.8) return;
      gesture.points.push(point);
      setDraftAnnotation((a) => (a ? { ...a, points: [...gesture.points] } : null));
    } else if (gesture.tool === 'line')
      setDraftAnnotation((a) => (a ? { ...a, points: [gesture.start, point] } : null));
    else
      setDraftAnnotation((a) =>
        a
          ? {
              ...a,
              x: Math.min(point.x, gesture.start.x),
              y: Math.min(point.y, gesture.start.y),
              width: Math.abs(point.x - gesture.start.x),
              height: Math.abs(point.y - gesture.start.y),
            }
          : null,
      );
  }
  function pointerUp(event: ReactPointerEvent<SVGSVGElement>) {
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
    if (draftAnnotation) {
      if (draft.current?.tool === 'select')
        commit(current.current.map((a) => (a.id === draftAnnotation.id ? draftAnnotation : a)));
      else if (
        draftAnnotation.points?.length ||
        ((draftAnnotation.width ?? 0) > 2 && (draftAnnotation.height ?? 0) > 2)
      )
        commit([...current.current, draftAnnotation]);
    }
    draft.current = null;
    setDraftAnnotation(null);
  }
  function saveText() {
    if (!ready || transition.current || !editing || !editing.text.trim()) return;
    setError('');
    const old = editing.id ? current.current.find((a) => a.id === editing.id) : undefined;
    const item = {
      ...(old ?? baseAnnotation(editing.type, editing.point)),
      text: editing.text.trim(),
      width:
        editing.type === 'comment'
          ? 24
          : Math.max(...editing.text.split('\n').map((line) => line.length * 8.3), 100),
      height: editing.type === 'comment' ? 24 : editing.text.split('\n').length * 21,
    };
    commit(
      old ? current.current.map((a) => (a.id === old.id ? item : a)) : [...current.current, item],
    );
    setEditing(null);
    if (item.type === 'comment') setPanel('comments');
  }
  async function editPage(action: PageAction) {
    if (!pdf || !ready || transition.current) return;
    setPageMenu(false);
    setBusy('Updating pages');
    setError('');
    try {
      await flush();
      const nextBlob = await transformPageInWorker(workingBlob, action, pageIndex);
      if (nextBlob.size > 100 * 1024 * 1024)
        throw new Error('This page change would exceed the 100 MB encrypted export limit.');
      const nextAnnotations = remapAnnotations(current.current, action, pageIndex, pageSize.height);
      const nextCount =
        pageCount +
        (action === 'duplicate' || action === 'insert' ? 1 : action === 'delete' ? -1 : 0);
      const nextIndex =
        action === 'earlier'
          ? pageIndex - 1
          : action === 'later' || action === 'insert' || action === 'duplicate'
            ? pageIndex + 1
            : Math.min(pageIndex, nextCount - 1);
      const saved = await replaceDocumentWithAnnotations(
        record.id,
        nextBlob,
        nextCount,
        nextAnnotations,
      );
      syncTimestamp(saved.updatedAt);
      pushHistory(
        { annotations: current.current, blob: workingBlob, pageIndex, pageCount },
        {
          annotations: nextAnnotations,
          blob: nextBlob,
          pageIndex: nextIndex,
          pageCount: nextCount,
        },
      );
      replace(nextAnnotations, false);
      setWorkingBlob(nextBlob);
      setPageIndex(nextIndex);
      await onDocumentChange({ blob: nextBlob, pageCount: nextCount });
      setNotice('Pages updated and saved on this device.');
    } catch (e) {
      setError(`Could not update pages: ${errorMessage(e)}`);
    } finally {
      setBusy('');
    }
  }
  async function exportPdf(extract = false) {
    if (!pdf || !ready || transition.current) return;
    setBusy('Preparing PDF');
    setError('');
    try {
      await flush();
      const output = await exportPdfInWorker(
        workingBlob,
        current.current,
        pdf,
        extract ? pageIndex : undefined,
      );
      const encrypted = await encryptExport(output, {
        name:
          record.name.replace(/\.pdf$/i, '') +
          (extract ? ` — page ${pageIndex + 1}` : ' — annotated') +
          '.pdf',
        mimeType: 'application/pdf',
      });
      downloadBlob(
        encrypted,
        `margin-document-${new Date().toISOString().replace(/[:.]/g, '-')}.margin`,
      );
      setNotice('Encrypted .margin file ready. Reopen in Margin with your vault passphrase.');
    } catch (e) {
      setError(`Export could not finish: ${errorMessage(e)}`);
    } finally {
      setBusy('');
    }
  }
  async function mergePages(file: File) {
    if (!ready || transition.current) return;
    setBusy('Merging PDF pages');
    setError('');
    try {
      if (file.size > 100 * 1024 * 1024)
        throw new Error('Choose a PDF smaller than 100 MB for this encrypted workspace.');
      const signature = new TextDecoder().decode(await file.slice(0, 1024).arrayBuffer());
      if (!signature.includes('%PDF-'))
        throw new Error('This file does not contain a supported PDF signature.');
      await flush();
      const merged = await mergePdfInWorker(workingBlob, file);
      if (merged.blob.size > 100 * 1024 * 1024)
        throw new Error('The merged document would exceed the 100 MB encrypted export limit.');
      const saved = await replaceDocumentWithAnnotations(
        record.id,
        merged.blob,
        merged.pageCount,
        current.current,
      );
      syncTimestamp(saved.updatedAt);
      pushHistory(
        { annotations: current.current, blob: workingBlob, pageIndex, pageCount },
        {
          annotations: current.current,
          blob: merged.blob,
          pageIndex: pageCount,
          pageCount: merged.pageCount,
        },
      );
      setWorkingBlob(merged.blob);
      setPageIndex(pageCount);
      await onDocumentChange({ blob: merged.blob, pageCount: merged.pageCount });
      setNotice(`Added ${merged.pageCount - pageCount} pages. Saved on this device.`);
    } catch (e) {
      setError(`Could not merge this PDF: ${errorMessage(e)}`);
    } finally {
      setBusy('');
      if (mergeInput.current) mergeInput.current.value = '';
    }
  }
  async function runSearch() {
    if (!pdf || !search.trim()) return;
    const generation = ++searchGeneration.current;
    setSearching(true);
    setSearchResults([]);
    const query = search.trim().toLocaleLowerCase();
    try {
      for (let index = 0; index < pdf.numPages; index++) {
        if (searchGeneration.current !== generation) return;
        const p = await pdf.getPage(index + 1),
          content = await p.getTextContent(),
          text = content.items.map((item) => ('str' in item ? item.str : '')).join(' '),
          match = text.toLocaleLowerCase().indexOf(query);
        if (match !== -1)
          setSearchResults((results) => [
            ...results,
            {
              page: index,
              snippet:
                (match > 40 ? '…' : '') +
                text.slice(Math.max(0, match - 40), match + query.length + 85) +
                '…',
            },
          ]);
        setSearchProgress(index + 1);
        if (Math.abs(index - pageIndex) > 2) p.cleanup();
        if (index % 8 === 0) await new Promise((resolve) => setTimeout(resolve, 0));
      }
    } catch (e) {
      if (searchGeneration.current === generation) setError(`Search stopped: ${errorMessage(e)}`);
    } finally {
      if (searchGeneration.current === generation) setSearching(false);
    }
  }
  function readAloud() {
    if (!('speechSynthesis' in window)) {
      setError('Read aloud is unavailable in this browser.');
      return;
    }
    if (speaking) {
      window.speechSynthesis.cancel();
      setSpeaking(false);
      return;
    }
    if (!pageText.trim()) {
      setNotice(
        'This page has no selectable text. Scanned pages need OCR, which is not connected in this local workspace.',
      );
      return;
    }
    const utterance = new SpeechSynthesisUtterance(pageText);
    utterance.rate = readSpeed;
    utterance.onend = () => setSpeaking(false);
    utterance.onerror = () => setSpeaking(false);
    window.speechSynthesis.speak(utterance);
    setSpeaking(true);
  }
  function fitPage() {
    if (canvasArea.current)
      setZoom(clamp((canvasArea.current.clientWidth - 100) / pageSize.width, 0.3, 2.5));
  }
  async function close() {
    try {
      await leaveGuard();
      onClose();
    } catch (reason) {
      setError(errorMessage(reason));
    }
  }
  const commands = [
    ...tools.map((t) => ({ label: `${t.label} tool`, detail: t.key, run: () => chooseTool(t.id) })),
    { label: 'Export encrypted file', detail: '.margin', run: () => void exportPdf() },
    { label: 'Add a blank page', detail: 'Pages', run: () => void editPage('insert') },
    { label: 'Rotate current page', detail: 'Pages', run: () => void editPage('rotate') },
    { label: 'Find in document', detail: 'Search', run: () => setPanel('search') },
    { label: 'Read current page aloud', detail: 'Accessibility', run: readAloud },
    { label: 'Fit page to width', detail: 'View', run: fitPage },
  ];
  const activeTool =
    tools.find((t) => t.id === tool)?.label ??
    (tool === 'rectangle' ? 'Rectangle' : tool === 'ellipse' ? 'Ellipse' : 'Line');
  return (
    <div className="document-editor">
      <input
        hidden
        ref={mergeInput}
        type="file"
        accept="application/pdf"
        aria-label="Choose PDF to merge"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) void mergePages(file);
        }}
      />
      <header className="editor-header">
        <button
          className="editor-icon"
          onClick={() => void close()}
          disabled={!!busy || leaving}
          aria-label="Back to workspace"
          title="Back to workspace"
        >
          <ArrowLeft size={19} />
        </button>
        <div className="editor-title">
          <div className="editor-breadcrumb">
            WORKSPACE <span>/</span> MY DOCUMENTS
          </div>
          <h1>{record.name.replace(/\.pdf$/i, '')}</h1>
        </div>
        <div
          className={`editor-save ${saveState === 'error' ? 'has-error' : ''}`}
          aria-live="polite"
          title="Annotations and document pages are saved in this browser's IndexedDB. Cloud sync is not configured."
        >
          {saveState === 'saving' || saveState === 'loading' ? (
            <Loader2 size={14} className="is-spinning" />
          ) : saveState === 'error' ? (
            <WifiOff size={14} />
          ) : online ? (
            <Check size={14} />
          ) : (
            <WifiOff size={14} />
          )}
          <span>
            {saveState === 'loading'
              ? 'Opening local work'
              : saveState === 'saving'
                ? 'Saving locally…'
                : saveState === 'error'
                  ? 'Not saved — retry'
                  : online
                    ? 'Saved on this device'
                    : 'Offline · saved on this device'}
          </span>
        </div>
        <button
          className="editor-secondary editor-read"
          onClick={readAloud}
          disabled={!ready}
          title="Read this page aloud"
        >
          {speaking ? <VolumeX size={16} /> : <Volume2 size={16} />}
          <span>{speaking ? 'Stop reading' : 'Read aloud'}</span>
        </button>
        <button
          className="editor-primary"
          onClick={() => void exportPdf()}
          disabled={!ready}
          title="Export PDF content in an encrypted .margin package. Reopen in Margin with your vault passphrase."
        >
          <Download size={16} />
          <span>Export encrypted file</span>
        </button>
      </header>
      <div className="editor-toolbar">
        <button
          className="editor-icon"
          onClick={() => setSidebar(!sidebar)}
          aria-label={sidebar ? 'Hide pages' : 'Show pages'}
          title="Toggle pages"
        >
          {sidebar ? <PanelLeftClose size={18} /> : <PanelLeftOpen size={18} />}
        </button>
        <div className="editor-toolbar-divider" />
        <div className="editor-tools" role="toolbar" aria-label="Annotation tools">
          {tools.map(({ id, label, key, Icon }) => (
            <button
              key={id}
              className={`editor-tool ${tool === id ? 'is-active' : ''}`}
              onClick={() => chooseTool(id)}
              aria-pressed={tool === id}
              title={`${label}${shortcuts ? ` (${key})` : ''}`}
              disabled={!ready}
            >
              <Icon size={18} />
              <span>{label}</span>
            </button>
          ))}
          <div className="editor-menu-wrap">
            <button
              className={`editor-tool ${['rectangle', 'ellipse', 'line'].includes(tool) ? 'is-active' : ''}`}
              onClick={() => setShapeMenu(!shapeMenu)}
              disabled={!ready}
              aria-expanded={shapeMenu}
            >
              <Square size={17} />
              <span>Shapes</span>
              <ChevronDown size={12} />
            </button>
            {shapeMenu ? (
              <div className="editor-dropdown">
                {[
                  { id: 'rectangle', label: 'Rectangle', Icon: Square },
                  { id: 'ellipse', label: 'Ellipse', Icon: Circle },
                  { id: 'line', label: 'Line', Icon: Minus },
                ].map(({ id, label, Icon }) => (
                  <button key={id} onClick={() => chooseTool(id as AnnotationTool)}>
                    <Icon size={15} />
                    {label}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        </div>
        <div className="editor-toolbar-spacer" />
        <button
          className="editor-icon"
          title="Undo (⌘Z)"
          aria-label="Undo"
          disabled={!history.length || !!busy || leaving}
          onClick={() => void undo()}
        >
          <Undo2 size={18} />
        </button>
        <button
          className="editor-icon"
          title="Redo (⌘⇧Z)"
          aria-label="Redo"
          disabled={!future.length || !!busy || leaving}
          onClick={() => void redo()}
        >
          <Redo2 size={18} />
        </button>
        <div className="editor-toolbar-divider" />
        <button
          className={`editor-icon ${panel === 'search' ? 'is-active' : ''}`}
          onClick={() => setPanel(panel === 'search' ? null : 'search')}
          aria-label="Find in document"
          title="Find in document"
        >
          <Search size={18} />
        </button>
        <button
          className={`editor-icon ${panel === 'comments' ? 'is-active' : ''}`}
          onClick={() => setPanel(panel === 'comments' ? null : 'comments')}
          aria-label="Show comments"
          title="Comments"
        >
          <MessageSquare size={18} />
        </button>
        <button
          className="editor-icon"
          onClick={() => setCommandOpen(true)}
          aria-label="Open command palette"
          title="Commands (⌘K)"
        >
          <Command size={17} />
        </button>
      </div>
      <div className="editor-contextbar">
        <span className="editor-context-label">{activeTool}</span>
        <span className="editor-context-separator" />
        {tool === 'select' ? (
          <span className="editor-tool-help">
            {selected
              ? 'Drag to move · Delete to remove'
              : 'Select an annotation to move or edit it'}
          </span>
        ) : tool === 'eraser' ? (
          <span className="editor-tool-help">Click an annotation to remove it</span>
        ) : (
          <>
            <div className="editor-swatches" aria-label="Annotation color">
              {colors.map((c) => (
                <button
                  key={c}
                  style={{ background: c }}
                  className={color === c ? 'is-selected' : ''}
                  onClick={() => setColor(c)}
                  aria-label={`Use ${c} color`}
                  aria-pressed={color === c}
                />
              ))}
            </div>
            <label className="editor-color-input" title="Custom color">
              <input
                type="color"
                value={color}
                onChange={(e) => setColor(e.target.value)}
                aria-label="Custom annotation color"
              />
            </label>
            {['pen', 'rectangle', 'ellipse', 'line'].includes(tool) ? (
              <label className="editor-width-control">
                <span>Weight</span>
                <input
                  type="range"
                  min="1"
                  max="10"
                  step=".5"
                  value={strokeWidth}
                  onChange={(e) => setStrokeWidth(+e.target.value)}
                  aria-label="Stroke width"
                />
                <span>{strokeWidth} px</span>
              </label>
            ) : null}
            {tool === 'highlight' ? (
              <label className="editor-width-control">
                <span>Opacity</span>
                <input
                  type="range"
                  min=".1"
                  max=".7"
                  step=".05"
                  value={opacity}
                  onChange={(e) => setOpacity(+e.target.value)}
                  aria-label="Highlight opacity"
                />
                <span>{Math.round(opacity * 100)}%</span>
              </label>
            ) : null}
            <span className="editor-tool-help">
              {tool === 'text'
                ? 'Click anywhere to add text'
                : tool === 'comment'
                  ? 'Click a point to leave a note'
                  : tool === 'highlight'
                    ? 'Drag across an area to highlight'
                    : 'Click and drag on the page'}
            </span>
          </>
        )}
        {selected ? (
          <div className="editor-selection-actions">
            {current.current.find((a) => a.id === selected)?.text ? (
              <button
                onClick={() => {
                  const a = current.current.find((a) => a.id === selected)!;
                  setEditing({
                    point: { x: a.x, y: a.y },
                    type: a.type === 'comment' ? 'comment' : 'text',
                    text: a.text ?? '',
                    id: a.id,
                  });
                }}
              >
                Edit text
              </button>
            ) : null}
            <button onClick={removeSelected}>
              <Trash2 size={13} />
              Delete
            </button>
          </div>
        ) : null}
      </div>
      {error || pdfError || saveState === 'error' ? (
        <div className="editor-error" role="alert">
          <span>
            {error ||
              pdfError ||
              (loaded
                ? `Your latest edits are still in memory. Saving failed: ${saveError}`
                : `Annotations could not be loaded. Editing is paused: ${saveError}`)}
          </span>
          {saveState === 'error' ? (
            <button onClick={() => void (loaded ? flush() : reload()).catch(() => {})}>
              {loaded ? 'Retry save' : 'Retry loading'}
            </button>
          ) : null}
          <button onClick={() => setError('')} aria-label="Dismiss error">
            <X size={15} />
          </button>
        </div>
      ) : null}
      {lockStatus === 'blocked' || lockStatus === 'unsupported' ? (
        <div className="editor-error" role="status">
          <span>
            {lockStatus === 'blocked'
              ? 'This document is open for editing in another tab. Close it there to edit safely here.'
              : 'This browser cannot acquire a document editing lock. Use a current Chrome browser to edit safely.'}
          </span>
          {lockStatus === 'blocked' ? (
            <button onClick={() => window.location.reload()}>Reload and retry</button>
          ) : null}
        </div>
      ) : null}
      <div className="editor-body">
        {sidebar ? (
          <aside className="editor-pages" aria-label="Document pages">
            <div className="editor-panel-heading">
              <span>Pages</span>
              <span className="editor-count">{pageCount}</span>
            </div>
            <div className="editor-thumbnails">
              {pdf ? (
                Array.from(
                  { length: Math.min(5, pageCount) },
                  (_, i) => clamp(pageIndex - 2, 0, Math.max(0, pageCount - 5)) + i,
                ).map((index) => (
                  <button
                    key={index}
                    className={`editor-thumbnail ${index === pageIndex ? 'is-current' : ''}`}
                    onClick={() => setPageIndex(index)}
                    aria-label={`Go to page ${index + 1}`}
                    aria-current={index === pageIndex ? 'page' : undefined}
                  >
                    <div className="editor-thumbnail-paper">
                      <PdfCanvas pdf={pdf} pageIndex={index} scale={0.19} thumbnail />
                    </div>
                    <span>{index + 1}</span>
                  </button>
                ))
              ) : (
                <div className="editor-muted">Loading pages…</div>
              )}
              {pageCount > 5 ? (
                <p className="editor-thumbnail-note">Nearby pages are loaded as you navigate.</p>
              ) : null}
            </div>
            <button
              className="editor-add-page"
              onClick={() => void editPage('insert')}
              disabled={!ready}
            >
              <Plus size={16} />
              Add page
            </button>
          </aside>
        ) : null}
        <main ref={canvasArea} className="editor-canvas-area" aria-label="PDF document">
          <div className="editor-page-topline">
            <span>
              PAGE {pageIndex + 1} OF {pageCount}
            </span>
            <div className="editor-menu-wrap">
              <button
                className="editor-page-options"
                onClick={() => setPageMenu(!pageMenu)}
                disabled={!ready}
              >
                Page options
                <ChevronDown size={13} />
              </button>
              {pageMenu ? (
                <div className="editor-dropdown editor-page-dropdown">
                  <button onClick={() => void editPage('rotate')}>
                    <RotateCw size={15} />
                    Rotate clockwise
                  </button>
                  <button onClick={() => void editPage('duplicate')}>
                    <Copy size={15} />
                    Duplicate page
                  </button>
                  <button onClick={() => void editPage('insert')}>
                    <FilePlus2 size={15} />
                    Insert blank page
                  </button>
                  <button
                    onClick={() => {
                      setPageMenu(false);
                      mergeInput.current?.click();
                    }}
                  >
                    <FilePlus2 size={15} />
                    Merge another PDF
                  </button>
                  <button
                    onClick={() => {
                      setPageMenu(false);
                      void exportPdf(true);
                    }}
                  >
                    <Download size={15} />
                    Extract encrypted page
                  </button>
                  <button disabled={pageIndex === 0} onClick={() => void editPage('earlier')}>
                    <ArrowUp size={15} />
                    Move earlier
                  </button>
                  <button
                    disabled={pageIndex === pageCount - 1}
                    onClick={() => void editPage('later')}
                  >
                    <ArrowDown size={15} />
                    Move later
                  </button>
                  <button
                    className="is-danger"
                    disabled={pageCount === 1}
                    onClick={() => void editPage('delete')}
                  >
                    <Trash2 size={15} />
                    Delete page
                  </button>
                </div>
              ) : null}
            </div>
          </div>
          {loading ? (
            <div className="editor-loading">
              <Loader2 size={26} className="is-spinning" />
              <h2>Opening your document</h2>
              <p>Preparing the page in a background worker.</p>
            </div>
          ) : null}
          {pdf ? (
            <div
              className={`editor-paper tool-${tool}`}
              style={{ width: pageSize.width * zoom, height: pageSize.height * zoom }}
            >
              <PdfCanvas pdf={pdf} pageIndex={pageIndex} scale={zoom} onSize={onSize} />
              <svg
                className="editor-annotation-layer"
                width={pageSize.width * zoom}
                height={pageSize.height * zoom}
                viewBox={`0 0 ${pageSize.width} ${pageSize.height}`}
                onPointerDown={pointerDown}
                onPointerMove={pointerMove}
                onPointerUp={pointerUp}
                onPointerCancel={() => {
                  draft.current = null;
                  setDraftAnnotation(null);
                }}
                onDoubleClick={(e) => {
                  if (tool !== 'select') return;
                  const p = position(e),
                    a = [...currentPageAnnotations]
                      .reverse()
                      .find((item) => item.text && hitTest(item, p));
                  if (a)
                    setEditing({
                      point: { x: a.x, y: a.y },
                      type: a.type === 'comment' ? 'comment' : 'text',
                      text: a.text ?? '',
                      id: a.id,
                    });
                }}
                aria-label="Annotation canvas. Choose a tool, then draw or click on the document."
              >
                {currentPageAnnotations
                  .filter((a) => a.id !== draftAnnotation?.id)
                  .map((a) => (
                    <AnnotationGraphic key={a.id} annotation={a} selected={selected === a.id} />
                  ))}
                {draftAnnotation ? (
                  <AnnotationGraphic annotation={draftAnnotation} selected={tool === 'select'} />
                ) : null}
              </svg>
            </div>
          ) : null}
          {!loading && pdfError ? (
            <div className="editor-loading">
              <h2>This PDF could not be opened</h2>
              <p>{pdfError}</p>
              <button className="editor-secondary" onClick={() => void close()}>
                Back to documents
              </button>
            </div>
          ) : null}
          <div className="editor-canvas-bottom-space" />
        </main>
        {panel ? (
          <aside
            className="editor-sidepanel"
            aria-label={
              panel === 'comments'
                ? 'Comments'
                : panel === 'search'
                  ? 'Document search'
                  : 'Page text'
            }
          >
            <div className="editor-panel-heading">
              <span>
                {panel === 'comments'
                  ? 'Comments'
                  : panel === 'search'
                    ? 'Find in document'
                    : 'Page text'}
              </span>
              <button
                className="editor-icon"
                onClick={() => setPanel(null)}
                aria-label="Close panel"
              >
                <X size={16} />
              </button>
            </div>
            {panel === 'comments' ? (
              <>
                <p className="editor-panel-description">
                  Notes are private to this browser. Add a comment anywhere on a page.
                </p>
                <button
                  className="editor-panel-add"
                  disabled={!ready}
                  onClick={() => chooseTool('comment')}
                >
                  <Plus size={15} />
                  Add comment
                </button>
                <div className="editor-comments">
                  {annotations.filter((a) => a.type === 'comment').length ? (
                    annotations
                      .filter((a) => a.type === 'comment')
                      .map((a) => (
                        <article
                          key={a.id}
                          className={`editor-comment ${selected === a.id ? 'is-selected' : ''}`}
                        >
                          <button
                            className="editor-comment-locator"
                            onClick={() => {
                              setPageIndex(a.pageIndex);
                              setSelected(a.id);
                            }}
                          >
                            <span className="editor-comment-avatar">Y</span>
                            <span>
                              <strong>You</strong>
                              <small>
                                Page {a.pageIndex + 1} ·{' '}
                                {new Date(a.createdAt).toLocaleDateString(undefined, {
                                  month: 'short',
                                  day: 'numeric',
                                })}
                              </small>
                            </span>
                          </button>
                          <p>{a.text}</p>
                          <div className="editor-comment-actions">
                            <button
                              disabled={!ready}
                              onClick={() =>
                                setEditing({
                                  point: { x: a.x, y: a.y },
                                  type: 'comment',
                                  text: a.text ?? '',
                                  id: a.id,
                                })
                              }
                            >
                              Edit
                            </button>
                            <button
                              disabled={!ready}
                              onClick={() =>
                                commit(current.current.filter((item) => item.id !== a.id))
                              }
                            >
                              Delete
                            </button>
                          </div>
                        </article>
                      ))
                  ) : (
                    <div className="editor-panel-empty">
                      <MessageSquare size={28} />
                      <h3>A little space for your thoughts</h3>
                      <p>Add a question, a reminder, or your next big idea.</p>
                    </div>
                  )}
                </div>
              </>
            ) : null}
            {panel === 'search' ? (
              <>
                <form
                  className="editor-search-form"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void runSearch();
                  }}
                >
                  <div>
                    <Search size={16} />
                    <input
                      value={search}
                      onChange={(e) => setSearch(e.target.value)}
                      placeholder="Search document text"
                      aria-label="Search document text"
                      autoFocus
                    />
                  </div>
                  <button className="editor-primary" disabled={!pdf || searching || !search.trim()}>
                    {searching ? 'Searching…' : 'Find'}
                  </button>
                </form>
                {searching ? (
                  <div className="editor-search-status">
                    Reading page {searchProgress} of {pageCount}
                    <button
                      onClick={() => {
                        searchGeneration.current++;
                        setSearching(false);
                      }}
                    >
                      Stop
                    </button>
                  </div>
                ) : (
                  <p className="editor-panel-description">
                    {searchResults.length
                      ? `${searchResults.length} matching pages`
                      : 'Search selectable PDF text. Scanned pages require OCR.'}
                  </p>
                )}
                <div className="editor-search-results">
                  {searchResults.map((result) => (
                    <button key={result.page} onClick={() => setPageIndex(result.page)}>
                      <strong>Page {result.page + 1}</strong>
                      <span>{result.snippet}</span>
                    </button>
                  ))}
                </div>
              </>
            ) : null}
            {panel === 'text' ? (
              <>
                <div className="editor-text-tools">
                  <button
                    className="editor-secondary"
                    disabled={!pageText}
                    onClick={() =>
                      void navigator.clipboard
                        .writeText(pageText)
                        .then(() => setNotice('Page text copied.'))
                        .catch(() =>
                          setError(
                            'Clipboard permission was denied. Select and copy the page text below.',
                          ),
                        )
                    }
                  >
                    <Copy size={14} />
                    Copy text
                  </button>
                  <label>
                    Reading speed
                    <select value={readSpeed} onChange={(e) => setReadSpeed(+e.target.value)}>
                      <option value=".75">0.75×</option>
                      <option value="1">1×</option>
                      <option value="1.25">1.25×</option>
                      <option value="1.5">1.5×</option>
                    </select>
                  </label>
                </div>
                <div className="editor-page-text">
                  {pageText ||
                    'This page has no selectable text. OCR is not connected in this local workspace.'}
                </div>
              </>
            ) : null}
          </aside>
        ) : null}
      </div>
      <footer className="editor-footer">
        <div className="editor-footer-left">
          <span className="editor-local-dot" />
          Local workspace<span className="editor-footer-divider">·</span>
          <button onClick={() => setPanel(panel === 'text' ? null : 'text')}>View page text</button>
        </div>
        <div className="editor-navigation">
          <button
            className="editor-icon"
            aria-label="Previous page"
            disabled={pageIndex === 0}
            onClick={() => setPageIndex((i) => i - 1)}
          >
            <ChevronLeft size={16} />
          </button>
          <label>
            <input
              type="number"
              min="1"
              max={pageCount}
              value={pageIndex + 1}
              onChange={(e) =>
                setPageIndex(clamp((Number(e.target.value) || 1) - 1, 0, pageCount - 1))
              }
              aria-label="Current page"
            />
            <span>/ {pageCount}</span>
          </label>
          <button
            className="editor-icon"
            aria-label="Next page"
            disabled={pageIndex >= pageCount - 1}
            onClick={() => setPageIndex((i) => i + 1)}
          >
            <ChevronRight size={16} />
          </button>
        </div>
        <div className="editor-zoom">
          <button
            className="editor-icon"
            onClick={() => setZoom((v) => clamp(v - 0.1, 0.3, 2.5))}
            aria-label="Zoom out"
          >
            <Minus size={15} />
          </button>
          <button className="editor-zoom-value" onClick={() => setZoom(1)} title="Reset zoom">
            {Math.round(zoom * 100)}%
          </button>
          <button
            className="editor-icon"
            onClick={() => setZoom((v) => clamp(v + 0.1, 0.3, 2.5))}
            aria-label="Zoom in"
          >
            <Plus size={15} />
          </button>
          <span className="editor-toolbar-divider" />
          <button
            className="editor-icon"
            onClick={fitPage}
            aria-label="Fit page width"
            title="Fit page width"
          >
            <Maximize2 size={15} />
          </button>
        </div>
      </footer>
      {busy ? (
        <div className="editor-busy" role="status">
          <Loader2 size={16} className="is-spinning" />
          {busy}…
        </div>
      ) : null}
      {notice ? (
        <div className="editor-toast" role="status">
          <Check size={16} />
          {notice}
        </div>
      ) : null}
      <dialog ref={editDialog} className="editor-dialog" onCancel={() => setEditing(null)}>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            saveText();
          }}
        >
          <div className="editor-dialog-heading">
            <h2>
              {editing?.id ? 'Edit' : 'Add'} {editing?.type === 'comment' ? 'comment' : 'text'}
            </h2>
            <button
              type="button"
              className="editor-icon"
              onClick={() => setEditing(null)}
              aria-label="Close text editor"
            >
              <X size={18} />
            </button>
          </div>
          <p>
            {editing?.type === 'comment'
              ? 'Leave a note attached to this point on your document.'
              : 'Your text will appear directly on the page.'}
          </p>
          {editing && error ? <p role="alert">{error}</p> : null}
          <textarea
            autoFocus
            aria-label={editing?.type === 'comment' ? 'Comment text' : 'Annotation text'}
            placeholder={editing?.type === 'comment' ? 'What are you thinking?' : 'Start writing…'}
            value={editing?.text ?? ''}
            onChange={(e) =>
              setEditing((value) => (value ? { ...value, text: e.target.value } : value))
            }
            rows={5}
          />
          <div className="editor-dialog-actions">
            <button type="button" className="editor-secondary" onClick={() => setEditing(null)}>
              Cancel
            </button>
            <button
              type="submit"
              className="editor-primary"
              disabled={!ready || !editing?.text.trim()}
            >
              Save {editing?.type === 'comment' ? 'comment' : 'text'}
            </button>
          </div>
        </form>
      </dialog>
      <dialog
        ref={commandDialog}
        className="editor-dialog editor-command-dialog"
        onCancel={() => setCommandOpen(false)}
      >
        <div className="editor-command-search">
          <Search size={19} />
          <input
            autoFocus
            value={commandQuery}
            onChange={(e) => setCommandQuery(e.target.value)}
            placeholder="What would you like to do?"
            aria-label="Search commands"
          />
          <button className="editor-keycap" onClick={() => setCommandOpen(false)}>
            Esc
          </button>
        </div>
        <div className="editor-command-list">
          {commands
            .filter((command) => command.label.toLowerCase().includes(commandQuery.toLowerCase()))
            .map((command) => (
              <button
                key={command.label}
                onClick={() => {
                  setCommandOpen(false);
                  setCommandQuery('');
                  command.run();
                }}
                disabled={!ready}
              >
                <span>{command.label}</span>
                <small>{command.detail}</small>
              </button>
            ))}
        </div>
        <div className="editor-command-footnote">Everything you need, a few keystrokes away.</div>
      </dialog>
    </div>
  );
}
