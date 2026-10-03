import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { ReadingController, initialReadingSnapshot, type ReadingEngine } from './reading';

function browserEngine(): ReadingEngine | null {
  if (
    typeof window === 'undefined' ||
    !('speechSynthesis' in window) ||
    typeof window.SpeechSynthesisUtterance !== 'function'
  )
    return null;
  const synthesis = window.speechSynthesis;
  return {
    getVoices: () => synthesis.getVoices(),
    createUtterance: (text) => new SpeechSynthesisUtterance(text),
    speak: (utterance) => synthesis.speak(utterance),
    cancel: () => synthesis.cancel(),
    pause: () => synthesis.pause(),
    resume: () => synthesis.resume(),
    listenVoices: (listener) => {
      synthesis.addEventListener('voiceschanged', listener);
      return () => synthesis.removeEventListener('voiceschanged', listener);
    },
  };
}
/** Local browser voices only. Rate/voice changes restart the current sentence; paused
 * playback stays paused until resumed. Text/context changes and unmount cancel speech.
 * Call stop() when a containing view starts locking/leaving before it unmounts.
 */
export function useReadAloud(text: string, contextKey: string) {
  const controller = useRef<ReadingController | null>(null);
  const [snapshot, setSnapshot] = useState(() => initialReadingSnapshot(false));
  useLayoutEffect(() => {
    const current = new ReadingController(browserEngine(), {
      preferredLanguage: typeof navigator === 'undefined' ? undefined : navigator.language,
    });
    controller.current = current;
    const unsubscribe = current.subscribe(setSnapshot);
    current.connect();
    setSnapshot(current.getSnapshot());
    return () => {
      controller.current = null;
      unsubscribe();
      current.dispose();
    };
  }, []);
  useLayoutEffect(() => {
    controller.current?.setContext(text, contextKey);
  }, [text, contextKey]);
  const play = useCallback(() => controller.current?.play(), []);
  const pause = useCallback(() => controller.current?.pause(), []);
  const resume = useCallback(() => controller.current?.resume(), []);
  const stop = useCallback(() => controller.current?.stop(), []);
  const setVoiceURI = useCallback((value: string) => controller.current?.setVoiceURI(value), []);
  const setRate = useCallback((value: number) => controller.current?.setRate(value), []);
  const refreshVoices = useCallback(() => controller.current?.refreshVoices(), []);
  return { ...snapshot, play, pause, resume, stop, setVoiceURI, setRate, refreshVoices };
}
