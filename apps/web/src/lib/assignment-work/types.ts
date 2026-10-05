// Type-only imports keep the server's Node/crypto implementation out of the browser bundle.
export type {
  AppendOperation,
  AppendReceipt,
  CatchUpResult,
  CommittedOperation,
  DocumentDescription,
  SyncAnnotation,
} from '../../../../api/src/sync/types';
export type { WorkManifest } from '../../../../api/src/assignments/work/types';
export type { StudentWorkReservation } from '../../../../api/src/assignments/types';

export interface StudentSession {
  authenticated: true;
  sessionId: string;
  userId: string;
  organizationId: string;
  role: 'student';
  authenticationMethod: 'lti';
  mfa: boolean;
  createdAt: number;
  lastSeenAt: number;
  expiresAt: number;
}
export interface RequestOptions {
  signal?: AbortSignal;
}
export class AssignmentWorkClientError extends Error {
  readonly name = 'AssignmentWorkClientError';
  constructor(
    readonly code: string,
    message: string,
    readonly status?: number,
    readonly uncertainSave = false,
    readonly operationId?: string,
  ) {
    super(message);
  }
}
export const MAX_SOURCE_BYTES = 100 * 1024 * 1024;
export const MAX_JSON_BYTES = 1_100_000;
export const MAX_OPERATION_BYTES = 65_536;
export const REQUEST_TIMEOUT_MS = 45_000;
