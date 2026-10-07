import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import {
  ArrowLeft,
  ArrowUpRight,
  PenTool,
  Stamp,
  ArrowDown,
  ArrowUp,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Circle,
  Command,
  Copy,
  Crop,
  Download,
  Eraser,
  FilePlus2,
  Focus,
  ListChecks,
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
  WifiOff,
  X,
} from 'lucide-react';
import type { Annotation, AnnotationTool, DocumentRecord, Point } from '@margin/core';
import {
  getDocument,
  getDocumentForOcr,
  getOcrForExport,
  replaceDocumentWithAnnotations,
} from '../lib/storage';
import { useAnnotations, type AnnotationPersistence } from './useAnnotations';
import { assertAssignmentEdit, assignmentToolAllowed } from './assignmentEditing';
import { usePdf } from './usePdf';
import { PdfCanvas } from './PdfCanvas';
import { AnnotationGraphic } from './AnnotationLayer';
import { FormsDialog } from './FormsDialog';
import { CropDialog } from './CropDialog';
import type { CropPageInfo, CropRequest } from './cropTypes';
import { PermissionFlag } from 'pdfjs-dist';
import { ReadingPanel, ReadingPageOverlay, defaultReadingAppearance } from './ReadingPanel';
import { usePageText } from './usePageText';
import { resolvePageText } from './resolvedPageText';
import { usePageOcr } from './usePageOcr';
import { OcrTools } from './OcrTools';
import { OcrTextLayer, type OcrSelection } from './OcrTextLayer';
import { pdfQuadToRect } from './ocrPage';
import type { PdfFormChange, PdfFormInspection } from './formTypes';
import { SignatureDialog, type SignatureInput } from './SignatureDialog';
import {
  bounds,
  clamp,
  hitTest,
  movedAnnotation,
  remapAnnotations,
  uid,
  type PageAction,
} from './model';
import { downloadBlob } from './pdf';
import {
  transformPageInWorker,
  exportPdfInWorker,
  mergePdfInWorker,
  inspectPdfFormInWorker,
  applyPdfFormInWorker,
  inspectPageCropInWorker,
  applyPageCropInWorker,
} from './pageWorker';
import { useDocumentLock } from './useDocumentLock';
import { createVaultGuard, encryptExport, onBeforeVaultLock, onVaultLock } from '../lib/vault';
import './editor.css';

