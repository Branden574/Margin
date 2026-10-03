import { PDFDocument, StandardFonts, LineCapStyle, degrees, rgb } from 'pdf-lib';
import { auditPdfForEditing, loadEditablePdf } from './forms';
import type { Annotation } from '@margin/core';
import { annotationPaths, dashPattern, pathData, textLike, type PageAction } from './model';

export async function transformPage(blob: Blob, action: PageAction, index: number): Promise<Blob> {
  const pdf = await loadEditablePdf(blob);
  const { hasFields } = auditPdfForEditing(pdf);
  if (hasFields && action !== 'rotate' && action !== 'insert')
    throw new Error(
      'Copying, reordering, or deleting pages with form fields is not supported yet. Your original PDF is unchanged.',
    );
  const page = pdf.getPage(index);
  if (action === 'rotate') page.setRotation(degrees((page.getRotation().angle + 90) % 360));
  if (action === 'duplicate') {
    const [copy] = await pdf.copyPages(pdf, [index]);
    pdf.insertPage(index + 1, copy);
  }
  if (action === 'insert') pdf.insertPage(index + 1, [page.getWidth(), page.getHeight()]);
  if (action === 'delete') {
    if (pdf.getPageCount() === 1) throw new Error('A document needs at least one page.');
    pdf.removePage(index);
  }
  if (action === 'earlier' || action === 'later') {
    const next = index + (action === 'earlier' ? -1 : 1);
    if (next < 0 || next >= pdf.getPageCount())
      throw new Error('This page is already at the edge of the document.');
    const [copy] = await pdf.copyPages(pdf, [index]);
    pdf.removePage(index);
    pdf.insertPage(next, copy);
  }
  const bytes = await pdf.save({ updateFieldAppearances: false });
  return new Blob([bytes as BlobPart], { type: 'application/pdf' });
}
const color = (hex: string) =>
  rgb(
    parseInt(hex.slice(1, 3), 16) / 255,
    parseInt(hex.slice(3, 5), 16) / 255,
    parseInt(hex.slice(5, 7), 16) / 255,
  );
