import { useEffect, useState } from 'react';
import { acquireDocumentLock, type DocumentLockStatus } from '../lib/document-lock';
/** Structural PDF changes require a single local writer; this is not cloud collaboration. */
export function useDocumentLock(documentId: string) {
  const [status, setStatus] = useState<DocumentLockStatus>('pending');
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!navigator.locks) {
      setStatus('unsupported');
      return;
    }
    return acquireDocumentLock(navigator.locks, documentId, setStatus);
  }, [documentId, attempt]);
  return { lockStatus: status, retryLock: () => setAttempt((value) => value + 1) };
}
