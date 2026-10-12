import { createDockerScannerExecutor, type DockerScannerOptions } from './docker.js';
import { IsolatedSourceScanner, type IsolatedSourceScannerOptions } from './source.js';

export { ScannerExecutorError } from './docker.js';
export { ScannerUnavailableError } from './protocol.js';
export type { DockerScannerOptions } from './docker.js';
export type { IsolatedSourceScannerOptions } from './source.js';

/** Real composition only: readiness precedes any ingestion claim or advertised scanner health. */
export async function createIsolatedSourceScanner(
  options: IsolatedSourceScannerOptions & { docker: DockerScannerOptions },
  signal: AbortSignal,
  onCreated?: (scanner: IsolatedSourceScanner) => void,
): Promise<IsolatedSourceScanner> {
  const executor = await createDockerScannerExecutor(options.docker);
  const scanner = new IsolatedSourceScanner(executor, options);
  try {
    // The composition root retains cleanup ownership even if readiness and its first close both fail.
    onCreated?.(scanner);
    await scanner.ready(signal);
    return scanner;
  } catch (error) {
    // The executor retains its private journal and lock if real container cleanup is uncertain.
    await scanner.close();
    throw error;
  }
}
