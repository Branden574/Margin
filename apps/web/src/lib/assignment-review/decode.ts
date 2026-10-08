import { operation } from '../assignment-work/decode';
import type {
  ReviewContext,
  ReviewPage,
  ReviewSnapshot,
  ReviewSubmission,
  ReviewChunk,
} from './types';
import { ReviewClientError } from './types';

export function invalid(): never {
  throw new ReviewClientError('invalid_response', 'The retained submission could not be verified.');
}
export function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid();
  const row = value as Record<string, unknown>;
  if (Object.keys(row).length !== keys.length || keys.some((key) => !Object.hasOwn(row, key)))
    return invalid();
  return row;
}
export function integer(
  value: unknown,
  minimum: number,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum)
    return invalid();
  return value as number;
}
export function id(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value)
  )
    return invalid();
  return value;
}
export function hash(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) return invalid();
  return value;
}
function text(value: unknown, maximum: number, empty = false): string {
  if (
    typeof value !== 'string' ||
    [...value].length > maximum ||
    (!empty && !value.trim()) ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)
  )
    return invalid();
  return value;
}
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(',')}}`;
  return JSON.stringify(value);
}
export function context(value: unknown): ReviewContext {
  const row = object(value, ['assignment', 'mode']);
  const a = object(row.assignment, ['id', 'title', 'instructions']);
  if (row.mode !== 'author-only') return invalid();
  return {
    assignment: {
      id: id(a.id),
      title: text(a.title, 200),
      instructions: text(a.instructions, 10000, true),
    },
    mode: 'author-only',
  };
}
export function submission(value: unknown, now: number): ReviewSubmission {
  const row = object(value, [
    'id',
    'frozenCursor',
    'frozenAt',
    'revision',
    'preparation',
    'errorCode',
  ]);
  if (
    typeof row.frozenAt !== 'string' ||
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(row.frozenAt) ||
    !Number.isFinite(Date.parse(row.frozenAt)) ||
    new Date(row.frozenAt).toISOString() !== row.frozenAt ||
    Date.parse(row.frozenAt) > now + 60000
  )
    return invalid();
  if (
    !['preparing', 'failed', 'ready'].includes(row.preparation as string) ||
    (row.errorCode !== null &&
      !['source_unavailable', 'snapshot_invalid', 'authority_revoked', 'retry_exhausted'].includes(
        row.errorCode as string,
      )) ||
    (row.preparation === 'failed') !== (row.errorCode !== null)
  )
    return invalid();
  return {
    id: id(row.id),
    frozenCursor: integer(row.frozenCursor, 0, 100000),
    frozenAt: row.frozenAt,
    revision: integer(row.revision, 1),
    preparation: row.preparation as ReviewSubmission['preparation'],
    errorCode: row.errorCode as ReviewSubmission['errorCode'],
  };
}
export function page(value: unknown, now: number, after?: string): ReviewPage {
  const row = object(value, ['submissions', 'nextCursor']);
  if (!Array.isArray(row.submissions) || row.submissions.length > 20) return invalid();
  const submissions = row.submissions.map((v) => submission(v, now));
  let previous = after ?? '';
  for (const s of submissions) {
    if (s.id <= previous) return invalid();
    previous = s.id;
  }
  const nextCursor = row.nextCursor === null ? null : id(row.nextCursor);
  if (nextCursor !== null && (submissions.length !== 20 || nextCursor !== previous))
    return invalid();
  return { submissions, nextCursor };
}
export function snapshot(
  value: unknown,
  c: ReviewContext,
  organizationId: string,
  submissionId: string,
  now: number,
): ReviewSnapshot {
  const row = object(value, [
    'assignmentId',
    'submission',
    'snapshotPin',
    'organizationId',
    'workId',
    'documentId',
    'versionId',
    'pages',
    'source',
    'annotationCount',
    'outputBytes',
    'outputSha256',
    'chunks',
  ]);
  const s = submission(row.submission, now);
  if (
    id(row.assignmentId) !== c.assignment.id ||
    id(row.organizationId) !== organizationId ||
    s.id !== submissionId ||
    s.preparation !== 'ready'
  )
    return invalid();
  if (
    !Array.isArray(row.pages) ||
    row.pages.length < 1 ||
    row.pages.length > 2000 ||
    !Array.isArray(row.chunks) ||
    row.chunks.length < 1 ||
    row.chunks.length > 2048
  )
    return invalid();
  const pages = row.pages.map((value, index) => {
    const p = object(value, ['id', 'index', 'width', 'height']);
    if (
      p.index !== index ||
      ![p.width, p.height].every(
        (n) => typeof n === 'number' && Number.isFinite(n) && n > 0 && n <= 100000,
      )
    )
      return invalid();
    return { id: id(p.id), index, width: p.width as number, height: p.height as number };
  });
  if (new Set(pages.map((p) => p.id)).size !== pages.length) return invalid();
  const source = object(row.source, ['sha256', 'bytes', 'mimeType']);
  if (source.mimeType !== 'application/pdf') return invalid();
  const chunks = row.chunks.map((value, index) => {
    const chunk = object(value, ['index', 'sha256', 'bytes']);
    if (chunk.index !== index) return invalid();
    return { index, sha256: hash(chunk.sha256), bytes: integer(chunk.bytes, 1, 262144) };
  });
  const outputBytes = integer(row.outputBytes, 1, 256 * 1024 * 1024);
  if (chunks.reduce((total, chunk) => total + chunk.bytes, 0) !== outputBytes) return invalid();
  const annotationCount = integer(row.annotationCount, 0, s.frozenCursor);
  if (
    (s.frozenCursor === 0) !== (annotationCount === 0) ||
    (annotationCount === 0 && chunks.length !== 1)
  )
    return invalid();
  return {
    assignmentId: c.assignment.id,
    submission: s,
    snapshotPin: hash(row.snapshotPin),
    organizationId,
    workId: id(row.workId),
    documentId: id(row.documentId),
    versionId: id(row.versionId),
    pages,
    source: {
      sha256: hash(source.sha256),
      bytes: integer(source.bytes, 8, 100 * 1024 * 1024),
      mimeType: 'application/pdf',
    },
    annotationCount,
    outputBytes,
    outputSha256: hash(row.outputSha256),
    chunks,
  };
}
export function chunk(value: unknown, snapshot: ReviewSnapshot, index: number): ReviewChunk {
  const row = object(value, [
    'schema',
    'organizationId',
    'workId',
    'documentId',
    'versionId',
    'frozenCursor',
    'index',
    'entries',
  ]);
  if (
    row.schema !== 1 ||
    row.organizationId !== snapshot.organizationId ||
    row.workId !== snapshot.workId ||
    row.documentId !== snapshot.documentId ||
    row.versionId !== snapshot.versionId ||
    row.frozenCursor !== snapshot.submission.frozenCursor ||
    row.index !== index ||
    !Array.isArray(row.entries) ||
    row.entries.length > snapshot.annotationCount ||
    (row.entries.length === 0 && snapshot.annotationCount !== 0)
  )
    return invalid();
  const pageIds = new Set(snapshot.pages.map((page) => page.id));
  const entries = row.entries.map((value) => {
    const base = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
    const e = object(value, [
      'annotationId',
      'pageId',
      'revision',
      'latestCursor',
      'deleted',
      'layerOrder',
      ...(base.deleted === false ? ['annotation'] : []),
    ]);
    const annotationId = id(e.annotationId),
      pageId = id(e.pageId);
    const latestCursor = integer(e.latestCursor, 1, snapshot.submission.frozenCursor);
    const revision = integer(e.revision, 1, latestCursor);
    if (typeof e.deleted !== 'boolean' || !pageIds.has(pageId)) return invalid();
    if (e.deleted) {
      if (e.layerOrder !== null || revision < 2) return invalid();
      return { annotationId, pageId, revision, latestCursor, deleted: true, layerOrder: null };
    }
    const layerOrder = integer(e.layerOrder, 1, latestCursor);
    if (revision === 1 && layerOrder !== latestCursor) return invalid();
    let annotation;
    try {
      annotation = operation({
        documentId: snapshot.documentId,
        versionId: snapshot.versionId,
        pageId,
        annotationId,
        operationId: annotationId,
        baseRevision: revision - 1,
        kind: 'put',
        annotation: e.annotation,
      }).annotation!;
    } catch {
      return invalid();
    }
    if (canonical(annotation) !== canonical(e.annotation)) return invalid();
    return { annotationId, pageId, revision, latestCursor, deleted: false, layerOrder, annotation };
  });
  return {
    schema: 1,
    organizationId: snapshot.organizationId,
    workId: snapshot.workId,
    documentId: snapshot.documentId,
    versionId: snapshot.versionId,
    frozenCursor: snapshot.submission.frozenCursor,
    index,
    entries,
  };
}
