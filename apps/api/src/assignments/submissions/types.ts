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
export interface SubmissionPage {
  submissions: SubmissionStatus[];
  nextCursor: string | null;
}
export interface AssignmentSubmissionService {
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
