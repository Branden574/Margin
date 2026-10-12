import { open, readFile, unlink } from 'node:fs/promises';
import { spawn } from 'node:child_process';

const protocol = 'margin-pdf-inspection-v1';
const qpdfVersion = '12.4.2';
const pdfjsVersion = '6.3.289';
const engineVersion = `qpdf-${qpdfVersion}+pdfjs-${pdfjsVersion}+policy-1`;
const input = '/work/source.pdf';
const maxInput = 100 * 1024 * 1024;
const maxOutput = 256 * 1024;
const base = { protocol, engine: 'qpdf-pdfjs', engineVersion };
// Engine diagnostics may contain document names, text, paths and URI values.
// Only the fixed protocol below is allowed across the container boundary.
for (const key of ['log', 'warn', 'error', 'info', 'debug']) console[key] = () => {};
class Rejection extends Error {
  constructor(reason) {
    super(reason);
    this.reason = reason;
  }
}
let file;
let bytes;
let task;
let child;
let emitted = false;
function emit(status, reason, pages = []) {
  if (emitted) return;
  const value = {
    ...base,
    status,
    reason,
    pageCount: pages.length,
    ...(status === 'valid' ? { pageGeometry: pages } : {}),
  };
  const json = JSON.stringify(value) + '\n';
  if (Buffer.byteLength(json) > maxOutput) throw new Rejection('resource_limit');
  emitted = true;
  process.stdout.write(json);
  process.exitCode = status === 'valid' ? 0 : 10;
}
async function structure() {
  return await new Promise((resolve, reject) => {
    child = spawn('/app/validate', [], { stdio: ['ignore', 'pipe', 'ignore'], env: {} });
    let result = '';
    let oversized = false;
    child.stdout.on('data', (chunk) => {
      if (oversized) return;
      if (Buffer.byteLength(result) + chunk.length > 1024) {
        oversized = true;
        child.kill('SIGKILL');
      } else result += chunk.toString('utf8');
    });
    child.once('error', reject);
    child.once('close', (code, signal) => {
      child = undefined;
      if (oversized) return reject(new Rejection('resource_limit'));
      if (signal || ![0, 10].includes(code)) return reject(new Error('engine_unavailable'));
      try {
        const r = JSON.parse(result);
        if (
          Object.keys(r).sort().join(',') !== 'pageCount,qpdfVersion,reason,status' ||
          r.qpdfVersion !== qpdfVersion ||
          !Number.isSafeInteger(r.pageCount) ||
          r.pageCount < 0 ||
          r.pageCount > 2000 ||
          !['clean', 'unsupported', 'invalid_document', 'resource_limit'].includes(r.reason) ||
          !['valid', 'rejected'].includes(r.status) ||
          (code === 0) !== (r.status === 'valid' && r.reason === 'clean' && r.pageCount > 0)
        )
          throw new Error('engine_protocol');
        resolve(r);
      } catch {
        reject(new Error('engine_protocol'));
      }
    });
  });
}

try {
  if (process.argv.length !== 2) throw new Error('engine_configuration');
  file = await open(input, 'wx', 0o600);
  let count = 0;
  for await (const chunk of process.stdin) {
    if (chunk.length > maxInput - count) throw new Rejection('resource_limit');
    count += chunk.length;
    await file.writeFile(chunk);
  }
  await file.close();
  file = undefined;
  if (count < 8) throw new Rejection('invalid_document');
  bytes = new Uint8Array(await readFile(input));
  if (!/^%PDF-[12]\.\d/.test(Buffer.from(bytes.subarray(0, 8)).toString('latin1')))
    throw new Rejection('invalid_document');
  const checked = await structure();
  if (checked.status !== 'valid') throw new Rejection(checked.reason);
  const { getDocument, version } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  if (version !== pdfjsVersion) throw new Error('engine_version');
  task = getDocument({
    data: bytes,
    stopAtErrors: true,
    isEvalSupported: false,
    enableXfa: false,
    useSystemFonts: false,
    disableFontFace: true,
    isOffscreenCanvasSupported: false,
    isImageDecoderSupported: false,
    maxImageSize: 16 * 1024 * 1024,
    disableAutoFetch: true,
    disableStream: true,
    disableRange: true,
    cMapUrl: '/app/node_modules/pdfjs-dist/cmaps/',
    cMapPacked: true,
    standardFontDataUrl: '/app/node_modules/pdfjs-dist/standard_fonts/',
    wasmUrl: '/app/node_modules/pdfjs-dist/wasm/',
    verbosity: 0,
  });
  const pdf = await task.promise;
  if (pdf.numPages !== checked.pageCount) throw new Rejection('invalid_document');
  const pages = [];
  let operators = 0;
  for (let index = 0; index < pdf.numPages; index++) {
    const page = await pdf.getPage(index + 1);
    const { width, height } = page.getViewport({ scale: 1 });
    if (![width, height].every((n) => Number.isFinite(n) && n > 0 && n <= 100000))
      throw new Rejection('resource_limit');
    const list = await page.getOperatorList();
    operators += list.fnArray.length;
    if (operators > 500000) throw new Rejection('resource_limit');
    pages.push({ index, width, height });
    page.cleanup();
  }
  emit('valid', 'clean', pages);
} catch (error) {
  if (error instanceof Rejection) emit('rejected', error.reason);
  else if (['InvalidPDFException', 'FormatError', 'PasswordException'].includes(error?.name))
    emit('rejected', error.name === 'PasswordException' ? 'unsupported' : 'invalid_document');
  else {
    // Unknown dependency/process/filesystem outcomes are infrastructure failures, not approvals.
    process.exitCode = 20;
  }
} finally {
  await file?.close().catch(() => {});
  await task?.destroy().catch(() => {});
  // PDF.js transfers the typed array; a detached input has no remaining bytes to clear here.
  if (bytes?.byteLength) bytes.fill(0);
  await unlink(input).catch(() => {});
}
