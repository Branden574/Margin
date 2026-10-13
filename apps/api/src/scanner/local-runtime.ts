import { LocalKeyProvider } from '../encryption.js';
import { LocalEncryptedArtifactRepository } from '../local-artifacts.js';
import { PostgresIngestionRepository } from '../ingestion/postgres.js';
import { SourceInspectionWorker } from '../ingestion/worker.js';
import { acquireCanvasRuntimeAdmission } from '../canvas-local/maintenance.js';
import { assertCanvasInspectorReady } from '../canvas-local/preflight.js';
import { assertNoPendingCertificateMaintenance } from '../canvas-local/certificate-barrier.js';
import { loadLocalScannerConfig } from './local-config.js';
import { createIsolatedSourceScanner } from './index.js';
import { startInspectionLoop, type InspectionLoopEvent } from './loop.js';

export class LocalScannerStartupError extends Error {
  readonly code = 'scanner_startup_refused';
  readonly name = 'LocalScannerStartupError';
  constructor() {
    super(
      'Local source inspection startup was refused. Verify the private configuration, database readiness, reviewed engine images and current signed definitions.',
    );
  }
}
/** Retry only this runtime's owned cleanup; never remove the journal or kill host processes. */
export class LocalScannerCleanupPendingError extends Error {
  readonly code = 'cleanup_pending';
  readonly name = 'LocalScannerCleanupPendingError';
  constructor(readonly retryClose: () => Promise<void>) {
    super(
      'Local source inspection cleanup is pending. This process retains unfinished resources and preserves any executor journal and lock. Restore local services and retry shutdown in this process.',
    );
  }
}

/** Standalone local sidecar. It neither changes API health nor seeds inspection decisions. */
export async function startLocalScanner(
  configPath: string,
  options: {
    signal?: AbortSignal;
    intervalMs?: number;
    onEvent?: (event: InspectionLoopEvent) => void;
  } = {},
): Promise<{ signal: AbortSignal; close(): Promise<void> }> {
  const stopping = new AbortController();
  const cleanups: Array<() => void | Promise<void>> = [];
  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => {
    if (closing) return closing;
    const pending = Promise.resolve().then(async () => {
      // Stop at a failed drain/cleanup: lower dependencies and maintenance admission
      // remain owned. Successfully completed stages are not repeated on retry.
      while (cleanups.length) {
        try {
          await cleanups[cleanups.length - 1]();
        } catch {
          throw new LocalScannerCleanupPendingError(close);
        }
        cleanups.pop();
      }
    });
    closing = pending;
    stopping.abort();
    void pending.catch(() => {
      if (closing === pending) closing = undefined;
    });
    return pending;
  };
  const active = (signal: AbortSignal) => {
    if (signal.aborted) throw new LocalScannerStartupError();
  };
  try {
    active(options.signal ?? stopping.signal);
    const loaded = await loadLocalScannerConfig(configPath);
    cleanups.push(loaded.dispose);
    const config = loaded.configuration;
    active(options.signal ?? stopping.signal);
    const admission = await acquireCanvasRuntimeAdmission(config.database, {
      signal: options.signal,
    });
    cleanups.push(() => admission.close());
    await assertNoPendingCertificateMaintenance(config.canvasRoot);
    const admitted = AbortSignal.any([
      admission.signal,
      ...(options.signal ? [options.signal] : []),
    ]);
    const signal = AbortSignal.any([admitted, stopping.signal]);
    active(signal);
    await assertCanvasInspectorReady(config.database, {
      instanceId: config.instanceId,
      systemIdentifier: config.systemIdentifier,
      signal,
    });
    active(signal);
    const keys = new LocalKeyProvider(config.wrappingKey, config.wrappingKeyId);
    cleanups.push(() => keys.close());
    // LocalKeyProvider owns a copy. Dispose loader bytes before any inspection claim.
    loaded.dispose();
    const storage = new LocalEncryptedArtifactRepository({
      rootDirectory: config.artifactDirectory,
      keyManagementProvider: keys,
    });
    cleanups.push(() => storage.close());
    const repository = new PostgresIngestionRepository(config.database, keys, 'inspector');
    cleanups.push(() => repository.close());
    let ownedScanner: Awaited<ReturnType<typeof createIsolatedSourceScanner>> | undefined;
    const scanner = await createIsolatedSourceScanner(
      {
        parserImage: config.parserImage,
        antivirusImage: config.antivirusImage,
        definitionsDirectory: config.definitionsDirectory,
        docker: { ...config.docker },
        uid: config.uid,
        gid: config.gid,
      },
      signal,
      (created) => {
        ownedScanner = created;
        cleanups.push(() => created.close());
      },
    );
    if (scanner !== ownedScanner) throw new LocalScannerStartupError();
    active(signal);
    const worker = new SourceInspectionWorker(repository, storage, scanner);
    cleanups.push(() => worker.close());
    const loop = startInspectionLoop(worker, {
      signal,
      intervalMs: options.intervalMs,
      onEvent: options.onEvent,
    });
    cleanups.push(() => loop.close());
    const lost = () => {
      void close().catch(() => {});
    };
    admitted.addEventListener('abort', lost, { once: true });
    cleanups.push(() => admitted.removeEventListener('abort', lost));
    active(signal);
    return { signal: admitted, close };
  } catch {
    // A startup failure can still own a scanner. Propagate its retryable cleanup
    // handle if Docker cannot confirm teardown; never pretend startup succeeded.
    await close();
    throw new LocalScannerStartupError();
  }
}
