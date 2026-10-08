import { describe, expect, it } from 'vitest';
import {
  projectSubmissionStatus,
  type SubmissionProcessingStatusRow,
} from '../apps/api/src/assignments/submissions/status';
import type { SubmissionStatus } from '../apps/api/src/assignments/submissions/types';
const base: SubmissionStatus = {
  id: 'immutable-submission',
  requestId: 'immutable-request',
  attempt: 1,
  frozenCursor: 8,
  frozenAt: '2026-10-08T00:00:00.000Z',
  revision: 1,
  phase: 'processing',
  confirmedAt: null,
  retryAllowed: false,
  errorCode: null,
};
const pending: SubmissionProcessingStatusRow = {
  status_revision: '1',
  processing_generation: 1,
  materialization_state: 'pending',
  published_error_code: null,
  failed_at: null,
  materialized_at: null,
};
const failed: SubmissionProcessingStatusRow = {
  ...pending,
  status_revision: '2',
  materialization_state: 'failed',
  published_error_code: 'source_unavailable',
  failed_at: new Date(),
};
describe('durable status projection over an immutable submission', () => {
  it('keeps captured identity unchanged and never presents internal materialization as Canvas confirmation', () => {
    const original = structuredClone(base);
    expect(projectSubmissionStatus(base, pending)).toEqual(base);
    expect(
      projectSubmissionStatus(base, {
        ...pending,
        status_revision: '2',
        materialization_state: 'completed',
        materialized_at: new Date(),
      }),
    ).toEqual({ ...base, revision: 2 });
    expect(base).toEqual(original);
  });
  it.each(['source_unavailable', 'authority_revoked', 'retry_exhausted'] as const)(
    'offers retry only for recoverable %s before generation three',
    (code) => {
      expect(projectSubmissionStatus(base, { ...failed, published_error_code: code })).toEqual({
        ...base,
        revision: 2,
        phase: 'failed',
        retryAllowed: true,
        errorCode: code,
      });
      expect(
        projectSubmissionStatus(base, {
          ...failed,
          status_revision: '6',
          processing_generation: 3,
          published_error_code: code,
        }).retryAllowed,
      ).toBe(false);
    },
  );
  it('never retries invalid frozen content and clears failure fields when a retry has been accepted', () => {
    expect(
      projectSubmissionStatus(base, { ...failed, published_error_code: 'snapshot_invalid' })
        .retryAllowed,
    ).toBe(false);
    expect(
      projectSubmissionStatus(base, { ...pending, status_revision: '3', processing_generation: 2 }),
    ).toEqual({ ...base, revision: 3 });
  });
  it.each([
    { status_revision: '0' },
    { status_revision: '1.1' },
    { status_revision: '9007199254740992' },
    { processing_generation: 0 },
    { processing_generation: 4 },
    { processing_generation: 1.5 },
    { processing_generation: 2 },
    { status_revision: '2' },
    { ...failed, status_revision: '3' },
    { ...failed, status_revision: '4' },
    { materialization_state: 'sent' },
    { published_error_code: 'source_unavailable' },
    { failed_at: new Date() },
    { materialized_at: new Date() },
    { materialization_state: 'completed', status_revision: '2' },
    { materialization_state: 'completed', materialized_at: new Date() },
    { materialization_state: 'completed', status_revision: '2', materialized_at: new Date(NaN) },
    {
      materialization_state: 'failed',
      published_error_code: 'source_unavailable',
      status_revision: '2',
    },
    { materialization_state: 'failed', failed_at: new Date(), status_revision: '2' },
    { ...failed, failed_at: new Date(NaN) },
    { ...failed, published_error_code: 'private provider error' },
  ])('fails closed on invalid processing metadata %#', (change) => {
    expect(() =>
      projectSubmissionStatus(base, { ...pending, ...change } as SubmissionProcessingStatusRow),
    ).toThrow(expect.objectContaining({ code: 'submission_integrity' }));
  });
});
