import type { IncomingHttpHeaders } from 'node:http';
import {
  CanvasLMSProvider,
  type LoginInitiation,
  type InstallationRepository,
  type LaunchReplayRepository,
  type LMSLaunchContext,
} from '@margin/lms';
import type { JWTVerifyGetKey } from 'jose';
import type { SessionPrincipal } from '../identity/types.js';
import { createHash } from 'node:crypto';
import {
  LmsHttpError,
  type CanvasHttpInstallation,
  type IssueLmsSession,
  type LmsEnrollmentRepository,
  type LmsSessionBindingRepository,
  type LmsSessionPrincipal,
  type VerifiedLmsEnrollment,
} from './types.js';

export interface LmsRepository
  extends InstallationRepository,
    LaunchReplayRepository,
    LmsEnrollmentRepository,
    LmsSessionBindingRepository {
  findById(id: string): Promise<CanvasHttpInstallation | null>;
}
export interface LmsServiceOptions {
  applicationOrigin: string;
  repository: LmsRepository;
  issueSession: IssueLmsSession;
  authenticateSession?: (request: {
    headers: IncomingHttpHeaders;
  }) => Promise<{ principal: LmsSessionPrincipal }>;
  launchReturnPaths?: readonly string[];
  onVerifiedLaunch?: (input: {
    launch: LMSLaunchContext;
    enrollment: VerifiedLmsEnrollment;
    principal: SessionPrincipal;
  }) => Promise<{ redirectPath: string } | void>;
  /** Trusted server-only dependency injection. Omit to use the registered remote JWKS. */
  resolveKey?: (installation: CanvasHttpInstallation) => JWTVerifyGetKey;
}
const statePattern = /^[A-Za-z0-9_-]{43}$/;
const cookiePrefix = '__Host-margin-lti-';
export function launchCookieName(state: string): string {
  if (!statePattern.test(state))
    throw new LmsHttpError(
      400,
      'invalid_state',
      'This Canvas launch is invalid. Restart it from Canvas.',
    );
  return cookiePrefix + createHash('sha256').update(state).digest('hex').slice(0, 32);
}
function launchCookie(name: string, value: string, maxAge: number) {
  return `${name}=${value}; Path=/; Secure; HttpOnly; SameSite=None; Max-Age=${maxAge}`;
}
export function clearLaunchCookie(state: string): string {
  return launchCookie(launchCookieName(state), '', 0);
}
function readBinding(header: string | undefined, state: string): string {
  const name = launchCookieName(state);
  if (!header || header.length > 8192)
    throw new LmsHttpError(
      403,
      'launch_cookie_missing',
      'The Canvas launch cookie is unavailable. Return to Canvas and launch Margin in a top-level tab.',
    );
  const matches = header
    .split(';')
    .map((v) => v.trim())
    .filter((v) => v.startsWith(`${name}=`));
  if (matches.length !== 1 || !statePattern.test(matches[0].slice(name.length + 1)))
    throw new LmsHttpError(
      403,
      'launch_cookie_missing',
      'The Canvas launch cookie is unavailable or ambiguous. Return to Canvas and launch Margin in a top-level tab.',
    );
  return matches[0].slice(name.length + 1);
}
export class LmsService {
  readonly applicationOrigin: string;
  private readonly provider: CanvasLMSProvider;
  private readonly returnPaths: Set<string>;
  constructor(private readonly options: LmsServiceOptions) {
    const origin = new URL(options.applicationOrigin);
    if (origin.protocol !== 'https:' || origin.origin !== options.applicationOrigin)
      throw new Error('LMS requires an exact HTTPS application origin.');
    this.applicationOrigin = origin.origin;
    this.returnPaths = new Set(options.launchReturnPaths ?? ['/']);
    if (!this.returnPaths.size || this.returnPaths.size > 16)
      throw new Error('Configure between one and sixteen LMS return paths.');
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
          'LMS return paths must be exact same-origin paths without queries or fragments.',
        );
    }
    this.provider = new CanvasLMSProvider({
      installations: options.repository,
      replay: options.repository,
      ...(options.resolveKey
        ? {
            resolveKey: (installation) =>
              options.resolveKey!(installation as CanvasHttpInstallation),
          }
        : {}),
    });
  }
  async context(request: { headers: IncomingHttpHeaders }) {
    if (!this.options.authenticateSession)
      throw new LmsHttpError(503, 'lms_unconfigured', 'Canvas session access is not configured.');
    const { principal } = await this.options.authenticateSession(request);
    const enrollment = await this.options.repository.getSessionEnrollment(principal);
    if (!enrollment)
      throw new LmsHttpError(
        403,
        'lms_context_unavailable',
        'Open Margin from an approved Canvas course to continue.',
      );
    return {
      provider: 'canvas',
      installationId: enrollment.installationId,
      courseId: enrollment.courseId,
      role: enrollment.role,
      capabilities: ['launch-context'],
    };
  }
  async installation(id: string): Promise<CanvasHttpInstallation> {
    const value = await this.options.repository.findById(id);
    if (!value?.enabled)
      throw new LmsHttpError(
        404,
        'installation_unavailable',
        'This Canvas installation is unavailable. Contact your institution administrator.',
      );
    if (!Array.isArray(value.frameOrigins) || value.frameOrigins.length > 20)
      throw new Error('Invalid Canvas frame configuration.');
    for (const item of value.frameOrigins) {
      const origin = new URL(item);
      if (origin.protocol !== 'https:' || origin.origin !== item)
        throw new Error('Canvas frame origins must be exact approved HTTPS origins.');
    }
    const paths = new Set([`/api/lms/canvas/${id}/launch`, `/api/lms/canvas/${id}/deep-link`]);
    for (const target of value.targets) {
      const url = new URL(target.uri);
      if (
        url.origin !== this.applicationOrigin ||
        !paths.has(url.pathname) ||
        url.search ||
        url.hash ||
        (target.messageType === 'LtiResourceLinkRequest') !== url.pathname.endsWith('/launch')
      )
        throw new Error('Canvas targets must match the exact registered HTTPS launch handler.');
    }
    return value;
  }
  async beginLogin(id: string, input: LoginInitiation, cookieHeader?: string) {
    await this.installation(id);
    if (
      (cookieHeader?.length ?? 0) > 8192 ||
      (cookieHeader?.split(';').filter((v) => v.trim().startsWith(cookiePrefix)).length ?? 0) >= 8
    )
      throw new LmsHttpError(
        429,
        'too_many_launches',
        'Finish an existing Canvas launch or retry in five minutes.',
      );
    const result = await this.provider.beginLogin(id, input);
    return {
      location: result.authorizationUrl,
      cookies: [launchCookie(launchCookieName(result.state), result.browserBinding, 300)],
    };
  }
  async completeLaunch(
    id: string,
    path: string,
    parameters: URLSearchParams,
    request: { headers: IncomingHttpHeaders },
  ) {
    const state = parameters.get('state') ?? '';
    const binding = readBinding(request.headers.cookie, state);
    if (parameters.has('error'))
      throw new LmsHttpError(
        401,
        'canvas_authorization_failed',
        'Canvas did not authorize this launch. Return to Canvas and try again.',
      );
    await this.installation(id);
    const launch = await this.provider.validateLaunch({
      state,
      id_token: parameters.get('id_token') ?? '',
      browserBinding: binding,
    });
    if (
      launch.installationId !== id ||
      launch.targetUri !== new URL(path, this.applicationOrigin).href
    )
      throw new LmsHttpError(
        403,
        'launch_route_mismatch',
        'This Canvas launch does not match its registered destination.',
      );
    const enrollment = await this.options.repository.resolveEnrollment(launch);
    if (!enrollment)
      throw new LmsHttpError(
        403,
        'enrollment_required',
        'This Canvas account and course need an approved Margin enrollment. Contact your institution administrator.',
      );
    const result = await this.options.issueSession(enrollment, request);
    if (
      result.principal.authenticationMethod !== 'lti' ||
      result.principal.userId !== enrollment.userId ||
      result.principal.organizationId !== enrollment.organizationId ||
      result.principal.role !== enrollment.role
    )
      throw new Error('Identity service returned a mismatched LMS session.');
    await this.options.repository.recordSessionBinding(enrollment, result.principal);
    const next = await this.options.onVerifiedLaunch?.({
      launch,
      enrollment,
      principal: result.principal,
    });
    const redirectPath = next?.redirectPath ?? '/';
    if (!this.returnPaths.has(redirectPath))
      throw new Error('The Canvas launch hook returned an unregistered destination.');
    return {
      location: new URL(redirectPath, this.applicationOrigin).href,
      cookies: [...result.cookies, clearLaunchCookie(state)],
    };
  }
}
export const createLmsService = (options: LmsServiceOptions) => new LmsService(options);