export interface ExportPageView {
  pageIndex: number;
  transform: number[];
}
async function rasterText(
  text: string,
  size: number,
  ink: string,
  face = 'sans-serif',
  style = '',
) {
  const canvas = new OffscreenCanvas(1, 1),
    context = canvas.getContext('2d');
  if (!context) throw new Error('This browser cannot export Unicode text.');
  context.font = `${style} ${size * 2}px ${face}`.trim();
  canvas.width = Math.ceil(context.measureText(text).width) + 8;
  canvas.height = size * 2 + 16;
  context.font = `${style} ${size * 2}px ${face}`.trim();
  context.fillStyle = ink;
  context.fillText(text, 0, size * 2 + 2);
  return {
    data: new Uint8Array(await (await canvas.convertToBlob({ type: 'image/png' })).arrayBuffer()),
    width: canvas.width / 2,
    height: canvas.height / 2,
  };
}
export async function exportAnnotatedPdf(
  blob: Blob,
  annotations: Annotation[],
  views: ExportPageView[],
): Promise<Blob> {
  const pdf = await loadEditablePdf(blob);
  auditPdfForEditing(pdf);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const signatureFont = annotations.some((a) => a.type === 'signature' && a.text)
    ? await pdf.embedFont(StandardFonts.TimesRomanItalic)
    : font;
  const stampFont = annotations.some((a) => a.type === 'stamp')
    ? await pdf.embedFont(StandardFonts.HelveticaBold)
    : font;
  const comments = annotations.filter((a) => a.type === 'comment');
  for (const index of new Set(annotations.map((a) => a.pageIndex))) {
    const page = pdf.getPage(index),
      view = views.find((item) => item.pageIndex === index);
    if (!view) throw new Error(`Page ${index + 1} was not prepared for export.`);
    const [a, b, c, d, e, f] = view.transform,
      det = a * d - b * c;
    const xy = (x: number, y: number) => ({
      x: (d * (x - e) - c * (y - f)) / det,
      y: (a * (y - f) - b * (x - e)) / det,
    });
    const pageRotation = page.getRotation().angle;
    for (const a of annotations.filter((item) => item.pageIndex === index)) {
      const ink = color(a.color),
        width = a.width ?? 160,
        height = a.height ?? 24;
      if (textLike(a)) {
        const isSignature = a.type === 'signature',
          isStamp = a.type === 'stamp';
        const textFont = isSignature ? signatureFont : isStamp ? stampFont : font;
        const textSize = isSignature ? (a.fontSize ?? 28) : isStamp ? 12 : 16;
        const angle = a.rotation ?? 0,
          rad = (angle * Math.PI) / 180;
        if (isStamp)
          page.drawRectangle({
            ...xy(a.x - Math.sin(rad) * height, a.y + Math.cos(rad) * height),
            width,
            height,
            rotate: degrees(pageRotation - angle),
            borderColor: ink,
            borderWidth: a.strokeWidth,
            borderOpacity: a.opacity,
          });
        const lines = (a.text ?? '').split('\n');
        for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
          const line = lines[lineIndex],
            offset = (isStamp ? 24 : textSize) + lineIndex * (textSize + 5);
          const textX = a.x + Math.cos(rad) * (isStamp ? 10 : 0),
            textY = a.y + Math.sin(rad) * (isStamp ? 10 : 0);
          const origin = xy(textX - Math.sin(rad) * offset, textY + Math.cos(rad) * offset);
          try {
            textFont.encodeText(line);
            page.drawText(line, {
              ...origin,
              font: textFont,
              size: textSize,
              opacity: a.opacity,
              color: ink,
              rotate: degrees(pageRotation - angle),
            });
          } catch {
            const raster = await rasterText(
                line,
                textSize,
                a.color,
                isSignature ? '"Times New Roman", serif' : 'sans-serif',
                isSignature ? 'italic' : isStamp ? 'bold' : '',
              ),
              png = await pdf.embedPng(raster.data);
            const pos = xy(
              textX - Math.sin(rad) * (offset + 5),
              textY + Math.cos(rad) * (offset + 5),
            );
            page.drawImage(png, {
              ...pos,
              width: raster.width,
              height: raster.height,
              opacity: a.opacity,
              rotate: degrees(pageRotation - angle),
            });
          }
        }
      } else if (a.type === 'comment') {
        const center = xy(a.x + 11, a.y + 11);
        page.drawCircle({ ...center, size: 11, color: ink });
        page.drawText(String(comments.findIndex((comment) => comment.id === a.id) + 1), {
          ...xy(a.x + 7, a.y + 16),
          size: 11,
          font,
          color: rgb(1, 1, 1),
          rotate: degrees(pageRotation),
        });
      } else if (annotationPaths(a).length) {
        for (const [pathIndex, points] of annotationPaths(a).entries()) {
          if (points.length > 1)
            page.drawSvgPath(
              pathData(
                points.map((point) => {
                  const pos = xy(point.x, point.y);
                  return { x: pos.x, y: -pos.y };
                }),
              ),
              {
                x: 0,
                y: 0,
                scale: 1,
                borderColor: ink,
                borderWidth: a.strokeWidth,
                borderOpacity: a.opacity,
                borderLineCap: LineCapStyle.Round,
                borderDashArray: a.type === 'arrow' && pathIndex > 0 ? undefined : dashPattern(a),
              },
            );
          if (points.length === 1)
            page.drawCircle({
              ...xy(points[0].x, points[0].y),
              size: a.strokeWidth / 2,
              color: ink,
              opacity: a.opacity,
            });
        }
      } else if (a.type === 'ellipse') {
        page.drawEllipse({
          ...xy(a.x + width / 2, a.y + height / 2),
          xScale: width / 2,
          yScale: height / 2,
          borderColor: ink,
          borderWidth: a.strokeWidth,
          borderLineCap: LineCapStyle.Round,
          borderDashArray: dashPattern(a),
          borderOpacity: a.opacity,
          rotate: degrees(pageRotation),
          opacity: a.opacity,
        });
      } else {
        page.drawRectangle({
          ...xy(a.x, a.y + height),
          width,
          height,
          rotate: degrees(pageRotation),
          ...(a.type === 'highlight'
            ? { color: ink, opacity: a.opacity }
            : {
                borderColor: ink,
                borderWidth: a.strokeWidth,
                borderLineCap: LineCapStyle.Round,
                borderDashArray: dashPattern(a),
                borderOpacity: a.opacity,
                opacity: a.opacity,
              }),
        });
      }
    }
  }
  if (comments.length) {
    // Full comments travel with an export, without covering the underlying worksheet.
    let notesPage = pdf.addPage([612, 792]),
      y = 737;
    const heading = () => {
      notesPage.drawText('Document notes', {
        x: 48,
        y: 744,
        font,
        size: 20,
        color: rgb(0.16, 0.16, 0.14),
      });
      y = 710;
    };
    heading();
    for (const [index, comment] of comments.entries()) {
      if (y < 110) {
        notesPage = pdf.addPage([612, 792]);
        heading();
      }
      notesPage.drawText(`${index + 1}. Page ${comment.pageIndex + 1}`, {
        x: 48,
        y,
        font,
        size: 12,
        color: color(comment.color),
      });
      y -= 23;
      for (const paragraph of (comment.text ?? '').split('\n')) {
        const words = paragraph.split(/\s+/),
          rows: string[] = [];
        let row = '';
        for (const word of words) {
          if ((row + ' ' + word).length > 82 && row) {
            rows.push(row);
            row = '';
          }
          if (word.length > 82) {
            if (row) {
              rows.push(row);
              row = '';
            }
            for (let i = 0; i < word.length; i += 82) rows.push(word.slice(i, i + 82));
          } else row += (row ? ' ' : '') + word;
        }
        if (row || !rows.length) rows.push(row);
        for (const line of rows) {
          if (y < 55) {
            notesPage = pdf.addPage([612, 792]);
            heading();
          }
          try {
            font.encodeText(line);
            notesPage.drawText(line, { x: 48, y, font, size: 11, color: rgb(0.25, 0.26, 0.23) });
          } catch {
            const raster = await rasterText(line, 11, '#40433b'),
              png = await pdf.embedPng(raster.data);
            notesPage.drawImage(png, {
              x: 48,
              y: y - 4,
              width: raster.width,
              height: raster.height,
            });
          }
          y -= 17;
        }
      }
      y -= 22;
    }
  }
  const bytes = await pdf.save({ updateFieldAppearances: false });
  return new Blob([bytes as BlobPart], { type: 'application/pdf' });
}
export function downloadBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob),
    anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

