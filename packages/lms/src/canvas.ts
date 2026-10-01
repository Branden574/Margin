import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  createRemoteJWKSet,
  customFetch,
  decodeProtectedHeader,
  jwtVerify,
  type JWTVerifyGetKey,
} from 'jose';
import type {
  CanvasInstallation,
  CanvasServiceAction,
  CanvasServiceDescriptor,
  InstallationRepository,
  LaunchReplayRepository,
  LaunchResponse,
  LMSLaunchContext,
  LMSProvider,
  LMSRoleHint,
  LoginInitiation,
  LoginRedirect,
} from './types.js';

export const LTI_CLAIM = 'https://purl.imsglobal.org/spec/lti/claim/';
export const AGS_CLAIM = 'https://purl.imsglobal.org/spec/lti-ags/claim/endpoint';
export const NRPS_CLAIM = 'https://purl.imsglobal.org/spec/lti-nrps/claim/namesroleservice';
export const DEEP_LINK_CLAIM = 'https://purl.imsglobal.org/spec/lti-dl/claim/deep_linking_settings';
export const CANVAS_SCOPES = {
  roster: 'https://purl.imsglobal.org/spec/lti-nrps/scope/contextmembership.readonly',
  score: 'https://purl.imsglobal.org/spec/lti-ags/scope/score',
  lineItemsRead: 'https://purl.imsglobal.org/spec/lti-ags/scope/lineitem.readonly',
  lineItems: 'https://purl.imsglobal.org/spec/lti-ags/scope/lineitem',
} as const;
/** Official Instructure hosted endpoints verified 2026-10-01; not institution URLs. */
export function hostedCanvasEndpoints(environment: 'production' | 'beta' | 'test') {
  const environmentLabel = environment === 'production' ? '' : `.${environment}`;
  return {
    issuer: `https://canvas${environmentLabel}.instructure.com`,
    authorizationEndpoint: `https://sso${environmentLabel}.canvaslms.com/api/lti/authorize_redirect`,
    jwksUri: `https://sso${environmentLabel}.canvaslms.com/api/lti/security/jwks`,
  };
}
export class LTIError extends Error {
  constructor(
    public readonly code:
      | 'configuration'
      | 'login'
      | 'state'
      | 'token'
      | 'context'
      | 'replay'
      | 'permission',
    message: string,
  ) {
    super(message);
    this.name = 'LTIError';
  }
}
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
function equal(a: string, b: string) {
  const first = Buffer.from(a),
    second = Buffer.from(b);
  return first.length === second.length && timingSafeEqual(first, second);
}
function string(value: unknown, label: string, max = 2048): string {
  if (
    typeof value !== 'string' ||
    !value.length ||
    value.length > max ||
    /[\u0000-\u001f\u007f]/.test(value)
  )
    throw new LTIError('context', `The LTI ${label} is missing or invalid.`);
  return value;
}
function strings(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length > 100)
    throw new LTIError('context', `The LTI ${label} is invalid.`);
  return value.map((item) => string(item, label, 1024));
}
function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new LTIError('context', `The LTI ${label} is invalid.`);
  return value as Record<string, unknown>;
}
function https(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new LTIError('configuration', 'A configured LTI URL is invalid.');
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash)
    throw new LTIError('configuration', 'LTI URLs require HTTPS without credentials or fragments.');
  return url;
}
function validateInstallation(value: CanvasInstallation | null): CanvasInstallation {
  if (!value?.enabled)
    throw new LTIError('configuration', 'This Canvas installation is unavailable or revoked.');
  for (const key of ['id', 'organizationId', 'issuer', 'clientId', 'deploymentId'] as const)
    string(value[key], key);
  if (
    !Number.isSafeInteger(value.version) ||
    value.version < 1 ||
    !value.targets.length ||
    value.targets.length > 20
  )
    throw new LTIError('configuration', 'Canvas registration is incomplete.');
  https(value.issuer);
  https(value.authorizationEndpoint);
  https(value.jwksUri);
  if (new URL(value.authorizationEndpoint).search || new URL(value.jwksUri).search)
    throw new LTIError(
      'configuration',
      'Registered authorization and key URLs must not contain query parameters.',
    );
  for (const target of value.targets) {
    https(target.uri);
    if (!['LtiResourceLinkRequest', 'LtiDeepLinkingRequest'].includes(target.messageType))
      throw new LTIError('configuration', 'Unsupported registered LTI message type.');
  }
  for (const origin of value.serviceOrigins)
    if (https(origin).origin !== origin)
      throw new LTIError('configuration', 'Service allowlists must contain exact HTTPS origins.');
  strings(value.allowedServiceScopes, 'registered scopes');
  if (value.trustedAdditionalAudiences)
    strings(value.trustedAdditionalAudiences, 'registered audiences');
  return value;
}
function serviceUrl(value: unknown, installation: CanvasInstallation): string {
  const input = string(value, 'service URL');
  const url = https(input);
  if (!installation.serviceOrigins.includes(url.origin))
    throw new LTIError(
      'permission',
      'The Canvas service endpoint is outside this installation’s approved origins.',
    );
  return input;
}
function optionalString(value: unknown, label: string): string | undefined {
  return value === undefined ? undefined : string(value, label);
}
function roleHints(roles: readonly string[]): LMSRoleHint[] {
  const hints = new Set<LMSRoleHint>();
  if (roles.includes('http://purl.imsglobal.org/vocab/lis/v2/membership#Learner'))
    hints.add('learner');
  if (roles.includes('http://purl.imsglobal.org/vocab/lis/v2/membership#Instructor'))
    hints.add('instructor');
  if (
    roles.some((role) =>
      [
        'http://purl.imsglobal.org/vocab/lis/v2/membership#Administrator',
        'http://purl.imsglobal.org/vocab/lis/v2/institution/person#Administrator',
        'http://purl.imsglobal.org/vocab/lis/v2/system/person#Administrator',
      ].includes(role),
    )
  )
    hints.add('administrator');
  return [...hints];
}
function freeze<T extends object>(value: T): T {
  for (const child of Object.values(value)) if (child && typeof child === 'object') freeze(child);
  return Object.freeze(value);
}

