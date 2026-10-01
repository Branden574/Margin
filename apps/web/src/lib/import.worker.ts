import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

export const MAX_IMPORT_BYTES = 100 * 1024 * 1024;
export type ImportKind = 'pdf' | 'png' | 'jpeg';
export type ImportTask = { kind: 'import'; file: File } | { kind: 'blank'; title: string };
export interface ImportResult {
  blob: Blob;
  pageCount: number;
}

export function detectFileKind(bytes: Uint8Array): ImportKind | undefined {
  if (
    bytes.length >= 5 &&
    bytes[0] === 0x25 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x44 &&
    bytes[3] === 0x46 &&
    bytes[4] === 0x2d
  )
    return 'pdf';
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  )
    return 'png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)
    return 'jpeg';
  return undefined;
}
function pdfBlob(bytes: Uint8Array): Blob {
  return new Blob([new Uint8Array(bytes)], { type: 'application/pdf' });
}

/** Browsers invoke this processor in a module worker; Node tests exercise the same implementation. */
export async function processImportTask(
  task: ImportTask,
  progress: (value: number) => void = () => undefined,
): Promise<ImportResult> {
  if (task.kind === 'blank') {
    const pdf = await PDFDocument.create();
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    const page = pdf.addPage([612, 792]);
    page.drawLine({
      start: { x: 48, y: 740 },
      end: { x: 564, y: 740 },
      color: rgb(0.88, 0.9, 0.88),
      thickness: 0.5,
    });
    page.drawText('MARGIN', { x: 48, y: 754, size: 8, font, color: rgb(0.5, 0.54, 0.5) });
    page.drawText('1', { x: 555, y: 32, size: 8, font, color: rgb(0.5, 0.54, 0.5) });
    pdf.setTitle(task.title);
    return { blob: pdfBlob(await pdf.save()), pageCount: 1 };
  }
  const { file } = task;
  if (file.size === 0)
    throw new Error('This file is empty. Choose a PDF, PNG, or JPEG with content.');
  if (file.size > MAX_IMPORT_BYTES)
    throw new Error(
      'This file is larger than the 100 MB import limit. Please choose a smaller document.',
    );
  const header = new Uint8Array(await file.slice(0, 16).arrayBuffer());
  const kind = detectFileKind(header);
  if (!kind)
    throw new Error(
      'This file is not a supported PDF, PNG, or JPEG. Renaming its extension will not convert it.',
    );
  const expectedExtensions = kind === 'pdf' ? /\.pdf$/i : kind === 'png' ? /\.png$/i : /\.jpe?g$/i;
  const expectedMime =
    kind === 'pdf' ? 'application/pdf' : kind === 'png' ? 'image/png' : 'image/jpeg';
  if (!expectedExtensions.test(file.name))
    throw new Error(
      'The filename extension does not match the detected file content. Use a correctly exported PDF, PNG, or JPEG.',
    );
  if (file.type && file.type !== expectedMime && file.type !== 'application/octet-stream')
    throw new Error(
      'The declared file type does not match the detected content. Export the file again before importing.',
    );
  if (kind === 'png') {
    const header = new DataView(await file.slice(0, 24).arrayBuffer());
    if (header.byteLength < 24 || header.getUint32(16) * header.getUint32(20) > 24_000_000)
      throw new Error(
        'This image exceeds the 24 megapixel processing limit. Resize it before importing.',
      );
  }
  progress(15);
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (kind === 'pdf') {
    let pdf: PDFDocument;
    try {
      pdf = await PDFDocument.load(bytes, { updateMetadata: false });
    } catch (error) {
      if (error instanceof Error && /encrypt|password/i.test(error.message))
        throw new Error(
          'This PDF is password protected. Save an unlocked copy, then import it again.',
        );
      throw new Error('This PDF could not be opened. It may be damaged or incomplete.');
    }
    const pageCount = pdf.getPageCount();
    if (pageCount > 2000)
      throw new Error(
        'This PDF exceeds the 2,000 page processing limit. Split it into smaller files.',
      );
    if (pageCount === 0)
      throw new Error('This PDF has no pages. Choose a PDF with at least one page.');
    progress(75);
    return { blob: pdfBlob(bytes), pageCount };
  }
  const pdf = await PDFDocument.create();
  try {
    const embedded = kind === 'png' ? await pdf.embedPng(bytes) : await pdf.embedJpg(bytes);
    if (embedded.width * embedded.height > 24_000_000)
      throw new Error('Image dimensions exceed the processing limit.');
    const scale = Math.min(1, 14400 / Math.max(embedded.width, embedded.height));
    const width = Math.max(1, embedded.width * scale);
    const height = Math.max(1, embedded.height * scale);
    pdf.addPage([width, height]).drawImage(embedded, { x: 0, y: 0, width, height });
  } catch {
    throw new Error('This image could not be opened. Try exporting it as a standard PNG or JPEG.');
  }
  pdf.setTitle(file.name.replace(/\.(png|jpe?g)$/i, '').trim() || 'Untitled document');
  pdf.setProducer('Margin image import');
  const blob = pdfBlob(await pdf.save());
  progress(75);
  return { blob, pageCount: 1 };
}

const workerScope = globalThis as typeof globalThis & {
  document?: unknown;
  postMessage?: (value: unknown) => void;
  onmessage?: ((event: MessageEvent<{ id: string; task: ImportTask }>) => void) | null;
};
if (typeof workerScope.document === 'undefined' && typeof workerScope.postMessage === 'function') {
  workerScope.onmessage = (event) => {
    const { id, task } = event.data;
    void processImportTask(task, (progress) => workerScope.postMessage!({ id, progress })).then(
      (result) => workerScope.postMessage!({ id, result }),
      (error) =>
        workerScope.postMessage!({
          id,
          error: error instanceof Error ? error.message : 'The file could not be processed.',
        }),
    );
  };
}
