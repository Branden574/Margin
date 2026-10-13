import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { Annotation } from '@margin/core';
import type { FeedbackCapture } from '../apps/api/src/assignments/feedback/types';
import {
  parseFeedbackCommand,
  parseFeedbackContent,
} from '../apps/api/src/assignments/feedback/validation';
const capture: FeedbackCapture = {
  submissionId: randomUUID(),
  snapshotPin: 'a'.repeat(64),
  documentId: randomUUID(),
  versionId: randomUUID(),
  frozenCursor: 1,
  frozenAt: new Date().toISOString(),
  pages: [{ id: randomUUID(), index: 0, width: 612, height: 792 }],
  source: { mimeType: 'application/pdf', bytes: 100, sha256: 'b'.repeat(64) },
};
const annotation = (patch: Partial<Annotation> = {}): Annotation => ({
  id: randomUUID(),
  pageIndex: 0,
  type: 'pen',
  x: 0,
  y: 0,
  points: [
    { x: 0, y: 0, pressure: 0 },
    { x: 612, y: 792, pressure: 1 },
  ],
  color: '#123456',
  opacity: 1,
  strokeWidth: 2,
  createdAt: Date.now(),
  author: 'Teacher',
  ...patch,
});
describe('feedback input is a bounded separate layer on the exact captured geometry', () => {
  it('accepts endpoint pen geometry, highlights, comments and feedback stamps without changing student tool validation', () => {
    const annotations = [
      annotation(),
      annotation({ type: 'highlight', x: 10, y: 20, width: 300, height: 20, points: undefined }),
      annotation({
        type: 'comment',
        x: 10,
        y: 60,
        width: 150,
        height: 35,
        text: 'Explain this step.',
        points: undefined,
      }),
      annotation({
        type: 'stamp',
        x: 10,
        y: 150,
        width: 150,
        height: 35,
        text: 'Thoughtful work',
        points: undefined,
      }),
    ];
    expect(
      parseFeedbackContent({ comment: 'Good use of evidence.', annotations }, capture),
    ).toEqual({ comment: 'Good use of evidence.', annotations });
  });
  it.each([
    { pageIndex: 1 },
    { x: -0.01 },
    { x: 612.01 },
    { y: 792.01 },
    { width: 613 },
    { points: [{ x: 613, y: 1 }] },
    { points: [{ x: 1, y: 1, pressure: 1.1 }] },
    { type: 'signature' as const },
    { type: 'arrow' as const },
    { points: [] },
    { strokeWidth: 0 },
    { opacity: 1.01 },
  ])('rejects unsupported or off-page feedback %#', (patch) => {
    expect(() =>
      parseFeedbackContent({ comment: '', annotations: [annotation(patch)] }, capture),
    ).toThrow();
  });
  it('rejects duplicate identities, unbounded strokes/text, server-owned extras and aggregate overflow', () => {
    const a = annotation();
    for (const annotations of [
      [a, a],
      Array.from({ length: 501 }, () => annotation()),
      [annotation({ points: Array.from({ length: 2001 }, () => ({ x: 1, y: 1 })) })],
      [annotation({ text: 'x'.repeat(16001) })],
      [{ ...a, role: 'student' }],
      Array.from({ length: 100 }, () => annotation({ text: 'x'.repeat(3000) })),
    ])
      expect(() => parseFeedbackContent({ comment: '', annotations }, capture)).toThrow();
    expect(() =>
      parseFeedbackContent({ comment: 'x'.repeat(16001), annotations: [] }, capture),
    ).toThrow();
    expect(() => parseFeedbackContent({ comment: 'a\0b', annotations: [] }, capture)).toThrow();
  });
  it('uses teacher display provenance and returns independent validated annotation objects', () => {
    const input = {
      comment: '',
      annotations: [annotation({ author: 'A browser-supplied identity' })],
    };
    const parsed = parseFeedbackContent(input, capture);
    expect(parsed.annotations[0].author).toBe('Teacher');
    input.annotations[0].points![0].x = 500;
    expect(parsed.annotations[0].points![0].x).toBe(0);
  });
  it('accepts only exact save/release command fields without authority overrides', () => {
    const release = {
      requestId: randomUUID(),
      snapshotPin: capture.snapshotPin,
      expectedRevision: 1,
    };
    expect(parseFeedbackCommand(release, 'release')).toEqual(release);
    for (const value of [
      { ...release, userId: randomUUID() },
      { ...release, expectedRevision: 1.2 },
      { ...release, expectedRevision: 100001 },
      { ...release, snapshotPin: 'wrong' },
      { ...release, content: { comment: '', annotations: [] } },
    ])
      expect(() => parseFeedbackCommand(value, 'release')).toThrow();
    expect(() => parseFeedbackCommand(release, 'save')).toThrow();
  });
});
