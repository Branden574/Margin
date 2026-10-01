export type DocumentLockStatus = 'pending' | 'owned' | 'blocked' | 'unsupported';

// A released Web Lock settles asynchronously. Wait for this realm's previous
// cleanup before another mount tries ifAvailable, without waiting on other tabs.
const releases = new WeakMap<LockManager, Map<string, Promise<void>>>();

export function acquireDocumentLock(
  manager: LockManager,
  documentId: string,
  onStatus: (status: DocumentLockStatus) => void,
): () => void {
  let pending = releases.get(manager);
  if (!pending) {
    pending = new Map();
    releases.set(manager, pending);
  }
  const name = `margin-document:${documentId}`;
  const precedingRelease = pending.get(name);
  let active = true;
  let release = () => {};
  onStatus('pending');
  const request = (async () => {
    await precedingRelease;
    if (!active) return;
    try {
      await manager.request(name, { mode: 'exclusive', ifAvailable: true }, async (lock) => {
        if (!active) return;
        if (!lock) {
          onStatus('blocked');
          return;
        }
        onStatus('owned');
        await new Promise<void>((resolve) => {
          release = resolve;
          if (!active) resolve();
        });
      });
    } catch {
      if (active) onStatus('unsupported');
    }
  })();
  return () => {
    if (!active) return;
    active = false;
    release();
    pending.set(name, request);
    void request.then(() => {
      if (pending.get(name) === request) pending.delete(name);
    });
  };
}
