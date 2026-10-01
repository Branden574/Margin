import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { PDFArray, PDFDocument, PDFRawStream, decodePDFRawStream } from 'pdf-lib';
import { openDB } from 'idb';
import type { Annotation, DocumentRecord } from '@margin/core';
import { AnnotationGraphic } from '../apps/web/src/editor/AnnotationLayer';
import {
  annotationPaths,
  bounds,
  hitTest,
  movedAnnotation,
  remapAnnotations,
  rotateAnnotation,
} from '../apps/web/src/editor/model';
import { exportAnnotatedPdf, transformPage } from '../apps/web/src/editor/pdf';
import {
  createVault,
  decryptExport,
  encryptExport,
  lockVault,
  unlockVault,
  VAULT_DATABASE,
  vaultStatus,
} from '../apps/web/src/lib/vault';
import {
  appendAnnotationOperation,
  loadAnnotations,
  saveDocumentWithBlob,
} from '../apps/web/src/lib/storage';
const passphrase = 'editor-annotation-test-passphrase';
const make = (partial: Partial<Annotation>): Annotation => ({
  id: crypto.randomUUID(),
  pageIndex: 0,
  type: 'arrow',
  x: 50,
  y: 70,
  color: '#292925',
  strokeWidth: 2,
  opacity: 1,
  createdAt: 1,
  author: 'You',
  ...partial,
});
const arrow = () =>
  make({
    type: 'arrow',
    points: [
      { x: 50, y: 70 },
      { x: 170, y: 70 },
    ],
    lineStyle: 'dashed',
  });
const signature = () =>
  make({
    type: 'signature',
    strokes: [
      [
        { x: 30, y: 30 },
        { x: 80, y: 60 },
      ],
      [
        { x: 35, y: 100 },
        { x: 90, y: 110 },
      ],
    ],
  });
