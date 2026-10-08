import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, FileText, MessageSquare, Minus, Plus } from 'lucide-react';
import type { Annotation } from '@margin/core';
import { PdfCanvas } from '../editor/PdfCanvas';
import { AnnotationGraphic } from '../editor/AnnotationLayer';
import { usePdf } from '../editor/usePdf';

interface PageGeometry {
  id: string;
  index: number;
  width: number;
  height: number;
}
interface Props {
  source: Blob;
  pages: readonly PageGeometry[];
  annotations: readonly Annotation[];
}

/** This viewer has no editing adapter, local outbox, or mutable document subscription. */
export function CanvasReviewDocument({ source, pages, annotations }: Props) {
  const { pdf, loading, error } = usePdf(source);
  const [pageIndex, setPageIndex] = useState(0);
  const [zoom, setZoom] = useState<number | 'fit'>('fit');
  const [availableWidth, setAvailableWidth] = useState(0);
  const [geometryError, setGeometryError] = useState(false);
  const [measuredPage, setMeasuredPage] = useState(-1);
  const [showAnnotations, setShowAnnotations] = useState(true);
  const [textState, setTextState] = useState<{ page: number; text: string; error: boolean } | null>(
    null,
  );
  const [commentPage, setCommentPage] = useState(0);
  const surface = useRef<HTMLDivElement>(null);
  const page = pages[pageIndex];
  const pageAnnotations = useMemo(
    () => annotations.filter((annotation) => annotation.pageIndex === pageIndex),
    [annotations, pageIndex],
  );
  const comments = useMemo(
    () => pageAnnotations.filter((annotation) => annotation.type === 'comment'),
    [pageAnnotations],
  );
  const annotationText = useMemo(
    () => pageAnnotations.filter((annotation) => annotation.type !== 'comment' && annotation.text),
    [pageAnnotations],
  );
  useEffect(() => {
    const element = surface.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => setAvailableWidth(entry.contentRect.width));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!pdf) return;
    let stopped = false;
    void (async () => {
      try {
        const documentPage = await pdf.getPage(pageIndex + 1);
        if (stopped) return;
        const content = await documentPage.getTextContent();
        if (stopped) return;
        let text = '';
        for (const item of content.items) {
          if ('str' in item) text += item.str + (item.hasEOL ? '\n' : ' ');
          if (text.length > 200_000) throw new Error('Page text exceeds the review limit.');
        }
        setTextState({ page: pageIndex, text: text.trim(), error: false });
      } catch {
        if (!stopped) setTextState({ page: pageIndex, text: '', error: true });
      }
    })();
    return () => {
      stopped = true;
    };
  }, [pdf, pageIndex]);
  const measure = useCallback(
    (size: { width: number; height: number }) => {
      if (
        !page ||
        Math.abs(size.width - page.width) > 0.5 ||
        Math.abs(size.height - page.height) > 0.5
      ) {
        setGeometryError(true);
        return;
      }
      setMeasuredPage(pageIndex);
    },
    [page, pageIndex],
  );
  const navigate = (index: number) => {
    setMeasuredPage(-1);
    setCommentPage(0);
    setPageIndex(index);
    surface.current?.scrollTo({ top: 0, left: 0 });
  };
  const maxScale = Math.min(
    2,
    8192 / page.width,
    8192 / page.height,
    Math.sqrt(12_000_000 / (page.width * page.height)),
  );
  const fit = Math.min(1.25, Math.max(0.001, (availableWidth - 48) / page.width), maxScale);
  const scale = zoom === 'fit' ? fit : Math.min(zoom, maxScale);
  const ready = pdf && !loading && !error && !geometryError && pdf.numPages === pages.length;
  const renderBudgetExceeded = pageAnnotations.length > 5000;
  const shownComments = comments.slice(commentPage * 25, (commentPage + 1) * 25);
  const text = textState?.page === pageIndex ? textState : null;

  return (
    <div className="review-document">
      <nav className="review-document-toolbar" aria-label="Document controls">
        <div className="review-control-group">
          <button
            className="review-icon"
            aria-label="Previous page"
            disabled={pageIndex === 0}
            onClick={() => navigate(pageIndex - 1)}
          >
            <ChevronLeft size={17} />
          </button>
          <label className="review-page-select">
            Page
            <select
              aria-label="Document page"
              value={pageIndex}
              onChange={(event) => navigate(Number(event.target.value))}
            >
              {pages.map((item) => (
                <option key={item.id} value={item.index}>
                  {item.index + 1}
                </option>
              ))}
            </select>
            <span>of {pages.length}</span>
          </label>
          <button
            className="review-icon"
            aria-label="Next page"
            disabled={pageIndex >= pages.length - 1}
            onClick={() => navigate(pageIndex + 1)}
          >
            <ChevronRight size={17} />
          </button>
        </div>
        <div className="review-control-group">
          <button
            className="review-icon"
            aria-label="Zoom out"
            disabled={scale <= 0.1}
            onClick={() => setZoom(Math.max(0.1, scale - 0.1))}
          >
            <Minus size={15} />
          </button>
          <button
            className="review-fit"
            aria-label={`Fit page width, current zoom ${Math.round(scale * 100)} percent`}
            onClick={() => setZoom('fit')}
          >
            {zoom === 'fit' ? 'Fit width' : `${Math.round(scale * 100)}%`}
          </button>
          <button
            className="review-icon"
            aria-label="Zoom in"
            disabled={scale >= maxScale}
            onClick={() => setZoom(Math.min(maxScale, scale + 0.1))}
          >
            <Plus size={15} />
          </button>
        </div>
        <label className="review-layer-toggle">
          <input
            type="checkbox"
            checked={showAnnotations}
            onChange={(event) => setShowAnnotations(event.target.checked)}
          />
          Student annotations
        </label>
      </nav>
      <div className="review-document-body">
        <div
          className="review-paper-scroll"
          ref={surface}
          tabIndex={0}
          aria-label="Frozen submission document"
        >
          {loading && (
            <p className="review-canvas-message" role="status">
              Opening the preserved PDF…
            </p>
          )}
          {(error || geometryError || (pdf && pdf.numPages !== pages.length)) && (
            <p className="review-canvas-message" role="alert">
              The preserved document could not be displayed safely. Refresh this submission to try
              again.
            </p>
          )}
          {ready && (
            <div
              className="review-sheet-wrap"
              style={{ width: page.width * scale, height: page.height * scale }}
            >
              <div className="review-sheet" key={pageIndex}>
                <PdfCanvas pdf={pdf} pageIndex={pageIndex} scale={scale} onSize={measure} />
                {showAnnotations && measuredPage === pageIndex && !renderBudgetExceeded && (
                  <svg
                    className="review-annotation-layer"
                    width={page.width * scale}
                    height={page.height * scale}
                    viewBox={`0 0 ${page.width} ${page.height}`}
                    aria-hidden="true"
                  >
                    {pageAnnotations.map((annotation) => (
                      <AnnotationGraphic key={annotation.id} annotation={annotation} />
                    ))}
                  </svg>
                )}
              </div>
            </div>
          )}
        </div>
        <aside className="review-inspector" aria-label="Student comments and page text">
          <div className="review-inspector-heading">
            <MessageSquare size={17} />
            <h2>Student comments</h2>
            <span>{comments.length}</span>
          </div>
          <p className="review-small">Page {pageIndex + 1} · captured work</p>
          {renderBudgetExceeded && (
            <p className="review-notice" role="alert">
              This page has more than 5,000 annotations. The annotation layer is too large to
              display here; the preserved submission is unchanged.
            </p>
          )}
          {comments.length ? (
            <>
              <ol className="review-comments" start={commentPage * 25 + 1}>
                {shownComments.map((comment, index) => (
                  <li key={comment.id}>
                    <span className="review-comment-mark">{commentPage * 25 + index + 1}</span>
                    <div>
                      <strong>Student</strong>
                      <p>{comment.text || 'Empty comment'}</p>
                    </div>
                  </li>
                ))}
              </ol>
              {comments.length > 25 && (
                <nav className="review-comment-pages" aria-label="Comment pages">
                  <button
                    disabled={commentPage === 0}
                    onClick={() => setCommentPage((value) => value - 1)}
                  >
                    Previous comments
                  </button>
                  <span>
                    {commentPage + 1} / {Math.ceil(comments.length / 25)}
                  </span>
                  <button
                    disabled={(commentPage + 1) * 25 >= comments.length}
                    onClick={() => setCommentPage((value) => value + 1)}
                  >
                    Next comments
                  </button>
                </nav>
              )}
            </>
          ) : (
            <p className="review-empty-comments">No student comments on this page.</p>
          )}
          <details className="review-transcript">
            <summary>
              <FileText size={16} />
              Page text
            </summary>
            <p>
              {text
                ? text.error
                  ? 'Text could not be read from this page.'
                  : text.text || 'No selectable text in this PDF page.'
                : 'Reading page text…'}
            </p>
          </details>
          {!!annotationText.length && (
            <details className="review-transcript">
              <summary>Student annotation text ({annotationText.length})</summary>
              {annotationText.slice(0, 100).map((annotation) => (
                <p key={annotation.id}>{annotation.text}</p>
              ))}
              {annotationText.length > 100 && (
                <p>Showing the first 100 text annotations on this page.</p>
              )}
            </details>
          )}
          <p className="review-inspector-foot">
            Viewing the captured student layer. Teacher feedback and grading are not available in
            this viewer yet.
          </p>
        </aside>
      </div>
    </div>
  );
}
