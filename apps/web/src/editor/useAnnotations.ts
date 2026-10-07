import { useCallback, useEffect, useRef, useState } from 'react';
import type { Annotation, AnnotationOperation } from '@margin/core';
import { appendAnnotationOperation, loadAnnotations } from '../lib/storage';
import { uid } from './model';
export type SaveState = 'loading' | 'saved' | 'saving' | 'error';
export interface AnnotationPersistence {
  load(documentId: string): Promise<Annotation[]>;
  append(operation: AnnotationOperation): Promise<void>;
}
const localPersistence: AnnotationPersistence = {
  load: loadAnnotations,
  append: appendAnnotationOperation,
};
export function useAnnotations(
  documentId: string,
  initialTimestamp = 0,
  persistence: AnnotationPersistence = localPersistence,
) {
  const binding = useRef({ documentId, persistence });
  const activeBinding = useRef({ documentId, persistence });
  activeBinding.current = { documentId, persistence };
  const assertBinding = useCallback(() => {
    if (
      activeBinding.current.documentId !== binding.current.documentId ||
      activeBinding.current.persistence !== binding.current.persistence
    )
      throw new Error(
        'The annotation persistence changed. Reopen this editor before saving; pending drafts have been kept.',
      );
  }, []);
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
    void Promise.resolve()
      .then(() => {
        assertBinding();
        return binding.current.persistence.load(documentId);
      })
      .then((items) => {
        assertBinding();
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
  }, [documentId, persistence, assertBinding]);
  const reload = useCallback(async () => {
    const generation = ++loadGeneration.current;
    setLoaded(false);
    setSaveState('loading');
    try {
      assertBinding();
      if (pending.current.length || draining.current)
        throw new Error(
          'Save pending annotation edits before reloading. Your drafts have been kept.',
        );
      const items = await binding.current.persistence.load(documentId);
      assertBinding();
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
  }, [documentId, persistence, assertBinding]);
  const flush = useCallback(() => {
    if (draining.current) return drainingPromise.current;
    draining.current = true;
    const work = (async () => {
      if (pending.current.length) setSaveState('saving');
      try {
        assertBinding();
        while (pending.current.length) {
          assertBinding();
          await binding.current.persistence.append(structuredClone(pending.current[0]));
          assertBinding();
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
  }, [assertBinding]);
  const replace = useCallback(
    (next: Annotation[], persist = true) => {
      assertBinding();
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
          annotation: annotation ? structuredClone(annotation) : undefined,
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
    [documentId, flush, assertBinding],
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
  const sameBinding =
    documentId === binding.current.documentId && persistence === binding.current.persistence;
  return {
    annotations: sameBinding ? annotations : [],
    current,
    replace,
    flush,
    saveState,
    saveError,
    loaded: loaded && sameBinding,
    reload,
    syncTimestamp,
  };
}
