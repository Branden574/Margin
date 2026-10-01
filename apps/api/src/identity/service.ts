import { randomUUID } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';
import * as oidc from 'openid-client';
import {
  createCookieCrypto,
  equalSecret,
  identityLookupKey,
  isOpaqueToken,
  opaqueToken,
  tokenHash,
} from './crypto.js';
import { discoverProvider, secureUrl, type OidcTestOptions } from './oidc.js';
import {
  IdentityError,
  type IdentityConfig,
  type IdentityRepository,
  type SessionPrincipal,
} from './types.js';

export const SESSION_COOKIE = '__Host-margin-session';
export const LOGIN_COOKIE = '__Host-margin-login';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const privileged = new Set(['school_admin', 'district_admin', 'owner', 'support', 'system_admin']);
export interface IdentityRequest {
  headers: IncomingHttpHeaders;
}
export interface LoginResult {
  location: string;
  cookies: string[];
}
export interface AuthenticatedRequest {
  principal: SessionPrincipal;
  csrfToken: string;
}
export interface IdentityFederation {
  /** Must recheck the persisted LMS installation, identity link, course and enrollment. */
  authorizeLmsSession: (principal: SessionPrincipal) => Promise<boolean>;
}

function boundedInteger(value: number, low: number, high: number, label: string) {
  if (!Number.isInteger(value) || value < low || value > high)
    throw new Error(`${label} is outside its permitted range.`);
  return value;
}
export function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  if (header.length > 8192)
    throw new IdentityError(400, 'invalid_cookie', 'The session cookie is invalid.');
  const matches = header
    .split(';')
    .map((entry) => entry.trim())
    .filter((entry) => entry.startsWith(`${name}=`));
  if (matches.length > 1)
    throw new IdentityError(400, 'invalid_cookie', 'Duplicate session cookies are not accepted.');
  return matches[0]?.slice(name.length + 1);
}
function cookie(name: string, value: string, maxAge: number) {
  return `${name}=${value}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`;
}
export const clearIdentityCookies = () => [
  cookie(SESSION_COOKIE, '', 0),
  cookie(LOGIN_COOKIE, '', 0),
];
export const clearLoginCookie = () => cookie(LOGIN_COOKIE, '', 0);