export interface CanvasProviderOptions {
  installations: InstallationRepository;
  replay: LaunchReplayRepository;
  /** Defaults to cached, pinned registration JWKS; injectable only at the server boundary. */
  resolveKey?: (installation: CanvasInstallation) => JWTVerifyGetKey;
  now?: () => number;
  /** Additional application grants are mandatory; absent means every service action is denied. */
  authorizeService?: (context: LMSLaunchContext, action: CanvasServiceAction) => Promise<boolean>;
}

const MAX_KEYSETS = 128;
const MAX_JWKS_BYTES = 128 * 1024;
function requireVerifiedTls() {
  if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0')
    throw new LTIError(
      'configuration',
      'Canvas verification refuses globally disabled TLS certificate verification.',
    );
}
/** URL is administrator-registered, never read from the token. Bounds apply to decoded body bytes. */
function boundedJwksFetch(
  expectedUrl: string,
): NonNullable<Parameters<typeof createRemoteJWKSet>[1]>[typeof customFetch] {
  return async (url, init) => {
    requireVerifiedTls();
    if (url !== expectedUrl || https(url).href !== expectedUrl)
      throw new LTIError('configuration', 'Canvas key retrieval URL does not match registration.');
    const signal = AbortSignal.any([init.signal, AbortSignal.timeout(5000)]);
    const response = await fetch(url, { ...init, redirect: 'error', signal });
    const contentType = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
    const declared = Number(response.headers.get('content-length'));
    if (
      response.status !== 200 ||
      !['application/json', 'application/jwk-set+json'].includes(contentType ?? '') ||
      declared > MAX_JWKS_BYTES ||
      !response.body
    ) {
      await response.body?.cancel();
      throw new LTIError('token', 'The Canvas key response is invalid or oversized.');
    }
    const reader = response.body.getReader();
    let length = 0;
    const chunks: Uint8Array[] = [];
    try {
      for (;;) {
        signal.throwIfAborted();
        const { done, value } = await reader.read();
        if (done) break;
        length += value.byteLength;
        if (length > MAX_JWKS_BYTES)
          throw new LTIError('token', 'The Canvas key response is oversized.');
        chunks.push(value);
      }
      signal.throwIfAborted();
      const text = Buffer.concat(chunks, length).toString('utf8');
      const parsed: unknown = JSON.parse(text);
      if (
        !parsed ||
        typeof parsed !== 'object' ||
        !Array.isArray((parsed as { keys?: unknown }).keys) ||
        (parsed as { keys: unknown[] }).keys.length > 64
      )
        throw new LTIError('token', 'The Canvas key set is invalid.');
      return new Response(text, { status: 200, headers: { 'content-type': 'application/json' } });
    } finally {
      await reader.cancel().catch(() => {});
    }
  };
}

