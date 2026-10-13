import type { Annotation } from '@margin/core';
import { AssignmentError } from '../types.js';
import { canonical, identifier, parseOperation } from '../../sync/validation.js';
import {
  MAX_FEEDBACK_ANNOTATIONS,
  MAX_FEEDBACK_BYTES,
  MAX_FEEDBACK_COMMENT_LENGTH,
  type FeedbackCapture,
  type FeedbackContent,
  type ReleaseFeedbackInput,
  type SaveFeedbackInput,
} from './types.js';

const bad = (message: string) => new AssignmentError(400, 'invalid_feedback', message);
export const feedbackId = (value: unknown) => {
  try {
    const id = identifier(value);
    if (id !== value) throw bad('Use canonical feedback identifiers.');
    return id;
  } catch {
    throw bad('Use canonical feedback identifiers.');
  }
};
function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).some((k) => !keys.includes(k))
  )
    throw bad('Feedback contains unsupported fields.');
  return value as Record<string, unknown>;
}
export function parseFeedbackCommand(
  value: unknown,
  action: 'save' | 'release',
): SaveFeedbackInput | ReleaseFeedbackInput {
  const v = object(value, [
    'requestId',
    'snapshotPin',
    'expectedRevision',
    ...(action === 'save' ? ['content'] : []),
  ]);
  if (
    Object.keys(v).length !== (action === 'save' ? 4 : 3) ||
    typeof v.snapshotPin !== 'string' ||
    !/^[a-f0-9]{64}$/.test(v.snapshotPin) ||
    !Number.isSafeInteger(v.expectedRevision) ||
    (v.expectedRevision as number) < 0 ||
    (v.expectedRevision as number) > 100000
  )
    throw bad('Use the exact captured snapshot and saved feedback revision.');
  return {
    requestId: feedbackId(v.requestId),
    snapshotPin: v.snapshotPin,
    expectedRevision: v.expectedRevision as number,
    ...(action === 'save' ? { content: v.content as FeedbackContent } : {}),
  };
}
/** This uses student-operation validation without granting a student new tools or document rights. */
export function parseFeedbackContent(value: unknown, capture: FeedbackCapture): FeedbackContent {
  const v = object(value, ['comment', 'annotations']);
  if (
    Object.keys(v).length !== 2 ||
    typeof v.comment !== 'string' ||
    v.comment.length > MAX_FEEDBACK_COMMENT_LENGTH ||
    v.comment.includes('\0') ||
    !Array.isArray(v.annotations) ||
    v.annotations.length > MAX_FEEDBACK_ANNOTATIONS
  )
    throw bad('Keep feedback within its comment and annotation limits.');
  const ids = new Set<string>();
  const annotations: Annotation[] = v.annotations.map((raw: unknown) => {
    const a = object(raw, [
      'id',
      'pageIndex',
      'type',
      'x',
      'y',
      'width',
      'height',
      'points',
      'text',
      'color',
      'strokeWidth',
      'opacity',
      'rotation',
      'createdAt',
      'author',
    ]);
    const id = feedbackId(a.id);
    if (ids.has(id)) throw bad('Feedback annotation identifiers must be unique.');
    ids.add(id);
    if (
      !Number.isSafeInteger(a.pageIndex) ||
      (a.pageIndex as number) < 0 ||
      (a.pageIndex as number) >= capture.pages.length ||
      typeof a.createdAt !== 'number' ||
      !Number.isSafeInteger(a.createdAt) ||
      a.createdAt < 0 ||
      a.createdAt > 8640000000000000 ||
      typeof a.author !== 'string' ||
      a.author.length > 200
    )
      throw bad('Use a captured document page and valid annotation metadata.');
    const page = capture.pages[a.pageIndex as number];
    const { id: _id, pageIndex: _page, createdAt: _created, author: _author, ...shape } = a;
    const stamp = shape.type === 'stamp';
    if (
      stamp &&
      (typeof shape.text !== 'string' ||
        !shape.text.trim() ||
        shape.text.length > 160 ||
        shape.width === undefined ||
        shape.height === undefined ||
        shape.points !== undefined)
    )
      throw bad('A feedback stamp needs bounded text and a page rectangle.');
    let parsed;
    try {
      parsed = parseOperation({
        documentId: capture.documentId,
        versionId: capture.versionId,
        pageId: page.id,
        annotationId: id,
        operationId: id,
        baseRevision: 0,
        kind: 'put',
        annotation: { ...shape, ...(stamp ? { type: 'text' } : {}) },
      }).annotation!;
    } catch {
      throw bad('The feedback annotation is unsupported or exceeds its limits.');
    }
    const inside = (x: number, y: number) =>
      x >= 0 && y >= 0 && x <= page.width && y <= page.height;
    if (
      !inside(parsed.x, parsed.y) ||
      !inside(parsed.x + (parsed.width ?? 0), parsed.y + (parsed.height ?? 0)) ||
      parsed.points?.some((p) => !inside(p.x, p.y))
    )
      throw bad('Feedback must fit the exact captured page.');
    return {
      id,
      pageIndex: page.index,
      ...parsed,
      ...(stamp ? { type: 'stamp' as const } : {}),
      createdAt: a.createdAt,
      author: 'Teacher',
    };
  });
  const content = { comment: v.comment, annotations };
  if (Buffer.byteLength(canonical(content)) > MAX_FEEDBACK_BYTES)
    throw new AssignmentError(413, 'feedback_too_large', 'Reduce the feedback size before saving.');
  return content;
}
