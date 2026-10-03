import { createHmac, randomUUID } from 'node:crypto';
import type { InstallationRepository } from '@margin/lms';
import type { SessionPrincipal } from '../identity/types.js';
import { assignmentId, parseAssignmentInput, verifyReadySource } from './policy.js';
import { AssignmentDeepLinkSigner, deepLinkForm } from './deep-link.js';
import {
  AssignmentError,
  type AssignmentAuthorizer,
  type AssignmentRecord,
  type AssignmentRepository,
  type AssignmentSourceGateway,
  type DeepLinkSelection,
  type VerifiedAssignmentLaunch,
} from './types.js';
export interface AssignmentServiceOptions {
  repository: AssignmentRepository;
  authorizer: AssignmentAuthorizer;
  installations: InstallationRepository;
  sources?: AssignmentSourceGateway;
  signer?: AssignmentDeepLinkSigner;
  /** Independent 32-byte server key; not the session, vault or LMS subject lookup key. */
  resourceHmacKey: Uint8Array;
}
export class AssignmentService {
  private readonly resourceKey: Buffer;
  constructor(private readonly options: AssignmentServiceOptions) {
    if (options.resourceHmacKey.byteLength !== 32)
      throw new Error('Assignment resource HMAC key requires 32 random bytes.');
    this.resourceKey = Buffer.from(options.resourceHmacKey);
  }
  close() {
    this.resourceKey.fill(0);
  }
  private async course(principal: SessionPrincipal, role?: 'teacher' | 'student') {
    const enrollment = await this.options.authorizer.getSessionEnrollment(principal);
    if (!enrollment || (role && enrollment.role !== role))
      throw new AssignmentError(
        403,
        role === 'teacher' ? 'teacher_required' : 'course_access_denied',
        'This action requires an approved Canvas course enrollment.',
      );
    return enrollment;
  }
  private sources(): AssignmentSourceGateway {
    if (!this.options.sources)
      throw new AssignmentError(
        503,
        'inspection_unconfigured',
        'Assignment sources are unavailable until trusted document inspection is configured.',
      );
    return this.options.sources;
  }
  private async available(assignment: AssignmentRecord) {
    if (!(await this.sources().stillAvailable(assignment.source)))
      throw new AssignmentError(
        409,
        'source_unavailable',
        'The assignment source is unavailable or no longer approved. Contact your teacher.',
      );
  }
  async create(principal: SessionPrincipal, value: unknown): Promise<AssignmentRecord> {
    const enrollment = await this.course(principal, 'teacher'),
      input = parseAssignmentInput(value);
    const source = await this.sources().resolveForTeacher(principal, {
      documentId: input.documentId,
      versionId: input.versionId,
    });
    if (!source)
      throw new AssignmentError(
        409,
        'source_not_ready',
        'Choose a document you own that has passed required inspection.',
      );
    const approved = verifyReadySource(source, {
      organizationId: principal.organizationId,
      ownerId: principal.userId,
      documentId: input.documentId,
      versionId: input.versionId,
    });
    if (!(await this.sources().stillAvailable(approved)))
      throw new AssignmentError(
        409,
        'source_unavailable',
        'The selected source is no longer approved.',
      );
    const result = await this.options.repository.create(principal, enrollment, input, approved);
    await this.available(result);
    return result;
  }
  /** Invoked only by the verified LTI launch hook after the session binding has been committed. */
  async captureVerifiedLaunch({
    launch,
    principal,
  }: VerifiedAssignmentLaunch): Promise<{ redirectPath: string }> {
    const enrollment = await this.course(principal),
      mapped = await this.options.authorizer.resolveEnrollment(launch);
    if (
      !mapped ||
      mapped.installationId !== enrollment.installationId ||
      mapped.registrationVersion !== enrollment.registrationVersion ||
      mapped.organizationId !== enrollment.organizationId ||
      mapped.userId !== enrollment.userId ||
      mapped.courseId !== enrollment.courseId ||
      mapped.role !== enrollment.role ||
      launch.expiresAt * 1000 <= Date.now()
    )
      throw new AssignmentError(
        403,
        'launch_scope',
        'The verified launch does not match this current Canvas session.',
      );
    const installation = await this.options.installations.findById(enrollment.installationId);
    if (
      !installation?.enabled ||
      installation.version !== enrollment.registrationVersion ||
      installation.organizationId !== enrollment.organizationId
    )
      throw new AssignmentError(
        403,
        'installation_revoked',
        'This Canvas installation changed. Launch again from Canvas.',
      );
    if (launch.messageType === 'LtiDeepLinkingRequest') {
      if (
        enrollment.role !== 'teacher' ||
        !launch.deepLinking?.acceptTypes.includes('ltiResourceLink')
      )
        throw new AssignmentError(
          403,
          'deep_link_not_allowed',
          'Canvas content selection requires a teacher launch that accepts LTI resource links.',
        );
      const target = new URL(launch.deepLinking.returnUrl);
      if (
        target.protocol !== 'https:' ||
        target.username ||
        target.password ||
        target.hash ||
        !installation.serviceOrigins.includes(target.origin)
      )
        throw new AssignmentError(
          403,
          'return_url_rejected',
          'The Canvas selection return location is not approved.',
        );
      const resourceTargets = installation.targets.filter(
        (t) => t.messageType === 'LtiResourceLinkRequest',
      );
      if (resourceTargets.length !== 1)
        throw new AssignmentError(
          503,
          'launch_target_ambiguous',
          'Configure exactly one registered resource launch target for assignment selection.',
        );
      const selection: DeepLinkSelection = {
        id: randomUUID(),
        sessionId: principal.sessionId,
        installationId: enrollment.installationId,
        registrationVersion: enrollment.registrationVersion,
        organizationId: enrollment.organizationId,
        courseId: enrollment.courseId,
        userId: principal.userId,
        issuer: installation.issuer,
        clientId: installation.clientId,
        deploymentId: installation.deploymentId,
        returnUrl: launch.deepLinking.returnUrl,
        launchUrl: resourceTargets[0].uri,
        ...(launch.deepLinking.data !== undefined ? { data: launch.deepLinking.data } : {}),
        expiresAt: Date.now() + 600000,
      };
      await this.options.repository.captureSelection(principal, enrollment, selection);
      return { redirectPath: '/canvas/author' };
    }
    const selected = launch.resource?.assignmentId;
    if (!selected)
      throw new AssignmentError(
        403,
        'assignment_launch_required',
        'This signed Canvas launch does not identify a Margin assignment.',
      );
    const resourceDigest = createHmac('sha256', this.resourceKey)
      .update(
        JSON.stringify([
          'margin-assignment-resource-v1',
          enrollment.installationId,
          launch.resource!.reference.externalId,
        ]),
      )
      .digest('hex');
    await this.options.repository.bindResource(
      principal,
      enrollment,
      selected,
      resourceDigest,
      (source) => this.sources().stillAvailable(source),
    );
    return { redirectPath: '/canvas/work' };
  }
  async currentSelection(principal: SessionPrincipal) {
    const enrollment = await this.course(principal, 'teacher');
    const selection = await this.options.repository.currentSelection(principal, enrollment);
    return selection
      ? { id: selection.id, courseId: enrollment.courseId, expiresAt: selection.expiresAt }
      : null;
  }
  async completeDeepLink(
    principal: SessionPrincipal,
    selectionId: string,
    selectedAssignmentId: string | null,
  ) {
    const enrollment = await this.course(principal, 'teacher');
    if (!this.options.signer)
      throw new AssignmentError(
        503,
        'signing_unconfigured',
        'Canvas content selection signing is not configured.',
      );
    const selection = await this.options.repository.getSelection(
      principal,
      enrollment,
      assignmentId(selectionId),
    );
    if (!selection)
      throw new AssignmentError(
        409,
        'selection_expired',
        'This Canvas selection expired or was already used. Restart from Canvas.',
      );
    const installation = await this.options.installations.findById(enrollment.installationId);
    if (
      !installation?.enabled ||
      installation.version !== selection.registrationVersion ||
      installation.issuer !== selection.issuer ||
      installation.clientId !== selection.clientId ||
      installation.deploymentId !== selection.deploymentId ||
      !installation.serviceOrigins.includes(new URL(selection.returnUrl).origin) ||
      !installation.targets.some(
        (t) => t.messageType === 'LtiResourceLinkRequest' && t.uri === selection.launchUrl,
      )
    )
      throw new AssignmentError(
        403,
        'selection_registration_changed',
        'This Canvas installation changed. Restart selection from Canvas.',
      );
    const assignment = selectedAssignmentId
      ? await this.options.repository.get(principal, enrollment, assignmentId(selectedAssignmentId))
      : null;
    if (selectedAssignmentId && (!assignment || assignment.createdBy !== principal.userId))
      throw new AssignmentError(
        403,
        'assignment_selection_denied',
        'Select an assignment you authored in the current course.',
      );
    if (assignment) await this.available(assignment);
    const response = await this.options.signer.sign(selection, assignment);
    if (
      !(await this.options.repository.consumeSelection(
        principal,
        enrollment,
        selection.id,
        assignment?.id ?? null,
      ))
    )
      throw new AssignmentError(
        409,
        'selection_replayed',
        'This Canvas selection was already completed. Restart from Canvas.',
      );
    return deepLinkForm(response);
  }
  async reserveStudentWork(principal: SessionPrincipal) {
    const enrollment = await this.course(principal, 'student');
    const assignment = await this.options.repository.getBoundAssignment(principal, enrollment);
    if (!assignment)
      throw new AssignmentError(
        403,
        'assignment_launch_required',
        'Open an assignment from its verified Canvas resource link.',
      );
    await this.available(assignment);
    return this.options.repository.reserveStudentWork(principal, enrollment);
  }
  async currentAssignment(principal: SessionPrincipal): Promise<AssignmentRecord | null> {
    const enrollment = await this.course(principal);
    const assignment = await this.options.repository.getBoundAssignment(principal, enrollment);
    if (assignment) await this.available(assignment);
    return assignment;
  }
}
