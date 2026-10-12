import { deflateSync } from 'node:zlib';

/** Generated, nonsecret PDF fixtures; never copied from a user's workspace. */
export function pdfStream(bytes: Buffer, dictionary = ''): Buffer {
  return Buffer.concat([
    Buffer.from(`<< ${dictionary} /Length ${bytes.length} >>\nstream\n`),
    bytes,
    Buffer.from('\nendstream'),
  ]);
}
export function pdfObjects(objects: Array<string | Buffer>): Buffer {
  const chunks: Buffer[] = [Buffer.from('%PDF-1.7\n%\x80\x81\x82\x83\n', 'latin1')];
  const offsets = [0];
  let length = chunks[0].length;
  for (let i = 0; i < objects.length; i++) {
    offsets.push(length);
    const object = objects[i];
    const chunk = Buffer.concat([
      Buffer.from(`${i + 1} 0 obj\n`),
      Buffer.isBuffer(object) ? object : Buffer.from(object),
      Buffer.from('\nendobj\n'),
    ]);
    chunks.push(chunk);
    length += chunk.length;
  }
  chunks.push(
    Buffer.from(
      `xref\n0 ${offsets.length}\n0000000000 65535 f \n` +
        offsets
          .slice(1)
          .map((n) => `${String(n).padStart(10, '0')} 00000 n \n`)
          .join('') +
        `trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${length}\n%%EOF\n`,
    ),
  );
  return Buffer.concat(chunks);
}
export function sourceObjects(
  options: {
    catalog?: string;
    page?: string;
    content?: Buffer;
    extra?: Array<string | Buffer>;
  } = {},
): Array<string | Buffer> {
  return [
    `<< /Type /Catalog /Pages 2 0 R ${options.catalog ?? ''} >>`,
    '<< /Type /Pages /Count 1 /Kids [3 0 R] >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R ${options.page ?? ''} >>`,
    pdfStream(options.content ?? Buffer.from('BT /F1 12 Tf 40 700 Td (Known fixture) Tj ET')),
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    ...(options.extra ?? []),
  ];
}
export const benignPdf = () => pdfObjects(sourceObjects());
export const geometryPdf = () =>
  pdfObjects(
    sourceObjects({
      page: '/CropBox [20 30 500 700] /Rotate 90 /UserUnit 2',
    }),
  );
export const activePdf = (escaped = false) =>
  pdfObjects(
    sourceObjects({
      catalog: `${escaped ? '/Open#41ction' : '/OpenAction'} 6 0 R`,
      extra: ['<< /S /Java#53cript /JS (app.alert\\(secret-fixture\\)) >>'],
    }),
  );
export const externalLinkPdf = () =>
  pdfObjects(
    sourceObjects({
      page: '/Annots [6 0 R]',
      extra: [
        '<< /Type /Annot /Subtype /Link /Rect [0 0 10 10] /A << /S /URI /URI (https://fixture.invalid/private) >> >>',
      ],
    }),
  );
export const embeddedPdf = () =>
  pdfObjects(
    sourceObjects({
      catalog: '/Names << /EmbeddedFiles << /Names [(fixture) 6 0 R] >> >>',
      extra: [
        '<< /Type /Filespec /F (fixture.txt) /EF << /F 7 0 R >> >>',
        pdfStream(Buffer.from('only fixture data'), '/Type /EmbeddedFile'),
      ],
    }),
  );
export const xfaPdf = () =>
  pdfObjects(
    sourceObjects({
      catalog: '/AcroForm << /Fields [] /XFA 6 0 R >>',
      extra: [pdfStream(Buffer.from('<fixture/>'))],
    }),
  );
export const inlineImagePdf = () =>
  pdfObjects(
    sourceObjects({
      content: Buffer.from('q BI /W 1 /H 1 /CS /RGB /BPC 8 ID abc EI Q'),
    }),
  );
export const deepPdf = () =>
  pdfObjects(
    sourceObjects({
      catalog: '/Fixture ' + '['.repeat(90) + '0' + ']'.repeat(90),
    }),
  );
export const filterBombPdf = () =>
  pdfObjects(
    sourceObjects({
      extra: [pdfStream(Buffer.from('00>'), '/Filter [' + '/ASCIIHexDecode '.repeat(9) + ']')],
    }),
  );
