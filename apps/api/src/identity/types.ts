export const identityRoles = [
  'student',
  'teacher',
  'viewer',
  'school_admin',
  'district_admin',
  'owner',
  'support',
  'system_admin',
] as const;
export type IdentityRole = (typeof identityRoles)[number];

export interface Membership {
  organizationId: string;
  role: IdentityRole;
}
export interface ProvisionedIdentity {
  userId: string;
  memberships: Membership[];
}
export interface SessionPrincipal extends Membership {
  /** Absent only on older in-process fixtures; PostgreSQL always supplies the method. */
  authenticationMethod?: 'oidc' | 'lti';
  sessionId: string;
  userId: string;
  mfa: boolean;
  createdAt: number;
  expiresAt: number;
  lastSeenAt: number;
}
export interface NewSession extends SessionPrincipal {
  sessionHash: string;
  idleExpiresAt: number;
}
export interface SessionSummary {
  sessionId: string;
  organizationId: string;
  createdAt: number;
  expiresAt: number;
  lastSeenAt: number;
  current: boolean;
}
/** All context is supplied by the trusted BFF, never from arbitrary client identity headers. */
export interface IdentityRepository {
  reserveLogin(stateHash: string, expiresAt: number): Promise<void>;
  consumeLogin(stateHash: string, now: number): Promise<boolean>;
  findIdentity(identityKey: string): Promise<ProvisionedIdentity | null>;
  createSession(session: NewSession, previousSessionHash?: string): Promise<void>;
  authenticate(
    sessionHash: string,
    now: number,
    idleTimeoutMs: number,
  ): Promise<SessionPrincipal | null>;
  revokeSession(sessionHash: string, now: number): Promise<void>;
  listSessions(sessionHash: string, now: number): Promise<SessionSummary[]>;
  revokeOwnedSession(sessionHash: string, targetSessionId: string, now: number): Promise<boolean>;
}

export interface IdentityConfig {
  issuerUrl: string;
  clientId: string;
  /** Confidential BFF client credential. Never exposed to the browser. */
  clientSecret: string;
  applicationOrigin: string;
  redirectUri: string;
  /** Independent secret for encrypted login cookies and CSRF derivation; exactly 32 bytes. */
  sessionSecret: Uint8Array;
  /** Stable, separately managed HMAC key for pseudonymous issuer/subject lookup; exactly 32 bytes. */
  identityHmacKey: Uint8Array;
  allowedReturnPaths?: readonly string[];
  /** Exact HTTPS origins for IdP endpoints hosted away from its issuer origin. */
  allowedProviderOrigins?: readonly string[];
  sessionMaxAgeSeconds?: number;
  idleTimeoutSeconds?: number;
  loginMaxAgeSeconds?: number;
  /** Exact signed ACR values the configured issuer guarantees represent MFA. Empty denies privileged login. */
  mfaAcrValues?: readonly string[];
  idTokenSigningAlgorithm?: 'RS256' | 'PS256' | 'ES256';
}

export class IdentityError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'IdentityError';
  }
}