async function fixture() {
  const pdf = await PDFDocument.create();
  pdf.addPage([400, 600]);
  return new Blob([(await pdf.save()) as BlobPart], { type: 'application/pdf' });
}
function content(pdf: PDFDocument) {
  const streams = pdf.getPage(0).node.Contents();
  if (!(streams instanceof PDFArray)) throw new Error('Missing PDF content');
  return Array.from({ length: streams.size() }, (_, i) =>
    Buffer.from(
      decodePDFRawStream(pdf.context.lookup(streams.get(i), PDFRawStream)).decode(),
    ).toString(),
  ).join('\n');
}
afterEach(async () => {
  await lockVault();
});
describe('real arrow, stamp and signature geometry', () => {
  it('draws and hit-tests arrowheads in every direction without accepting distant empty regions', () => {
    for (const end of [
      { x: 170, y: 70 },
      { x: 50, y: 190 },
      { x: -70, y: 70 },
      { x: 50, y: -50 },
    ]) {
      const item = make({ type: 'arrow', points: [{ x: 50, y: 70 }, end] });
      const paths = annotationPaths(item);
      expect(paths).toHaveLength(2);
      expect(paths[1][1]).toEqual(end);
      expect(hitTest(item, paths[1][0], 1)).toBe(true);
      expect(hitTest(item, { x: 300, y: 300 })).toBe(false);
      const extent = bounds(item);
      for (const p of paths.flat()) {
        expect(p.x).toBeGreaterThanOrEqual(extent.x);
        expect(p.y).toBeGreaterThanOrEqual(extent.y);
      }
    }
    expect(
      annotationPaths(
        make({
          type: 'arrow',
          points: [
            { x: 1, y: 1 },
            { x: 1, y: 1 },
          ],
        }),
      ),
    ).toHaveLength(1);
  });
  it('keeps signature pen lifts separate through move, rotation and page duplication', () => {
    const original = signature(),
      moved = movedAnnotation(original, 10, 20);
    expect(moved.strokes?.[1][0]).toEqual({ x: 45, y: 120 });
    expect(original.strokes?.[1][0]).toEqual({ x: 35, y: 100 });
    expect(hitTest(original, { x: 82, y: 82 }, 1)).toBe(false);
    const rotated = rotateAnnotation(original, 600);
    expect(rotated.strokes?.[0][0]).toEqual({ x: 570, y: 30 });
    const duplicated = remapAnnotations([original], 'duplicate', 0, 600);
    expect(duplicated).toHaveLength(2);
    expect(duplicated[1].id).not.toBe(original.id);
    expect(duplicated[1].strokes).toEqual(original.strokes);
  });
  it('rotates typed signatures and stamp boxes as a single visual object', () => {
    for (const type of ['signature', 'stamp'] as const) {
      const original = make({ type, text: 'REVIEWED', width: 140, height: 36 });
      const result = rotateAnnotation(original, 600);
      expect(result).toMatchObject({ x: 530, y: 50, rotation: 90, width: 140, height: 36 });
      expect(bounds(result)).toMatchObject({ x: 494, y: 50, width: 36, height: 140 });
    }
  });
  it('uses separate SVG paths for pen lifts and a solid arrowhead alongside a dashed shaft', () => {
    const arrowSvg = renderToStaticMarkup(
      createElement(AnnotationGraphic, { annotation: arrow() }),
    );
    expect(arrowSvg.match(/<path /g)).toHaveLength(2);
    expect(arrowSvg.match(/stroke-dasharray=/g)).toHaveLength(1);
    const signatureSvg = renderToStaticMarkup(
      createElement(AnnotationGraphic, { annotation: signature() }),
    );
    expect(signatureSvg.match(/<path /g)).toHaveLength(2);
    const typed = renderToStaticMarkup(
      createElement(AnnotationGraphic, {
        annotation: make({
          type: 'signature',
          text: 'Alex Rivera',
          fontSize: 28,
          width: 150,
          height: 36,
        }),
      }),
    );
    expect(typed).toContain('font-style="italic"');
    expect(typed).toContain('Alex Rivera');
  });
});
describe('annotation persistence and encrypted export', () => {
  it('retains new annotation payloads through encrypted storage, delete/replay and vault relock', async () => {
    await vaultStatus();
    const db = await openDB(VAULT_DATABASE, 1);
    await db.clear('public');
    await db.clear('records');
    db.close();
    await createVault(passphrase);
    const blob = await fixture();
    const record: DocumentRecord = {
      id: 'annotations-roundtrip',
      name: 'Private signatures',
      mimeType: 'application/pdf',
      size: blob.size,
      pageCount: 1,
      createdAt: 1,
      updatedAt: 1,
      folderId: null,
      starred: false,
      trashed: false,
      cover: 'blank',
      source: 'created',
    };
    await saveDocumentWithBlob(record, blob);
    const items = [
      arrow(),
      signature(),
      make({
        type: 'signature',
        text: 'Private Alex Rivera',
        fontSize: 28,
        width: 210,
        height: 36,
      }),
      make({ type: 'stamp', text: 'REVIEWED', width: 140, height: 36 }),
    ];
    for (const [i, item] of items.entries())
      await appendAnnotationOperation({
        id: crypto.randomUUID(),
        documentId: record.id,
        timestamp: 10 + i,
        kind: 'put',
        annotationId: item.id,
        annotation: item,
      });
    await appendAnnotationOperation({
      id: crypto.randomUUID(),
      documentId: record.id,
      timestamp: 20,
      kind: 'delete',
      annotationId: items[0].id,
    });
    expect(await loadAnnotations(record.id)).toHaveLength(3);
    await appendAnnotationOperation({
      id: crypto.randomUUID(),
      documentId: record.id,
      timestamp: 21,
      kind: 'put',
      annotationId: items[0].id,
      annotation: items[0],
    });
    const stored = await openDB(VAULT_DATABASE, 1);
    expect(JSON.stringify(await stored.getAll('records'))).not.toContain('Private Alex Rivera');
    stored.close();
    await lockVault();
    await unlockVault(passphrase);
    const restored = await loadAnnotations(record.id);
    for (const item of items) expect(restored.find((a) => a.id === item.id)).toEqual(item);
    const flattened = await exportAnnotatedPdf(blob, restored, [
      { pageIndex: 0, transform: [1, 0, 0, -1, 0, 600] },
    ]);
    const encrypted = await encryptExport(flattened, {
      name: 'Private signatures.pdf',
      mimeType: 'application/pdf',
    });
    expect(await encrypted.slice(0, 4).text()).not.toBe('%PDF');
    expect(await encrypted.text()).not.toContain('Private Alex Rivera');
    const decrypted = await decryptExport(encrypted, passphrase);
    expect(new Uint8Array(await decrypted.blob.arrayBuffer())).toEqual(
      new Uint8Array(await flattened.arrayBuffer()),
    );
    const pdf = await PDFDocument.load(await decrypted.blob.arrayBuffer()),
      stream = content(pdf);
    expect(stream).toContain('[6 4] 0 d');
    expect(stream).toContain('30 -570 m');
    expect(stream).toContain('35 -500 m');
    expect(stream).not.toContain('35 -500 l');
    expect(stream).toContain('<5245564945574544>');
    expect(stream).toContain(Buffer.from('Private Alex Rivera').toString('hex').toUpperCase());
    expect(pdf.getPage(0).node.Resources()?.toString()).toContain('Times-Italic');
  });
  it.each(['line', 'ellipse', 'rectangle'] as const)(
    'renders visible round dots for %s in both the SVG preview and PDF export',
    async (type) => {
      const item = make({
        type,
        lineStyle: 'dotted',
        width: 140,
        height: 80,
        points:
          type === 'line'
            ? [
                { x: 20, y: 30 },
                { x: 160, y: 30 },
              ]
            : undefined,
      });
      const svg = renderToStaticMarkup(createElement(AnnotationGraphic, { annotation: item }));
      expect(svg).toContain('stroke-dasharray="0.1 4"');
      // Tiny dash segments need round caps to paint dots with the intended stroke diameter.
      // Butt caps leave nearly invisible 0.1-unit slivers even at a two-unit stroke width.
      expect(svg).toContain('stroke-linecap="round"');
      expect(svg).toContain('stroke-width="2"');
      const output = await exportAnnotatedPdf(
        await fixture(),
        [item],
        [{ pageIndex: 0, transform: [1, 0, 0, -1, 0, 600] }],
      );
      const stream = content(await PDFDocument.load(await output.arrayBuffer()));
      expect(stream).toContain('[0.1 4] 0 d');
      expect(stream).toContain('2 w');
      expect(stream).toContain('1 J');
    },
  );
  it('exports arrowhead geometry and uninterrupted dash patterns after rotation', async () => {
    const item = arrow();
    const blob = await transformPage(await fixture(), 'rotate', 0);
    const rotated = rotateAnnotation(item, 600);
    const output = await exportAnnotatedPdf(
      blob,
      [rotated],
      [{ pageIndex: 0, transform: [0, 1, 1, 0, 0, 0] }],
    );
    const stream = content(await PDFDocument.load(await output.arrayBuffer()));
    expect(stream).toContain('[6 4] 0 d');
    expect((stream.match(/\nS\n/g) || []).length).toBeGreaterThanOrEqual(2);
    expect(stream).toContain('50 -530 m');
    expect(stream).toContain('170 -530 l');
  });
});
