import { useEffect, useState } from 'react';
/** Structural PDF changes require a single local writer; this is not cloud collaboration. */
export function useDocumentLock(documentId: string) {
  const [status, setStatus] = useState<'pending' | 'owned' | 'blocked' | 'unsupported'>('pending');
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!navigator.locks) {
      setStatus('unsupported');
      return;
    }
    let active = true;
    let release: () => void = () => {};
    setStatus('pending');
    void navigator.locks
      .request(
        `margin-document:${documentId}`,
        { mode: 'exclusive', ifAvailable: true },
        async (lock) => {
          if (!active) return;
          if (!lock) {
            setStatus('blocked');
            return;
          }
          setStatus('owned');
          await new Promise<void>((resolve) => {
            release = resolve;
            if (!active) resolve();
          });
        },
      )
      .catch(() => {
        if (active) setStatus('unsupported');
      });
    return () => {
      active = false;
      release();
    };
  }, [documentId, attempt]);
  return { lockStatus: status, retryLock: () => setAttempt((value) => value + 1) };
}
