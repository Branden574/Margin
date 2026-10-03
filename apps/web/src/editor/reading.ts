/** Page text is never persisted or sent to an application/network service by this module. */
export const READING_RATES = [0.5, 0.75, 1, 1.25, 1.5, 2] as const;
export type ReadingRate = (typeof READING_RATES)[number];
/** UTF-16 code units, matching the page text extractor. Oversize pages are refused, not cut. */
export const MAX_READING_CHARACTERS = 200_000;
export const MAX_UTTERANCE_CHARACTERS = 240;
export const READING_START_TIMEOUT_MS = 10_000;
export interface ReadingRange {
  start: number;
  end: number;
}
export interface ReadingPlan {
  sentences: ReadingRange[];
  chunks: ReadingRange[];
}
export type ReadingErrorCode =
  | 'unsupported'
  | 'no-text'
  | 'no-local-voice'
  | 'voice-unavailable'
  | 'text-too-long'
  | 'text-format'
  | 'invalid-setting'
  | 'engine';
export interface ReadingSnapshot {
  status: 'idle' | 'starting' | 'playing' | 'paused' | 'error';
  supported: boolean;
  voices: SpeechSynthesisVoice[];
  voicesReady: boolean;
  voiceURI: string;
  rate: ReadingRate;
  sentence: ReadingRange | null;
  word: ReadingRange | null;
  boundarySupport: 'unknown' | 'sentence' | 'word';
  error: string;
  errorCode: ReadingErrorCode | null;
}
export interface ReadingEngine {
  getVoices(): SpeechSynthesisVoice[];
  createUtterance(text: string): SpeechSynthesisUtterance;
  speak(utterance: SpeechSynthesisUtterance): void;
  cancel(): void;
  pause(): void;
  resume(): void;
  listenVoices(listener: () => void): () => void;
}
export interface ReadingClock {
  setTimeout(callback: () => void, delay: number): unknown;
  clearTimeout(handle: unknown): void;
}
export interface ReadingControllerOptions {
  preferredLanguage?: string;
  clock?: ReadingClock;
}
const defaultClock: ReadingClock = {
  setTimeout: (callback, delay) => setTimeout(callback, delay),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};
