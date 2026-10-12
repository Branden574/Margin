import { randomUUID } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import {
  activePdf,
  benignPdf,
  decodedBombPdf,
  deepPdf,
  embeddedPdf,
  externalLinkPdf,
  filterBombPdf,
  geometryPdf,
  imagePdf,
  inlineImagePdf,
  jpegPdf,
  manyPagesPdf,
  nestedInlineImagePdf,
  objectStreamBombPdf,
  pdfObjects,
  predictorBombPdf,
  sourceObjects,
  xfaPdf,
} from './helpers/scanner-pdf-fixtures';

const command = promisify(execFile);
const image = process.env.MARGIN_PDF_PARSER_IMAGE;
const dockerExecutable = process.env.MARGIN_SCANNER_DOCKER_BIN;
const dockerSocket = process.env.MARGIN_SCANNER_DOCKER_SOCKET;
if (image && (!dockerExecutable?.startsWith('/') || !dockerSocket?.startsWith('/')))
  throw new Error(
    'Real parser tests require an explicit absolute Docker executable and Unix socket.',
  );
const dockerEndpoint = ['--host', 'unix://' + dockerSocket];
const dockerEnvironment = { PATH: process.env.PATH, LANG: 'C', LC_ALL: 'C' };
const suite = image ? describe : describe.skip;
async function docker(args: string[]) {
  return (
    await command(dockerExecutable!, [...dockerEndpoint, ...args], {
      env: dockerEnvironment,
      timeout: 15000,
      maxBuffer: 1024 * 1024,
    })
  ).stdout.trim();
}
async function inspect(bytes: Buffer) {
  const name = 'margin-parser-test-' + randomUUID();
  const cid = await docker([
    'create',
    '--interactive',
    '--attach',
    'stdin',
    '--attach',
    'stdout',
    '--attach',
    'stderr',
    '--name',
    name,
    '--label',
    'org.margin.scanner.test=' + name,
    '--network',
    'none',
    '--read-only',
    '--user',
    '65532:65532',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges',
    '--cpus',
    '1',
    '--memory',
    '1g',
    '--memory-swap',
    '1g',
    '--pids-limit',
    '64',
    '--ulimit',
    'core=0',
    '--ulimit',
    'nofile=64:64',
    '--tmpfs',
    '/work:rw,noexec,nosuid,nodev,size=128m,uid=65532,gid=65532,mode=0700',
    '--tmpfs',
    '/tmp:rw,noexec,nosuid,nodev,size=16m,uid=65532,gid=65532,mode=0700',
    image!,
  ]);
  if (!/^[a-f0-9]{64}$/.test(cid)) throw new Error('Invalid owned scanner container ID');
  const started = performance.now();
  try {
    const result = await new Promise<{ code: number | null; output: string; stderr: string }>(
      (resolve, reject) => {
        const child = spawn(
          dockerExecutable!,
          [...dockerEndpoint, 'start', '--attach', '--interactive', cid],
          {
            env: dockerEnvironment,
            stdio: 'pipe',
          },
        );
        let output = '',
          stderr = '',
          exceeded = false;
        const timer = setTimeout(() => {
          void docker(['kill', cid]).catch(() => {});
          child.kill('SIGKILL');
          reject(new Error('Parser exceeded the actual container deadline'));
        }, 45000);
        child.stdout.on('data', (data: Buffer) => {
          if (Buffer.byteLength(output) + data.length > 256 * 1024) {
            exceeded = true;
            void docker(['kill', cid]).catch(() => {});
          } else output += data.toString();
        });
        child.stderr.on('data', (data: Buffer) => {
          if (Buffer.byteLength(stderr) + data.length > 4096) {
            exceeded = true;
            void docker(['kill', cid]).catch(() => {});
          } else stderr += data.toString();
        });
        child.once('error', (e) => {
          clearTimeout(timer);
          reject(e);
        });
        child.once('close', (code) => {
          clearTimeout(timer);
          exceeded
            ? reject(new Error('Parser emitted excessive output'))
            : resolve({ code, output, stderr });
        });
        child.stdin.on('error', () => {});
        child.stdin.end(bytes);
      },
    );
    const state = JSON.parse(await docker(['inspect', '--format', '{{json .State}}', cid]));
    expect(state.Running).toBe(false);
    expect(state.OOMKilled).toBe(false);
    expect(result.stderr).toBe('');
    const json = JSON.parse(result.output);
    expect(json).toMatchObject({
      protocol: 'margin-pdf-inspection-v1',
      engine: 'qpdf-pdfjs',
      engineVersion: 'qpdf-12.4.2+pdfjs-6.3.289+policy-1',
    });
    expect(result.output).not.toMatch(
      /Known fixture|secret-fixture|fixture\.invalid|\/work\/|source\.pdf/,
    );
    return { ...result, json, elapsedMs: Math.round(performance.now() - started) };
  } finally {
    await docker(['rm', '--force', cid]);
  }
}