export async function mergePdf(
  original: Blob,
  incoming: Blob,
): Promise<{ blob: Blob; pageCount: number }> {
  const target = await loadEditablePdf(original),
    extra = await loadEditablePdf(incoming);
  const targetForm = auditPdfForEditing(target),
    extraForm = auditPdfForEditing(extra);
  if (targetForm.hasFields || extraForm.hasFields)
    throw new Error(
      'Merging PDFs with form fields is not supported yet. Your original PDFs are unchanged.',
    );
  for (const page of await target.copyPages(extra, extra.getPageIndices())) target.addPage(page);
  return {
    blob: new Blob([(await target.save()) as BlobPart], { type: 'application/pdf' }),
    pageCount: target.getPageCount(),
  };
}
export async function extractPdfPage(
  blob: Blob,
  index: number,
  appendixStart?: number,
): Promise<Blob> {
  const source = await loadEditablePdf(blob),
    result = await PDFDocument.create();
  if (auditPdfForEditing(source).hasFields)
    throw new Error(
      'Extracting pages with form fields is not supported yet. Your original PDF is unchanged.',
    );
  const indices = [
    index,
    ...(appendixStart === undefined
      ? []
      : source.getPageIndices().filter((i) => i >= appendixStart)),
  ];
  for (const page of await result.copyPages(source, indices)) result.addPage(page);
  return new Blob([(await result.save()) as BlobPart], { type: 'application/pdf' });
}
