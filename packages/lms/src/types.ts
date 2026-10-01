/** External identifiers are always scoped to a server-registered installation. */
export interface LMSReference {
  installationId: string;
  externalId: string;
}
export interface LMSUser {
  reference: LMSReference;
  roleHints: readonly LMSRoleHint[];
}
export interface LMSCourse {
  reference: LMSReference;
  title?: string;
  label?: string;
}
export interface LMSAssignment {
  reference: LMSReference;
  course: LMSReference;
  title: string;
}
export interface LMSSubmission {
  reference: LMSReference;
  assignment: LMSReference;
  user: LMSReference;
  attempt: number;
}
export interface LMSGrade {
  submission: LMSReference;
  score: number;
  maximum: number;
  recordedAt: string;
}
export type LMSRoleHint = 'learner' | 'instructor' | 'administrator';
export type LTIMessageType = 'LtiResourceLinkRequest' | 'LtiDeepLinkingRequest';

export interface LMSLaunchContext {
  provider: 'canvas';
  installationId: string;
  organizationId: string;
  registrationVersion: number;
  issuer: string;
  clientId: string;
  deploymentId: string;
  messageType: LTIMessageType;
  targetUri: string;
  user: LMSUser;
  /** Protocol roles are hints for a server-side grant decision, never application admin grants. */
  protocolRoles: readonly string[];
  course?: LMSCourse;
  resource?: { reference: LMSReference; title?: string; assignmentId?: string };
  issuedAt: number;
  expiresAt: number;
  services: {
    grades?: { lineItem?: string; lineItems?: string; scopes: readonly string[] };
    roster?: { url: string; versions: readonly string[] };
  };
  deepLinking?: {
    returnUrl: string;
    acceptTypes: readonly string[];
    presentationTargets: readonly string[];
    data?: string;
  };
}

export interface LMSProvider {
  readonly id: 'canvas';
  readonly capabilities: readonly ['lti-launch-verification'];
  beginLogin(installationId: string, input: LoginInitiation): Promise<LoginRedirect>;
  validateLaunch(input: LaunchResponse): Promise<LMSLaunchContext>;
}
/** Future services are separate contracts; no fake successful implementations are exported. */
export interface LMSRosterService {
  getRoster(course: LMSReference): Promise<readonly LMSUser[]>;
}
export interface LMSGradeService {
  syncGrade(
    grade: LMSGrade,
    idempotencyKey: string,
  ): Promise<{ providerReceipt: string; confirmedAt: string }>;
}

export interface LoginInitiation {
  iss: string;
  login_hint: string;
  target_link_uri: string;
  client_id?: string;
  lti_message_hint?: string;
  lti_deployment_id?: string;
  /** Canvas currently also supplies this convenience parameter. */
  deployment_id?: string;
}
export interface LoginRedirect {
  authorizationUrl: string;
  state: string;
  /** Set only in a Secure, HttpOnly browser-binding cookie; never send in the query or log. */
  browserBinding: string;
  expiresAt: number;
}
export interface LaunchResponse {
  state: string;
  id_token: string;
  /** Read from the independent browser cookie, never the form body or URL. */
  browserBinding: string;
}

export interface CanvasInstallation {
  id: string;
  organizationId: string;
  version: number;
  enabled: boolean;
  issuer: string;
  clientId: string;
  deploymentId: string;
  authorizationEndpoint: string;
  jwksUri: string;
  /** Exact registered redirect/target pairs; changing one invalidates pending launches. */
  targets: readonly { uri: string; messageType: LTIMessageType }[];
  /** Default audience policy is clientId alone; extras require explicit registration. */
  trustedAdditionalAudiences?: readonly string[];
  /** Admin-approved institution origins for signed AGS/NRPS/deep-link return URLs. */
  serviceOrigins: readonly string[];
  /** Installation permission ceiling, intersected with signed launch scopes. */
  allowedServiceScopes: readonly string[];
}
export interface InstallationRepository {
  /** Must use the server's registered immutable tenant tuple, not browser-supplied ownership. */
  findById(id: string): Promise<CanvasInstallation | null>;
}
export interface LaunchAttempt {
  stateDigest: string;
  nonceDigest: string;
  browserBindingDigest: string;
  installationId: string;
  registrationVersion: number;
  targetUri: string;
  messageType: LTIMessageType;
  createdAt: number;
  expiresAt: number;
}
export interface LaunchReplayRepository {
  /** Insert only, with unique stateDigest. Never overwrite an existing attempt. */
  create(attempt: LaunchAttempt): Promise<boolean>;
  find(stateDigest: string): Promise<LaunchAttempt | null>;
  /**
   * Atomically compare every persisted attempt field, require expiresAt > now,
   * consume the state, and reserve unique (installationId, nonceDigest) until
   * retainNonceUntil. Return false for any mismatch/replay. Must be durable and
   * shared across API replicas; a Map is suitable only in synthetic tests.
   */
  consume(attempt: LaunchAttempt, now: number, retainNonceUntil: number): Promise<boolean>;
}

export type CanvasServiceAction = 'read-roster' | 'write-score' | 'read-line-items';
export interface CanvasServiceDescriptor {
  installationId: string;
  organizationId: string;
  method: 'GET' | 'POST';
  url: string;
  scopes: readonly string[];
  mediaType: string;
}
