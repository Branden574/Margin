import type { SessionPrincipal } from '../identity/types.js';
import type { IncomingHttpHeaders } from 'node:http';
import type { CanvasInstallation, LMSLaunchContext } from '@margin/lms';

export interface CanvasHttpInstallation extends CanvasInstallation {
  /** Exact institution origins allowed to display only the top-level continuation page. */
  frameOrigins: readonly string[];
}
export interface VerifiedLmsEnrollment {
  installationId: string;
  registrationVersion: number;
  organizationId: string;
  userId: string;
  courseId: string;
  role: 'student' | 'teacher' | 'viewer';
  /** Pseudonymous server lookup keys, never returned to the browser. */
  subjectDigest: string;
  courseDigest: string;
}
export interface LmsEnrollmentRepository {
  /** Explicit provisioned subject/course/enrollment and live membership only. Never auto-create. */
  resolveEnrollment(launch: LMSLaunchContext): Promise<VerifiedLmsEnrollment | null>;
}
export interface LmsSessionPrincipal {
  sessionId: string;
  userId: string;
  organizationId: string;
  role: string;
  authenticationMethod?: string;
}
export interface LmsSessionBindingRepository {
  recordSessionBinding(
    enrollment: VerifiedLmsEnrollment,
    principal: LmsSessionPrincipal,
  ): Promise<void>;
  getSessionEnrollment(principal: LmsSessionPrincipal): Promise<VerifiedLmsEnrollment | null>;
  authorizeSession(principal: {
    sessionId: string;
    userId: string;
    organizationId: string;
    role: string;
    authenticationMethod?: string;
  }): Promise<boolean>;
}
export interface LmsSessionResult {
  cookies: string[];
  principal: SessionPrincipal;
}
/** The trusted composition root supplies an identity-issued boundary, not an arbitrary HTTP callback. */
export type IssueLmsSession = (
  enrollment: Readonly<VerifiedLmsEnrollment>,
  request: { headers: IncomingHttpHeaders },
) => Promise<LmsSessionResult>;
export class LmsHttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'LmsHttpError';
  }
}