export interface AssignmentEditorOptions {
  persistence: AnnotationPersistence;
  allowedTools: readonly AnnotationTool[];
  readOnly: boolean;
  controls: ReactNode;
}
interface Props {
  document: DocumentRecord;
  blob: Blob;
  onClose: () => void;
  onDocumentChange: (changes: { blob: Blob; document: DocumentRecord }) => Promise<void>;
  shortcuts?: boolean;
  registerLeaveGuard?: (guard: (() => Promise<void>) | null) => void;
  assignment?: AssignmentEditorOptions;
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
  assignment,
}: Props) {
  const assignmentRef = useRef(assignment);
  assignmentRef.current = assignment;
  const [workingBlob, setWorkingBlob] = useState(blob);
  const [contentRevision, setContentRevision] = useState('');
  const [ocrRefresh, setOcrRefresh] = useState(0);
  const [selectingOcr, setSelectingOcr] = useState(false);
  const [ocrSelection, setOcrSelection] = useState<OcrSelection | null>(null);
  const { lockStatus, retryLock } = useDocumentLock(record.id);
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
  } = useAnnotations(record.id, record.updatedAt, assignment?.persistence);
  const [pageIndex, setPageIndex] = useState(0),
    [zoom, setZoom] = useState(0.95),
    [pageSize, setPageSize] = useState({ width: 612, height: 792 });
  const [tool, setTool] = useState<AnnotationTool>('select'),
    [color, setColor] = useState(colors[0]),
    [strokeWidth, setStrokeWidth] = useState(2.5),
    [opacity, setOpacity] = useState(0.32),
    [lineStyle, setLineStyle] = useState<NonNullable<Annotation['lineStyle']>>('solid'),
    [signatureOpen, setSignatureOpen] = useState(false);
  const [formInspection, setFormInspection] = useState<PdfFormInspection | null>(null),
    [formDirty, setFormDirty] = useState(false),
    [formError, setFormError] = useState('');
  const [cropInspection, setCropInspection] = useState<{
      info: CropPageInfo;
      revision: string;
    } | null>(null),
    [cropDirty, setCropDirty] = useState(false),
    [cropError, setCropError] = useState('');
  const cropAbort = useRef<AbortController | null>(null);
  const cropOpener = useRef<HTMLButtonElement>(null);
  const cropWasOpen = useRef(false);
  useEffect(() => () => cropAbort.current?.abort(), []);
  const [sidebar, setSidebar] = useState(true),
    [panel, setPanel] = useState<'comments' | 'search' | 'text' | null>(null),
    [pageMenu, setPageMenu] = useState(false),
    [shapeMenu, setShapeMenu] = useState(false);
  const [focusMode, setFocusMode] = useState(false),
    [readingAppearance, setReadingAppearance] = useState(defaultReadingAppearance);
  const readingButton = useRef<HTMLButtonElement>(null);
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
  const exportAbort = useRef<AbortController | null>(null);
  useEffect(() => () => exportAbort.current?.abort(), []);
  const [exportLink, setExportLink] = useState<{ url: string; name: string } | null>(null);
  useEffect(() => {
    return () => {
      if (exportLink) URL.revokeObjectURL(exportLink.url);
    };
  }, [exportLink]);
  const [online, setOnline] = useState(navigator.onLine);
  const pageReading = usePageText(!vaultLocking && !leaving ? pdf : null, pageIndex, {
    documentId: record.id,
    contentRevision,
    refresh: ocrRefresh,
  });
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
    searchAbort = useRef<AbortController | null>(null),
    editDialog = useRef<HTMLDialogElement>(null),
    commandDialog = useRef<HTMLDialogElement>(null),
    mergeInput = useRef<HTMLInputElement>(null);
  const transition = useRef<Promise<void> | null>(null),
    transitionState = useRef({ busy, editing, signatureOpen, formDirty, cropDirty });
  transitionState.current = { busy, editing, signatureOpen, formDirty, cropDirty };
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
  const editable = ready && !assignment?.readOnly;
  const canUseTool = (next: AnnotationTool | Annotation['type']) =>
    ready && assignmentToolAllowed(assignment, next);
  const canChangePdf = ready && !assignment;
  const ocr = usePageOcr(pdf, record.id, contentRevision, pageIndex, ready, () =>
    setOcrRefresh((value) => value + 1),
  );
  const editorIdentity = useRef({ pdf, pageIndex, contentRevision, ready, ocrRecord: ocr.record });
  editorIdentity.current = { pdf, pageIndex, contentRevision, ready, ocrRecord: ocr.record };
  useEffect(() => {
    if (cropInspection) cropWasOpen.current = true;
    else if (cropWasOpen.current && ready) {
      cropWasOpen.current = false;
      cropOpener.current?.focus();
    }
  }, [cropInspection, ready]);
  useEffect(() => {
    setSelectingOcr(false);
    setOcrSelection(null);
  }, [pdf, pageIndex, contentRevision, panel, ocr.record]);
  const onSize = useCallback(
    (size: { width: number; height: number }) =>
      setPageSize((previous) =>
        previous.width === size.width && previous.height === size.height ? previous : size,
      ),
    [],
  );
  useEffect(() => {
    setLockInitialized(false);
    if (lockStatus !== 'owned') return;
    let active = true;
    void Promise.all([getDocumentForOcr(record.id), reload()])
      .then(([fresh]) => {
        if (!active) return;
        if (!fresh)
          throw new Error('This document was removed in another tab. Return to the workspace.');
        setWorkingBlob(fresh.blob);
        setContentRevision(fresh.record.contentRevision);
        syncTimestamp(fresh.record.updatedAt);
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
      : draft.current ||
          state.editing?.text.trim() ||
          state.signatureOpen ||
          state.formDirty ||
          state.cropDirty
        ? 'Save or cancel the pending annotation, form, or crop changes before leaving or locking.'
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
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      const state = transitionState.current;
      if (
        state.busy ||
        state.signatureOpen ||
        state.formDirty ||
        state.cropDirty ||
        state.editing?.text.trim() ||
        draft.current
      ) {
        event.preventDefault();
        event.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, []);
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
  }, [pageIndex]);
  useEffect(() => {
    searchGeneration.current++;
    searchAbort.current?.abort();
    setSearching(false);
    setSearchResults([]);
  }, [pdf, ocrRefresh]);
  useEffect(
    () => () => {
      searchGeneration.current++;
      searchAbort.current?.abort();
    },
    [],
  );
  useEffect(() => {
    if (panel !== 'text') setFocusMode(false);
  }, [panel]);
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
  function allowPdfMutation() {
    if (!assignmentRef.current) return true;
    setError('Assignment PDF pages and form fields cannot be changed.');
    return false;
  }
  function openSignature() {
    if (!canUseTool('signature')) return;
    setError('');
    setSignatureOpen(true);
  }
  function editAnnotationText(item: Annotation) {
    if (!canUseTool(item.type)) return;
    setEditing({
      point: { x: item.x, y: item.y },
      type: item.type === 'comment' ? 'comment' : 'text',
      text: item.text ?? '',
      id: item.id,
    });
  }
  function navigatePage(next: number | ((current: number) => number)) {
    if (assignmentRef.current && draft.current) {
      setError('Save or discard the pending annotation before changing pages.');
      return;
    }
    setPageIndex(next);
  }
  function commit(next: Annotation[]) {
    if (!editorIdentity.current.ready || transition.current) return false;
    const before = current.current;
    try {
      assertAssignmentEdit(before, next, assignmentRef.current);
      replace(next);
    } catch (reason) {
      setError(errorMessage(reason));
      return false;
    }
    pushHistory(
      { annotations: before, blob: workingBlob, pageIndex, pageCount },
      { annotations: next, blob: workingBlob, pageIndex, pageCount },
    );
    return true;
  }
  async function restore(snapshot: Snapshot) {
    assertAssignmentEdit(
      current.current,
      snapshot.annotations,
      assignmentRef.current,
      snapshot.blob !== workingBlob || snapshot.pageCount !== pageCount,
    );
    if (snapshot.blob !== workingBlob) {
      await flush();
      const saved = await replaceDocumentWithAnnotations(
        record.id,
        snapshot.blob,
        snapshot.pageCount,
        snapshot.annotations,
      );
      syncTimestamp(saved.updatedAt);
      setContentRevision(saved.contentRevision!);
      replace(snapshot.annotations, false);
      setWorkingBlob(snapshot.blob);
      await onDocumentChange({ blob: snapshot.blob, document: saved });
    } else replace(snapshot.annotations);
    navigatePage(snapshot.pageIndex);
    setSelected(null);
  }
  async function undo() {
    const entry = history.at(-1);
    if (!entry || !editable || transition.current) return;
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
    if (!entry || !editable || transition.current) return;
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
    if (!canUseTool(next) || transition.current) return;
    if (assignment && draft.current) {
      setError('Finish or cancel the pending annotation before choosing another tool.');
      return;
    }
    setSelected(null);
    draft.current = null;
    setDraftAnnotation(null);
    setTool(next);
    setSelectingOcr(false);
    setOcrSelection(null);
    setShapeMenu(false);
    if (next === 'highlight' && color === colors[0]) setColor(colors[1]);
  };
  function removeSelected() {
    if (selected) {
      if (commit(current.current.filter((a) => a.id !== selected))) setSelected(null);
    }
  }
  useEffect(() => {
    if (!shortcuts) return;
    const keydown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (
        target.closest(
          'input,textarea,select,[contenteditable="true"],dialog,.reading-panel,.ocr-tools,.ocr-text-layer',
        )
      )
        return;
      if (focusMode) {
        if (e.metaKey || e.ctrlKey || e.altKey) return;
        if (e.key === 'Escape') setFocusMode(false);
        if (e.key === 'ArrowRight') navigatePage((i) => Math.min(pageCount - 1, i + 1));
        if (e.key === 'ArrowLeft') navigatePage((i) => Math.max(0, i - 1));
        return;
      }
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
        draft.current = null;
        setDraftAnnotation(null);
        setSelected(null);
        setPageMenu(false);
        setShapeMenu(false);
      }
      if (selected && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) {
        e.preventDefault();
        const item = current.current.find((a) => a.id === selected);
        if (item) {
          const b = bounds(item),
            distance = e.shiftKey ? 10 : 1;
          const dx = clamp(
            e.key === 'ArrowRight' ? distance : e.key === 'ArrowLeft' ? -distance : 0,
            -b.x,
            pageSize.width - b.x - b.width,
          );
          const dy = clamp(
            e.key === 'ArrowDown' ? distance : e.key === 'ArrowUp' ? -distance : 0,
            -b.y,
            pageSize.height - b.y - b.height,
          );
          if (dx || dy)
            commit(current.current.map((a) => (a.id === item.id ? movedAnnotation(a, dx, dy) : a)));
        }
        return;
      }
      if (e.key === 'ArrowRight') navigatePage((i) => Math.min(pageCount - 1, i + 1));
      if (e.key === 'ArrowLeft') navigatePage((i) => Math.max(0, i - 1));
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
      ...(['line', 'arrow', 'rectangle', 'ellipse', 'pen'].includes(type) && lineStyle !== 'solid'
        ? { lineStyle }
        : {}),
    };
  }
  function insertAtCenter(item: Annotation) {
    if (!ready || transition.current) return;
    if (!commit([...current.current, item])) return;
    setTool('select');
    setSelected(item.id);
    setShapeMenu(false);
  }
  function insertSignature(value: SignatureInput) {
    if (!canUseTool('signature') || transition.current) return;
    const width = Math.max(10, Math.min(320, pageSize.width - 40));
    if (value.kind === 'typed') {
      const context = document.createElement('canvas').getContext('2d');
      if (context) context.font = 'italic 30px "Times New Roman", serif';
      const measured = context?.measureText(value.text).width ?? value.text.length * 30;
      const scale = Math.min(1, width / Math.max(measured, 1)),
        fontSize = 30 * scale,
        actualWidth = Math.min(width, measured * scale + 4);
      insertAtCenter({
        ...baseAnnotation('signature', {
          x: (pageSize.width - actualWidth) / 2,
          y: pageSize.height / 2 - (fontSize + 8) / 2,
        }),
        text: value.text,
        fontSize,
        width: actualWidth,
        height: fontSize + 8,
      });
    } else {
      if (!value.strokes.some((stroke) => stroke.length)) return;
      const box = bounds({
        ...baseAnnotation('signature', { x: 0, y: 0 }),
        strokes: value.strokes,
      });
      const scale = Math.min(width / Math.max(box.width, 1), 100 / Math.max(box.height, 1), 1);
      const placedX = (pageSize.width - box.width * scale) / 2,
        placedY = (pageSize.height - box.height * scale) / 2;
      insertAtCenter({
        ...baseAnnotation('signature', { x: placedX, y: placedY }),
        strokeWidth: 2.5,
        strokes: value.strokes.map((stroke) =>
          stroke.map((point) => ({
            x: placedX + (point.x - box.x) * scale,
            y: placedY + (point.y - box.y) * scale,
          })),
        ),
        width: box.width * scale,
        height: box.height * scale,
      });
    }
    setSignatureOpen(false);
    setError('');
  }
  function insertStamp(text: 'REVIEWED' | 'GREAT WORK' | 'REVISE') {
    insertAtCenter({
      ...baseAnnotation('stamp', {
        x: Math.max(10, (pageSize.width - 140) / 2),
        y: Math.max(10, pageSize.height / 2 - 18),
      }),
      text,
      width: 140,
      height: 36,
      strokeWidth: 1.5,
    });
  }
  function insertKeyboardShape() {
    if (!ready || !['line', 'arrow', 'rectangle', 'ellipse'].includes(tool)) return;
    const start = { x: pageSize.width / 2 - 65, y: pageSize.height / 2 - 30 };
    insertAtCenter({
      ...baseAnnotation(tool as Annotation['type'], start),
      ...(['line', 'arrow'].includes(tool)
        ? { points: [start, { x: start.x + 130, y: start.y + 60 }] }
        : { width: 130, height: 60 }),
    });
  }
  function pointerDown(event: ReactPointerEvent<SVGSVGElement>) {
    if (!canUseTool(tool) || transition.current || event.button !== 0 || draft.current) return;
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
      if (hit && canUseTool(hit.type))
        draft.current = { tool, start: point, points: [], original: hit };
      return;
    }
    draft.current = { tool, start: point, points: [point] };
    setDraftAnnotation({
      ...baseAnnotation(tool, point),
      ...(tool === 'pen' || tool === 'line' || tool === 'arrow'
        ? { points: [point] }
        : { width: 0, height: 0 }),
    });
  }
  function pointerMove(event: ReactPointerEvent<SVGSVGElement>) {
    const gesture = draft.current;
    if (!gesture || !editable) return;
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
    } else if (gesture.tool === 'line' || gesture.tool === 'arrow')
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
    savePointerDraft();
  }
  function savePointerDraft() {
    if (draftAnnotation) {
      if (draft.current?.tool === 'select') {
        if (
          !commit(current.current.map((a) => (a.id === draftAnnotation.id ? draftAnnotation : a)))
        )
          return;
      } else if (
        draftAnnotation.type === 'line' || draftAnnotation.type === 'arrow'
          ? Boolean(
              draftAnnotation.points &&
                draftAnnotation.points.length > 1 &&
                Math.hypot(
                  draftAnnotation.points.at(-1)!.x - draftAnnotation.points[0].x,
                  draftAnnotation.points.at(-1)!.y - draftAnnotation.points[0].y,
                ) > 1,
            )
          : draftAnnotation.points?.length ||
            ((draftAnnotation.width ?? 0) > 2 && (draftAnnotation.height ?? 0) > 2)
      ) {
        if (!commit([...current.current, draftAnnotation])) return;
      }
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
    if (
      !commit(
        old ? current.current.map((a) => (a.id === old.id ? item : a)) : [...current.current, item],
      )
    )
      return;
    setEditing(null);
    if (item.type === 'comment') setPanel('comments');
  }
  async function openForm() {
    if (!allowPdfMutation() || !ready || transition.current) return;
    setBusy('Reading PDF form');
    setError('');
    setFormError('');
    try {
      await flush();
      setFormInspection(await inspectPdfFormInWorker(workingBlob));
    } catch (reason) {
      setError(`Could not open this form: ${errorMessage(reason)}`);
    } finally {
      setBusy('');
    }
  }
  async function saveForm(changes: PdfFormChange[]) {
    if (!allowPdfMutation() || !ready || transition.current) return;
    setBusy('Saving form');
    setFormError('');
    try {
      await flush();
      const nextBlob = await applyPdfFormInWorker(workingBlob, changes);
      const saved = await replaceDocumentWithAnnotations(
        record.id,
        nextBlob,
        pageCount,
        current.current,
      );
      syncTimestamp(saved.updatedAt);
      setContentRevision(saved.contentRevision!);
      pushHistory(
        { annotations: current.current, blob: workingBlob, pageIndex, pageCount },
        { annotations: current.current, blob: nextBlob, pageIndex, pageCount },
      );
      setWorkingBlob(nextBlob);
      setFormDirty(false);
      setFormInspection(null);
      await onDocumentChange({ blob: nextBlob, document: saved });
      setNotice('Form changes saved on this device.');
    } catch (reason) {
      setFormError(errorMessage(reason));
    } finally {
      setBusy('');
    }
  }
  async function cropOperation<T>(
    run: (signal: AbortSignal, ensureCurrent: () => void) => Promise<T>,
    awaitSaveOutcome = false,
  ): Promise<T> {
    const guard = createVaultGuard();
    const controller = new AbortController();
    cropAbort.current = controller;
    const removeLockListener = onVaultLock(() => controller.abort());
    const timeout = setTimeout(
      () => controller.abort(new Error('The crop operation exceeded 90 seconds. Try again.')),
      90_000,
    );
    const ensureCurrent = () => {
      guard();
      controller.signal.throwIfAborted();
      if (
        editorIdentity.current.pdf !== pdf ||
        editorIdentity.current.pageIndex !== pageIndex ||
        editorIdentity.current.contentRevision !== contentRevision
      )
        throw new Error(
          'The document changed while cropping. Reopen the crop editor and try again.',
        );
    };
    let rejectAbort!: (reason: unknown) => void;
    const interrupted = new Promise<never>((_, reject) => {
      rejectAbort = reject;
    });
    const abort = () => rejectAbort(controller.signal.reason);
    controller.signal.addEventListener('abort', abort, { once: true });
    const work = run(controller.signal, ensureCurrent);
    try {
      return await Promise.race([work, interrupted]);
    } catch (reason) {
      // Cancellation must not unlock editing while an atomic save is still settling.
      if (awaitSaveOutcome) await work.catch(() => undefined);
      throw reason;
    } finally {
      clearTimeout(timeout);
      removeLockListener();
      controller.signal.removeEventListener('abort', abort);
      if (cropAbort.current === controller) cropAbort.current = null;
    }
  }
  async function openCrop() {
    if (!allowPdfMutation() || !pdf || !ready || transition.current || cropAbort.current) return;
    setPageMenu(false);
    setBusy('Reading page dimensions');
    setError('');
    setCropError('');
    try {
      const info = await cropOperation(async (signal, ensureCurrent) => {
        await flush();
        ensureCurrent();
        const permissions = await pdf.getPermissions();
        ensureCurrent();
        if (permissions !== null && !permissions.has(PermissionFlag.MODIFY_CONTENTS))
          throw new Error('This PDF does not allow changing its page dimensions.');
        const result = await inspectPageCropInWorker(workingBlob, pageIndex, signal);
        ensureCurrent();
        return result;
      });
      setCropInspection({ info, revision: contentRevision });
    } catch (reason) {
      setError(`Could not crop this page: ${errorMessage(reason)}`);
    } finally {
      setBusy('');
    }
  }
  async function saveCrop(request: CropRequest) {
    if (!allowPdfMutation() || !ready || !cropInspection || transition.current || cropAbort.current)
      return;
    setBusy('Saving page crop');
    setCropError('');
    let savingStarted = false;
    let guard: (() => void) | undefined;
    try {
      guard = createVaultGuard();
      await cropOperation(async (signal, ensureCurrent) => {
        if (
          cropInspection.revision !== contentRevision ||
          cropInspection.info.pageIndex !== pageIndex
        )
          throw new Error('The document changed. Reopen the crop editor and try again.');
        await flush();
        ensureCurrent();
        const result = await applyPageCropInWorker(workingBlob, pageIndex, request, signal);
        ensureCurrent();
        if (result.changed) {
          const beforeAnnotations = current.current;
          const nextAnnotations = beforeAnnotations.map((annotation) =>
            annotation.pageIndex === pageIndex
              ? movedAnnotation(annotation, result.annotationOffset.x, result.annotationOffset.y)
              : annotation,
          );
          savingStarted = true;
          const saved = await replaceDocumentWithAnnotations(
            record.id,
            result.blob,
            pageCount,
            nextAnnotations,
            contentRevision,
            signal,
          );
          ensureCurrent();
          syncTimestamp(saved.updatedAt);
          setContentRevision(saved.contentRevision!);
          pushHistory(
            { annotations: beforeAnnotations, blob: workingBlob, pageIndex, pageCount },
            { annotations: nextAnnotations, blob: result.blob, pageIndex, pageCount },
          );
          replace(nextAnnotations, false);
          setWorkingBlob(result.blob);
          setSelected(null);
          setCropInspection(null);
          setCropDirty(false);
          await onDocumentChange({ blob: result.blob, document: saved });
        } else {
          setCropInspection(null);
          setCropDirty(false);
        }
        setNotice(
          request.kind === 'reset'
            ? 'Full page restored and saved.'
            : 'Page crop saved on this device.',
        );
      }, true);
    } catch (reason) {
      if (!savingStarted) setCropError(errorMessage(reason));
      else {
        // An interruption at the commit boundary has an uncertain outcome. Read the
        // durable state before allowing another edit; never replay stale crop history.
        setLockInitialized(false);
        setCropInspection(null);
        setCropDirty(false);
        setHistory([]);
        setFuture([]);
        setSelected(null);
        try {
          if (!guard) throw reason;
          guard();
          const fresh = await getDocumentForOcr(record.id);
          guard();
          if (!fresh) throw new Error('This document is no longer available.');
          await reload();
          guard();
          syncTimestamp(fresh.record.updatedAt);
          setContentRevision(fresh.record.contentRevision);
          setWorkingBlob(fresh.blob);
          await onDocumentChange({ blob: fresh.blob, document: fresh.record });
          guard();
          setLockInitialized(true);
          setError(
            `Crop saving was interrupted. The last saved version has been reopened; check its page dimensions before trying again. ${errorMessage(reason)}`,
          );
        } catch {
          setError(
            'Crop saving was interrupted and its saved state could not be checked. Return to the workspace and reopen this document before editing.',
          );
        }
      }
    } finally {
      setBusy('');
    }
  }
  async function editPage(action: PageAction) {
    if (!allowPdfMutation() || !pdf || !ready || transition.current) return;
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
      setContentRevision(saved.contentRevision!);
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
      navigatePage(nextIndex);
      await onDocumentChange({ blob: nextBlob, document: saved });
      setNotice('Pages updated and saved on this device.');
    } catch (e) {
      setError(`Could not update pages: ${errorMessage(e)}`);
    } finally {
      setBusy('');
    }
  }
  async function exportPdf(extract = false) {
    if (!pdf || !ready || transition.current || exportAbort.current) return;
    const controller = new AbortController();
    exportAbort.current = controller;
    const removeLockListener = onVaultLock(() => controller.abort());
    const timeout = setTimeout(
      () =>
        controller.abort(new Error('Export exceeded 120 seconds. Try exporting a single page.')),
      120_000,
    );
    setExportLink(null);
    setBusy('Preparing PDF');
    setError('');
    try {
      const guard = createVaultGuard();
      const ensureCurrent = () => {
        guard();
        controller.signal.throwIfAborted();
        if (
          editorIdentity.current.pdf !== pdf ||
          editorIdentity.current.contentRevision !== contentRevision
        )
          throw new Error('The PDF changed while preparing this export. Try again.');
      };
      await flush();
      ensureCurrent();
      const ocrRecords = await getOcrForExport(
        record.id,
        contentRevision,
        extract ? pageIndex : undefined,
        controller.signal,
      );
      ensureCurrent();
      const output = await exportPdfInWorker(
        workingBlob,
        current.current,
        pdf,
        extract ? pageIndex : undefined,
        ocrRecords,
        controller.signal,
      );
      ensureCurrent();
      const encrypted = await encryptExport(output, {
        name:
          record.name.replace(/\.pdf$/i, '') +
          (extract ? ` — page ${pageIndex + 1}` : ' — annotated') +
          '.pdf',
        mimeType: 'application/pdf',
      });
      const fresh = await getDocument(record.id);
      ensureCurrent();
      if (!fresh || fresh.contentRevision !== contentRevision)
        throw new Error('The PDF changed while preparing this export. Reopen it and try again.');
      const name = `margin-document-${new Date().toISOString().replace(/[:.]/g, '-')}.margin`;
      setExportLink({ url: URL.createObjectURL(encrypted), name });
      downloadBlob(encrypted, name);
      setNotice('Encrypted .margin file ready. Reopen in Margin with your vault passphrase.');
    } catch (e) {
      setError(`Export could not finish: ${errorMessage(e)}`);
    } finally {
      clearTimeout(timeout);
      removeLockListener();
      if (exportAbort.current === controller) exportAbort.current = null;
      setBusy('');
    }
  }
  async function mergePages(file: File) {
    if (!allowPdfMutation() || !ready || transition.current) return;
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
      setContentRevision(saved.contentRevision!);
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
      navigatePage(pageCount);
      await onDocumentChange({ blob: merged.blob, document: saved });
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
    searchAbort.current?.abort();
    const abort = new AbortController();
    searchAbort.current = abort;
    const generation = ++searchGeneration.current;
    setSearching(true);
    setSearchResults([]);
    const query = search.trim().toLocaleLowerCase();
    try {
      for (let index = 0; index < pdf.numPages; index++) {
        if (searchGeneration.current !== generation) return;
        const { text: rawText } = await resolvePageText(
          pdf,
          index,
          {
            signal: abort.signal,
            cleanup: true,
          },
          { documentId: record.id, contentRevision },
        );
        if (searchGeneration.current !== generation) return;
        const text = rawText.replace(/\s+/g, ' '),
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
        if (index % 8 === 0) await new Promise((resolve) => setTimeout(resolve, 0));
      }
    } catch (e) {
      if (searchGeneration.current === generation) setError(`Search stopped: ${errorMessage(e)}`);
    } finally {
      if (searchGeneration.current === generation) setSearching(false);
    }
  }
  async function highlightOcrSelection() {
    if (
      !canUseTool('highlight') ||
      !pdf ||
      !ocr.record ||
      !ocrSelection ||
      !pageReading.canCopy ||
      !ocr.canHighlight ||
      focusMode
    )
      return;
    const expected = ocr.record;
    const page = await pdf.getPage(pageIndex + 1);
    if (
      editorIdentity.current.pdf !== pdf ||
      editorIdentity.current.pageIndex !== pageIndex ||
      editorIdentity.current.contentRevision !== expected.contentRevision ||
      editorIdentity.current.ocrRecord !== expected ||
      !editorIdentity.current.ready
    )
      return;
    const transform = page.getViewport({ scale: 1 }).transform;
    const boxes = expected.words
      .slice(ocrSelection.start, ocrSelection.end)
      .map((word) => pdfQuadToRect(word.quad, transform));
    const lines: typeof boxes = [];
    for (const box of boxes) {
      const previous = lines.at(-1);
      if (
        previous &&
        Math.abs(previous.y - box.y) < Math.min(previous.height, box.height) * 0.35 &&
        box.x >= previous.x &&
        box.x - (previous.x + previous.width) < box.height * 1.5
      ) {
        previous.width = Math.max(previous.x + previous.width, box.x + box.width) - previous.x;
        previous.height = Math.max(previous.height, box.y + box.height - previous.y);
      } else lines.push({ ...box });
    }
    if (lines.length > 500) {
      setError('Select a smaller passage to highlight.');
      return;
    }
    if (
      !commit([
        ...current.current,
        ...lines.map((box) => ({
          ...baseAnnotation('highlight', box),
          ...box,
          color: colors[1],
          opacity: 0.32,
        })),
      ])
    )
      return;
    setNotice('Recognized passage highlighted.');
    setOcrSelection(null);
    window.getSelection()?.removeAllRanges();
  }
  function readAloud() {
    setPanel('text');
  }
  function toggleFocusMode(value: boolean) {
    if (assignmentRef.current && draft.current) {
      setError('Save or discard the pending annotation before changing reading mode.');
      return;
    }
    setFocusMode(value);
    if (value) {
      setSelectingOcr(false);
      setOcrSelection(null);
    }
    setSelected(null);
    setPageMenu(false);
    setShapeMenu(false);
    draft.current = null;
    setDraftAnnotation(null);
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
    ...tools
      .filter((t) => assignmentToolAllowed(assignment, t.id))
      .map((t) => ({ label: `${t.label} tool`, detail: t.key, run: () => chooseTool(t.id) })),
    ...(!assignment
      ? [
          { label: 'Arrow tool', detail: 'Shapes', run: () => chooseTool('arrow') },
          {
            label: 'Fill PDF form',
            detail: 'Existing document fields',
            run: () => void openForm(),
          },
          { label: 'Add signature', detail: 'Typed or drawn', run: openSignature },
          { label: 'Add reviewed stamp', detail: 'Feedback', run: () => insertStamp('REVIEWED') },
          { label: 'Add a blank page', detail: 'Pages', run: () => void editPage('insert') },
          { label: 'Rotate current page', detail: 'Pages', run: () => void editPage('rotate') },
          { label: 'Crop current page', detail: 'Pages', run: () => void openCrop() },
        ]
      : []),
    { label: 'Export encrypted file', detail: '.margin', run: () => void exportPdf() },
    { label: 'Find in document', detail: 'Search', run: () => setPanel('search') },
    { label: 'Read current page aloud', detail: 'Accessibility', run: readAloud },
    { label: 'Fit page to width', detail: 'View', run: fitPage },
  ];
  const activeTool =
    tools.find((t) => t.id === tool)?.label ??
    (tool === 'rectangle'
      ? 'Rectangle'
      : tool === 'ellipse'
        ? 'Ellipse'
        : tool === 'arrow'
          ? 'Arrow'
          : 'Line');
  return (
    <div className={`document-editor${focusMode ? ' is-reading-focus' : ''}`}>
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
            {assignment ? 'CANVAS' : 'WORKSPACE'} <span>/</span>{' '}
            {assignment ? 'ASSIGNMENT' : 'MY DOCUMENTS'}
          </div>
          <h1>{record.name.replace(/\.pdf$/i, '')}</h1>
        </div>
        <div
          className={`editor-save ${saveState === 'error' ? 'has-error' : ''}`}
          aria-live="polite"
          title={
            assignment
              ? 'Assignment edits are saved in the encrypted local queue. See assignment status for server confirmation.'
              : "Annotations and document pages are saved in this browser's IndexedDB. Cloud sync is not configured."
          }
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
          ref={readingButton}
          className="editor-secondary editor-read"
          onClick={readAloud}
          disabled={!pdf}
          title="Open reading tools"
          aria-label="Read aloud"
          aria-expanded={panel === 'text'}
        >
          <Volume2 size={16} />
          <span>Read aloud</span>
        </button>
        {focusMode ? (
          <button
            className="editor-secondary editor-focus-exit"
            onClick={() => setFocusMode(false)}
          >
            <Focus size={16} />
            Exit focus mode
          </button>
        ) : null}
        <button
          className="editor-secondary editor-form-button"
          onClick={() => void openForm()}
          disabled={!canChangePdf}
          title="Fill existing PDF form fields"
          aria-label="Fill form"
        >
          <ListChecks size={16} />
          <span>Fill form</span>
        </button>
        <button
          className="editor-primary editor-export-button"
          onClick={() => void exportPdf()}
          disabled={!ready}
          title="Export PDF content in an encrypted .margin package. Reopen in Margin with your vault passphrase."
          aria-label="Export encrypted file"
        >
          <Download size={16} />
          <span>Export encrypted file</span>
        </button>
      </header>
      {assignment?.controls}
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
              disabled={!canUseTool(id)}
            >
              <Icon size={18} />
              <span>{label}</span>
            </button>
          ))}
          <div className="editor-menu-wrap">
            <button
              className={`editor-tool ${['rectangle', 'ellipse', 'line', 'arrow'].includes(tool) ? 'is-active' : ''}`}
              onClick={() => setShapeMenu(!shapeMenu)}
              disabled={
                !['rectangle', 'ellipse', 'line', 'arrow'].some((id) =>
                  canUseTool(id as AnnotationTool),
                )
              }
              aria-expanded={shapeMenu}
              aria-label="Shapes"
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
                  { id: 'arrow', label: 'Arrow', Icon: ArrowUpRight },
                ].map(({ id, label, Icon }) => (
                  <button
                    key={id}
                    disabled={!canUseTool(id as AnnotationTool)}
                    onClick={() => chooseTool(id as AnnotationTool)}
                  >
                    <Icon size={15} />
                    {label}
                  </button>
                ))}
                <div className="editor-dropdown-label">Feedback stamps</div>
                {(['REVIEWED', 'GREAT WORK', 'REVISE'] as const).map((text) => (
                  <button
                    key={text}
                    disabled={!canUseTool('stamp')}
                    onClick={() => insertStamp(text)}
                  >
                    <Stamp size={15} />
                    {text === 'REVIEWED'
                      ? 'Reviewed stamp'
                      : text === 'GREAT WORK'
                        ? 'Great work stamp'
                        : 'Revise stamp'}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
          <button
            className="editor-tool"
            disabled={!canUseTool('signature')}
            onClick={openSignature}
            aria-label="Add signature"
          >
            <PenTool size={18} />
            <span>Sign</span>
          </button>
        </div>
        <div className="editor-toolbar-spacer" />
        <button
          className="editor-icon"
          title="Undo (⌘Z)"
          aria-label="Undo"
          disabled={!history.length || !editable}
          onClick={() => void undo()}
        >
          <Undo2 size={18} />
        </button>
        <button
          className="editor-icon"
          title="Redo (⌘⇧Z)"
          aria-label="Redo"
          disabled={!future.length || !editable}
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
              ? 'Drag or arrow keys to move · Shift for larger steps · Delete to remove'
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
            {['pen', 'rectangle', 'ellipse', 'line', 'arrow'].includes(tool) ? (
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
            {['pen', 'rectangle', 'ellipse', 'line', 'arrow'].includes(tool) ? (
              <label className="editor-line-style">
                <span>Line style</span>
                <select
                  aria-label="Line style"
                  value={lineStyle}
                  disabled={!!assignment || !editable}
                  onChange={(e) => {
                    if (assignmentRef.current) return;
                    setLineStyle(e.target.value as NonNullable<Annotation['lineStyle']>);
                  }}
                >
                  <option value="solid">Solid</option>
                  <option value="dashed">Dashed</option>
                  <option value="dotted">Dotted</option>
                </select>
              </label>
            ) : null}
            {['line', 'arrow', 'rectangle', 'ellipse'].includes(tool) ? (
              <button
                className="editor-inline-action"
                onClick={insertKeyboardShape}
                disabled={!canUseTool(tool)}
              >
                Insert {tool} at center
              </button>
            ) : null}
            {tool === 'highlight' ? (
              <label className="editor-width-control">
                <span>Opacity</span>
                <input
                  type="range"
                  min=".1"
                  max=".7"
                  step=".01"
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
            {current.current.find(
              (a) => a.id === selected && (a.type === 'text' || a.type === 'comment'),
            )?.text ? (
              <button
                disabled={!canUseTool(current.current.find((a) => a.id === selected)!.type)}
                onClick={() => {
                  const a = current.current.find((a) => a.id === selected)!;
                  editAnnotationText(a);
                }}
              >
                Edit text
              </button>
            ) : null}
            <button onClick={removeSelected} disabled={!canUseTool('eraser')}>
              <Trash2 size={13} />
              Delete
            </button>
          </div>
        ) : null}
        {assignment && draftAnnotation ? (
          <div className="editor-selection-actions">
            <button onClick={savePointerDraft} disabled={!editable}>
              Save draft
            </button>
            <button
              onClick={() => {
                draft.current = null;
                setDraftAnnotation(null);
              }}
            >
              Discard draft
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
      {exportLink ? (
        <div className="export-ready" role="status">
          <span>Encrypted export prepared. If your download did not start, use this link.</span>
          <a href={exportLink.url} download={exportLink.name}>
            Download encrypted file
          </a>
          <button aria-label="Dismiss prepared export" onClick={() => setExportLink(null)}>
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
          {lockStatus === 'blocked' ? <button onClick={retryLock}>Retry editing</button> : null}
        </div>
      ) : null}
      <div className="editor-body">
        {sidebar && !focusMode ? (
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
                    onClick={() => navigatePage(index)}
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
              disabled={!canChangePdf}
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
                ref={cropOpener}
                className="editor-page-options"
                onClick={() => setPageMenu(!pageMenu)}
                disabled={!ready}
              >
                Page options
                <ChevronDown size={13} />
              </button>
              {pageMenu ? (
                <div className="editor-dropdown editor-page-dropdown">
                  <button disabled={!canChangePdf} onClick={() => void openCrop()}>
                    <Crop size={15} />
                    Crop page
                  </button>
                  <button disabled={!canChangePdf} onClick={() => void editPage('rotate')}>
                    <RotateCw size={15} />
                    Rotate clockwise
                  </button>
                  <button disabled={!canChangePdf} onClick={() => void editPage('duplicate')}>
                    <Copy size={15} />
                    Duplicate page
                  </button>
                  <button disabled={!canChangePdf} onClick={() => void editPage('insert')}>
                    <FilePlus2 size={15} />
                    Insert blank page
                  </button>
                  <button
                    disabled={!canChangePdf}
                    onClick={() => {
                      if (!allowPdfMutation()) return;
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
                  <button
                    disabled={!canChangePdf || pageIndex === 0}
                    onClick={() => void editPage('earlier')}
                  >
                    <ArrowUp size={15} />
                    Move earlier
                  </button>
                  <button
                    disabled={!canChangePdf || pageIndex === pageCount - 1}
                    onClick={() => void editPage('later')}
                  >
                    <ArrowDown size={15} />
                    Move later
                  </button>
                  <button
                    className="is-danger"
                    disabled={!canChangePdf || pageCount === 1}
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
          {pdf &&
          panel !== 'text' &&
          !pageReading.loading &&
          !pageReading.error &&
          !ocr.record &&
          pageReading.text.replace(/\s/g, '').length < 24 ? (
            <div className="ocr-offer">
              <span>
                This page has little selectable text. Make a printed English scan searchable and
                readable.
              </span>
              <button
                className="editor-secondary"
                disabled={!ready}
                onClick={() => setPanel('text')}
              >
                Recognize text
              </button>
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
                      .find(
                        (item) =>
                          (item.type === 'text' || item.type === 'comment') &&
                          item.text &&
                          hitTest(item, p),
                      );
                  if (a) editAnnotationText(a);
                }}
                aria-label={
                  focusMode
                    ? 'Page annotations. Exit focus mode to edit.'
                    : 'Annotation canvas. Choose a tool, then draw or click on the document.'
                }
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
              {selectingOcr && ocr.record && pageReading.canCopy && !focusMode && ready ? (
                <OcrTextLayer
                  pdf={pdf}
                  record={ocr.record}
                  zoom={zoom}
                  onSelection={setOcrSelection}
                />
              ) : null}
              {panel === 'text' ? (
                <ReadingPageOverlay
                  appearance={readingAppearance}
                  pageHeight={pageSize.height * zoom}
                />
              ) : null}
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
            className={`editor-sidepanel${panel === 'text' ? ' editor-reading-panel' : ''}`}
            aria-label={
              panel === 'comments'
                ? 'Comments'
                : panel === 'search'
                  ? 'Document search'
                  : 'Reading tools'
            }
          >
            <div className="editor-panel-heading">
              <span>
                {panel === 'comments'
                  ? 'Comments'
                  : panel === 'search'
                    ? 'Find in document'
                    : 'Reading tools'}
              </span>
              <button
                className="editor-icon"
                onClick={() => {
                  if (panel === 'text') readingButton.current?.focus();
                  setPanel(null);
                }}
                aria-label="Close panel"
              >
                <X size={16} />
              </button>
            </div>
            {panel === 'comments' ? (
              <>
                <p className="editor-panel-description">
                  {assignment
                    ? 'Assignment comments are saved locally and queued with your work.'
                    : 'Notes are private to this browser. Add a comment anywhere on a page.'}
                </p>
                <button
                  className="editor-panel-add"
                  disabled={!canUseTool('comment')}
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
                              navigatePage(a.pageIndex);
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
                              disabled={!canUseTool('comment')}
                              onClick={() => editAnnotationText(a)}
                            >
                              Edit
                            </button>
                            <button
                              disabled={!canUseTool('eraser')}
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
                        searchAbort.current?.abort();
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
                      : 'Search PDF text and saved recognized text. Recognize scanned pages first.'}
                  </p>
                )}
                <div className="editor-search-results">
                  {searchResults.map((result) => (
                    <button key={result.page} onClick={() => navigatePage(result.page)}>
                      <strong>Page {result.page + 1}</strong>
                      <span>{result.snippet}</span>
                    </button>
                  ))}
                </div>
              </>
            ) : null}
            {panel === 'text' && !vaultLocking && !leaving ? (
              <>
                <OcrTools
                  ocr={ocr}
                  disabled={!ready || !!pageReading.error || pageReading.loading}
                  selecting={selectingOcr}
                  onSelecting={(value) => {
                    setSelectingOcr(value);
                    setOcrSelection(null);
                    if (value) setFocusMode(false);
                  }}
                  canSelect={pageReading.canCopy}
                  canHighlight={ocr.canHighlight && canUseTool('highlight')}
                  hasSelection={!!ocrSelection}
                  onHighlight={() => void highlightOcrSelection()}
                />
                <ReadingPanel
                  text={loading ? '' : pageReading.text}
                  contextKey={`${record.id}:${contentRevision}:${pageIndex}:${ocrRefresh}`}
                  source={pageReading.source}
                  pageNumber={pageIndex + 1}
                  loading={loading || pageReading.loading}
                  extractionError={pageReading.error}
                  canCopy={pageReading.canCopy}
                  focusMode={focusMode}
                  onFocusMode={toggleFocusMode}
                  appearance={readingAppearance}
                  onAppearance={setReadingAppearance}
                  onNotice={setNotice}
                  onError={setError}
                />
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
            onClick={() => navigatePage((i) => i - 1)}
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
                navigatePage(clamp((Number(e.target.value) || 1) - 1, 0, pageCount - 1))
              }
              aria-label="Current page"
            />
            <span>/ {pageCount}</span>
          </label>
          <button
            className="editor-icon"
            aria-label="Next page"
            disabled={pageIndex >= pageCount - 1}
            onClick={() => navigatePage((i) => i + 1)}
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
      {cropInspection && pdf && (
        <CropDialog
          pdf={pdf}
          info={cropInspection.info}
          annotations={currentPageAnnotations}
          busy={!!busy}
          error={cropError}
          onDirtyChange={setCropDirty}
          onApply={saveCrop}
          onClose={() => {
            if (busy || cropAbort.current) return;
            setCropInspection(null);
            setCropDirty(false);
            setCropError('');
          }}
        />
      )}
      {formInspection && (
        <FormsDialog
          inspection={formInspection}
          busy={!!busy}
          error={formError}
          onDirtyChange={setFormDirty}
          onSave={saveForm}
          onClose={() => {
            setFormInspection(null);
            setFormDirty(false);
            setFormError('');
          }}
        />
      )}
      <SignatureDialog
        ink={color}
        open={signatureOpen}
        disabled={!ready}
        error={error}
        onClose={() => {
          setSignatureOpen(false);
          setError('');
        }}
        onInsert={insertSignature}
      />
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
              disabled={!editing || !canUseTool(editing.type) || !editing.text.trim()}
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
