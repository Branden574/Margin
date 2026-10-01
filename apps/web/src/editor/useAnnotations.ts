import { useCallback, useEffect, useRef, useState } from 'react';
import type { Annotation, AnnotationOperation } from '@margin/core';
import { appendAnnotationOperation, loadAnnotations } from '../lib/storage';
import { uid } from './model';
export type SaveState = 'loading' | 'saved' | 'saving' | 'error';
export function useAnnotations(documentId: string, initialTimestamp = 0) {
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const [saveState, setSaveState] = useState<SaveState>('loading');
  const [saveError, setSaveError] = useState('');
  const [loaded, setLoaded] = useState(false);
  const current = useRef<Annotation[]>([]),
    pending = useRef<AnnotationOperation[]>([]),
    draining = useRef(false),
    timestamp = useRef(Math.max(Date.now(), initialTimestamp));
  const drainingPromise = useRef<Promise<void>>(Promise.resolve()),
    loadGeneration = useRef(0);
  useEffect(() => {
    let alive = true;
    const generation = ++loadGeneration.current;
    void loadAnnotations(documentId)
      .then((items) => {
        if (alive && generation === loadGeneration.current) {
          current.current = items;
          setAnnotations(items);
          setLoaded(true);
          setSaveState('saved');
        }
      })
      .catch((error) => {
        if (alive && generation === loadGeneration.current) {
          setSaveError(String(error));
          setSaveState('error');
        }
      });
    return () => {
      alive = false;
    };
  }, [documentId]);
  const reload = useCallback(async () => {
    const generation = ++loadGeneration.current;
    setLoaded(false);
    setSaveState('loading');
    try {
      const items = await loadAnnotations(documentId);
      if (generation !== loadGeneration.current) return;
      current.current = items;
      setAnnotations(items);
      setLoaded(true);
      setSaveState('saved');
      setSaveError('');
    } catch (error) {
      if (generation === loadGeneration.current) {
        setSaveError(String(error));
        setSaveState('error');
      }
    }
  }, [documentId]);
  const flush = useCallback(() => {
    if (draining.current) return drainingPromise.current;
    draining.current = true;
    const work = (async () => {
      if (pending.current.length) setSaveState('saving');
      try {
        while (pending.current.length) {
          await appendAnnotationOperation(pending.current[0]);
          pending.current.shift();
        }
        setSaveState('saved');
        setSaveError('');
      } catch (error) {
        setSaveState('error');
        setSaveError(
          error instanceof Error ? error.message : 'Browser storage could not save this change.',
        );
        throw error;
      } finally {
        draining.current = false;
      }
    })();
    drainingPromise.current = work;
    return work;
  }, []);
  const replace = useCallback(
    (next: Annotation[], persist = true) => {
      if (persist) {
        const old = new Map(current.current.map((a) => [a.id, a]));
        const nextIds = new Set(next.map((a) => a.id));
        const operation = (
          kind: 'put' | 'delete',
          annotationId: string,
          annotation?: Annotation,
        ): AnnotationOperation => ({
          id: uid(),
          documentId,
          timestamp: (timestamp.current = Math.max(timestamp.current + 1, Date.now())),
          kind,
          annotationId,
          annotation,
        });
        for (const a of next)
          if (a !== old.get(a.id)) pending.current.push(operation('put', a.id, a));
        for (const a of current.current)
          if (!nextIds.has(a.id)) pending.current.push(operation('delete', a.id));
      }
      current.current = next;
      setAnnotations(next);
      if (persist) void flush().catch(() => {});
    },
    [documentId, flush],
  );
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (pending.current.length) {
        event.preventDefault();
        event.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, []);
  const syncTimestamp = (value: number) => {
    timestamp.current = Math.max(timestamp.current, value);
  };
  return {
    annotations,
    current,
    replace,
    flush,
    saveState,
    saveError,
    loaded,
    reload,
    syncTimestamp,
  };
}
