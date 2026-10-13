import type { Annotation } from '@margin/core';
import { operation } from '../assignment-work/decode';
import { canonical, hash, id, integer, object } from '../assignment-review/decode';
import type {
  FeedbackCapture,
  FeedbackContent,
  FeedbackCommand,
  FeedbackRelease,
  TeacherFeedback,
  StudentFeedback,
} from '../../../../api/src/assignments/feedback/types';
export type { FeedbackCapture, FeedbackContent, FeedbackCommand, TeacherFeedback, StudentFeedback };
export const fail = () =>
  new Error('The feedback response could not be verified. Reopen this submission.');
const timestamp = (value: unknown): string => {
  if (
    typeof value !== 'string' ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  )
    throw fail();
  return value;
};
export function capture(value: unknown): FeedbackCapture {
  const row = object(value, [
    'submissionId',
    'snapshotPin',
    'documentId',
    'versionId',
    'frozenCursor',
    'frozenAt',
    'pages',
    'source',
  ]);
  if (!Array.isArray(row.pages) || !row.pages.length || row.pages.length > 2000) throw fail();
  const pageIds = new Set<string>();
  const pages = row.pages.map((value, index) => {
    const p = object(value, ['id', 'index', 'width', 'height']);
    const pageId = id(p.id);
    if (
      p.index !== index ||
      pageIds.has(pageId) ||
      typeof p.width !== 'number' ||
      typeof p.height !== 'number' ||
      !Number.isFinite(p.width) ||
      !Number.isFinite(p.height) ||
      p.width <= 0 ||
      p.height <= 0 ||
      p.width > 100000 ||
      p.height > 100000
    )
      throw fail();
    pageIds.add(pageId);
    return { id: pageId, index, width: p.width, height: p.height };
  });
  const source = object(row.source, ['sha256', 'bytes', 'mimeType']);
  if (source.mimeType !== 'application/pdf') throw fail();
  return {
    submissionId: id(row.submissionId),
    snapshotPin: hash(row.snapshotPin),
    documentId: id(row.documentId),
    versionId: id(row.versionId),
    frozenCursor: integer(row.frozenCursor, 0),
    frozenAt: timestamp(row.frozenAt),
    pages,
    source: {
      sha256: hash(source.sha256),
      bytes: integer(source.bytes, 1, 100 * 1024 * 1024),
      mimeType: 'application/pdf',
    },
  };
}
export function content(value: unknown, snapshot: FeedbackCapture): FeedbackContent {
  const row = object(value, ['comment', 'annotations']);
  if (
    typeof row.comment !== 'string' ||
    row.comment.length > 16000 ||
    row.comment.includes('\0') ||
    !Array.isArray(row.annotations) ||
    row.annotations.length > 500
  )
    throw fail();
  const ids = new Set<string>();
  const annotations: Annotation[] = row.annotations.map((value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw fail();
    const {
      id: rawId,
      pageIndex: rawPage,
      createdAt,
      author,
      ...shape
    } = value as Record<string, unknown>;
    const annotationId = id(rawId),
      pageIndex = integer(rawPage, 0, snapshot.pages.length - 1),
      page = snapshot.pages[pageIndex];
    if (ids.has(annotationId) || typeof author !== 'string' || author.length > 200) throw fail();
    ids.add(annotationId);
    integer(createdAt, 0, 8640000000000000);
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
      throw fail();
    const parsed = operation({
      documentId: snapshot.documentId,
      versionId: snapshot.versionId,
      pageId: page.id,
      annotationId,
      operationId: annotationId,
      baseRevision: 0,
      kind: 'put',
      annotation: { ...shape, ...(stamp ? { type: 'text' } : {}) },
    }).annotation!;
    const inside = (x: number, y: number) =>
      x >= 0 && y >= 0 && x <= page.width && y <= page.height;
    if (
      !inside(parsed.x, parsed.y) ||
      !inside(parsed.x + (parsed.width ?? 0), parsed.y + (parsed.height ?? 0)) ||
      parsed.points?.some((p) => !inside(p.x, p.y))
    )
      throw fail();
    return {
      id: annotationId,
      pageIndex,
      ...parsed,
      ...(stamp ? { type: 'stamp' as const } : {}),
      createdAt: createdAt as number,
      author: 'Teacher',
    };
  });
  const result = { comment: row.comment, annotations };
  if (new TextEncoder().encode(canonical(result)).length > 196608)
    throw new Error('Feedback is too large. Shorten the comment or remove a few marks.');
  return result;
}
function release(value: unknown, snapshot: FeedbackCapture): FeedbackRelease | null {
  if (value === null) return null;
  const row = object(value, ['revision', 'releasedAt', 'content']);
  return {
    revision: integer(row.revision, 1, 100000),
    releasedAt: timestamp(row.releasedAt),
    content: content(row.content, snapshot),
  };
}
export function teacher(value: unknown): TeacherFeedback {
  const row = object(value, ['capture', 'revision', 'savedAt', 'content', 'released']);
  const snapshot = capture(row.capture),
    revision = integer(row.revision, 0, 100000),
    savedAt = row.savedAt === null ? null : timestamp(row.savedAt),
    released = release(row.released, snapshot);
  if ((revision === 0) !== (savedAt === null) || (released && released.revision > revision))
    throw fail();
  return {
    capture: snapshot,
    revision,
    savedAt,
    content: content(row.content, snapshot),
    released,
  };
}
export function student(value: unknown): StudentFeedback {
  const row = object(value, ['capture', 'released']);
  const snapshot = capture(row.capture);
  return { capture: snapshot, released: release(row.released, snapshot) };
}
export function command(value: unknown): FeedbackCommand {
  const row = object(value, [
    'requestId',
    'action',
    'expectedRevision',
    'snapshotPin',
    'state',
    'revision',
    'code',
    'savedAt',
    'releasedAt',
  ]);
  if (
    !['save', 'release'].includes(row.action as string) ||
    !['accepted', 'rejected'].includes(row.state as string) ||
    ![null, 'revision_changed', 'draft_required'].includes(row.code as null | string)
  )
    throw fail();
  const result = {
    requestId: id(row.requestId),
    action: row.action,
    expectedRevision: integer(row.expectedRevision, 0, 100000),
    snapshotPin: hash(row.snapshotPin),
    state: row.state,
    revision: integer(row.revision, 0, 100000),
    code: row.code,
    savedAt: row.savedAt === null ? null : timestamp(row.savedAt),
    releasedAt: row.releasedAt === null ? null : timestamp(row.releasedAt),
  } as FeedbackCommand;
  if (
    (result.state === 'accepted') !== (result.code === null) ||
    (result.state === 'accepted' &&
      (result.revision !== result.expectedRevision + (result.action === 'save' ? 1 : 0) ||
        !result.savedAt ||
        (result.action === 'release' && !result.releasedAt)))
  )
    throw fail();
  return result;
}
export const same = (a: unknown, b: unknown) => canonical(a) === canonical(b);
