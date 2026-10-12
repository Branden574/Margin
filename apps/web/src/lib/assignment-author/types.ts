import type { StudentSession, RequestOptions } from '../assignment-work/types';
export type { RequestOptions };
export const authorTools = [
  'text',
  'pen',
  'highlight',
  'comment',
  'rectangle',
  'ellipse',
  'line',
  'eraser',
] as const;
export type AuthorTool = (typeof authorTools)[number];
export type AuthorSession = Omit<StudentSession, 'role'> & { role: 'teacher' };
export interface AuthorContext {
  origin: string;
  session: AuthorSession;
  selection: { id: string; courseId: string; expiresAt: number };
}
export interface AuthorSource {
  documentId: string;
  versionId: string;
  name: string;
  pageCount: number;
  bytes: number;
  inspection: 'approved';
  availability: 'not-checked';
}
export interface AuthorSourcePage {
  sources: AuthorSource[];
  nextCursor: string | null;
}
export const MAX_AUTHOR_UPLOAD_BYTES = 100 * 1024 * 1024;
export interface AuthorUploadIntent {
  requestId: string;
  metadata: { name: string; mimeType: 'application/pdf' };
  plaintextBytes: number;
  plaintextSha256: string;
}
export interface AuthorUpload {
  id: string;
  requestId: string;
  status: 'pending' | 'quarantined' | 'ready' | 'rejected';
}
export interface AuthorUploadResult {
  upload: AuthorUpload;
  duplicate: boolean;
}
export interface AuthorDraft {
  documentId: string;
  versionId: string;
  title: string;
  instructions: string;
  policy: {
    allowedTools: AuthorTool[];
    allowExport: true;
    allowCopyPaste: true;
    allowReadAloud: true;
    assessment: false;
  };
}
export interface AuthorAssignment {
  id: string;
  title: string;
  instructions: string;
  policy: AuthorDraft['policy'];
  createdAt: string;
}
export interface AuthorReturnForm {
  action: string;
  fields: { csrfToken: string; assignmentId: string };
}
export class AuthorClientError extends Error {
  readonly name = 'AuthorClientError';
  constructor(
    readonly code: string,
    message: string,
    readonly status?: number,
    readonly uncertainCreate = false,
  ) {
    super(message);
  }
}
export interface AssignmentAuthorClient {
  open(options?: RequestOptions): Promise<AuthorContext>;
  sources(after?: string, options?: RequestOptions): Promise<AuthorSourcePage>;
  reserveUpload(intent: AuthorUploadIntent, options?: RequestOptions): Promise<AuthorUploadResult>;
  uploadContent(id: string, content: Blob, options?: RequestOptions): Promise<AuthorUploadResult>;
  uploadStatus(id: string, options?: RequestOptions): Promise<AuthorUpload>;
  create(
    draft: AuthorDraft,
    requestId: string,
    options?: RequestOptions,
  ): Promise<AuthorAssignment>;
  prepareReturn(assignmentId: string | null, options?: RequestOptions): Promise<AuthorReturnForm>;
  dispose(): void;
}