export function decodedBombPdf(): Buffer {
  // Each stream stays below 64MiB; their aggregate crosses 256MiB.
  const encoded = deflateSync(Buffer.alloc(56 * 1024 * 1024, 32));
  return pdfObjects(
    sourceObjects({
      extra: Array.from({ length: 5 }, () => pdfStream(encoded, '/Filter /FlateDecode')),
    }),
  );
}
export function predictorBombPdf(): Buffer {
  // 28MiB post-PNG output per stream, 56MiB pre-predictor inflation. Four
  // streams cross the aggregate work limit although their final output does not.
  const encoded = deflateSync(Buffer.alloc(56 * 1024 * 1024));
  return pdfObjects(
    sourceObjects({
      extra: Array.from({ length: 4 }, () =>
        pdfStream(
          encoded,
          '/Filter /FlateDecode /DecodeParms << /Predictor 12 /Columns 1 /Colors 1 /BitsPerComponent 8 >>',
        ),
      ),
    }),
  );
}
export function objectStreamBombPdf(
  filter = '/FlateDecode',
  decodedSize = 56 * 1024 * 1024,
): Buffer {
  // Valid xref-stream entries force qpdf to resolve five separately compressed object streams.
  // Their internal decompression must be bounded BEFORE ordinary stream iteration.
  const objects = sourceObjects();
  const compressedIds = [11, 12, 13, 14, 15];
  for (const id of compressedIds) {
    const header = Buffer.from(`${id} 0 `);
    const value = Buffer.concat([
      header,
      Buffer.from('<< /Fixture true >>'),
      Buffer.alloc(decodedSize, 32),
    ]);
    const encoded = deflateSync(value);
    value.fill(0);
    objects.push(
      pdfStream(encoded, `/Type /ObjStm /N 1 /First ${header.length} /Filter ${filter}`),
    );
  }
  const chunks: Buffer[] = [Buffer.from('%PDF-1.7\n')];
  const offsets = [0];
  let length = chunks[0].length;
  for (let i = 0; i < objects.length; i++) {
    offsets.push(length);
    const object = objects[i];
    const chunk = Buffer.concat([
      Buffer.from(`${i + 1} 0 obj\n`),
      Buffer.isBuffer(object) ? object : Buffer.from(object),
      Buffer.from('\nendobj\n'),
    ]);
    chunks.push(chunk);
    length += chunk.length;
  }
  const xrefId = 16;
  const xref = Buffer.alloc((xrefId + 1) * 7);
  xref.writeUInt16BE(65535, 5);
  for (let id = 1; id <= xrefId; id++) {
    const at = id * 7;
    if (id >= 11 && id <= 15) {
      xref[at] = 2;
      xref.writeUInt32BE(id - 5, at + 1);
    } else {
      xref[at] = 1;
      xref.writeUInt32BE(id === xrefId ? length : offsets[id], at + 1);
    }
  }
  chunks.push(
    Buffer.from(`${xrefId} 0 obj\n`),
    pdfStream(xref, `/Type /XRef /Size ${xrefId + 1} /W [1 4 2] /Root 1 0 R`),
    Buffer.from(`\nendobj\nstartxref\n${length}\n%%EOF\n`),
  );
  return Buffer.concat(chunks);
}
export function jpegPdf(bytes: Buffer): Buffer {
  const objects = sourceObjects({ content: Buffer.from('q 100 0 0 100 10 10 cm /Im0 Do Q') });
  objects[2] =
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /XObject << /Im0 6 0 R >> >> /Contents 4 0 R >>';
  objects.push(
    pdfStream(
      bytes,
      '/Type /XObject /Subtype /Image /Width 2 /Height 2 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode',
    ),
  );
  return pdfObjects(objects);
}
export function nestedInlineImagePdf(kind: 'form' | 'pattern' | 'type3'): Buffer {
  const extra: Array<string | Buffer> = [];
  if (kind === 'type3') extra.push('<< /Type /Font /Subtype /Type3 /CharProcs << /a 7 0 R >> >>');
  extra.push(
    pdfStream(
      Buffer.from('q BI /W 1 /H 1 /CS /RGB /BPC 8 ID abc EI Q'),
      kind === 'form'
        ? '/Subtype /Form /BBox [0 0 1 1]'
        : kind === 'pattern'
          ? '/PatternType 1 /BBox [0 0 1 1]'
          : '',
    ),
  );
  return pdfObjects(sourceObjects({ extra }));
}
export function imagePdf(oversized = false): Buffer {
  const pixels = deflateSync(Buffer.from([255, 0, 0, 0, 255, 0, 0, 0, 255, 0, 0, 0]));
  const objects = sourceObjects({ content: Buffer.from('q 100 0 0 100 10 10 cm /Im0 Do Q') });
  objects[2] =
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /XObject << /Im0 6 0 R >> >> /Contents 4 0 R >>';
  objects.push(
    pdfStream(
      pixels,
      `/Type /XObject /Subtype /Image /Width ${oversized ? 50000 : 2} /Height ${oversized ? 50000 : 2} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode`,
    ),
  );
  return pdfObjects(objects);
}
export function manyPagesPdf(count: number): Buffer {
  const objects = sourceObjects();
  objects[1] = `<< /Type /Pages /Count ${count} /Kids [${Array.from({ length: count }, (_, i) => `${i === 0 ? 3 : i + 5} 0 R`).join(' ')}] >>`;
  for (let i = 1; i < count; i++) objects.push(objects[2]);
  return pdfObjects(objects);
}
