import type { PoolConfig } from 'pg';
import type { JWK } from 'jose';
import {
  createIdentityService,
  createLtiIdentityService,
  PostgresIdentityRepository,
  type IdentityConfig,
  type LtiIdentityConfig,
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
import { PostgresIngestionRepository } from './ingestion/postgres.js';
import { PostgresAssignmentSubmissionService } from './assignments/submissions/index.js';
import { PostgresAssignmentReviewService } from './assignments/review/index.js';
import {
  PostgresSubmissionProcessor,
  SubmissionMaterializationWorker,
  type MaterializationReceipt,
} from './assignments/submissions/processing/index.js';

interface CanvasRuntimeCommonConfig {
  /** Four distinct least-privilege logins; each repository enforces its own runtime role. */
  databases: { identity: PoolConfig; lms: PoolConfig; assignments: PoolConfig; work: PoolConfig };
  lmsLookupKey: Uint8Array;
  resourceHmacKey: Uint8Array;
  /** Explicit all-or-none local submission pipeline. No scheduler or Canvas delivery is implied. */
  submissions?: {
    databases: {
      capture: PoolConfig;
      processor: PoolConfig;
      reviewer: PoolConfig;
      sourceReader: PoolConfig;
    };
    captureEnabled: boolean;
    processingDeadlineMs?: number;
  };
}
export type CanvasRuntimeConfig = CanvasRuntimeCommonConfig &
  (
    | { authentication?: 'oidc'; identity: IdentityConfig }
    | { authentication: 'lti-only'; identity: LtiIdentityConfig }
  );
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
    assignmentSubmissionService?: PostgresAssignmentSubmissionService;
    assignmentReviewService?: PostgresAssignmentReviewService;
  };
  /** Explicit single-job processing; absent unless the submission pipeline was configured. */
  materializeSubmission?: (signal?: AbortSignal) => Promise<MaterializationReceipt | null>;
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
  const shutdown = new AbortController();
  const processing = new Set<Promise<MaterializationReceipt | null>>();
  let closing: Promise<void> | undefined;
  let closed = false;
  const close = () => {
    closed = true;
    shutdown.abort();
    return (closing ??= (async () => {
      const errors: unknown[] = [];
      // Public worker calls have bounded deadlines. Borrowed providers retain their own lifecycle.
      await Promise.allSettled([...processing]);
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
      config.authentication !== undefined &&
      !['oidc', 'lti-only'].includes(config.authentication)
    )
      throw new Error('Use explicit OIDC or LTI-only authentication.');
    if (config.authentication === 'lti-only' && oidcTests)
      throw new Error('LTI-only authentication does not accept an OIDC transport.');
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
    const commonIdentity: LtiIdentityConfig = {
      ...config.identity,
      sessionSecret: copyKey(config.identity.sessionSecret, 'Session secret'),
      identityHmacKey: copyKey(config.identity.identityHmacKey, 'Identity lookup key'),
      allowedReturnPaths: config.identity.allowedReturnPaths?.slice(),
    };
    const identityConfig: IdentityConfig | undefined =
      config.authentication === 'lti-only'
        ? undefined
        : {
            ...config.identity,
            ...commonIdentity,
            allowedProviderOrigins: config.identity.allowedProviderOrigins?.slice(),
            mfaAcrValues: config.identity.mfaAcrValues?.slice(),
          };
    const submissions = config.submissions && {
      ...config.submissions,
      databases: { ...config.submissions.databases },
    };
    if (
      submissions &&
      (typeof submissions.captureEnabled !== 'boolean' ||
        !submissions.databases?.capture ||
        !submissions.databases.processor ||
        !submissions.databases.reviewer ||
        !submissions.databases.sourceReader)
    )
      throw new Error(
        'Submission composition requires an explicit capture policy and four database configurations.',
      );
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
    let capture: PostgresAssignmentSubmissionService | undefined;
    let review: PostgresAssignmentReviewService | undefined;
    let worker: SubmissionMaterializationWorker | undefined;
    if (submissions) {
      const sourceReader = new PostgresIngestionRepository(
        submissions.databases.sourceReader,
        keys,
        'reader',
      );
      cleanups.push(() => sourceReader.close());
      const processor = new PostgresSubmissionProcessor(submissions.databases.processor, keys);
      cleanups.push(() => processor.close());
      capture = new PostgresAssignmentSubmissionService(submissions.databases.capture, keys, {
        captureEnabled: submissions.captureEnabled,
      });
      cleanups.push(() => capture!.close());
      review = new PostgresAssignmentReviewService(
        submissions.databases.reviewer,
        keys,
        sourceReader,
        artifacts,
      );
      cleanups.push(() => review!.close());
      worker = new SubmissionMaterializationWorker(processor, sourceReader, artifacts, {
        deadlineMs: submissions.processingDeadlineMs,
      });
    }
    const federation = {
      authorizeLmsSession: (principal) => lmsRepository.authorizeSession(principal),
    } satisfies import('./identity/index.js').IdentityFederation;
    const identity = identityConfig
      ? await createIdentityService(identityConfig, identityRepository, oidcTests, federation)
      : await createLtiIdentityService(commonIdentity, identityRepository, federation);
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
      launchReturnPaths: ['/canvas/author', '/canvas/work', '/canvas/review'],
      resolveKey: resolveLmsKey,
    });
    return {
      apiServices: {
        identityService: identity,
        lmsService: lms,
        assignmentService: assignments,
        assignmentWorkService: work,
        ...(capture && review
          ? { assignmentSubmissionService: capture, assignmentReviewService: review }
          : {}),
      },
      ...(worker
        ? {
            materializeSubmission(signal?: AbortSignal) {
              if (closed) return Promise.reject(new Error('The Canvas runtime is closed.'));
              const run = worker!.runOne(
                signal ? AbortSignal.any([signal, shutdown.signal]) : shutdown.signal,
              );
              processing.add(run);
              void run.then(
                () => processing.delete(run),
                () => processing.delete(run),
              );
              return run;
            },
          }
        : {}),
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
