/** Pinned Tesseract.js 7.0.0 browser-worker protocol. No document URLs enter this adapter. */
export const OCR_ASSET_BASE = '/ocr/tesseract-7.0.0-eng-1';
export const OCR_MAX_PIXELS = 4_000_000;
export const OCR_MAX_SIDE = 4_096;
export const OCR_MAX_IMAGE_BYTES = 20 * 1024 * 1024;
export const OCR_MAX_CHARACTERS = 200_000;
export const OCR_MAX_WORDS = 20_000;
export const OCR_TIMEOUT_MS = 90_000;
const MAX_RESULT_NODES = 80_000;

export interface OcrWord {
  start: number;
  end: number;
  confidence: number;
  box: { x0: number; y0: number; x1: number; y1: number };
}
export interface OcrResult {
  text: string;
  words: OcrWord[];
}
export interface OcrProgress {
  stage: 'loading' | 'recognizing';
  progress: number;
}
export interface OcrRasterRequest {
  /** A PNG generated from a bounded PDF.js canvas; dimensions must match its IHDR. */
  image: Blob;
  width: number;
  height: number;
  signal: AbortSignal;
  onProgress?: (progress: OcrProgress) => void;
}
export class OcrError extends Error {
  constructor(
    public readonly code:
      | 'unsupported'
      | 'busy'
      | 'invalid_image'
      | 'timeout'
      | 'engine'
      | 'invalid_result'
      | 'result_limit',
    message: string,
  ) {
    super(message);
    this.name = 'OcrError';
  }
}
const aborted = () => new DOMException('Text recognition was cancelled.', 'AbortError');
const invalidResult = () =>
  new OcrError('invalid_result', 'The recognition engine returned invalid text or coordinates.');
const resultLimit = () =>
  new OcrError('result_limit', 'This page exceeds the recognition text limits. Nothing was saved.');
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalidResult();
  return value as Record<string, unknown>;
}
export function validateOcrDimensions(width: number, height: number): void {
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width < 1 ||
    height < 1 ||
    width > OCR_MAX_SIDE ||
    height > OCR_MAX_SIDE ||
    width * height > OCR_MAX_PIXELS
  )
    throw new OcrError(
      'invalid_image',
      'Recognition supports images up to 4 million pixels and 4,096 pixels per side.',
    );
}
function validText(text: string) {
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u.test(text)) return false;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(++i);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
    } else if (code >= 0xdc00 && code <= 0xdfff) return false;
  }
  return true;
}
/** Canonical OCR text uses spaces between words, LF between lines, and two LFs between paragraphs. */
export function normalizeOcrResult(data: unknown, width: number, height: number): OcrResult {
  validateOcrDimensions(width, height);
  const page = object(data);
  if (typeof page.text !== 'string') throw invalidResult();
  if (page.text.length > OCR_MAX_CHARACTERS) throw resultLimit();
  if (!validText(page.text)) throw invalidResult();
  if (page.blocks === null && !page.text.trim()) return { text: '', words: [] };
  let nodes = 0,
    wordCount = 0,
    length = 0;
  const parts: string[] = [];
  const words: OcrWord[] = [];
  const array = (value: unknown): unknown[] => {
    if (!Array.isArray(value)) throw invalidResult();
    nodes += value.length;
    if (nodes > MAX_RESULT_NODES) throw resultLimit();
    return value;
  };
  const append = (text: string) => {
    if (length + text.length > OCR_MAX_CHARACTERS) throw resultLimit();
    parts.push(text);
    length += text.length;
  };
  for (const rawBlock of array(page.blocks)) {
    for (const rawParagraph of array(object(rawBlock).paragraphs)) {
      let firstLine = true;
      for (const rawLine of array(object(rawParagraph).lines)) {
        let firstWord = true;
        for (const rawWord of array(object(rawLine).words)) {
          if (++wordCount > OCR_MAX_WORDS) throw resultLimit();
          const word = object(rawWord);
          if (typeof word.text !== 'string') throw invalidResult();
          if (word.text.length > OCR_MAX_CHARACTERS) throw resultLimit();
          if (!validText(word.text)) throw invalidResult();
          const text = word.text.trim();
          const box = object(word.bbox);
          const { x0, y0, x1, y1 } = box;
          if (
            typeof word.confidence !== 'number' ||
            !Number.isFinite(word.confidence) ||
            word.confidence < 0 ||
            word.confidence > 100 ||
            typeof x0 !== 'number' ||
            typeof y0 !== 'number' ||
            typeof x1 !== 'number' ||
            typeof y1 !== 'number' ||
            ![x0, y0, x1, y1].every(Number.isFinite) ||
            x0 < 0 ||
            y0 < 0 ||
            x1 > width ||
            y1 > height ||
            x1 <= x0 ||
            y1 <= y0
          )
            throw invalidResult();
          if (!text) continue;
          if (firstWord) {
            if (words.length) append(firstLine ? '\n\n' : '\n');
            firstWord = false;
            firstLine = false;
          } else append(' ');
          const start = length;
          append(text);
          words.push({ start, end: length, confidence: word.confidence, box: { x0, y0, x1, y1 } });
        }
      }
    }
  }
  const text = parts.join('');
  // Layout whitespace is canonicalized, but missing/reordered recognized content is never discarded.
  if (text.replace(/\s/gu, '') !== page.text.replace(/\s/gu, '')) throw invalidResult();
  return { text, words };
}

