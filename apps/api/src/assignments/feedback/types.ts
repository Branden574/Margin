import type { Annotation } from '@margin/core';
import type { SessionPrincipal } from '../../identity/types.js';
import type { ReviewPin, ReviewSnapshot } from '../review/types.js';

export interface FeedbackOptions {
  signal?: AbortSignal;
}
/** Annotation author/time are display metadata, never authorization or release evidence. */
export interface FeedbackContent {
  comment: string;
  annotations: Annotation[];
}
export interface FeedbackCapture {
  submissionId: string;
  snapshotPin: string;
  documentId: string;
  versionId: string;
  frozenCursor: number;
  frozenAt: string;
  pages: Array<{ id: string; index: number; width: number; height: number }>;
  source: { sha256: string; bytes: number; mimeType: 'application/pdf' };
}
export interface FeedbackRelease {
  /** The immutable saved draft revision explicitly returned by the author. */
  revision: number;
  releasedAt: string;
  content: FeedbackContent;
}
export interface TeacherFeedback {
  capture: FeedbackCapture;
  /** Zero denotes no saved draft. Saves advance this revision; returning does not. */
  revision: number;
  savedAt: string | null;
  content: FeedbackContent;
  released: FeedbackRelease | null;
}
export interface StudentFeedback {
  capture: FeedbackCapture;
  released: FeedbackRelease | null;
}
export interface SaveFeedbackInput {
  requestId: string;
  snapshotPin: string;
  expectedRevision: number;
  content: FeedbackContent;
}
export interface ReleaseFeedbackInput {
  requestId: string;
  snapshotPin: string;
  expectedRevision: number;
}
/** Exact command outcome; a later draft is never substituted for its saved/released revision. */
export interface FeedbackCommand {
  requestId: string;
  action: 'save' | 'release';
  expectedRevision: number;
  snapshotPin: string;
  state: 'accepted' | 'rejected';
  revision: number;
  code: 'revision_changed' | 'draft_required' | null;
  savedAt: string | null;
  releasedAt: string | null;
}
export interface AssignmentFeedbackService {
  teacher(
    principal: SessionPrincipal,
    submissionId: string,
    options?: FeedbackOptions,
  ): Promise<TeacherFeedback>;
  save(
    principal: SessionPrincipal,
    submissionId: string,
    input: unknown,
    options?: FeedbackOptions,
  ): Promise<FeedbackCommand>;
  release(
    principal: SessionPrincipal,
    submissionId: string,
    input: unknown,
    options?: FeedbackOptions,
  ): Promise<FeedbackCommand>;
  command(
    principal: SessionPrincipal,
    submissionId: string,
    requestId: string,
    options?: FeedbackOptions,
  ): Promise<FeedbackCommand>;
  student(
    principal: SessionPrincipal,
    submissionId: string,
    options?: FeedbackOptions,
  ): Promise<StudentFeedback>;
  /** The owning student's immutable capture, available only after an authenticated return. */
  studentCapture(
    principal: SessionPrincipal,
    submissionId: string,
    options?: FeedbackOptions,
  ): Promise<ReviewSnapshot>;
  /** Caller owns and must erase the authenticated plaintext buffer after use. */
  studentChunk(
    principal: SessionPrincipal,
    submissionId: string,
    index: number,
    pin: ReviewPin,
    options?: FeedbackOptions,
  ): Promise<Buffer>;
}
export const MAX_FEEDBACK_BYTES = 196608;
export const MAX_FEEDBACK_ANNOTATIONS = 500;
export const MAX_FEEDBACK_COMMENT_LENGTH = 16000;
