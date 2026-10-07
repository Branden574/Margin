import type { PoolConfig } from 'pg';
import type { JWK } from 'jose';
import {
  createIdentityService,
  PostgresIdentityRepository,
  type IdentityConfig,
  type IdentityService,
} from './identity/index.js';
import type { OidcTestOptions } from './identity/oidc.js';
import { createLmsService, PostgresLmsRepository, type LmsServiceOptions } from './lms/index.js';
import {
  AssignmentDeepLinkSigner,
  AssignmentService,
  PostgresAssignmentRepository,
  type AssignmentSourceGateway,
  type AssignmentSourceCatalog,
} from './assignments/index.js';
import { PostgresAssignmentWorkService } from './assignments/work/index.js';
import type { KeyManagementProvider } from './encryption.js';
import type { ArtifactReader } from './ingestion/types.js';

export interface CanvasRuntimeConfig {
  identity: IdentityConfig;
  /** Four distinct least-privilege logins; each repository enforces its own runtime role. */
  databases: { identity: PoolConfig; lms: PoolConfig; assignments: PoolConfig; work: PoolConfig };
  lmsLookupKey: Uint8Array;
  resourceHmacKey: Uint8Array;
}
export interface CanvasRuntimeDependencies {
  /** Borrowed dependencies. The caller owns their shutdown and their secret material. */
  keys: KeyManagementProvider;
  artifacts: ArtifactReader;
  sources: AssignmentSourceGateway;
  /** Optional metadata-only inspected-source discovery. Absence leaves the catalog unavailable. */
  sourceCatalog?: AssignmentSourceCatalog;
  signer: AssignmentDeepLinkSigner;
  /** Synthetic transport remains restricted by createIdentityService to NODE_ENV=test. */
  oidcTests?: OidcTestOptions;
  /** Trusted server-only key resolution; omission uses the installation's registered JWKS. */
  resolveLmsKey?: LmsServiceOptions['resolveKey'];
}
export interface CanvasRuntime {
  apiServices: {
    identityService: IdentityService;
    lmsService: ReturnType<typeof createLmsService>;
    assignmentService: AssignmentService;
    assignmentWorkService: PostgresAssignmentWorkService;
  };
  /** A fresh public-only clone, available until close. This does not publish an HTTP endpoint. */
  publicJwks(): { keys: JWK[] };
  /** Stop accepting HTTP requests and drain them before closing this owned service graph. */
  close(): Promise<void>;
}

/**
 * Explicit composition only: no environment loading, listener, migration, provisioning or scanner.
 * Owns constructed repositories and copied configuration keys; never closes borrowed providers.
 */
export async function createCanvasRuntime(
  config: CanvasRuntimeConfig,
  dependencies: CanvasRuntimeDependencies,
): Promise<CanvasRuntime> {
  const secrets: Buffer[] = [];
  const cleanups: Array<() => Promise<unknown> | void> = [];
  let closing: Promise<void> | undefined;
  let closed = false;
  const close = () => {
    closed = true;
    return (closing ??= (async () => {
      const errors: unknown[] = [];
      for (const cleanup of cleanups.reverse()) {
        try {
          await cleanup();
        } catch (error) {
          errors.push(error);
        }
      }
      for (const secret of secrets) secret.fill(0);
      if (errors.length) throw new AggregateError(errors, 'Canvas runtime cleanup failed.');
    })());
  };
  const copyKey = (value: Uint8Array, label: string) => {
    if (!(value instanceof Uint8Array) || value.byteLength !== 32)
      throw new Error(`${label} must contain exactly 32 bytes.`);
    const copied = Buffer.from(value);
    secrets.push(copied);
    return copied;
  };
  try {
    const { keys, artifacts, sources, sourceCatalog, signer, resolveLmsKey, oidcTests } =
      dependencies;
    if (
      !keys?.wrapKey ||
      !keys.unwrapKey ||
      !artifacts?.get ||
      !sources?.resolveForTeacher ||
      !sources.stillAvailable ||
      !sources.prepareAvailability ||
      !signer?.sign ||
      !signer.jwks
    )
      throw new Error(
        'Canvas composition requires explicit key, artifact, source and signing providers.',
      );
    // Snapshot all mutable keys and allowlists before asynchronous issuer discovery.
    const identityConfig: IdentityConfig = {
      ...config.identity,
      sessionSecret: copyKey(config.identity.sessionSecret, 'Session secret'),
      identityHmacKey: copyKey(config.identity.identityHmacKey, 'Identity lookup key'),
      allowedReturnPaths: config.identity.allowedReturnPaths?.slice(),
      allowedProviderOrigins: config.identity.allowedProviderOrigins?.slice(),
      mfaAcrValues: config.identity.mfaAcrValues?.slice(),
    };
    const lmsKey = copyKey(config.lmsLookupKey, 'LMS lookup key');
    const resourceKey = copyKey(config.resourceHmacKey, 'Assignment resource key');
    if (secrets.some((key, i) => secrets.slice(0, i).some((previous) => key.equals(previous))))
      throw new Error('Session, identity, LMS and assignment HMAC keys must be independent.');
    const jwks = signer.jwks();
    const lmsRepository = new PostgresLmsRepository(config.databases.lms, lmsKey);
    cleanups.push(() => lmsRepository.close());
    const identityRepository = new PostgresIdentityRepository(config.databases.identity);
    cleanups.push(() => identityRepository.close());
    const assignmentRepository = new PostgresAssignmentRepository(
      config.databases.assignments,
      keys,
    );
    cleanups.push(() => assignmentRepository.close());
    const work = new PostgresAssignmentWorkService(config.databases.work, keys, artifacts);
    cleanups.push(() => work.close());
    const identity = await createIdentityService(identityConfig, identityRepository, oidcTests, {
      authorizeLmsSession: (principal) => lmsRepository.authorizeSession(principal),
    });
    const assignments = new AssignmentService({
      repository: assignmentRepository,
      authorizer: lmsRepository,
      installations: lmsRepository,
      sources,
      sourceCatalog,
      signer,
      resourceHmacKey: resourceKey,
    });
    cleanups.push(() => assignments.close());
    const lms = createLmsService({
      applicationOrigin: identity.applicationOrigin,
      repository: lmsRepository,
      issueSession: (enrollment, request) => identity.issueLmsSession(enrollment, request),
      authenticateSession: (request) => identity.authenticateRequest(request),
      onVerifiedLaunch: (input) => assignments.captureVerifiedLaunch(input),
      launchReturnPaths: ['/canvas/author', '/canvas/work'],
      resolveKey: resolveLmsKey,
    });
    return {
      apiServices: {
        identityService: identity,
        lmsService: lms,
        assignmentService: assignments,
        assignmentWorkService: work,
      },
      publicJwks() {
        if (closed) throw new Error('The Canvas runtime is closed.');
        return structuredClone(jwks);
      },
      close,
    };
  } catch (error) {
    try {
      await close();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'Canvas runtime construction failed.');
    }
    throw error;
  }
}