suite('real isolated PDF parser (explicit image required)', () => {
  it('parses a benign PDF under nonroot/no-network/readonly/tmpfs constraints', async () => {
    const result = await inspect(benignPdf());
    expect(result.code).toBe(0);
    expect(result.json).toMatchObject({
      status: 'valid',
      reason: 'clean',
      pageCount: 1,
      pageGeometry: [{ index: 0, width: 612, height: 792 }],
    });
    console.info(
      `Actual ARM64 parser benign fixture: ${result.elapsedMs}ms including container start`,
    );
  });
  it('derives effective CropBox, intrinsic rotation and UserUnit geometry', async () => {
    const result = await inspect(geometryPdf());
    expect(result.code).toBe(0);
    expect(result.json.pageGeometry).toEqual([{ index: 0, width: 1340, height: 960 }]);
  });
  it('validates a real Flate image before PDF.js interprets it', async () => {
    const result = await inspect(imagePdf());
    expect(result.code).toBe(0);
    expect(result.json.status).toBe('valid');
  });
  it('validates a real JPEG through its header and full DCT decoder', async () => {
    const jpeg = await readFile(
      new URL('../infra/scanner/parser/fixtures/generated-2x2.jpg', import.meta.url),
    );
    const result = await inspect(jpegPdf(jpeg));
    expect(result.code).toBe(0);
    expect(result.json.status).toBe('valid');
  });
  it('bounds actual JPEG dimensions even when the PDF dictionary claims two pixels', async () => {
    const jpeg = await readFile(
      new URL('../infra/scanner/parser/fixtures/generated-2x2.jpg', import.meta.url),
    );
    const sof = jpeg.indexOf(Buffer.from([0xff, 0xc0, 0, 17, 8]));
    expect(sof).toBeGreaterThan(0);
    jpeg.writeUInt16BE(8192, sof + 5);
    jpeg.writeUInt16BE(8192, sof + 7);
    const result = await inspect(jpegPdf(jpeg));
    expect(result.code).toBe(10);
    expect(result.json.reason).toBe('resource_limit');
  });
  it('accepts inert content text containing PDF action names and an internal destination', async () => {
    const result = await inspect(
      pdfObjects(
        sourceObjects({
          content: Buffer.from(
            'BT /F1 12 Tf (/A /JS /URI /OpenAction are plain fixture text) Tj ET',
          ),
          page: '/Annots [6 0 R]',
          extra: ['<< /Type /Annot /Subtype /Link /Rect [0 0 10 10] /Dest [3 0 R /Fit] >>'],
        }),
      ),
    );
    expect(result.code).toBe(0);
  });
  it.each([
    ['JavaScript', () => activePdf()],
    ['escaped active keys', () => activePdf(true)],
    ['external URI', externalLinkPdf],
    ['embedded file', embeddedPdf],
    ['XFA', xfaPdf],
    ['inline image unsupported decoder path', inlineImagePdf],
    ['inline image in a Form XObject', () => nestedInlineImagePdf('form')],
    ['inline image in a tiling pattern', () => nestedInlineImagePdf('pattern')],
    ['inline image in a Type3 glyph', () => nestedInlineImagePdf('type3')],
  ])('rejects %s via parsed structure', async (_name, fixture) => {
    const result = await inspect(fixture());
    expect(result.code).toBe(10);
    expect(result.json).toMatchObject({ status: 'rejected', reason: 'unsupported', pageCount: 0 });
    expect(result.json.pageGeometry).toBeUndefined();
  });
  it.each(['/Crypt', '/UnknownDecode', '/CCITTFaxDecode', '/JPXDecode', '/JBIG2Decode'])(
    'cannot use unsupported %s in an internal compressed object table',
    async (filter) => {
      const result = await inspect(objectStreamBombPdf(filter, 32));
      expect(result.code).toBe(10);
      expect(result.json.status).toBe('rejected');
    },
  );
  it('rejects an actual qpdf encrypted regression fixture', async () => {
    const result = await inspect(
      await readFile(new URL('../infra/scanner/parser/fixtures/encrypted.pdf', import.meta.url)),
    );
    expect(result.code).toBe(10);
    expect(result.json.reason).toBe('unsupported');
  });
  it('rejects malformed bytes without reporting document text', async () => {
    const result = await inspect(Buffer.from('%PDF-1.7\nsecret-fixture invalid data'));
    expect(result.code).toBe(10);
    expect(result.json.reason).toBe('invalid_document');
  });
  it.each([
    ['nesting', deepPdf],
    ['filter chain', filterBombPdf],
    ['image expansion', () => imagePdf(true)],
    ['aggregate decoded content', decodedBombPdf],
    ['intermediate PNG predictor work', predictorBombPdf],
    ['compressed object tables', objectStreamBombPdf],
    ['page count', () => manyPagesPdf(2001)],
  ])(
    'bounds %s without container OOM',
    async (name, fixture) => {
      const result = await inspect(fixture());
      expect(result.code).toBe(10);
      expect(result.json).toMatchObject({
        status: 'rejected',
        reason: 'resource_limit',
        pageCount: 0,
      });
      console.info(`Actual ARM64 parser ${name}: ${result.elapsedMs}ms including container start`);
    },
    60000,
  );
  it('validates every page of a generated 500-page PDF within the scanner deadline', async () => {
    const result = await inspect(manyPagesPdf(500));
    expect(result.code).toBe(0);
    expect(result.json.pageCount).toBe(500);
    expect(result.json.pageGeometry).toHaveLength(500);
    console.info(
      `Actual ARM64 parser 500-page fixture: ${result.elapsedMs}ms including container start`,
    );
  }, 60000);
});