/** Narrow injectable worker/clock boundary; production always uses a same-origin classic worker. */
export interface OcrWorker {
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: ((event: { preventDefault?: () => void }) => void) | null;
  onmessageerror: (() => void) | null;
  postMessage(message: unknown, transfer?: Transferable[]): void;
  terminate(): void;
}
export interface OcrEnvironment {
  origin: string;
  createWorker(url: string): OcrWorker;
  setTimeout(callback: () => void, delay: number): unknown;
  clearTimeout(handle: unknown): void;
}
// Shared across recognizer instances: changing pages or opening another panel never starts a pool.
let activeJob: symbol | undefined;
let serial = 0;
type Action = 'load' | 'loadLanguage' | 'initialize' | 'recognize';

export function createOcrRecognizer(environment: OcrEnvironment) {
  return (request: OcrRasterRequest): Promise<OcrResult> => {
    if (request.signal.aborted) return Promise.reject(aborted());
    try {
      validateOcrDimensions(request.width, request.height);
      if (
        !(request.image instanceof Blob) ||
        request.image.type !== 'image/png' ||
        request.image.size < 33 ||
        request.image.size > OCR_MAX_IMAGE_BYTES
      )
        throw new OcrError('invalid_image', 'Recognition requires a bounded PNG page image.');
    } catch (error) {
      return Promise.reject(error);
    }
    if (activeJob)
      return Promise.reject(
        new OcrError('busy', 'Wait for the current text recognition to finish.'),
      );
    const identity = Symbol('ocr');
    activeJob = identity;
    return new Promise<OcrResult>((resolve, reject) => {
      let worker: OcrWorker | undefined;
      let finished = false;
      let timer: unknown;
      let pending:
        | {
            action: Action;
            jobId: string;
            resolve: (value: unknown) => void;
            reject: (error: Error) => void;
          }
        | undefined;
      const workerId = `margin-ocr-${++serial}`;
      let sequence = 0;
      const finish = (error?: Error, result?: OcrResult) => {
        if (finished) return;
        finished = true;
        environment.clearTimeout(timer);
        request.signal.removeEventListener('abort', cancel);
        const interrupted = pending;
        pending = undefined;
        if (error) interrupted?.reject(error);
        if (worker) {
          worker.onmessage = worker.onerror = worker.onmessageerror = null;
          try {
            worker.terminate();
          } catch {
            // Preserve the actual result/error; the worker cannot publish another accepted result.
          }
          worker = undefined;
        }
        if (activeJob === identity) activeJob = undefined;
        if (error) reject(error);
        else resolve(result!);
      };
      const cancel = () => finish(aborted());
      const engineError = () =>
        finish(new OcrError('engine', 'Local text recognition failed. Try this page again.'));
      const progress = (action: Action, amount: number) => {
        if (finished) return;
        const loadingStep = action === 'load' ? 0 : action === 'loadLanguage' ? 1 : 2;
        try {
          request.onProgress?.({
            stage: action === 'recognize' ? 'recognizing' : 'loading',
            progress: action === 'recognize' ? amount : (loadingStep + amount) / 3,
          });
        } catch {
          // UI progress callbacks must not strand a worker or expose engine messages.
        }
      };
      const send = (action: Action, payload: unknown, transfer: Transferable[] = []) =>
        new Promise<unknown>((resolveStep, rejectStep) => {
          if (finished || !worker) {
            rejectStep(aborted());
            return;
          }
          const jobId = `${workerId}-${++sequence}`;
          pending = { action, jobId, resolve: resolveStep, reject: rejectStep };
          progress(action, 0);
          if (finished) return;
          try {
            worker.postMessage({ workerId, jobId, action, payload }, transfer);
          } catch {
            engineError();
          }
        });
      request.signal.addEventListener('abort', cancel, { once: true });
      timer = environment.setTimeout(
        () =>
          finish(
            new OcrError('timeout', 'Text recognition exceeded 90 seconds. Nothing was saved.'),
          ),
        OCR_TIMEOUT_MS,
      );
      if (request.signal.aborted) {
        cancel();
        return;
      }
      void (async () => {
        const header = new Uint8Array(await request.image.slice(0, 33).arrayBuffer());
        if (finished) return;
        const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
        if (
          header.length !== 33 ||
          ![137, 80, 78, 71, 13, 10, 26, 10].every((byte, i) => header[i] === byte) ||
          view.getUint32(8) !== 13 ||
          view.getUint32(12) !== 0x49484452 ||
          view.getUint32(16) !== request.width ||
          view.getUint32(20) !== request.height
        )
          throw new OcrError('invalid_image', 'The PNG dimensions do not match this page image.');
        const origin = new URL(environment.origin);
        if (!['http:', 'https:'].includes(origin.protocol) || origin.origin !== environment.origin)
          throw new OcrError('unsupported', 'Local recognition needs an HTTP or HTTPS app origin.');
        const base = new URL(OCR_ASSET_BASE, origin).href;
        worker = environment.createWorker(`${base}/worker.min.js`);
        worker.onerror = (event) => {
          event.preventDefault?.();
          engineError();
        };
        worker.onmessageerror = engineError;
        worker.onmessage = ({ data }) => {
          if (finished || !pending || !data || typeof data !== 'object') return;
          const message = data as Record<string, unknown>;
          if (
            message.workerId !== workerId ||
            message.jobId !== pending.jobId ||
            message.action !== pending.action
          )
            return;
          if (message.status === 'progress') {
            const info = message.data as { progress?: unknown } | null;
            if (typeof info?.progress === 'number' && Number.isFinite(info.progress))
              progress(pending.action, Math.max(0, Math.min(1, info.progress)));
          } else if (message.status === 'resolve') {
            const step = pending;
            pending = undefined;
            step.resolve(message.data);
          } else engineError();
        };
        await send('load', {
          options: { corePath: `${base}/core`, lstmOnly: true, logging: false },
        });
        await send('loadLanguage', {
          langs: 'eng',
          options: { langPath: `${base}/lang`, cacheMethod: 'none', gzip: true, lstmOnly: true },
        });
        await send('initialize', { langs: 'eng', oem: 1, config: { debug_file: '/dev/null' } });
        if (finished) return;
        const bytes = await request.image.arrayBuffer();
        if (finished) return;
        const data = await send(
          'recognize',
          {
            image: new Uint8Array(bytes),
            options: { tessedit_pageseg_mode: '3', rotateAuto: false, rotateRadians: 0 },
            output: { text: true, blocks: true, debug: false },
          },
          [bytes],
        );
        if (!finished) finish(undefined, normalizeOcrResult(data, request.width, request.height));
      })().catch((error: unknown) => {
        if (finished) return;
        if (error instanceof OcrError) finish(error);
        else engineError();
      });
    });
  };
}

export function recognizeRaster(request: OcrRasterRequest): Promise<OcrResult> {
  if (typeof Worker === 'undefined' || typeof location === 'undefined')
    return Promise.reject(
      new OcrError('unsupported', 'This browser does not support local recognition.'),
    );
  return createOcrRecognizer({
    origin: location.origin,
    createWorker: (url) => new Worker(url) as OcrWorker,
    setTimeout: (callback, delay) => globalThis.setTimeout(callback, delay),
    clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
  })(request);
}