export function initialReadingSnapshot(supported: boolean): ReadingSnapshot {
  return {
    status: 'idle',
    supported,
    voices: [],
    voicesReady: false,
    voiceURI: '',
    rate: 1,
    sentence: null,
    word: null,
    boundarySupport: 'unknown',
    error: '',
    errorCode: null,
  };
}
class ReadingFailure extends Error {
  constructor(
    readonly code: ReadingErrorCode,
    message: string,
  ) {
    super(message);
  }
}
function sentenceRanges(text: string): ReadingRange[] {
  if (typeof Intl.Segmenter === 'function') {
    return Array.from(
      new Intl.Segmenter(undefined, { granularity: 'sentence' }).segment(text),
      (part) => ({ start: part.index, end: part.index + part.segment.length }),
    ).filter((range) => /\S/u.test(text.slice(range.start, range.end)));
  }
  // Conservative punctuation/newline fallback; slices and UTF-16 offsets stay unchanged.
  const ranges: ReadingRange[] = [];
  const endings = /[.!?。！？]+[”’"'»）)\]]*(?:\s+|$)|[\r\n]+/gu;
  let start = 0;
  for (const match of text.matchAll(endings)) {
    const end = match.index! + match[0].length;
    if (/\S/u.test(text.slice(start, end))) ranges.push({ start, end });
    start = end;
  }
  if (/\S/u.test(text.slice(start))) ranges.push({ start, end: text.length });
  return ranges;
}
function graphemeEnds(text: string): number[] {
  if (typeof Intl.Segmenter === 'function')
    return Array.from(
      new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text),
      (part) => part.index + part.segment.length,
    );
  // Keep surrogate pairs, combining marks, emoji modifiers/ZWJ sequences and flag pairs
  // together when Segmenter is unavailable. This is a bounded chunking fallback, not NLP.
  const ends: number[] = [];
  let offset = 0,
    previous = '',
    regionalCount = 0;
  for (const point of text) {
    const regional = /[\u{1f1e6}-\u{1f1ff}]/u.test(point);
    const joined =
      !offset ||
      /[\p{M}\u200d\ufe0e\ufe0f\u{1f3fb}-\u{1f3ff}]/u.test(point) ||
      previous === '\u200d' ||
      (previous === '\r' && point === '\n') ||
      (regional && regionalCount % 2 === 1);
    if (!joined) ends.push(offset);
    regionalCount = regional ? regionalCount + 1 : 0;
    offset += point.length;
    previous = point;
  }
  if (offset) ends.push(offset);
  return ends;
}
function lastAtOrBefore(values: number[], target: number): number {
  let low = 0,
    high = values.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (values[middle] <= target) low = middle + 1;
    else high = middle;
  }
  return low ? values[low - 1] : 0;
}
export function createReadingPlan(text: string): ReadingPlan {
  if (text.length > MAX_READING_CHARACTERS)
    throw new ReadingFailure(
      'text-too-long',
      `This page exceeds the ${MAX_READING_CHARACTERS.toLocaleString('en-US')}-character read-aloud limit. No text has been truncated or read.`,
    );
  if (!/\S/u.test(text))
    throw new ReadingFailure(
      'no-text',
      'This page has no selectable text to read. Scanned pages need OCR.',
    );
  if (/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(text))
    throw new ReadingFailure(
      'text-format',
      'This page contains invalid text encoding and cannot be read safely.',
    );
  const sentences = sentenceRanges(text),
    ends = graphemeEnds(text);
  const chunks: ReadingRange[] = [];
  let start = 0;
  // Never cross a natural sentence boundary: onstart can then identify the sentence
  // even when a local voice supplies no word-boundary events.
  for (const sentenceEnd of [...sentences.map((range) => range.end), text.length]) {
    while (start < sentenceEnd) {
      const maximum = Math.min(start + MAX_UTTERANCE_CHARACTERS, sentenceEnd);
      let end = lastAtOrBefore(ends, maximum);
      if (end <= start)
        throw new ReadingFailure(
          'text-format',
          'This page contains a text cluster too long for the local speech engine. No text has been truncated.',
        );
      if (end < sentenceEnd) {
        // Retain whitespace in its original slice; never normalize or trim utterances.
        for (let i = end - 1; i > start + MAX_UTTERANCE_CHARACTERS / 2; i--)
          if (/\s/u.test(text[i]) && lastAtOrBefore(ends, i + 1) === i + 1) {
            end = i + 1;
            break;
          }
      }
      chunks.push({ start, end });
      start = end;
    }
  }
  return { sentences, chunks };
}
function atOffset(ranges: ReadingRange[], offset: number): ReadingRange | null {
  let low = 0,
    high = ranges.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (ranges[middle].end <= offset) low = middle + 1;
    else high = middle;
  }
  return ranges[low] ?? null;
}
function codePointBoundary(text: string, index: number): boolean {
  return !(
    index > 0 &&
    index < text.length &&
    /[\uD800-\uDBFF]/u.test(text[index - 1]) &&
    /[\uDC00-\uDFFF]/u.test(text[index])
  );
}
function eventWordRange(text: string, index: number, length: number): ReadingRange | null {
  if (
    Number.isInteger(length) &&
    length > 0 &&
    index + length <= text.length &&
    codePointBoundary(text, index + length)
  )
    return /\S/u.test(text.slice(index, index + length))
      ? { start: index, end: index + length }
      : null;
  if (length !== 0 && length !== undefined) return null;
  // A zero length means the engine did not supply it. Locate a source word only in
  // response to a genuine word event. charIndex is approximate per the Web Speech spec.
  if (typeof Intl.Segmenter === 'function') {
    for (const part of new Intl.Segmenter(undefined, { granularity: 'word' }).segment(text))
      if (part.isWordLike && part.index + part.segment.length > index)
        return { start: part.index, end: part.index + part.segment.length };
    return null;
  }
  for (const match of text.matchAll(/[\p{L}\p{N}\p{M}]+(?:['’][\p{L}\p{N}\p{M}]+)*/gu))
    if (match.index! + match[0].length > index)
      return { start: match.index!, end: match.index! + match[0].length };
  return null;
}
const ENGINE_ERROR =
  'The local speech engine could not continue. Check your device audio or installed voice, then try again.';

/** Dependency-injected, single-utterance queue. Native events are the sole timing source. */
export class ReadingController {
  private state: ReadingSnapshot;
  private listeners = new Set<(snapshot: ReadingSnapshot) => void>();
  private removeVoices: (() => void) | null = null;
  private disposed = false;
  private generation = 0;
  private text = '';
  private contextKey = '';
  private plan: ReadingPlan | null = null;
  private queue: ReadingRange[] = [];
  private queueIndex = 0;
  private utterance: SpeechSynthesisUtterance | null = null;
  private lastOffset: number | null = null;
  private pauseRequested = false;
  private restartOffset: number | null = null;
  private hadVoice = false;
  private deadline: unknown = null;
  private readonly clock: ReadingClock;
  constructor(
    private readonly engine: ReadingEngine | null,
    private readonly options: ReadingControllerOptions = {},
  ) {
    this.state = initialReadingSnapshot(Boolean(engine));
    this.clock = options.clock ?? defaultClock;
  }
  getSnapshot = () => this.state;
  subscribe = (listener: (snapshot: ReadingSnapshot) => void) => {
    if (this.disposed) return () => {};
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private publish(update: Partial<ReadingSnapshot>) {
    if (this.disposed) return;
    this.state = { ...this.state, ...update };
    for (const listener of this.listeners) listener(this.state);
  }
  connect() {
    if (this.disposed || !this.engine || this.removeVoices) return;
    try {
      this.removeVoices = this.engine.listenVoices(() => this.refreshVoices(true));
      this.refreshVoices();
    } catch {
      this.fail('engine', ENGINE_ERROR);
    }
  }
  refreshVoices = (receivedEvent = false) => {
    if (this.disposed || !this.engine) return;
    try {
      const all = this.engine.getVoices(),
        seen = new Set<string>();
      const voices = all.filter((voice) => {
        if (voice.localService !== true || !voice.voiceURI || seen.has(voice.voiceURI))
          return false;
        seen.add(voice.voiceURI);
        return true;
      });
      const current = voices.find((voice) => voice.voiceURI === this.state.voiceURI);
      let voiceURI = current?.voiceURI ?? '';
      if (!this.hadVoice && !voiceURI && voices.length) {
        const language = this.options.preferredLanguage?.replaceAll('_', '-').toLowerCase();
        const matching = language
          ? voices.filter((voice) => voice.lang.toLowerCase() === language)
          : [];
        const sameLanguage = language
          ? voices.filter(
              (voice) => voice.lang.toLowerCase().split('-')[0] === language.split('-')[0],
            )
          : [];
        voiceURI = (
          matching.find((voice) => voice.default) ??
          matching[0] ??
          sameLanguage.find((voice) => voice.default) ??
          sameLanguage[0] ??
          voices.find((voice) => voice.default) ??
          voices[0]
        ).voiceURI;
        this.hadVoice = true;
      }
      const lost = Boolean(this.state.voiceURI && !current);
      this.publish({
        voices,
        voicesReady: this.state.voicesReady || receivedEvent || all.length > 0,
        voiceURI,
      });
      if (lost)
        this.fail(
          'voice-unavailable',
          'The selected local voice is no longer available. Choose an installed local voice to continue.',
        );
    } catch {
      this.fail('engine', ENGINE_ERROR);
    }
  };
  setContext(text: string, contextKey: string) {
    if (this.disposed || (text === this.text && contextKey === this.contextKey)) return;
    this.stop();
    this.text = text;
    this.contextKey = contextKey;
    this.plan = null;
  }
  private detach(utterance: SpeechSynthesisUtterance) {
    utterance.onstart =
      utterance.onend =
      utterance.onerror =
      utterance.onpause =
      utterance.onresume =
      utterance.onboundary =
        null;
  }
  private clearDeadline() {
    if (this.deadline !== null) this.clock.clearTimeout(this.deadline);
    this.deadline = null;
  }
  private armDeadline() {
    this.clearDeadline();
    const generation = this.generation,
      utterance = this.utterance;
    this.deadline = this.clock.setTimeout(() => {
      this.deadline = null;
      if (
        !this.disposed &&
        generation === this.generation &&
        this.utterance === utterance &&
        this.state.status === 'starting'
      )
        this.fail(
          'engine',
          'The local voice did not start within 10 seconds. Try another installed voice or check device audio.',
        );
    }, READING_START_TIMEOUT_MS);
  }
  private cancelCurrent(): boolean {
    this.clearDeadline();
    this.generation++;
    const utterance = this.utterance;
    this.utterance = null;
    if (utterance) this.detach(utterance);
    try {
      if (utterance) this.engine?.cancel();
      return true;
    } catch {
      return false;
    }
  }
  private fail(code: ReadingErrorCode, message: string) {
    this.cancelCurrent();
    this.queue = [];
    this.queueIndex = 0;
    this.restartOffset = null;
    this.pauseRequested = false;
    this.publish({ status: 'error', sentence: null, word: null, error: message, errorCode: code });
  }
  stop = () => {
    if (this.disposed) return;
    const cancelled = this.cancelCurrent();
    this.queue = [];
    this.queueIndex = 0;
    this.restartOffset = null;
    this.pauseRequested = false;
    this.lastOffset = null;
    this.publish({
      status: cancelled ? 'idle' : 'error',
      sentence: null,
      word: null,
      boundarySupport: 'unknown',
      error: cancelled ? '' : ENGINE_ERROR,
      errorCode: cancelled ? null : 'engine',
    });
  };
  private currentSentenceStart(): number {
    const offset = this.lastOffset ?? this.queue[this.queueIndex]?.start ?? 0;
    return atOffset(this.plan?.sentences ?? [], offset)?.start ?? offset;
  }
  setRate = (value: number) => {
    if (this.disposed) return;
    if (!(READING_RATES as readonly number[]).includes(value)) {
      this.fail('invalid-setting', 'Choose one of the available reading speeds.');
      return;
    }
    if (value === this.state.rate) return;
    this.changeSettings({ rate: value as ReadingRate });
  };
  setVoiceURI = (voiceURI: string) => {
    if (this.disposed) return;
    this.refreshVoices();
    if (
      !this.state.voices.some((voice) => voice.voiceURI === voiceURI && voice.localService === true)
    ) {
      this.fail('no-local-voice', 'Choose an available voice marked as local by your browser.');
      return;
    }
    if (voiceURI === this.state.voiceURI) return;
    this.hadVoice = true;
    this.changeSettings({ voiceURI });
  };
  private changeSettings(update: Partial<ReadingSnapshot>) {
    const active = ['playing', 'starting', 'paused'].includes(this.state.status),
      paused = this.state.status === 'paused';
    const offset = this.currentSentenceStart();
    if (active && !this.cancelCurrent()) {
      this.fail('engine', ENGINE_ERROR);
      return;
    }
    this.publish({
      ...update,
      error: '',
      errorCode: null,
      boundarySupport: 'unknown',
      sentence: null,
      word: null,
      ...(active
        ? { status: paused ? ('paused' as const) : ('starting' as const) }
        : { status: 'idle' as const }),
    });
    if (active && paused) this.restartOffset = offset;
    else if (active) this.begin(offset);
  }
  play = () => {
    if (this.disposed || this.state.status === 'playing' || this.state.status === 'starting')
      return;
    if (this.state.status === 'paused') {
      this.resume();
      return;
    }
    this.begin(0);
  };
  private begin(offset: number) {
    if (!this.engine) {
      this.fail('unsupported', 'Read aloud is not supported in this browser.');
      return;
    }
    try {
      this.plan ??= createReadingPlan(this.text);
      this.refreshVoices();
      if (!this.state.voiceURI) {
        this.fail(
          'no-local-voice',
          'No local voice is available. Install a device voice or refresh the voices, then try again.',
        );
        return;
      }
      if (!this.cancelCurrent()) {
        this.fail('engine', ENGINE_ERROR);
        return;
      }
      this.queue = this.plan.chunks
        .filter((range) => range.end > offset)
        .map((range) => ({ start: Math.max(range.start, offset), end: range.end }));
      this.queueIndex = 0;
      this.restartOffset = null;
      this.lastOffset = null;
      this.pauseRequested = false;
      this.publish({
        status: 'starting',
        sentence: null,
        word: null,
        boundarySupport: 'unknown',
        error: '',
        errorCode: null,
      });
      // cancel() leaves the global engine paused. Resume an empty queue before speaking.
      this.engine.resume();
      this.speakNext();
    } catch (error) {
      if (error instanceof ReadingFailure) this.fail(error.code, error.message);
      else this.fail('engine', ENGINE_ERROR);
    }
  }
  private speakNext() {
    if (!this.engine || this.disposed || this.pauseRequested) return;
    if (this.queueIndex >= this.queue.length) {
      this.queue = [];
      this.publish({ status: 'idle', sentence: null, word: null });
      return;
    }
    // Whitespace-only slices have no audible content and some engines never emit an
    // event for them. Skip them without shifting any source text offsets.
    while (
      this.queueIndex < this.queue.length &&
      !/\S/u.test(
        this.text.slice(this.queue[this.queueIndex].start, this.queue[this.queueIndex].end),
      )
    )
      this.queueIndex++;
    if (this.queueIndex >= this.queue.length) {
      this.queue = [];
      this.publish({ status: 'idle', sentence: null, word: null });
      return;
    }
    const chunk = this.queue[this.queueIndex];
    try {
      // Recheck the currently enumerated object before EVERY utterance. Never leave voice null.
      const voice = this.engine
        .getVoices()
        .find(
          (candidate) =>
            candidate.voiceURI === this.state.voiceURI && candidate.localService === true,
        );
      if (!voice) {
        this.refreshVoices();
        this.fail(
          'voice-unavailable',
          'The selected local voice is unavailable. Choose an installed local voice to continue.',
        );
        return;
      }
      const raw = this.text.slice(chunk.start, chunk.end);
      // The API permits SSML. Full-width brackets keep an extracted <audio>/<voice> tag
      // from becoming speech markup while retaining exact, one-to-one UTF-16 offsets.
      const utterance = this.engine.createUtterance(raw.replace(/</g, '＜').replace(/>/g, '＞'));
      utterance.voice = voice;
      utterance.lang = voice.lang;
      utterance.rate = this.state.rate;
      const generation = this.generation;
      const current = () =>
        !this.disposed && this.generation === generation && this.utterance === utterance;
      this.utterance = utterance;
      utterance.onstart = () => {
        if (current() && !this.pauseRequested) {
          this.clearDeadline();
          this.lastOffset = chunk.start;
          this.publish({
            status: 'playing',
            sentence: atOffset(this.plan!.sentences, chunk.start),
            word: null,
          });
        }
      };
      utterance.onpause = () => {
        if (current() && this.pauseRequested) {
          this.clearDeadline();
          this.publish({ status: 'paused' });
        }
      };
      utterance.onresume = () => {
        if (current() && !this.pauseRequested) {
          this.clearDeadline();
          this.publish({ status: 'playing' });
        }
      };
      utterance.onboundary = (event) => {
        if (
          !current() ||
          this.pauseRequested ||
          !['word', 'sentence'].includes(event.name) ||
          !Number.isInteger(event.charIndex) ||
          event.charIndex < 0 ||
          event.charIndex >= raw.length ||
          !codePointBoundary(raw, event.charIndex)
        )
          return;
        this.clearDeadline();
        const offset = chunk.start + event.charIndex;
        if (this.lastOffset !== null && offset < this.lastOffset) return;
        this.lastOffset = offset;
        const localWord =
          event.name === 'word' ? eventWordRange(raw, event.charIndex, event.charLength) : null;
        this.publish({
          status: 'playing',
          sentence: atOffset(this.plan!.sentences, offset),
          word: localWord
            ? { start: chunk.start + localWord.start, end: chunk.start + localWord.end }
            : null,
          boundarySupport:
            event.name === 'word'
              ? 'word'
              : this.state.boundarySupport === 'word'
                ? 'word'
                : 'sentence',
        });
      };
      utterance.onerror = () => {
        if (current()) this.fail('engine', ENGINE_ERROR);
      };
      utterance.onend = () => {
        if (!current()) return;
        this.clearDeadline();
        this.detach(utterance);
        this.utterance = null;
        this.lastOffset = null;
        this.queueIndex++;
        this.publish({
          sentence: null,
          word: null,
          status: this.pauseRequested ? 'paused' : 'starting',
        });
        if (!this.pauseRequested) this.speakNext();
      };
      this.armDeadline();
      this.engine.speak(utterance);
    } catch {
      this.fail('engine', ENGINE_ERROR);
    }
  }
  pause = () => {
    if (this.disposed || !this.engine || !['playing', 'starting'].includes(this.state.status))
      return;
    this.clearDeadline();
    this.pauseRequested = true;
    this.publish({ status: 'paused' });
    try {
      this.engine.pause();
    } catch {
      this.fail('engine', ENGINE_ERROR);
    }
  };
  resume = () => {
    if (this.disposed || !this.engine || this.state.status !== 'paused') return;
    if (this.restartOffset !== null) {
      this.begin(this.restartOffset);
      return;
    }
    this.pauseRequested = false;
    this.publish({ status: 'starting' });
    try {
      if (this.utterance) this.armDeadline();
      this.engine.resume();
      if (!this.utterance) this.speakNext();
    } catch {
      this.fail('engine', ENGINE_ERROR);
    }
  };
  dispose() {
    if (this.disposed) return;
    this.cancelCurrent();
    try {
      this.removeVoices?.();
    } catch {
      // Teardown must still drop private text and listeners if a host API fails.
    }
    this.removeVoices = null;
    this.disposed = true;
    this.listeners.clear();
    this.text = '';
    this.contextKey = '';
    this.queue = [];
    this.plan = null;
  }
}
