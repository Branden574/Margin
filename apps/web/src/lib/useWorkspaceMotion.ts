import { useEffect, useRef, type RefObject } from 'react';

/** Motion is optional: the workspace is usable before this enhancement loads. */
export function useWorkspaceMotion(
  root: RefObject<HTMLDivElement | null>,
  active: boolean,
  reducedMotion: boolean,
) {
  const entered = useRef(false);

  useEffect(() => {
    if (!active) {
      entered.current = false;
      return;
    }
    if (reducedMotion) {
      entered.current = true;
      return;
    }
    let disposed = false;
    let revert: (() => void) | undefined;
    void import('./workspace-motion')
      .then(({ mountWorkspaceMotion }) => {
        if (disposed || !root.current) return;
        revert = mountWorkspaceMotion(root.current, !entered.current);
        entered.current = true;
      })
      .catch(() => {
        // Offline or interrupted loading must never prevent document access.
      });
    return () => {
      disposed = true;
      revert?.();
    };
  }, [root, active, reducedMotion]);
}