export class IdentityService {
  readonly applicationOrigin: string;
  readonly callbackPath: string;
  private readonly sessionSeconds: number;
  private readonly idleSeconds: number;
  private readonly loginSeconds: number;
  private readonly returnPaths: Set<string>;
  private readonly crypto;
  constructor(
    private readonly config: IdentityConfig,
    private readonly repository: IdentityRepository,
    private readonly provider: oidc.Configuration,
    private readonly federation?: IdentityFederation,
  ) {
    const origin = secureUrl(config.applicationOrigin, 'Application origin');
    if (origin.origin !== config.applicationOrigin)
      throw new Error('Application origin must be an exact HTTPS origin.');
    const redirect = secureUrl(config.redirectUri, 'OIDC redirect URI');
    if (redirect.origin !== origin.origin || redirect.pathname !== '/api/auth/callback')
      throw new Error('OIDC redirect must be the same-origin /api/auth/callback endpoint.');
    this.applicationOrigin = origin.origin;
    this.callbackPath = redirect.pathname;
    this.sessionSeconds = boundedInteger(
      config.sessionMaxAgeSeconds ?? 3600,
      300,
      86400,
      'Session lifetime',
    );
    this.idleSeconds = boundedInteger(
      config.idleTimeoutSeconds ?? Math.min(1800, this.sessionSeconds),
      60,
      this.sessionSeconds,
      'Idle timeout',
    );
    this.loginSeconds = boundedInteger(config.loginMaxAgeSeconds ?? 300, 60, 600, 'Login lifetime');
    this.returnPaths = new Set(config.allowedReturnPaths ?? ['/']);
    if (!this.returnPaths.size || this.returnPaths.size > 32)
      throw new Error('Configure between one and 32 return paths.');
    for (const path of this.returnPaths) {
      const url = new URL(path, origin);
      if (
        path.length > 256 ||
        !path.startsWith('/') ||
        path.startsWith('//') ||
        url.origin !== origin.origin ||
        url.pathname !== path ||
        url.search ||
        url.hash
      )
        throw new Error(
          'Return paths must be exact same-origin paths without queries or fragments.',
        );
    }
    if (config.identityHmacKey.byteLength !== 32)
      throw new Error('Identity HMAC key must contain exactly 32 random bytes.');
    if (
      (config.mfaAcrValues?.length ?? 0) > 16 ||
      config.mfaAcrValues?.some((value) => !value || value.length > 200)
    )
      throw new Error('Invalid MFA ACR configuration.');
    this.crypto = createCookieCrypto(config.sessionSecret, origin.origin);
  }
  requireSameOrigin(request: IdentityRequest, mutation = false): void {
    const origin = request.headers.origin;
    if (
      (mutation && !origin) ||
      (origin !== undefined && origin !== this.applicationOrigin) ||
      request.headers['sec-fetch-site'] === 'cross-site'
    )
      throw new IdentityError(
        403,
        'origin_rejected',
        'This request must come from the signed-in workspace.',
      );
  }
  async startLogin(
    input: { returnTo?: string; organizationId?: string } = {},
  ): Promise<LoginResult> {
    const returnTo = input.returnTo ?? [...this.returnPaths][0];
    if (!this.returnPaths.has(returnTo))
      throw new IdentityError(400, 'invalid_return_path', 'This return location is not allowed.');
    if (input.organizationId && !uuid.test(input.organizationId))
      throw new IdentityError(400, 'invalid_organization', 'Select a valid organization.');
    const state = opaqueToken();
    const nonce = opaqueToken();
    const verifier = oidc.randomPKCECodeVerifier();
    const expiresAt = Date.now() + this.loginSeconds * 1000;
    const parameters: Record<string, string> = {
      redirect_uri: this.config.redirectUri,
      scope: 'openid',
      state,
      nonce,
      code_challenge: await oidc.calculatePKCECodeChallenge(verifier),
      code_challenge_method: 'S256',
      response_mode: 'query',
      max_age: '300',
    };
    if (this.config.mfaAcrValues?.length)
      parameters.acr_values = this.config.mfaAcrValues.join(' ');
    await this.repository.reserveLogin(tokenHash(state), expiresAt);
    return {
      location: oidc.buildAuthorizationUrl(this.provider, parameters).href,
      cookies: [
        cookie(
          LOGIN_COOKIE,
          this.crypto.seal({
            version: 1,
            state,
            nonce,
            verifier,
            expiresAt,
            returnTo,
            ...(input.organizationId ? { organizationId: input.organizationId } : {}),
          }),
          this.loginSeconds,
        ),
      ],
    };
  }
  async completeLogin(
    callback: URL,
    cookieHeader?: string,
  ): Promise<LoginResult & { principal: SessionPrincipal }> {
    if (
      callback.origin !== this.applicationOrigin ||
      callback.pathname !== this.callbackPath ||
      callback.hash ||
      callback.href.length > 8192
    )
      throw new IdentityError(400, 'invalid_callback', 'The sign-in callback is invalid.');
    const saved = readCookie(cookieHeader, LOGIN_COOKIE);
    if (!saved)
      throw new IdentityError(
        400,
        'missing_login',
        'The sign-in cookie is missing. Start sign-in again.',
      );
    const transaction = this.crypto.open(saved);
    const states = callback.searchParams.getAll('state');
    if (
      transaction.expiresAt <= Date.now() ||
      states.length !== 1 ||
      !equalSecret(states[0], transaction.state) ||
      !this.returnPaths.has(transaction.returnTo)
    )
      throw new IdentityError(
        400,
        'invalid_login',
        'This sign-in attempt is invalid or expired. Start sign-in again.',
      );
    if (!(await this.repository.consumeLogin(tokenHash(transaction.state), Date.now())))
      throw new IdentityError(
        400,
        'login_used',
        'This sign-in attempt expired or was already used. Start sign-in again.',
      );
    let claims: oidc.IDToken | undefined;
    try {
      const tokens = await oidc.authorizationCodeGrant(this.provider, callback, {
        expectedState: transaction.state,
        expectedNonce: transaction.nonce,
        pkceCodeVerifier: transaction.verifier,
        idTokenExpected: true,
        maxAge: 300,
      });
      claims = tokens.claims();
      // Access, refresh, and ID tokens are deliberately neither persisted nor returned.
    } catch {
      throw new IdentityError(
        401,
        'oidc_verification_failed',
        'Sign-in could not be verified. Start sign-in again.',
      );
    }
    if (
      !claims ||
      typeof claims.sub !== 'string' ||
      !claims.sub ||
      claims.sub.length > 255 ||
      claims.iss !== this.config.issuerUrl
    )
      throw new IdentityError(401, 'oidc_verification_failed', 'Sign-in could not be verified.');
    const identity = await this.repository.findIdentity(
      identityLookupKey(this.config.identityHmacKey, claims.iss, claims.sub),
    );
    if (!identity?.memberships.length)
      throw new IdentityError(
        403,
        'membership_required',
        'Your account has no active workspace membership. Contact your organization administrator.',
      );
    const membership = transaction.organizationId
      ? identity.memberships.find((item) => item.organizationId === transaction.organizationId)
      : identity.memberships.length === 1
        ? identity.memberships[0]
        : undefined;
    if (!membership)
      throw new IdentityError(
        403,
        'organization_required',
        'Sign in for an organization in which you have active membership.',
      );
    const mfa =
      typeof claims.acr === 'string' && (this.config.mfaAcrValues ?? []).includes(claims.acr);
    if (privileged.has(membership.role) && !mfa)
      throw new IdentityError(
        403,
        'mfa_required',
        'This privileged role requires your organization’s configured multi-factor sign-in.',
      );
    const now = Date.now();
    const sessionToken = opaqueToken();
    const principal: SessionPrincipal = {
      ...membership,
      authenticationMethod: 'oidc',
      sessionId: randomUUID(),
      userId: identity.userId,
      mfa,
      createdAt: now,
      expiresAt: now + this.sessionSeconds * 1000,
      lastSeenAt: now,
    };
    const previous = readCookie(cookieHeader, SESSION_COOKIE);
    await this.repository.createSession(
      {
        ...principal,
        sessionHash: tokenHash(sessionToken),
        idleExpiresAt: now + this.idleSeconds * 1000,
      },
      previous && isOpaqueToken(previous) ? tokenHash(previous) : undefined,
    );
    return {
      principal,
      location: new URL(transaction.returnTo, this.applicationOrigin).href,
      cookies: [cookie(SESSION_COOKIE, sessionToken, this.sessionSeconds), clearLoginCookie()],
    };
  }
  /**
   * Server-only issuer boundary. Call only after cryptographic LTI verification and an
   * explicit provisioned enrollment lookup. The repository rechecks active membership.
   * The LMS caller must persist the session binding before returning these cookies.
   */
  async issueLmsSession(
    enrollment: { userId: string; organizationId: string; role: 'student' | 'teacher' | 'viewer' },
    request: IdentityRequest,
  ): Promise<{ principal: SessionPrincipal; cookies: string[] }> {
    if (!this.federation)
      throw new IdentityError(503, 'lms_unavailable', 'LMS sign-in is not configured.');
    if (
      !uuid.test(enrollment.userId) ||
      !uuid.test(enrollment.organizationId) ||
      !['student', 'teacher', 'viewer'].includes(enrollment.role)
    )
      throw new IdentityError(
        403,
        'lms_membership_required',
        'A permitted LMS membership is required.',
      );
    const now = Date.now();
    const sessionToken = opaqueToken();
    const principal: SessionPrincipal = {
      userId: enrollment.userId,
      organizationId: enrollment.organizationId,
      role: enrollment.role,
      authenticationMethod: 'lti',
      sessionId: randomUUID(),
      mfa: false,
      createdAt: now,
      expiresAt: now + this.sessionSeconds * 1000,
      lastSeenAt: now,
    };
    const previous = readCookie(request.headers.cookie, SESSION_COOKIE);
    await this.repository.createSession(
      {
        ...principal,
        sessionHash: tokenHash(sessionToken),
        idleExpiresAt: now + this.idleSeconds * 1000,
      },
      previous && isOpaqueToken(previous) ? tokenHash(previous) : undefined,
    );
    return {
      principal,
      cookies: [cookie(SESSION_COOKIE, sessionToken, this.sessionSeconds), clearLoginCookie()],
    };
  }
  private sessionToken(request: IdentityRequest): string {
    const token = readCookie(request.headers.cookie, SESSION_COOKIE);
    if (!token || !isOpaqueToken(token))
      throw new IdentityError(401, 'authentication_required', 'Sign in to access this workspace.');
    return token;
  }
  async authenticateRequest(request: IdentityRequest): Promise<AuthenticatedRequest> {
    this.requireSameOrigin(request);
    const token = this.sessionToken(request);
    const principal = await this.repository.authenticate(
      tokenHash(token),
      Date.now(),
      this.idleSeconds * 1000,
    );
    if (!principal)
      throw new IdentityError(
        401,
        'session_expired',
        'Your session expired or was revoked. Sign in again; local work is unchanged.',
      );
    if (
      principal.authenticationMethod === 'lti' &&
      (!this.federation || !(await this.federation.authorizeLmsSession(principal)))
    )
      throw new IdentityError(
        403,
        'lms_access_revoked',
        'This LMS session is unavailable. Open the assignment from Canvas again.',
      );
    if (privileged.has(principal.role) && !principal.mfa)
      throw new IdentityError(
        403,
        'mfa_required',
        'Your new role requires multi-factor sign-in. Sign in again.',
      );
    return { principal, csrfToken: this.crypto.csrf(token) };
  }
  verifyCsrf(request: IdentityRequest, authenticated: AuthenticatedRequest): void {
    this.requireSameOrigin(request, true);
    const supplied = request.headers['x-csrf-token'];
    if (
      typeof supplied !== 'string' ||
      !isOpaqueToken(supplied) ||
      !equalSecret(supplied, authenticated.csrfToken)
    )
      throw new IdentityError(
        403,
        'csrf_rejected',
        'The request could not be verified. Refresh the workspace and retry.',
      );
  }
  async logoutRequest(request: IdentityRequest): Promise<string[]> {
    const authenticated = await this.authenticateRequest(request);
    this.verifyCsrf(request, authenticated);
    await this.repository.revokeSession(tokenHash(this.sessionToken(request)), Date.now());
    return clearIdentityCookies();
  }
  async listSessions(request: IdentityRequest) {
    await this.authenticateRequest(request);
    return this.repository.listSessions(tokenHash(this.sessionToken(request)), Date.now());
  }
  async revokeOwnedSession(request: IdentityRequest, targetSessionId: string): Promise<boolean> {
    const authenticated = await this.authenticateRequest(request);
    this.verifyCsrf(request, authenticated);
    if (!uuid.test(targetSessionId))
      throw new IdentityError(
        404,
        'session_not_found',
        'This session is unavailable to your account.',
      );
    return this.repository.revokeOwnedSession(
      tokenHash(this.sessionToken(request)),
      targetSessionId,
      Date.now(),
    );
  }
}

export async function createIdentityService(
  config: IdentityConfig,
  repository: IdentityRepository,
  tests: OidcTestOptions = {},
  federation?: IdentityFederation,
): Promise<IdentityService> {
  if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0') {
    throw new Error('Identity startup refuses globally disabled TLS certificate verification.');
  }
  if (
    !config.clientId ||
    config.clientId.length > 512 ||
    config.clientSecret.length < 16 ||
    config.clientSecret.length > 4096
  )
    throw new Error('A bounded, confidential OIDC client configuration is required.');
  secureUrl(config.applicationOrigin, 'Application origin');
  secureUrl(config.redirectUri, 'OIDC redirect URI');
  if (config.sessionSecret.byteLength !== 32 || config.identityHmacKey.byteLength !== 32)
    throw new Error('Identity secrets must contain exactly 32 random bytes.');
  if (Buffer.from(config.sessionSecret).equals(Buffer.from(config.identityHmacKey)))
    throw new Error('Session and identity lookup secrets must be independent keys.');
  return new IdentityService(config, repository, await discoverProvider(config, tests), federation);
}
