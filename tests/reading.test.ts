import { describe, expect, it, vi } from 'vitest';
import {
  ReadingController,
  createReadingPlan,
  MAX_READING_CHARACTERS,
  MAX_UTTERANCE_CHARACTERS,
  READING_RATES,
  READING_START_TIMEOUT_MS,
  type ReadingClock,
  type ReadingEngine,
} from '../apps/web/src/editor/reading';
const voice = (voiceURI: string, localService = true, isDefault = false): SpeechSynthesisVoice => ({
  voiceURI,
  name: voiceURI,
  lang: 'en-US',
  localService,
  default: isDefault,
});
class FakeClock implements ReadingClock {
  now = 0;
  id = 0;
  tasks = new Map<number, { at: number; callback: () => void }>();
  setTimeout(callback: () => void, delay: number) {
    const id = ++this.id;
    this.tasks.set(id, { at: this.now + delay, callback });
    return id;
  }
  clearTimeout(handle: unknown) {
    this.tasks.delete(handle as number);
  }
  advance(milliseconds: number) {
    this.now += milliseconds;
    for (const [id, task] of [...this.tasks])
      if (task.at <= this.now) {
        this.tasks.delete(id);
        task.callback();
      }
  }
}
class FakeEngine implements ReadingEngine {
  voices = [voice('local-a'), voice('local-b')];
  created: SpeechSynthesisUtterance[] = [];
  spoken: SpeechSynthesisUtterance[] = [];
  listeners = new Set<() => void>();
  calls: string[] = [];
  throws: 'get' | 'speak' | 'pause' | 'resume' | 'cancel' | null = null;
  getVoices() {
    if (this.throws === 'get') throw new Error('private engine detail');
    return this.voices;
  }
  createUtterance(text: string) {
    const utterance = {
      text,
      voice: null,
      lang: '',
      rate: 1,
      onstart: null,
      onend: null,
      onerror: null,
      onpause: null,
      onresume: null,
      onboundary: null,
    } as unknown as SpeechSynthesisUtterance;
    this.created.push(utterance);
    return utterance;
  }
  speak(utterance: SpeechSynthesisUtterance) {
    this.calls.push('speak');
    if (this.throws === 'speak') throw new Error('private engine detail');
    this.spoken.push(utterance);
  }
  cancel() {
    this.calls.push('cancel');
    if (this.throws === 'cancel') throw new Error('private engine detail');
  }
  pause() {
    this.calls.push('pause');
    if (this.throws === 'pause') throw new Error('private engine detail');
  }
  resume() {
    this.calls.push('resume');
    if (this.throws === 'resume') throw new Error('private engine detail');
  }
  listenVoices(listener: () => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  voicesChanged() {
    for (const listener of this.listeners) listener();
  }
  current() {
    return this.spoken.at(-1)!;
  }
}
const fire = (
  utterance: SpeechSynthesisUtterance,
  type: 'start' | 'end' | 'pause' | 'resume' | 'error' | 'boundary',
  data: Partial<SpeechSynthesisEvent> = {},
) => {
  const event = {
    utterance,
    charIndex: 0,
    charLength: 0,
    name: '',
    ...data,
  } as SpeechSynthesisEvent;
  const callback = utterance[`on${type}`] as ((event: SpeechSynthesisEvent) => void) | null;
  callback?.call(utterance, event);
};
function setup(text = 'First sentence. Second sentence.', engine = new FakeEngine()) {
  const clock = new FakeClock();
  const controller = new ReadingController(engine, { clock });
  controller.connect();
  controller.setContext(text, 'document-a:page-1');
  return { controller, engine, clock };
}

describe('read-aloud segmentation without altered source offsets', () => {
  it('keeps exact UTF-16 slices through astral, combining, RTL, quotes and whitespace', () => {
    const text =
      '  🧪 Cafe\u0301 science.\n"שלום עולם!"  東京です。\nLast sentence without punctuation';
    const plan = createReadingPlan(text);
    expect(plan.chunks.map((range) => text.slice(range.start, range.end)).join('')).toBe(text);
    expect(plan.sentences[0].start).toBe(0);
    expect(plan.sentences.at(-1)?.end).toBe(text.length);
    for (const range of [...plan.sentences, ...plan.chunks]) {
      expect(range.end).toBeGreaterThan(range.start);
      expect(text.slice(range.start, range.end)).not.toMatch(/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/u);
    }
  });
  it('bounds punctuationless utterances and preserves every original grapheme and whitespace', () => {
    const text = 'a'.repeat(239) + '👩🏽‍🔬' + 'e\u0301'.repeat(230) + '  ' + 'x'.repeat(1200);
    const plan = createReadingPlan(text);
    expect(plan.sentences).toHaveLength(1);
    expect(plan.chunks.length).toBeGreaterThan(5);
    expect(plan.chunks.map((range) => text.slice(range.start, range.end)).join('')).toBe(text);
    const allowed = new Set(
      Array.from(
        new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text),
        (part) => part.index,
      ),
    );
    allowed.add(text.length);
    for (const range of plan.chunks) {
      expect(range.end - range.start).toBeLessThanOrEqual(MAX_UTTERANCE_CHARACTERS);
      expect(allowed.has(range.start)).toBe(true);
      expect(allowed.has(range.end)).toBe(true);
    }
  });
  it('refuses oversized, malformed and overlong single-cluster input without truncation', () => {
    expect(() => createReadingPlan('x'.repeat(MAX_READING_CHARACTERS + 1))).toThrow(
      'No text has been truncated',
    );
    expect(() => createReadingPlan('Broken \ud800 text')).toThrow('invalid text encoding');
    expect(() => createReadingPlan('a' + '\u0301'.repeat(MAX_UTTERANCE_CHARACTERS))).toThrow(
      'cluster too long',
    );
    expect(() => createReadingPlan(' \r\n\t ')).toThrow('no selectable text');
  });
  it('has a grapheme-safe, offset-preserving fallback when Intl.Segmenter is unavailable', () => {
    const original = Intl.Segmenter;
    Object.defineProperty(Intl, 'Segmenter', { configurable: true, value: undefined });
    try {
      const text = 'First. \n' + 'e\u0301'.repeat(121) + '👩🏽‍🔬' + ' 🇺🇸 '.repeat(35) + 'آخر جملة!';
      const plan = createReadingPlan(text);
      expect(plan.chunks.map((range) => text.slice(range.start, range.end)).join('')).toBe(text);
      const boundaries = new Set(
        Array.from(
          new original(undefined, { granularity: 'grapheme' }).segment(text),
          (part) => part.index,
        ),
      );
      boundaries.add(text.length);
      expect(
        plan.chunks.every((range) => boundaries.has(range.start) && boundaries.has(range.end)),
      ).toBe(true);
    } finally {
      Object.defineProperty(Intl, 'Segmenter', { configurable: true, value: original });
    }
  });
});

