import type { SessionPrincipal } from '../identity/types.js';
import type { VerifiedLmsEnrollment } from '../lms/types.js';
import type { LMSLaunchContext } from '@margin/lms';

export const assignmentTools = [
  'text',
  'pen',
  'highlight',
  'comment',
  'rectangle',
  'ellipse',
  'line',
  'eraser',
] as const;
export type AssignmentTool = (typeof assignmentTools)[number];
export interface AssignmentPolicy {
  allowedTools: AssignmentTool[];
  allowExport: boolean;
  allowCopyPaste: boolean;
  allowReadAloud: boolean;
  assessment: boolean;
}
export interface AssignmentInput {
  requestId: string;
  documentId: string;
  versionId: string;
  title: string;
  instructions: string;
  policy: AssignmentPolicy;
}
/** Supplied only by authoritative ingestion/inspection; a sync document alone is not ready. */
export interface ReadyAssignmentSource {
  organizationId: string;
  documentId: string;
  versionId: string;
  ownerId: string;
  artifactId: string;
  artifactVersion: string;
  sha256: string;
  scanReceiptId: string;
  inspectionStatus: 'ready';
  encrypted: true;
  pageCount: number;
}
export type PreparedAssignmentSourceCheck = (source: ReadyAssignmentSource) => Promise<boolean>;
export interface AssignmentSourceGateway {
  resolveForTeacher(
    principal: SessionPrincipal,
    reference: { documentId: string; versionId: string },
  ): Promise<ReadyAssignmentSource | null>;
  /** Must recheck current scan/revocation/object-version availability, never merely trust a stored snapshot. */
  stillAvailable(source: ReadyAssignmentSource): Promise<boolean>;
  /** Object I/O occurs here, outside assignment transactions. Returned one-use check is short-lived and DB-only. */
  prepareAvailability(source: ReadyAssignmentSource): Promise<PreparedAssignmentSourceCheck | null>;
}
export interface AssignmentRecord {
  id: string;
  organizationId: string;
  installationId: string;
  courseId: string;
  createdBy: string;
  createdAt: string;
  title: string;
  instructions: string;
  policy: AssignmentPolicy;
  source: ReadyAssignmentSource;
}
export interface AssignmentLaunchReceipt {
  assignmentId: string;
  resourceDigest: string;
  sessionId: string;
}
export interface StudentWorkReservation {
  id: string;
  assignmentId: string;
  userId: string;
  documentId: string;
  versionId: string;
  status: 'pending' | 'provisioned';
  duplicate: boolean;
}
export interface DeepLinkSelection {
  id: string;
  sessionId: string;
  installationId: string;
  registrationVersion: number;
  organizationId: string;
  courseId: string;
  userId: string;
  issuer: string;
  clientId: string;
  deploymentId: string;
  returnUrl: string;
  launchUrl: string;
  data?: string;
  expiresAt: number;
}
export interface AssignmentRepository {
  create(
    principal: SessionPrincipal,
    enrollment: VerifiedLmsEnrollment,
    input: AssignmentInput,
    source: ReadyAssignmentSource,
  ): Promise<AssignmentRecord>;
  get(
    principal: SessionPrincipal,
    enrollment: VerifiedLmsEnrollment,
    id: string,
  ): Promise<AssignmentRecord | null>;
  captureSelection(
    principal: SessionPrincipal,
    enrollment: VerifiedLmsEnrollment,
    selection: DeepLinkSelection,
  ): Promise<void>;
  currentSelection(
    principal: SessionPrincipal,
    enrollment: VerifiedLmsEnrollment,
  ): Promise<DeepLinkSelection | null>;
  getSelection(
    principal: SessionPrincipal,
    enrollment: VerifiedLmsEnrollment,
    id: string,
  ): Promise<DeepLinkSelection | null>;
  consumeSelection(
    principal: SessionPrincipal,
    enrollment: VerifiedLmsEnrollment,
    id: string,
    assignmentId: string | null,
  ): Promise<boolean>;
  bindResource(
    principal: SessionPrincipal,
    enrollment: VerifiedLmsEnrollment,
    assignmentId: string,
    resourceDigest: string,
    prepareSource: AssignmentSourceGateway['prepareAvailability'],
  ): Promise<void>;
  getBoundAssignment(
    principal: SessionPrincipal,
    enrollment: VerifiedLmsEnrollment,
  ): Promise<AssignmentRecord | null>;
  reserveStudentWork(
    principal: SessionPrincipal,
    enrollment: VerifiedLmsEnrollment,
  ): Promise<StudentWorkReservation>;
}
export interface AssignmentAuthorizer {
  resolveEnrollment(launch: LMSLaunchContext): Promise<VerifiedLmsEnrollment | null>;
  getSessionEnrollment(principal: SessionPrincipal): Promise<VerifiedLmsEnrollment | null>;
}
/** Callback input comes only from the protocol verifier's trusted server hook, never request JSON. */
export interface VerifiedAssignmentLaunch {
  launch: LMSLaunchContext;
  principal: SessionPrincipal;
}
export class AssignmentError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'AssignmentError';
  }
}
