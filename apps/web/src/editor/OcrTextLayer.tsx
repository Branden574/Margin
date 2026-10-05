import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import type { OcrPageRecord } from '@margin/core';
import { pdfQuadToRect } from './ocrPage';
export interface OcrSelection {
  start: number;
  end: number;
}
export function OcrTextLayer({
  pdf,
  record,
  zoom,
  onSelection,
}: {
  pdf: PDFDocumentProxy;
  record: OcrPageRecord;
  zoom: number;
  onSelection: (selection: OcrSelection | null) => void;
}) {
  const root = useRef<HTMLDivElement>(null);
  const keyboard = useRef({ anchor: 0, focus: 0 });
  const widths = useMemo(() => {
    const canvas = document.createElement('canvas'),
      context = canvas.getContext('2d');
    if (context) context.font = '100px Arial, sans-serif';
    return record.words.map(
      (word) => context?.measureText(record.text.slice(word.start, word.end)).width || 1,
    );
  }, [record]);
  const [geometry, setGeometry] = useState<{
    pdf: PDFDocumentProxy;
    record: OcrPageRecord;
    transform: number[];
  } | null>(null);
  useEffect(() => {
    let active = true;
    keyboard.current = { anchor: 0, focus: 0 };
    void pdf.getPage(record.pageIndex + 1).then(
      (page) => {
        if (active)
          setGeometry({ pdf, record, transform: page.getViewport({ scale: 1 }).transform });
      },
      () => {},
    );
    return () => {
      active = false;
    };
  }, [pdf, record]);
  const current = geometry?.pdf === pdf && geometry.record === record ? geometry : null;
  function capture() {
    const selection = window.getSelection(),
      layer = root.current;
    if (
      !selection ||
      !layer ||
      !selection.rangeCount ||
      selection.isCollapsed ||
      !layer.contains(selection.anchorNode) ||
      !layer.contains(selection.focusNode)
    ) {
      onSelection(null);
      return;
    }
    const range = selection.getRangeAt(0);
    const words = [...layer.querySelectorAll<HTMLElement>('[data-ocr-word]')].filter((node) =>
      range.intersectsNode(node),
    );
    if (!words.length) {
      onSelection(null);
      return;
    }
    onSelection({
      start: Number(words[0].dataset.ocrWord),
      end: Number(words.at(-1)!.dataset.ocrWord) + 1,
    });
    keyboard.current = {
      anchor: Number(words[0].dataset.ocrWord),
      focus: Number(words.at(-1)!.dataset.ocrWord) + 1,
    };
  }
  function selectWithKeyboard(event: KeyboardEvent<HTMLDivElement>) {
    if (
      !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key) ||
      event.metaKey ||
      event.ctrlKey ||
      event.altKey
    )
      return;
    event.preventDefault();
    event.stopPropagation();
    const previous = keyboard.current;
    const focus =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? record.words.length
          : Math.max(
              0,
              Math.min(record.words.length, previous.focus + (event.key === 'ArrowRight' ? 1 : -1)),
            );
    const anchor = event.shiftKey
      ? Math.max(0, Math.min(record.words.length, previous.anchor))
      : focus;
    keyboard.current = { anchor, focus };
    const nodes = root.current?.querySelectorAll<HTMLElement>('[data-ocr-word]');
    const selection = window.getSelection();
    if (!nodes?.length || !selection) return;
    const boundary = (index: number) =>
      index === nodes.length
        ? {
            node: nodes[index - 1].lastChild!,
            offset: nodes[index - 1].lastChild!.textContent!.length,
          }
        : { node: nodes[index].firstChild!, offset: 0 };
    const a = boundary(anchor),
      b = boundary(focus);
    selection.setBaseAndExtent(a.node, a.offset, b.node, b.offset);
    onSelection(
      anchor === focus ? null : { start: Math.min(anchor, focus), end: Math.max(anchor, focus) },
    );
    nodes[Math.min(focus, nodes.length - 1)].scrollIntoView({
      block: 'nearest',
      inline: 'nearest',
    });
  }
  return current ? (
    <div
      ref={root}
      className="ocr-text-layer"
      role="region"
      aria-label="Selectable recognized text"
      tabIndex={0}
      onPointerUp={capture}
      onKeyDown={selectWithKeyboard}
    >
      {record.words.map((word, index) => {
        const rect = pdfQuadToRect(word.quad, current.transform);
        const scaleX = rect.width / Math.max(0.01, (widths[index] * rect.height) / 100);
        return (
          <span
            key={index}
            data-ocr-word={index}
            style={{
              left: rect.x * zoom,
              top: rect.y * zoom,
              width: (rect.width * zoom) / scaleX,
              height: rect.height * zoom,
              fontSize: rect.height * zoom,
              lineHeight: `${rect.height * zoom}px`,
              transform: `scaleX(${scaleX})`,
            }}
          >
            {`${record.text.slice(word.start, word.end)} `}
          </span>
        );
      })}
    </div>
  ) : null;
}
