import { LocalKeyProvider } from './encryption.js';
import { dirname } from 'node:path';
import { LocalEncryptedArtifactRepository } from './local-artifacts.js';
import { loadCanvasLocalConfig } from './canvas-local/config.js';
import { assertCanvasDatabaseReady } from './canvas-local/preflight.js';
import { startCanvasLocalWorkers, type CanvasWorkerEvent } from './canvas-local/workers.js';
import { createCanvasRuntime } from './runtime-composition.js';
import { AssignmentDeepLinkSigner } from './assignments/index.js';
import {
  PostgresIngestionRepository,
  IngestionAssignmentSourceGateway,
  IngestionAssignmentSourceCatalog,
} from './ingestion/index.js';
import {
  PostgresStudentWorkProvisioner,
  StudentWorkProvisioningWorker,
} from './assignments/provisioning/index.js';
import { createApi } from './server.js';
import { TeacherSourceUploadService } from './ingestion/upload.js';
import { acquireCanvasRuntimeAdmission } from './canvas-local/maintenance.js';
import { assertNoPendingCertificateMaintenance } from './canvas-local/certificate-barrier.js';

async function stopHttp(server: ReturnType<typeof createApi>) {
  // Stop new connections first; give active responses a bounded chance to finish.
  try {
    if (server.listening)
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => server.closeAllConnections(), 10000);
        timer.unref();
        server.close((error) => {
          clearTimeout(timer);
          error ? reject(error) : resolve();
        });
        server.closeIdleConnections();
      });
  } finally {
    await server.drainRequests();
  }
}

/** Persistent, local-only composition. Never seeds identities, Canvas installations or scan approvals. */
export async function startCanvasLocalApi(
  configPath: string,
  options: { signal?: AbortSignal; onWorkerEvent?: (event: CanvasWorkerEvent) => void } = {},
) {
  const loaded = await loadCanvasLocalConfig(configPath);
  const config = loaded.configuration;
  const cleanups: Array<() => void | Promise<void>> = [loaded.dispose];
  let closePromise: Promise<void> | undefined;
  const close = () =>
    (closePromise ??= (async () => {
      const errors: unknown[] = [];
      for (const cleanup of cleanups.reverse()) {
        try {
          await cleanup();
        } catch (error) {
          errors.push(error);
        }
      }
      if (errors.length) throw new Error('The local Canvas runtime could not finish closing.');
    })());
  try {
    options.signal?.throwIfAborted();
    const admission = await acquireCanvasRuntimeAdmission(config.databases.identity, {
      signal: options.signal,
    });
    cleanups.push(() => admission.close());
    await assertNoPendingCertificateMaintenance(dirname(configPath));
    const startup = AbortSignal.any([
      admission.signal,
      ...(options.signal ? [options.signal] : []),
    ]);
    await assertCanvasDatabaseReady(config.databases, { signal: startup });
    startup.throwIfAborted();
    const keys = new LocalKeyProvider(config.secrets.wrapping, config.wrappingKeyId);
    cleanups.push(() => keys.close());
    const artifacts = new LocalEncryptedArtifactRepository({
      rootDirectory: config.artifactDirectory,
      keyManagementProvider: keys,
    });
    cleanups.push(() => artifacts.close());
    const ingestion = new PostgresIngestionRepository(config.databases.ingestion, keys, 'runtime');
    cleanups.push(() => ingestion.close());
    const reader = new PostgresIngestionRepository(config.databases.sourceReader, keys, 'reader');
    cleanups.push(() => reader.close());
    const sourceUploads = new TeacherSourceUploadService(ingestion, artifacts);
    cleanups.push(() => sourceUploads.close());
    const signer = new AssignmentDeepLinkSigner(
      config.toolSigning.kid,
      config.toolSigning.privateKeyPem.toString('utf8'),
    );
    const runtime = await createCanvasRuntime(
      {
        authentication: 'lti-only',
        databases: config.databases,
        identity: {
          applicationOrigin: config.applicationOrigin,
          sessionSecret: config.secrets.session,
          identityHmacKey: config.secrets.identity,
        },
        lmsLookupKey: config.secrets.lms,
        resourceHmacKey: config.secrets.resource,
        submissions: {
          databases: {
            ...config.databases,
            ...(config.feedbackDatabase ? { feedback: config.feedbackDatabase } : {}),
          },
          captureEnabled: config.captureEnabled,
        },
      },
      {
        keys,
        artifacts,
        sources: new IngestionAssignmentSourceGateway(ingestion, reader, artifacts),
        sourceCatalog: new IngestionAssignmentSourceCatalog(ingestion),
        signer,
      },
    );
    cleanups.push(() => runtime.close());
    const provisioner = new PostgresStudentWorkProvisioner(config.databases.provisioner, keys);
    cleanups.push(() => provisioner.close());
    const provisioningWorker = new StudentWorkProvisioningWorker(provisioner, reader, artifacts);
    const server = createApi({
      ...runtime.apiServices,
      sourceUploadService: sourceUploads,
      dataDirectory: config.dataDirectory,
      keyManagementProvider: keys,
      tls: config.tls,
      allowedOrigins: [config.applicationOrigin],
    });
    // Snapshot all secret buffers before releasing the loader's copies. Node's TLS context owns its key.
    loaded.dispose();
    startup.throwIfAborted();
    await new Promise<void>((resolve, reject) => {
      const failed = (error: Error) => {
        server.off('listening', ready);
        reject(error);
      };
      const ready = () => {
        server.off('error', failed);
        resolve();
      };
      server.once('error', failed);
      server.once('listening', ready);
      server.listen(config.listener.port, config.listener.host);
    });
    // Registered before worker cleanup so startup exceptions also close the listener.
    cleanups.push(() => stopHttp(server));
    startup.throwIfAborted();
    const workers = startCanvasLocalWorkers(
      [
        { name: 'provision', run: (signal) => provisioningWorker.runOne(signal) },
        { name: 'materialize', run: (signal) => runtime.materializeSubmission!(signal) },
      ],
      { onEvent: options.onWorkerEvent },
    );
    // Shutdown stops HTTP admission, drains workers, then closes repositories and providers.
    cleanups.pop();
    cleanups.push(async () => {
      // Both calls stop admission synchronously; await both before closing their dependencies.
      const results = await Promise.allSettled([workers.close(), stopHttp(server)]);
      if (results.some((result) => result.status === 'rejected'))
        throw new Error('Local Canvas requests or workers could not finish closing.');
    });
    const lostAdmission = () => {
      void close().catch(() => {});
    };
    admission.signal.addEventListener('abort', lostAdmission, { once: true });
    cleanups.push(() => admission.signal.removeEventListener('abort', lostAdmission));
    startup.throwIfAborted();
    return {
      origin: `https://${config.listener.host}:${config.listener.port}`,
      applicationOrigin: config.applicationOrigin,
      publicJwks: () => runtime.publicJwks(),
      signal: admission.signal,
      close,
    };
  } catch (error) {
    await close().catch(() => {});
    throw error;
  }
}
