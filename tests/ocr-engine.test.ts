import { afterEach, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { Worker as NodeWorker } from 'node:worker_threads';
import { deflateSync } from 'node:zlib';
import {
  createOcrRecognizer,
  normalizeOcrResult,
  recognizeRaster,
  OCR_ASSET_BASE,
  OCR_MAX_CHARACTERS,
  OCR_MAX_WORDS,
  OCR_TIMEOUT_MS,
  validateOcrDimensions,
  type OcrEnvironment,
  type OcrProgress,
  type OcrRasterRequest,
  type OcrWorker,
} from '../apps/web/src/editor/ocrEngine';

type Packet = { workerId: string; jobId: string; action: string; payload: Record<string, any> };
class FakeWorker implements OcrWorker {
  onmessage: OcrWorker['onmessage'] = null;
  onerror: OcrWorker['onerror'] = null;
  onmessageerror: OcrWorker['onmessageerror'] = null;
  sent: { packet: Packet; transfer: Transferable[] }[] = [];
  terminated = 0;
  failSend = false;
  postMessage(packet: unknown, transfer: Transferable[] = []) {
    if (this.failSend) throw new Error('private worker details');
    this.sent.push({ packet: packet as Packet, transfer });
  }
  terminate() {
    this.terminated++;
  }
  latest() {
    return this.sent.at(-1)!.packet;
  }
  emit(status: string, data: unknown = {}, packet = this.latest()) {
    this.onmessage?.({ data: { ...packet, status, data } });
  }
}
class FakeEnvironment implements OcrEnvironment {
  origin = 'https://127.0.0.1:5173';
  workers: FakeWorker[] = [];
  urls: string[] = [];
  timers = new Map<number, () => void>();
  id = 0;
  failCreate = false;
  createWorker(url: string) {
    if (this.failCreate) throw new Error('private worker details');
    const worker = new FakeWorker();
    this.workers.push(worker);
    this.urls.push(url);
    return worker;
  }
  setTimeout(callback: () => void, delay: number) {
    expect(delay).toBe(OCR_TIMEOUT_MS);
    this.timers.set(++this.id, callback);
    return this.id;
  }
  clearTimeout(handle: unknown) {
    this.timers.delete(handle as number);
  }
  expire() {
    for (const callback of [...this.timers.values()]) callback();
  }
}
// Only the adapter's header validation runs against this fixture; fake workers never decode pixels.
function png(width = 100, height = 80) {
  const bytes = new Uint8Array(33);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10]);
  const view = new DataView(bytes.buffer);
  view.setUint32(8, 13);
  view.setUint32(12, 0x49484452);
  view.setUint32(16, width);
  view.setUint32(20, height);
  bytes[24] = 8;
  bytes[25] = 6;
  return new Blob([bytes], { type: 'image/png' });
}
const tick = async () => {
  // Blob.arrayBuffer and chained protocol continuations need more than one microtask turn.
  await new Promise((resolve) => setTimeout(resolve, 0));
};
const word = (text: string, x0 = 1, y0 = 2, x1 = 30, y1 = 15) => ({
  text,
  confidence: 97,
  bbox: { x0, y0, x1, y1 },
});
const page = (...words: ReturnType<typeof word>[]) => ({
  text: words.map((value) => value.text).join(' '),
  blocks: [{ paragraphs: [{ lines: [{ words }] }] }],
});
const controllers: AbortController[] = [];
afterEach(async () => {
  for (const controller of controllers.splice(0)) controller.abort();
  await tick();
});
function setup(environment = new FakeEnvironment()) {
  const controller = new AbortController();
  controllers.push(controller);
  const request: OcrRasterRequest = {
    image: png(),
    width: 100,
    height: 80,
    signal: controller.signal,
  };
  return { environment, controller, request, recognize: createOcrRecognizer(environment) };
}
async function ready(worker: FakeWorker) {
  for (const action of ['load', 'loadLanguage', 'initialize']) {
    expect(worker.latest().action).toBe(action);
    worker.emit('resolve');
    await tick();
  }
  expect(worker.latest().action).toBe('recognize');
}

