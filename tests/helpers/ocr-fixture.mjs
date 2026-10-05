import { PDFDocument, degrees } from 'pdf-lib';
import { readFile } from 'node:fs/promises';

/** Printed synthetic pixels only; no selectable PDF text or recognition stubs. */
export async function createOcrPdfFixture() {
  const pdf = await PDFDocument.create();
  const image = await pdf.embedPng(
    await readFile(new URL('../fixtures/ocr-printed.png', import.meta.url)),
  );
  pdf.addPage([600, 720]).drawImage(image, { x: 0, y: 0, width: 600, height: 720 });
  pdf.addPage([600, 720]);
  const rotated = pdf.addPage([660, 780]);
  rotated.setCropBox(20, 30, 600, 720);
  rotated.setRotation(degrees(180));
  rotated.drawImage(image, { x: 620, y: 750, width: 600, height: 720, rotate: degrees(180) });
  return Buffer.from(await pdf.save());
}
