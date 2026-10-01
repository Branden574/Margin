export type DocumentPermission = 'owner' | 'editor' | 'viewer';
export interface SyncAnnotation {
  type: 'text' | 'pen' | 'highlight' | 'comment' | 'rectangle' | 'ellipse' | 'line';
  x: number;
  y: number;
  width?: number;
  height?: number;
  points?: { x: number; y: number; pressure?: number }[];
  text?: string;
  color: string;
  strokeWidth: number;
  opacity: number;
  rotation?: number;
}
export interface AppendOperation {
  documentId: string;
  versionId: string;
  pageId: string;
  annotationId: string;
  operationId: string;
  baseRevision: number;
  kind: 'put' | 'delete';
  annotation?: SyncAnnotation;
}
export interface AppendReceipt {
  operationId: string;
  cursor: number;
  annotationRevision: number;
  duplicate: boolean;
}
export interface CommittedOperation extends AppendOperation {
  actorId: string;
  cursor: number;
  annotationRevision: number;
  committedAt: string;
}
export interface SyncPage {
  id: string;
  index: number;
  width: number;
  height: number;
}
export interface DocumentDescription {
  documentId: string;
  versionId: string;
  cursor: number;
  permission: DocumentPermission;
  audience: 'members' | 'teachers';
  pages: SyncPage[];
}
export interface CatchUpRequest {
  documentId: string;
  afterCursor?: number;
  limit?: number;
}
export interface CatchUpResult {
  documentId: string;
  versionId: string;
  operations: CommittedOperation[];
  nextCursor: number;
  hasMore: boolean;
  currentCursor: number;
}
/** Trusted operator/service input. Never bind this contract directly to an untrusted browser route. */
export interface ProvisionDocument {
  organizationId: string;
  documentId: string;
  versionId: string;
  ownerId: string;
  audience: 'members' | 'teachers';
  pages: SyncPage[];
  grants?: { userId: string; permission: 'editor' | 'viewer' }[];
}
export class SyncError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: Record<string, string | number>,
  ) {
    super(message);
    this.name = 'SyncError';
  }
}