describe('local-only speech controller', () => {
  it('distinguishes unsupported, empty text and a missing local voice', () => {
    const unsupported = new ReadingController(null);
    unsupported.setContext('A page.', 'one');
    unsupported.play();
    expect(unsupported.getSnapshot()).toMatchObject({
      status: 'error',
      supported: false,
      errorCode: 'unsupported',
    });
    const empty = setup(' ');
    empty.controller.play();
    expect(empty.controller.getSnapshot().errorCode).toBe('no-text');
    expect(empty.engine.spoken).toHaveLength(0);
    const engine = new FakeEngine();
    engine.voices = [voice('remote-default', false, true)];
    const noLocal = setup('A page.', engine);
    noLocal.controller.play();
    expect(noLocal.controller.getSnapshot()).toMatchObject({
      errorCode: 'no-local-voice',
      voices: [],
      voiceURI: '',
    });
    expect(engine.spoken).toHaveLength(0);
  });
  it('waits for asynchronously enumerated local voices and never defaults to a remote voice', () => {
    const engine = new FakeEngine();
    engine.voices = [];
    const { controller } = setup('An entirely local page.', engine);
    expect(controller.getSnapshot()).toMatchObject({ voicesReady: false, voiceURI: '' });
    controller.play();
    expect(engine.spoken).toHaveLength(0);
    const local = voice('installed-local');
    engine.voices = [voice('remote-default', false, true), local];
    engine.voicesChanged();
    expect(controller.getSnapshot()).toMatchObject({
      voicesReady: true,
      voiceURI: local.voiceURI,
      voices: [local],
    });
    expect(engine.spoken).toHaveLength(0); // Loading voices does not autoplay page content.
    controller.play();
    expect(engine.current().voice).toBe(local);
    expect(engine.current().lang).toBe('en-US');
    expect(engine.calls.slice(-2)).toEqual(['resume', 'speak']);
    controller.setVoiceURI('remote-default');
    expect(controller.getSnapshot().errorCode).toBe('no-local-voice');
    expect(engine.spoken.every((utterance) => utterance.voice?.localService === true)).toBe(true);
  });
  it('uses native starts for sentence fallback and actual boundaries for source word offsets', () => {
    const text = '🧪 Cafe\u0301 science.\nSecond sentence.';
    const { controller, engine } = setup(text);
    controller.play();
    expect(controller.getSnapshot()).toMatchObject({
      status: 'starting',
      sentence: null,
      word: null,
      boundarySupport: 'unknown',
    });
    fire(engine.current(), 'start');
    expect(controller.getSnapshot()).toMatchObject({
      status: 'playing',
      sentence: createReadingPlan(text).sentences[0],
      word: null,
    });
    const start = text.indexOf('Cafe'),
      length = 'Cafe\u0301'.length;
    fire(engine.current(), 'boundary', { name: 'word', charIndex: start, charLength: length });
    expect(controller.getSnapshot().word).toEqual({ start, end: start + length });
    expect(
      text.slice(controller.getSnapshot().sentence!.start, controller.getSnapshot().sentence!.end),
    ).toBe('🧪 Cafe\u0301 science.\n');
    fire(engine.current(), 'end');
    expect(controller.getSnapshot()).toMatchObject({
      status: 'starting',
      word: null,
      sentence: null,
    });
    fire(engine.current(), 'start');
    fire(engine.current(), 'boundary', { name: 'sentence', charIndex: 0 });
    expect(controller.getSnapshot().word).toBeNull();
    expect(
      text.slice(controller.getSnapshot().sentence!.start, controller.getSnapshot().sentence!.end),
    ).toBe('Second sentence.');
    fire(engine.current(), 'end');
    expect(controller.getSnapshot()).toMatchObject({ status: 'idle', word: null, sentence: null });
  });
  it('derives a missing word length cautiously from a genuine boundary, ignores invalid/stale positions', () => {
    const { controller, engine } = setup('🧪 First word.');
    controller.play();
    fire(engine.current(), 'boundary', { name: 'word', charIndex: 3, charLength: 0 });
    expect(controller.getSnapshot().word).toEqual({ start: 3, end: 8 });
    const expected = controller.getSnapshot().word;
    for (const charIndex of [-1, 1, 100, NaN, 2.5])
      fire(engine.current(), 'boundary', { name: 'word', charIndex, charLength: 4 });
    expect(controller.getSnapshot().word).toEqual(expected);
    fire(engine.current(), 'boundary', { name: 'mark', charIndex: 9, charLength: 4 });
    expect(controller.getSnapshot().word).toEqual(expected);
  });
  it('queues one bounded utterance at a time and offsets later boundaries correctly', () => {
    const text = 'alpha '.repeat(130);
    const { controller, engine } = setup(text);
    controller.play();
    const plan = createReadingPlan(text);
    expect(engine.created).toHaveLength(1);
    for (const [index, chunk] of plan.chunks.entries()) {
      expect(engine.current().text).toBe(text.slice(chunk.start, chunk.end));
      fire(engine.current(), 'start');
      fire(engine.current(), 'boundary', { name: 'word', charIndex: 0, charLength: 5 });
      expect(controller.getSnapshot().word).toEqual({ start: chunk.start, end: chunk.start + 5 });
      fire(engine.current(), 'end');
      expect(engine.created).toHaveLength(Math.min(index + 2, plan.chunks.length));
    }
    expect(controller.getSnapshot().status).toBe('idle');
  });
  it('pauses/resumes without new utterances and explicitly resumes a fresh queue after stop', () => {
    const { controller, engine } = setup();
    controller.play();
    fire(engine.current(), 'start');
    controller.pause();
    expect(controller.getSnapshot().status).toBe('paused');
    controller.play();
    expect(controller.getSnapshot().status).toBe('starting');
    fire(engine.current(), 'resume');
    expect(controller.getSnapshot().status).toBe('playing');
    expect(engine.created).toHaveLength(1);
    controller.pause();
    controller.stop();
    controller.play();
    expect(engine.calls.slice(-3)).toEqual(['cancel', 'resume', 'speak']);
    expect(engine.created).toHaveLength(2);
  });
  it('restarts the current sentence for rate/voice changes and preserves paused intent', () => {
    const text = 'First sentence. Second sentence.';
    const { controller, engine } = setup(text);
    controller.play();
    fire(engine.current(), 'end');
    fire(engine.current(), 'boundary', { name: 'word', charIndex: 0, charLength: 6 });
    controller.setRate(1.5);
    expect(engine.current().text).toBe('Second sentence.');
    expect(engine.current().rate).toBe(1.5);
    fire(engine.current(), 'start');
    controller.pause();
    const count = engine.created.length;
    controller.setVoiceURI('local-b');
    expect(controller.getSnapshot()).toMatchObject({ status: 'paused', voiceURI: 'local-b' });
    expect(engine.created).toHaveLength(count);
    controller.resume();
    expect(engine.created).toHaveLength(count + 1);
    expect(engine.current().text).toBe('Second sentence.');
    expect(engine.current().voice?.voiceURI).toBe('local-b');
    for (const rate of READING_RATES) {
      controller.stop();
      controller.setRate(rate);
      controller.play();
      expect(engine.current().rate).toBe(rate);
    }
    controller.setRate(0.6);
    expect(controller.getSnapshot().errorCode).toBe('invalid-setting');
  });
  it('ignores every late callback after stop, restart, source change and disposal', () => {
    const { controller, engine } = setup();
    controller.play();
    const first = engine.current();
    const late = {
      start: first.onstart,
      end: first.onend,
      error: first.onerror,
      pause: first.onpause,
      resume: first.onresume,
      boundary: first.onboundary,
    };
    controller.stop();
    controller.play();
    fire(engine.current(), 'start');
    const active = engine.current(),
      snapshot = controller.getSnapshot();
    for (const callback of Object.values(late))
      callback?.call(first, {
        charIndex: 0,
        charLength: 5,
        name: 'word',
      } as SpeechSynthesisErrorEvent);
    expect(controller.getSnapshot()).toEqual(snapshot);
    expect(engine.current()).toBe(active);
    controller.setContext('New page.', 'document-a:page-2');
    expect(controller.getSnapshot().status).toBe('idle');
    expect(active.onend).toBeNull();
    controller.play();
    const last = engine.current(),
      lateEnd = last.onend;
    const listener = vi.fn();
    controller.subscribe(listener);
    controller.dispose();
    lateEnd?.call(last, {} as SpeechSynthesisEvent);
    engine.voicesChanged();
    expect(listener).not.toHaveBeenCalled();
    expect(engine.listeners.size).toBe(0);
    expect(last.onboundary).toBeNull();
    expect(engine.calls.at(-1)).toBe('cancel');
  });
  it('stops rather than falling back when the selected local voice disappears or becomes remote', () => {
    const { controller, engine } = setup();
    controller.play();
    engine.voices = [voice('local-a', false), voice('local-b')];
    engine.voicesChanged();
    expect(controller.getSnapshot()).toMatchObject({
      status: 'error',
      errorCode: 'voice-unavailable',
      voiceURI: '',
    });
    controller.play();
    expect(engine.spoken).toHaveLength(1);
    controller.setVoiceURI('local-b');
    controller.play();
    expect(engine.current().voice?.voiceURI).toBe('local-b');
  });
  it('prefers an explicitly enumerated local voice matching the UI language', () => {
    const engine = new FakeEngine(),
      clock = new FakeClock();
    const english = voice('English local');
    const french = { ...voice('French local'), lang: 'fr-FR' };
    engine.voices = [voice('Remote French', false, true), english, french];
    const controller = new ReadingController(engine, { clock, preferredLanguage: 'fr-CA' });
    controller.connect();
    controller.setContext('Bonjour.', 'page');
    controller.play();
    expect(engine.current().voice).toBe(french);
  });
  it('times out silent startup/resume without manufacturing progress or highlights', () => {
    const { controller, engine, clock } = setup('Only one sentence.');
    controller.play();
    clock.advance(READING_START_TIMEOUT_MS - 1);
    expect(controller.getSnapshot()).toMatchObject({
      status: 'starting',
      word: null,
      sentence: null,
    });
    clock.advance(1);
    expect(controller.getSnapshot()).toMatchObject({
      status: 'error',
      errorCode: 'engine',
      word: null,
      sentence: null,
    });
    expect(controller.getSnapshot().error).toContain('10 seconds');
    expect(engine.calls.at(-1)).toBe('cancel');
    controller.play();
    fire(engine.current(), 'start');
    expect(clock.tasks.size).toBe(0);
    controller.pause();
    controller.resume();
    expect(clock.tasks.size).toBe(1);
    clock.advance(READING_START_TIMEOUT_MS);
    expect(controller.getSnapshot().status).toBe('error');
  });
  it('clears startup deadlines on real boundaries, pause, context changes and disposal', () => {
    const { controller, engine, clock } = setup();
    controller.play();
    fire(engine.current(), 'boundary', { name: 'word', charIndex: 0, charLength: 5 });
    expect(clock.tasks.size).toBe(0);
    controller.stop();
    controller.play();
    controller.pause();
    expect(clock.tasks.size).toBe(0);
    clock.advance(READING_START_TIMEOUT_MS * 2);
    expect(controller.getSnapshot().status).toBe('paused');
    const paused = controller.getSnapshot();
    fire(engine.current(), 'boundary', { name: 'word', charIndex: 6, charLength: 8 });
    expect(controller.getSnapshot()).toEqual(paused);
    controller.resume();
    // A delayed acknowledgement of the old pause must not pause the resumed session again.
    fire(engine.current(), 'pause');
    expect(controller.getSnapshot().status).toBe('starting');
    fire(engine.current(), 'resume');
    expect(clock.tasks.size).toBe(0);
    controller.stop();
    controller.play();
    controller.setContext('Next.', 'page-2');
    expect(clock.tasks.size).toBe(0);
    controller.play();
    controller.dispose();
    expect(clock.tasks.size).toBe(0);
  });
  it('does not cross natural sentence boundaries or stall on large whitespace-only prefixes', () => {
    const text = ' '.repeat(800) + 'One sentence. Another sentence.';
    const { controller, engine } = setup(text);
    controller.play();
    expect(engine.current().text).toContain('One sentence.');
    expect(engine.current().text).not.toContain('Another');
    fire(engine.current(), 'start');
    expect(controller.getSnapshot().sentence?.end).toBe(text.indexOf('Another'));
    fire(engine.current(), 'end');
    fire(engine.current(), 'start');
    expect(engine.current().text).toBe('Another sentence.');
    expect(controller.getSnapshot().sentence?.start).toBe(text.indexOf('Another'));
  });
  it('neutralizes potential SSML without changing source offsets or exposing text in errors', () => {
    const text = '<speak><audio src="https://example.test/private"/>Read locally.</speak>';
    const { controller, engine } = setup(text);
    controller.play();
    expect(engine.current().text).not.toContain('<');
    expect(engine.current().text.length).toBe(text.length);
    fire(engine.current(), 'boundary', {
      name: 'word',
      charIndex: text.indexOf('Read'),
      charLength: 4,
    });
    expect(controller.getSnapshot().word).toEqual({
      start: text.indexOf('Read'),
      end: text.indexOf('Read') + 4,
    });
    fire(engine.current(), 'error');
    expect(controller.getSnapshot().errorCode).toBe('engine');
    expect(controller.getSnapshot().error).not.toContain('private');
    expect(controller.getSnapshot().error).not.toContain('Read locally');
  });
  it.each(['get', 'speak', 'pause', 'resume'] as const)(
    'contains %s engine failures without leaking raw errors',
    (operation) => {
      const { controller, engine } = setup();
      if (operation === 'pause') {
        controller.play();
        fire(engine.current(), 'start');
      }
      engine.throws = operation;
      if (operation === 'pause') controller.pause();
      else controller.play();
      expect(controller.getSnapshot()).toMatchObject({
        status: 'error',
        errorCode: 'engine',
        word: null,
        sentence: null,
      });
      expect(controller.getSnapshot().error).not.toContain('private engine detail');
    },
  );
});