/** Synthetic, public test pixels only. A tiny bitmap alphabet avoids platform fonts or native canvas. */
function printedPng() {
  const alphabet: Record<string, string[]> = {
    H: ['10001', '10001', '10001', '11111', '10001', '10001', '10001'],
    E: ['11111', '10000', '10000', '11110', '10000', '10000', '11111'],
    L: ['10000', '10000', '10000', '10000', '10000', '10000', '11111'],
    O: ['01110', '10001', '10001', '10001', '10001', '10001', '01110'],
  };
  const width = 608,
    height = 160,
    scale = 8;
  const pixels = Buffer.alloc((width + 1) * height, 255);
  for (let y = 0; y < height; y++) pixels[y * (width + 1)] = 0;
  let left = 40;
  for (const character of 'HELLO HELLO') {
    const glyph = alphabet[character];
    if (glyph)
      for (let row = 0; row < 7; row++)
        for (let col = 0; col < 5; col++)
          if (glyph[row][col] === '1')
            for (let y = 0; y < scale; y++)
              for (let x = 0; x < scale; x++)
                pixels[(48 + row * scale + y) * (width + 1) + 1 + left + col * scale + x] = 0;
    left += 6 * scale;
  }
  const chunk = (type: string, bytes: Buffer) => {
    const data = Buffer.concat([Buffer.from(type), bytes]);
    let crc = 0xffffffff;
    for (const byte of data) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
    const length = Buffer.alloc(4),
      checksum = Buffer.alloc(4);
    length.writeUInt32BE(bytes.length);
    checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    return Buffer.concat([length, data, checksum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  const bytes = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(pixels)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
  return { width, height, image: new Blob([bytes], { type: 'image/png' }) };
}

it('recognizes synthetic pixels through the installed pinned protocol with entirely local assets', async () => {
  const require = createRequire(import.meta.url);
  expect(require('tesseract.js/package.json').version).toBe('7.0.0');
  expect(require('tesseract.js-core/package.json').version).toBe('7.0.0');
  expect(require('@tesseract.js-data/eng/package.json').version).toBe('1.0.0');
  const language = join(
    dirname(require.resolve('@tesseract.js-data/eng/package.json')),
    '4.0.0_best_int',
  );
  let terminated: Promise<number> | undefined;
  let diagnosticBytes = 0;
  const recognize = createOcrRecognizer({
    origin: 'https://margin.test',
    createWorker() {
      const native = new NodeWorker(
        require.resolve('tesseract.js/src/worker-script/node/index.js'),
        { stdout: true, stderr: true },
      );
      const adapter: OcrWorker = {
        onmessage: null,
        onerror: null,
        onmessageerror: null,
        postMessage(message, transfer) {
          const packet = message as Packet;
          // The Node adapter uses the same worker protocol. Resolve language data on disk only.
          if (packet.action === 'loadLanguage') packet.payload.options.langPath = language;
          native.postMessage(
            packet,
            transfer?.map((value) => {
              if (!(value instanceof ArrayBuffer)) throw new Error('Unexpected OCR transfer type.');
              return value;
            }),
          );
        },
        terminate() {
          terminated = native.terminate();
        },
      };
      native.on('message', (data) => adapter.onmessage?.({ data }));
      native.on('error', () => adapter.onerror?.({}));
      native.on('messageerror', () => adapter.onmessageerror?.());
      // Never forward native diagnostics into test logs; count bytes without retaining their text.
      const diagnostic = (chunk: Buffer) => {
        diagnosticBytes = Math.min(4097, diagnosticBytes + chunk.length);
        if (diagnosticBytes > 4096) adapter.onerror?.({});
      };
      native.stdout?.on('data', diagnostic);
      native.stderr?.on('data', diagnostic);
      return adapter;
    },
    setTimeout: (callback, delay) => setTimeout(callback, delay),
    clearTimeout: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
  });
  const controller = new AbortController();
  controllers.push(controller);
  try {
    const result = await recognize({ ...printedPng(), signal: controller.signal });
    expect(result.text).toBe('HELLO HELLO');
    expect(result.words).toHaveLength(2);
    expect(result.words.every((value) => value.confidence > 50)).toBe(true);
    expect(result.words[0].box.x0).toBeLessThan(result.words[1].box.x0);
    expect(diagnosticBytes).toBe(0);
  } finally {
    controller.abort();
    await terminated;
  }
}, 15_000);

describe('OCR result text and pixel coordinates', () => {
  it('keeps engine reading order, paragraph/line boundaries and exact UTF-16 word offsets', () => {
    const a = word('🧪', 60),
      b = word('Cafe\u0301'),
      c = word('שלום'),
      d = word('world');
    a.bbox.x1 = 90;
    const result = normalizeOcrResult(
      {
        text: '🧪 Cafe\u0301\nשלום\n\nworld',
        blocks: [
          { paragraphs: [{ lines: [{ words: [a, b] }, { words: [c] }] }] },
          { paragraphs: [{ lines: [{ words: [d] }] }] },
        ],
      },
      100,
      80,
    );
    expect(result.text).toBe('🧪 Cafe\u0301\nשלום\n\nworld');
    expect(result.words.map((value) => result.text.slice(value.start, value.end))).toEqual([
      '🧪',
      'Cafe\u0301',
      'שלום',
      'world',
    ]);
    expect(result.words[0]).toEqual({ start: 0, end: 2, confidence: 97, box: a.bbox });
    expect(result.words[1].start).toBe(3);
  });
  it('accepts a legitimately empty page and does not invent words', () => {
    expect(normalizeOcrResult({ text: '', blocks: null }, 100, 80)).toEqual({
      text: '',
      words: [],
    });
    expect(normalizeOcrResult({ text: '\n', blocks: [] }, 100, 80)).toEqual({
      text: '',
      words: [],
    });
  });
  it('rejects missing word geometry instead of saving a text-only partial result', () => {
    for (const value of [
      null,
      {},
      { text: 'retained', blocks: null },
      { text: 'lost', blocks: [] },
    ])
      expect(() => normalizeOcrResult(value, 100, 80)).toThrow(/invalid text or coordinates/);
    expect(() =>
      normalizeOcrResult({ ...page(word('Complete')), text: 'Complete sentence' }, 100, 80),
    ).toThrow(/invalid text or coordinates/);
  });
  it.each([
    { x0: -1 },
    { x1: 101 },
    { y0: -1 },
    { y1: 81 },
    { x1: 1 },
    { y1: 2 },
    { x0: NaN },
    { x1: Infinity },
  ])('rejects invalid or out-of-raster boxes %j', (patch) => {
    const value = word('text');
    Object.assign(value.bbox, patch);
    expect(() => normalizeOcrResult(page(value), 100, 80)).toThrow(/invalid text or coordinates/);
  });
  it.each([-1, 101, NaN, Infinity])('rejects invalid confidence %s', (confidence) => {
    const value = { ...word('text'), confidence };
    expect(() => normalizeOcrResult(page(value), 100, 80)).toThrow(/invalid text or coordinates/);
  });
  it('rejects malformed text, Unicode and trees', () => {
    for (const text of ['a\u0000b', '\uD800', '\uDC00'])
      expect(() => normalizeOcrResult(page(word(text)), 100, 80)).toThrow();
    expect(() => normalizeOcrResult({ text: '', blocks: [{ paragraphs: {} }] }, 100, 80)).toThrow();
  });
  it('refuses oversize output without truncating it', () => {
    expect(() =>
      normalizeOcrResult(page(word('x'.repeat(OCR_MAX_CHARACTERS + 1))), 100, 80),
    ).toThrow(/limits/);
    expect(() =>
      normalizeOcrResult(
        {
          text: '',
          blocks: [
            {
              paragraphs: [
                { lines: [{ words: Array.from({ length: OCR_MAX_WORDS + 1 }, () => word('a')) }] },
              ],
            },
          ],
        },
        100,
        80,
      ),
    ).toThrow(/limits/);
    // Canonical separators count, even when an engine's aggregate text understates them.
    expect(() =>
      normalizeOcrResult(
        { ...page(word('a'.repeat(100_000)), word('b'.repeat(100_000))), text: '' },
        100,
        80,
      ),
    ).toThrow(/limits/);
    expect(() =>
      normalizeOcrResult({ text: '', blocks: Array(80_001).fill({ paragraphs: [] }) }, 100, 80),
    ).toThrow(/limits/);
  });
});

describe('local OCR worker lifecycle', () => {
  it('uses the pinned local protocol and transfers image bytes only after initialization', async () => {
    const { environment, recognize, request } = setup();
    const result = recognize(request);
    await tick();
    const worker = environment.workers[0];
    expect(environment.urls).toEqual([`${environment.origin}${OCR_ASSET_BASE}/worker.min.js`]);
    await ready(worker);
    const packets = worker.sent.map((value) => value.packet);
    expect(packets.map((value) => value.action)).toEqual([
      'load',
      'loadLanguage',
      'initialize',
      'recognize',
    ]);
    expect(packets[0].payload).toEqual({
      options: {
        corePath: `${environment.origin}${OCR_ASSET_BASE}/core`,
        lstmOnly: true,
        logging: false,
      },
    });
    expect(packets[1].payload).toEqual({
      langs: 'eng',
      options: {
        langPath: `${environment.origin}${OCR_ASSET_BASE}/lang`,
        cacheMethod: 'none',
        gzip: true,
        lstmOnly: true,
      },
    });
    expect(packets[2].payload).toEqual({
      langs: 'eng',
      oem: 1,
      config: { debug_file: '/dev/null' },
    });
    expect(packets.slice(0, 3).every((value) => !('image' in value.payload))).toBe(true);
    expect(packets[3].payload.output).toEqual({ text: true, blocks: true, debug: false });
    expect(packets[3].payload.options).toEqual({
      tessedit_pageseg_mode: '3',
      rotateAuto: false,
      rotateRadians: 0,
    });
    expect(worker.sent[3].transfer).toEqual([packets[3].payload.image.buffer]);
    worker.emit('resolve', page(word('Hello')));
    expect((await result).text).toBe('Hello');
    expect(worker.terminated).toBe(1);
    expect(environment.timers.size).toBe(0);
    expect(worker.onmessage).toBe(null);
  });
  it('cancels immediately during engine initialization and ignores callbacks from a previous worker', async () => {
    const { environment, recognize, request, controller } = setup();
    const first = recognize(request);
    const firstRejection = expect(first).rejects.toMatchObject({ name: 'AbortError' });
    await tick();
    const oldWorker = environment.workers[0];
    const oldHandler = oldWorker.onmessage!;
    const oldPacket = oldWorker.latest();
    controller.abort();
    await firstRejection;
    expect(oldWorker.terminated).toBe(1);
    expect(environment.timers.size).toBe(0);
    const next = setup(environment);
    const second = next.recognize(next.request);
    await tick();
    oldHandler({ data: { ...oldPacket, status: 'resolve', data: {} } });
    const fresh = environment.workers[1];
    expect(fresh.sent).toHaveLength(1);
    await ready(fresh);
    fresh.emit('resolve', page(word('New')));
    expect((await second).text).toBe('New');
  });
  it('cancels recognition without accepting partial output', async () => {
    const { environment, recognize, request, controller } = setup();
    const result = recognize(request);
    const rejected = expect(result).rejects.toMatchObject({ name: 'AbortError' });
    await tick();
    const worker = environment.workers[0];
    await ready(worker);
    controller.abort();
    await rejected;
    expect(worker.terminated).toBe(1);
  });
  it('allows one active job across independently created controllers', async () => {
    const first = setup(),
      second = setup();
    const running = first.recognize(first.request);
    const rejected = expect(running).rejects.toMatchObject({ name: 'AbortError' });
    await expect(second.recognize(second.request)).rejects.toMatchObject({ code: 'busy' });
    expect(second.environment.workers).toHaveLength(0);
    first.controller.abort();
    await rejected;
  });
  it.each(['initialization', 'recognition'])(
    'bounds stalled %s with a hard worker termination',
    async (phase) => {
      const { environment, recognize, request } = setup();
      const result = recognize(request);
      const rejected = expect(result).rejects.toMatchObject({ code: 'timeout' });
      await tick();
      const worker = environment.workers[0];
      if (phase === 'recognition') await ready(worker);
      environment.expire();
      await rejected;
      expect(worker.terminated).toBe(1);
      expect(environment.timers.size).toBe(0);
    },
  );
  it('forwards bounded progress without engine strings or stale phase progress', async () => {
    const { environment, recognize, request, controller } = setup();
    const progress: OcrProgress[] = [];
    const result = recognize({ ...request, onProgress: (value) => progress.push(value) });
    const rejected = expect(result).rejects.toMatchObject({ name: 'AbortError' });
    await tick();
    const worker = environment.workers[0];
    const first = worker.latest();
    worker.emit('progress', { progress: 0.6, status: 'private engine detail' });
    expect(progress.at(-1)).toEqual({ stage: 'loading', progress: 0.6 / 3 });
    await ready(worker);
    worker.emit('progress', { progress: 2 });
    expect(progress.at(-1)).toEqual({ stage: 'recognizing', progress: 1 });
    const count = progress.length;
    worker.emit('progress', { progress: 0.1 }, first);
    worker.emit('progress', { progress: NaN });
    expect(progress).toHaveLength(count);
    expect(JSON.stringify(progress)).not.toContain('private');
    controller.abort();
    await rejected;
  });
  it('does not strand a worker when the progress observer throws or cancels', async () => {
    const first = setup();
    const result = first.recognize({
      ...first.request,
      onProgress: () => {
        throw new Error('UI callback');
      },
    });
    await tick();
    const worker = first.environment.workers[0];
    await ready(worker);
    worker.emit('resolve', page(word('Complete')));
    expect((await result).text).toBe('Complete');
    const second = setup();
    await expect(
      second.recognize({ ...second.request, onProgress: () => second.controller.abort() }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(second.environment.workers[0].terminated).toBe(1);
    expect(second.environment.workers[0].sent).toHaveLength(0);
  });
  it.each(['reject', 'error', 'messageerror', 'send', 'create'])(
    'cleans up %s failures without echoing raw engine errors',
    async (failure) => {
      const { environment, recognize, request } = setup();
      environment.failCreate = failure === 'create';
      const result = recognize(request);
      const rejected = expect(result).rejects.toMatchObject({
        code: 'engine',
        message: 'Local text recognition failed. Try this page again.',
      });
      await tick();
      const worker = environment.workers[0];
      if (failure === 'reject') worker.emit('reject', 'private document details');
      if (failure === 'error') worker.onerror?.({ preventDefault() {} });
      if (failure === 'messageerror') worker.onmessageerror?.();
      if (failure === 'send') {
        worker.failSend = true;
        worker.emit('resolve');
      }
      await rejected;
      if (worker) expect(worker.terminated).toBe(1);
      expect(environment.timers.size).toBe(0);
    },
  );
  it('rejects invalid result geometry and releases the global worker slot', async () => {
    const { environment, recognize, request } = setup();
    const result = recognize(request);
    const rejected = expect(result).rejects.toMatchObject({ code: 'invalid_result' });
    await tick();
    const worker = environment.workers[0];
    await ready(worker);
    worker.emit('resolve', page(word('Outside', 1, 1, 1000, 10)));
    await rejected;
    expect(worker.terminated).toBe(1);
  });
  it('checks dimensions and the PNG header before allocating a worker', async () => {
    for (const [width, height] of [
      [0, 1],
      [4097, 1],
      [2001, 2000],
      [1.5, 2],
      [NaN, 2],
      [Infinity, 1],
    ])
      expect(() => validateOcrDimensions(width, height)).toThrow();
    expect(() => validateOcrDimensions(2000, 2000)).not.toThrow();
    const { environment, recognize, request } = setup();
    await expect(recognize({ ...request, width: 99 })).rejects.toMatchObject({
      code: 'invalid_image',
    });
    await expect(
      recognize({ ...request, image: new Blob([new Uint8Array(33)], { type: 'image/png' }) }),
    ).rejects.toMatchObject({ code: 'invalid_image' });
    await expect(
      recognize({ ...request, image: new Blob(['private'], { type: 'image/jpeg' }) }),
    ).rejects.toMatchObject({ code: 'invalid_image' });
    expect(environment.workers).toHaveLength(0);
    expect(environment.timers.size).toBe(0);
  });
  it('rejects already cancelled requests without worker creation', async () => {
    const { environment, recognize, request, controller } = setup();
    controller.abort();
    await expect(recognize(request)).rejects.toMatchObject({ name: 'AbortError' });
    expect(environment.workers).toHaveLength(0);
  });
  it('does not choose a remote or unsupported-origin worker fallback', async () => {
    const { environment, recognize, request } = setup();
    environment.origin = 'data:text/html,unsupported';
    await expect(recognize(request)).rejects.toMatchObject({ code: 'unsupported' });
    expect(environment.workers).toHaveLength(0);
    await expect(recognizeRaster(request)).rejects.toMatchObject({ code: 'unsupported' });
  });
});
