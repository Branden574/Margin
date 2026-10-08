import type { SessionPrincipal } from '../../identity/types.js';

export interface SubmissionInput {
  requestId: string;
  expectedCursor: number;
}
export interface SubmissionRequestOptions {
  signal?: AbortSignal;
}
export interface SubmissionStatus {
  id: string;
  requestId: string;
  attempt: 1;
  frozenCursor: number;
  frozenAt: string;
  revision: number;
  phase: 'processing' | 'queued' | 'sending' | 'uncertain' | 'failed' | 'confirmed';
  confirmedAt: string | null;
  retryAllowed: boolean;
  errorCode:
    | 'snapshot_invalid'
    | 'source_unavailable'
    | 'delivery_unavailable'
    | 'authority_revoked'
    | 'provider_rejected'
    | 'confirmation_unavailable'
    | 'retry_exhausted'
    | null;
}
export type SubmissionRequest =
  | {
      requestId: string;
      expectedCursor: number;
      state: 'captured';
      submission: SubmissionStatus;
    }
  | {
      requestId: string;
      expectedCursor: number;
      state: 'rejected';
      code: 'cursor_changed' | 'attempt_exists';
    };
export interface SubmissionReprocessInput {
  expectedRevision: number;
}
export interface SubmissionReprocessRequest {
  request: Extract<SubmissionRequest, { state: 'captured' }>;
  expectedRevision: number;
  state: 'accepted' | 'rejected';
  acceptedRevision: number | null;
  code: 'revision_changed' | 'not_retryable' | 'retry_limit' | null;
}
export interface SubmissionPage {
  submissions: SubmissionStatus[];
  nextCursor: string | null;
}
export interface AssignmentSubmissionService {
  reprocess(
    principal: SessionPrincipal,
    submissionId: string,
    value: unknown,
    options?: SubmissionRequestOptions,
  ): Promise<SubmissionReprocessRequest>;
  reprocessRequest(
    principal: SessionPrincipal,
    submissionId: string,
    expectedRevision: number,
    options?: SubmissionRequestOptions,
  ): Promise<SubmissionReprocessRequest>;
  capture(
    principal: SessionPrincipal,
    value: unknown,
    options?: SubmissionRequestOptions,
  ): Promise<{ request: SubmissionRequest; duplicate: boolean }>;
  request(
    principal: SessionPrincipal,
    requestId: string,
    options?: SubmissionRequestOptions,
  ): Promise<{ request: SubmissionRequest }>;
  list(
    principal: SessionPrincipal,
    input: { after?: string },
    options?: SubmissionRequestOptions,
  ): Promise<SubmissionPage>;
}
