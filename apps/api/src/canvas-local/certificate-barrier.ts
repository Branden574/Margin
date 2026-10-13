import { constants, type Stats } from 'node:fs';
import { lstat, open, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import { absolutePath, CanvasLocalConfigError, checkParents } from './protected-files.js';

export const CANVAS_CERTIFICATE_MAINTENANCE_MARKER = '.certificate-renewal.pending.json';
const unavailable = () =>
  new CanvasLocalConfigError(
    'certificate_maintenance_unavailable',
    'The private local database certificate maintenance state could not be verified.',
  );

function privateRoot(stat: Stats) {
  return (
    !!process.getuid &&
    stat.uid === process.getuid() &&
    stat.isDirectory() &&
    (stat.mode & 0o7777) === 0o700
  );
}

/**
 * Presence is the barrier: never open the journal, staged files, or marker body.
 * Call before config reads and again while holding shared database admission.
 * Same-account ancestor replacement still requires operating-system isolation.
 */
export async function assertNoPendingCertificateMaintenance(canvasRoot: string): Promise<void> {
  let directory: FileHandle | undefined;
  try {
    absolutePath(canvasRoot);
    await checkParents(canvasRoot);
    directory = await open(
      canvasRoot,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    const before = await directory.stat();
    if (!privateRoot(before)) throw new Error();
    let present = true;
    try {
      await lstat(join(canvasRoot, CANVAS_CERTIFICATE_MAINTENANCE_MARKER));
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error;
      present = false;
    }
    const after = await lstat(canvasRoot);
    if (!privateRoot(after) || after.dev !== before.dev || after.ino !== before.ino)
      throw new Error();
    if (present)
      throw new CanvasLocalConfigError(
        'certificate_maintenance_pending',
        'Local database certificate maintenance is incomplete. Finish the existing renewal before starting the API or scanner.',
      );
  } catch (error) {
    if (error instanceof CanvasLocalConfigError && error.code === 'certificate_maintenance_pending')
      throw error;
    throw unavailable();
  } finally {
    try {
      await directory?.close();
    } catch {
      throw unavailable();
    }
  }
}
