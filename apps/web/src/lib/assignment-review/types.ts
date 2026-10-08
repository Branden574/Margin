import type { Annotation } from '@margin/core';
export type {
  ReviewContext,
  ReviewPage,
  ReviewSnapshot,
  ReviewSubmission,
  ReviewChunk,
} from '../../../../api/src/assignments/review/types';
import type { ReviewContext, ReviewSnapshot } from '../../../../api/src/assignments/review/types';

export interface ReviewProgress {
  stage: 'snapshot' | 'annotations' | 'source' | 'verifying';
  completed: number;
  total: number;
}
export interface ReviewData {
  context: ReviewContext;
  detail: ReviewSnapshot;
  annotations: Annotation[];
  source: Blob;
}
export interface ReviewOptions {
  signal?: AbortSignal;
}
export interface ReviewLoadOptions extends ReviewOptions {
  onProgress?: (progress: ReviewProgress) => void;
}
export class ReviewClientError extends Error {
  readonly name = 'ReviewClientError';
  constructor(
    readonly code: string,
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}
// Rendering has a lower budget than durable server materialization. A larger retained
// capture is not deleted or silently truncated when this browser refuses to open it.
export const MAX_REVIEW_BYTES = 32 * 1024 * 1024;
export const MAX_REVIEW_SOURCE_BYTES = 50 * 1024 * 1024;
export const MAX_REVIEW_CHUNK_BYTES = 262144;
export const REVIEW_TIMEOUT_MS = 120000;