export class CanvasLMSProvider implements LMSProvider {
  readonly id = 'canvas' as const;
  readonly capabilities = ['lti-launch-verification'] as const;
  private readonly verified = new WeakSet<LMSLaunchContext>();
  private readonly keysets = new Map<string, JWTVerifyGetKey>();
  private readonly now: () => number;
  constructor(private readonly options: CanvasProviderOptions) {
    requireVerifiedTls();
    this.now = options.now ?? Date.now;
  }
  private key(installation: CanvasInstallation) {
    if (this.options.resolveKey) return this.options.resolveKey(installation);
    let key = this.keysets.get(installation.jwksUri);
    if (key) this.keysets.delete(installation.jwksUri);
    if (!key) {
      // Byte/time bounds and redirect denial supplement the registered URL boundary.
      key = createRemoteJWKSet(new URL(installation.jwksUri), {
        timeoutDuration: 5000,
        cooldownDuration: 30_000,
        cacheMaxAge: 300_000,
        [customFetch]: boundedJwksFetch(new URL(installation.jwksUri).href),
      });
    }
    this.keysets.set(installation.jwksUri, key);
    if (this.keysets.size > MAX_KEYSETS) this.keysets.delete(this.keysets.keys().next().value!);
    return key;
  }
  async beginLogin(installationId: string, input: LoginInitiation): Promise<LoginRedirect> {
    const installation = validateInstallation(
      await this.options.installations.findById(installationId),
    );
    if (
      input.iss !== installation.issuer ||
      (input.client_id !== undefined && input.client_id !== installation.clientId) ||
      [input.lti_deployment_id, input.deployment_id].some(
        (id) => id !== undefined && id !== installation.deploymentId,
      )
    )
      throw new LTIError('login', 'Canvas login does not match the registered installation.');
    const target = installation.targets.find((item) => item.uri === input.target_link_uri);
    if (!target) throw new LTIError('login', 'The Canvas launch target is not registered.');
    const hint = string(input.login_hint, 'login hint', 8192);
    const messageHint =
      input.lti_message_hint === undefined
        ? undefined
        : string(input.lti_message_hint, 'message hint', 8192);
    const state = randomBytes(32).toString('base64url'),
      nonce = randomBytes(32).toString('base64url'),
      browserBinding = randomBytes(32).toString('base64url');
    const createdAt = this.now(),
      expiresAt = createdAt + 300_000;
    if (
      !(await this.options.replay.create({
        stateDigest: digest(state),
        nonceDigest: digest(nonce),
        browserBindingDigest: digest(browserBinding),
        installationId: installation.id,
        registrationVersion: installation.version,
        targetUri: target.uri,
        messageType: target.messageType,
        createdAt,
        expiresAt,
      }))
    )
      throw new LTIError('state', 'The launch could not be prepared. Start it again from Canvas.');
    const authorization = new URL(installation.authorizationEndpoint);
    for (const [key, value] of Object.entries({
      scope: 'openid',
      response_type: 'id_token',
      response_mode: 'form_post',
      prompt: 'none',
      client_id: installation.clientId,
      redirect_uri: target.uri,
      login_hint: hint,
      state,
      nonce,
    }))
      authorization.searchParams.set(key, value);
    if (messageHint !== undefined) authorization.searchParams.set('lti_message_hint', messageHint);
    return { authorizationUrl: authorization.href, state, browserBinding, expiresAt };
  }
  async validateLaunch(input: LaunchResponse): Promise<LMSLaunchContext> {
    if (
      !/^[A-Za-z0-9_-]{43}$/.test(input.state) ||
      !/^[A-Za-z0-9_-]{43}$/.test(input.browserBinding)
    )
      throw new LTIError(
        'state',
        'The browser launch state is missing. Restart this launch in a top-level window.',
      );
    const attempt = await this.options.replay.find(digest(input.state));
    const now = this.now();
    if (
      !attempt ||
      attempt.expiresAt <= now ||
      !equal(attempt.browserBindingDigest, digest(input.browserBinding))
    )
      throw new LTIError(
        'state',
        'The launch state expired or belongs to another browser. Restart from Canvas.',
      );
    const installation = validateInstallation(
      await this.options.installations.findById(attempt.installationId),
    );
    if (
      installation.version !== attempt.registrationVersion ||
      !installation.targets.some(
        (target) => target.uri === attempt.targetUri && target.messageType === attempt.messageType,
      )
    )
      throw new LTIError('state', 'Canvas configuration changed. Restart the launch.');
    if (typeof input.id_token !== 'string' || input.id_token.length > 64 * 1024)
      throw new LTIError('token', 'The Canvas launch token is invalid.');
    let claims: Record<string, unknown>;
    try {
      const header = decodeProtectedHeader(input.id_token);
      if (
        header.alg !== 'RS256' ||
        !header.kid ||
        header.jku ||
        header.jwk ||
        header.x5u ||
        header.x5c
      )
        throw new Error('Unexpected signing key source.');
      const result = await jwtVerify(input.id_token, this.key(installation), {
        algorithms: ['RS256'],
        issuer: installation.issuer,
        audience: installation.clientId,
        requiredClaims: ['iss', 'aud', 'sub', 'exp', 'iat', 'nonce'],
        clockTolerance: 30,
        maxTokenAge: 300,
        currentDate: new Date(now),
      });
      claims = result.payload;
    } catch {
      throw new LTIError(
        'token',
        'The Canvas launch signature, identity or timestamp could not be verified.',
      );
    }
    const audiences =
      typeof claims.aud === 'string' ? [claims.aud] : strings(claims.aud, 'audiences');
    const trusted = new Set([
      installation.clientId,
      ...(installation.trustedAdditionalAudiences ?? []),
    ]);
    if (
      audiences.some((audience) => !trusted.has(audience)) ||
      (audiences.length > 1 && claims.azp !== installation.clientId) ||
      (claims.azp !== undefined && claims.azp !== installation.clientId)
    )
      throw new LTIError('token', 'The Canvas launch audience is not trusted.');
    const issuedAt = claims.iat as number,
      expiresAt = claims.exp as number;
    if (
      !Number.isSafeInteger(issuedAt) ||
      !Number.isSafeInteger(expiresAt) ||
      expiresAt <= issuedAt ||
      expiresAt - issuedAt > 600 ||
      issuedAt * 1000 < attempt.createdAt - 30_000
    )
      throw new LTIError('token', 'The Canvas launch timestamp is outside the accepted window.');
    if (!equal(digest(string(claims.nonce, 'nonce')), attempt.nonceDigest))
      throw new LTIError('token', 'The Canvas launch nonce does not match this request.');
    if (
      claims[LTI_CLAIM + 'deployment_id'] !== installation.deploymentId ||
      claims[LTI_CLAIM + 'version'] !== '1.3.0' ||
      claims[LTI_CLAIM + 'message_type'] !== attempt.messageType ||
      claims[LTI_CLAIM + 'target_link_uri'] !== attempt.targetUri
    )
      throw new LTIError(
        'context',
        'The Canvas launch deployment, message or target does not match this installation.',
      );
    const roles = strings(claims[LTI_CLAIM + 'roles'], 'roles');
    const context: LMSLaunchContext = {
      provider: 'canvas',
      installationId: installation.id,
      organizationId: installation.organizationId,
      registrationVersion: installation.version,
      issuer: installation.issuer,
      clientId: installation.clientId,
      deploymentId: installation.deploymentId,
      messageType: attempt.messageType,
      targetUri: attempt.targetUri,
      user: {
        reference: {
          installationId: installation.id,
          externalId: string(claims.sub, 'subject', 255),
        },
        roleHints: roleHints(roles),
      },
      protocolRoles: roles,
      issuedAt,
      expiresAt,
      services: {},
    };
    if (claims[LTI_CLAIM + 'context'] !== undefined) {
      const course = object(claims[LTI_CLAIM + 'context'], 'course');
      context.course = {
        reference: { installationId: installation.id, externalId: string(course.id, 'course id') },
        title: optionalString(course.title, 'course title'),
        label: optionalString(course.label, 'course label'),
      };
    }
    if (attempt.messageType === 'LtiResourceLinkRequest') {
      const resource = object(claims[LTI_CLAIM + 'resource_link'], 'resource link');
      context.resource = {
        reference: {
          installationId: installation.id,
          externalId: string(resource.id, 'resource id'),
        },
        title: optionalString(resource.title, 'resource title'),
      };
      if (claims[LTI_CLAIM + 'custom'] !== undefined) {
        const custom = object(claims[LTI_CLAIM + 'custom'], 'custom parameters');
        if (custom.margin_assignment_id !== undefined) {
          const assignmentId = string(custom.margin_assignment_id, 'assignment identifier', 36);
          if (
            !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(
              assignmentId,
            )
          )
            throw new LTIError('context', 'The assignment identifier is invalid.');
          context.resource.assignmentId = assignmentId;
        }
      }
    } else {
      const deep = object(claims[DEEP_LINK_CLAIM], 'deep linking settings');
      context.deepLinking = {
        returnUrl: serviceUrl(deep.deep_link_return_url, installation),
        acceptTypes: strings(deep.accept_types, 'deep link content types'),
        presentationTargets: strings(
          deep.accept_presentation_document_targets,
          'deep link presentation targets',
        ),
        ...(deep.data !== undefined
          ? { data: deep.data === '' ? '' : string(deep.data, 'deep link data', 8192) }
          : {}),
      };
    }
    if (claims[AGS_CLAIM] !== undefined) {
      const grades = object(claims[AGS_CLAIM], 'grade services');
      context.services.grades = {
        scopes: strings(grades.scope, 'grade scopes').filter((scope) =>
          installation.allowedServiceScopes.includes(scope),
        ),
        lineItem: grades.lineitem ? serviceUrl(grades.lineitem, installation) : undefined,
        lineItems: grades.lineitems ? serviceUrl(grades.lineitems, installation) : undefined,
      };
    }
    if (claims[NRPS_CLAIM] !== undefined) {
      const roster = object(claims[NRPS_CLAIM], 'roster service'),
        versions = strings(roster.service_versions, 'roster versions');
      if (!context.course || !versions.includes('2.0'))
        throw new LTIError('context', 'The roster claim lacks a supported course context.');
      context.services.roster = {
        url: serviceUrl(roster.context_memberships_url, installation),
        versions,
      };
    }
    if (!(await this.options.replay.consume(attempt, this.now(), expiresAt * 1000 + 30_000)))
      throw new LTIError(
        'replay',
        'This Canvas launch has already been used or expired. Restart from Canvas.',
      );
    freeze(context);
    this.verified.add(context);
    return context;
  }
  /** Policy/endpoint preparation only. No token request, roster sync or grade transmission occurs. */
  async prepareServiceRequest(
    context: LMSLaunchContext,
    action: CanvasServiceAction,
  ): Promise<CanvasServiceDescriptor> {
    if (!this.verified.has(context) || context.expiresAt * 1000 <= this.now())
      throw new LTIError('permission', 'A current verified launch is required.');
    const installation = validateInstallation(
      await this.options.installations.findById(context.installationId),
    );
    if (
      installation.organizationId !== context.organizationId ||
      installation.version !== context.registrationVersion ||
      !(await this.options.authorizeService?.(context, action))
    )
      throw new LTIError(
        'permission',
        'This application identity is not authorized for the Canvas service.',
      );
    const base = { installationId: context.installationId, organizationId: context.organizationId };
    if (action === 'read-roster') {
      if (
        !context.services.roster ||
        !installation.allowedServiceScopes.includes(CANVAS_SCOPES.roster)
      )
        throw new LTIError('permission', 'Roster access is not granted for this installation.');
      return {
        ...base,
        method: 'GET',
        url: serviceUrl(context.services.roster.url, installation),
        scopes: [CANVAS_SCOPES.roster],
        mediaType: 'application/vnd.ims.lti-nrps.v2.membershipcontainer+json',
      };
    }
    const grades = context.services.grades;
    if (
      action === 'write-score' &&
      grades?.lineItem &&
      grades.scopes.includes(CANVAS_SCOPES.score)
    ) {
      const url = new URL(serviceUrl(grades.lineItem, installation));
      url.pathname = url.pathname.replace(/\/$/, '') + '/scores';
      return {
        ...base,
        method: 'POST',
        url: url.href,
        scopes: [CANVAS_SCOPES.score],
        mediaType: 'application/vnd.ims.lis.v1.score+json',
      };
    }
    if (action === 'read-line-items' && grades?.lineItems) {
      const scope = grades.scopes.includes(CANVAS_SCOPES.lineItemsRead)
        ? CANVAS_SCOPES.lineItemsRead
        : grades.scopes.includes(CANVAS_SCOPES.lineItems)
          ? CANVAS_SCOPES.lineItems
          : undefined;
      if (scope)
        return {
          ...base,
          method: 'GET',
          url: serviceUrl(grades.lineItems, installation),
          scopes: [scope],
          mediaType: 'application/vnd.ims.lis.v2.lineitemcontainer+json',
        };
    }
    throw new LTIError(
      'permission',
      'This Canvas launch does not grant the requested service scope.',
    );
  }
}
