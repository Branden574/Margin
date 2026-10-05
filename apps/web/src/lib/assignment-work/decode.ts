import {
  AssignmentWorkClientError,
  MAX_OPERATION_BYTES,
  type AppendOperation,
  type AppendReceipt,
  type CatchUpResult,
  type CommittedOperation,
  type StudentSession,
  type StudentWorkReservation,
  type SyncAnnotation,
  type WorkManifest,
} from './types';

const tools = [
  'text',
  'pen',
  'highlight',
  'comment',
  'rectangle',
  'ellipse',
  'line',
  'eraser',
] as const;
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
export function invalid(): never {
  throw new AssignmentWorkClientError(
    'invalid_response',
    'The assignment service returned an invalid response.',
  );
}
export function object(value: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid();
  const item = value as Record<string, unknown>;
  if (Object.keys(item).some((key) => !allowed.includes(key))) return invalid();
  return item;
}
export function id(value: unknown): string {
  if (typeof value !== 'string' || !uuid.test(value)) return invalid();
  return value.toLowerCase();
}
function bool(value: unknown): boolean {
  if (typeof value !== 'boolean') return invalid();
  return value;
}
function num(value: unknown, min: number, max: number, integer = false): number {
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    value < min ||
    value > max ||
    (integer && !Number.isSafeInteger(value))
  )
    return invalid();
  return value;
}
function pageDimension(value: unknown): number {
  const result = num(value, 0, 100_000);
  return result > 0 ? result : invalid();
}
export const cursor = (value: unknown) => num(value, 0, 100_000, true);
function text(value: unknown, max: number, empty = false): string {
  if (
    typeof value !== 'string' ||
    value.length > max ||
    (!empty && !value.trim()) ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)
  )
    return invalid();
  return value;
}
export function session(value: unknown, now: number): StudentSession & { csrfToken: string } {
  const s = object(value, [
    'authenticated',
    'sessionId',
    'userId',
    'organizationId',
    'role',
    'authenticationMethod',
    'mfa',
    'createdAt',
    'lastSeenAt',
    'expiresAt',
    'csrfToken',
  ]);
  if (s.authenticated !== true || s.role !== 'student' || s.authenticationMethod !== 'lti')
    throw new AssignmentWorkClientError(
      'student_launch_required',
      'Open the assignment through a verified Canvas student launch.',
    );
  const createdAt = num(s.createdAt, 0, Number.MAX_SAFE_INTEGER, true);
  const lastSeenAt = num(s.lastSeenAt, createdAt, Number.MAX_SAFE_INTEGER, true);
  const expiresAt = num(s.expiresAt, lastSeenAt + 1, Number.MAX_SAFE_INTEGER, true);
  if (expiresAt <= now)
    throw new AssignmentWorkClientError(
      'session_expired',
      'This Canvas session has expired. Reopen the assignment from Canvas.',
    );
  if (typeof s.csrfToken !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(s.csrfToken)) return invalid();
  return {
    authenticated: true,
    sessionId: id(s.sessionId),
    userId: id(s.userId),
    organizationId: id(s.organizationId),
    role: 'student',
    authenticationMethod: 'lti',
    mfa: bool(s.mfa),
    createdAt,
    lastSeenAt,
    expiresAt,
    csrfToken: s.csrfToken,
  };
}
export function manifest(value: unknown): WorkManifest {
  const m = object(value, ['assignment', 'work']);
  const a = object(m.assignment, ['id', 'title', 'instructions', 'policy']);
  const p = object(a.policy, [
    'allowedTools',
    'assessment',
    'allowExport',
    'allowCopyPaste',
    'allowReadAloud',
  ]);
  if (
    !Array.isArray(p.allowedTools) ||
    p.allowedTools.length < 1 ||
    p.allowedTools.length > tools.length ||
    new Set(p.allowedTools).size !== p.allowedTools.length ||
    p.allowedTools.some((tool) => !tools.includes(tool))
  )
    return invalid();
  const result: WorkManifest = {
    assignment: {
      id: id(a.id),
      title: text(a.title, 200),
      instructions: text(a.instructions, 10_000, true),
      policy: {
        allowedTools: [...p.allowedTools],
        assessment: bool(p.assessment),
        allowExport: bool(p.allowExport),
        allowCopyPaste: bool(p.allowCopyPaste),
        allowReadAloud: bool(p.allowReadAloud),
      },
    },
    work: null,
  };
  if (m.work === null) return result;
  const w = object(m.work, ['id', 'status', 'document']);
  if (w.status === 'pending') {
    if (Object.hasOwn(w, 'document')) return invalid();
    result.work = { id: id(w.id), status: 'pending' };
  } else if (w.status === 'provisioned') {
    const d = object(w.document, [
      'documentId',
      'versionId',
      'cursor',
      'permission',
      'audience',
      'pages',
    ]);
    if (
      d.permission !== 'owner' ||
      d.audience !== 'members' ||
      !Array.isArray(d.pages) ||
      d.pages.length < 1 ||
      d.pages.length > 2000
    )
      return invalid();
    const pages = d.pages.map((value, index) => {
      const p = object(value, ['id', 'index', 'width', 'height']);
      if (p.index !== index) return invalid();
      return {
        id: id(p.id),
        index,
        width: pageDimension(p.width),
        height: pageDimension(p.height),
      };
    });
    if (new Set(pages.map((p) => p.id)).size !== pages.length) return invalid();
    result.work = {
      id: id(w.id),
      status: 'provisioned',
      document: {
        documentId: id(d.documentId),
        versionId: id(d.versionId),
        cursor: cursor(d.cursor),
        permission: 'owner',
        audience: 'members',
        pages,
      },
    };
  } else return invalid();
  return result;
}
export function reservation(
  value: unknown,
  m: WorkManifest,
  userId: string,
): StudentWorkReservation {
  const r = object(object(value, ['work']).work, [
    'id',
    'assignmentId',
    'userId',
    'documentId',
    'versionId',
    'status',
    'duplicate',
  ]);
  if (r.status !== 'pending' && r.status !== 'provisioned') return invalid();
  const result: StudentWorkReservation = {
    id: id(r.id),
    assignmentId: id(r.assignmentId),
    userId: id(r.userId),
    documentId: id(r.documentId),
    versionId: id(r.versionId),
    status: r.status,
    duplicate: bool(r.duplicate),
  };
  if (
    result.assignmentId !== m.assignment.id ||
    result.userId !== userId ||
    (m.work && m.work.id !== result.id)
  )
    return invalid();
  if (
    m.work?.status === 'provisioned' &&
    (result.status !== 'provisioned' ||
      result.documentId !== m.work.document.documentId ||
      result.versionId !== m.work.document.versionId)
  )
    return invalid();
  return result;
}
export function operation(value: unknown): AppendOperation {
  const o = object(value, [
    'documentId',
    'versionId',
    'pageId',
    'annotationId',
    'operationId',
    'baseRevision',
    'kind',
    'annotation',
  ]);
  if (o.kind !== 'put' && o.kind !== 'delete') return invalid();
  const result: AppendOperation = {
    documentId: id(o.documentId),
    versionId: id(o.versionId),
    pageId: id(o.pageId),
    annotationId: id(o.annotationId),
    operationId: id(o.operationId),
    baseRevision: cursor(o.baseRevision),
    kind: o.kind,
  };
  if (o.kind === 'delete') {
    if (Object.hasOwn(o, 'annotation')) return invalid();
  } else {
    const a = object(o.annotation, [
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
    ]);
    if (
      !tools.slice(0, -1).includes(a.type as (typeof tools)[number]) ||
      typeof a.color !== 'string' ||
      !/^#[a-f0-9]{6}$/i.test(a.color)
    )
      return invalid();
    const annotation: SyncAnnotation = {
      type: a.type as SyncAnnotation['type'],
      x: num(a.x, -100_000, 100_000),
      y: num(a.y, -100_000, 100_000),
      color: a.color.toLowerCase(),
      strokeWidth: num(a.strokeWidth, 0.1, 100),
      opacity: num(a.opacity, 0, 1),
    };
    for (const name of ['width', 'height'] as const)
      if (Object.hasOwn(a, name)) annotation[name] = num(a[name], 0, 100_000);
    if (Object.hasOwn(a, 'rotation')) annotation.rotation = num(a.rotation, 0, 359.999);
    if (Object.hasOwn(a, 'text')) {
      if (typeof a.text !== 'string' || a.text.length > 16_000 || a.text.includes('\0'))
        return invalid();
      annotation.text = a.text;
    }
    if (Object.hasOwn(a, 'points')) {
      if (!Array.isArray(a.points) || a.points.length < 1 || a.points.length > 2000)
        return invalid();
      annotation.points = a.points.map((value) => {
        const p = object(value, ['x', 'y', 'pressure']);
        return {
          x: num(p.x, -100_000, 100_000),
          y: num(p.y, -100_000, 100_000),
          ...(Object.hasOwn(p, 'pressure') ? { pressure: num(p.pressure, 0, 1) } : {}),
        };
      });
    }
    if (a.type === 'pen' && !annotation.points) return invalid();
    result.annotation = annotation;
  }
  if (new TextEncoder().encode(JSON.stringify(result)).byteLength > MAX_OPERATION_BYTES)
    return invalid();
  return result;
}
export function boundOperation(o: AppendOperation, m: WorkManifest) {
  if (
    m.work?.status !== 'provisioned' ||
    o.documentId !== m.work.document.documentId ||
    o.versionId !== m.work.document.versionId ||
    !m.work.document.pages.some((p) => p.id === o.pageId)
  )
    return invalid();
}
export function receipt(
  value: unknown,
  input: AppendOperation,
  knownCursor: number,
): AppendReceipt {
  const r = object(object(value, ['receipt']).receipt, [
    'operationId',
    'cursor',
    'annotationRevision',
    'duplicate',
  ]);
  const result = {
    operationId: id(r.operationId),
    cursor: cursor(r.cursor),
    annotationRevision: cursor(r.annotationRevision),
    duplicate: bool(r.duplicate),
  };
  if (
    result.operationId !== input.operationId ||
    result.cursor < 1 ||
    result.annotationRevision !== input.baseRevision + 1 ||
    (!result.duplicate && result.cursor <= knownCursor)
  )
    return invalid();
  return result;
}
export function catchUp(
  value: unknown,
  m: WorkManifest,
  userId: string,
  after: number,
  limit: number,
  knownCursor: number,
): CatchUpResult {
  const r = object(value, [
    'documentId',
    'versionId',
    'operations',
    'nextCursor',
    'currentCursor',
    'hasMore',
  ]);
  if (
    m.work?.status !== 'provisioned' ||
    id(r.documentId) !== m.work.document.documentId ||
    id(r.versionId) !== m.work.document.versionId ||
    !Array.isArray(r.operations) ||
    r.operations.length > limit
  )
    return invalid();
  const currentCursor = cursor(r.currentCursor),
    nextCursor = cursor(r.nextCursor),
    hasMore = bool(r.hasMore);
  if (currentCursor < after || currentCursor < knownCursor) return invalid();
  const ids = new Set<string>(),
    revisions = new Map<string, number>();
  const operations: CommittedOperation[] = r.operations.map((value, index) => {
    const c = object(value, [
      'documentId',
      'versionId',
      'pageId',
      'annotationId',
      'operationId',
      'baseRevision',
      'kind',
      'annotation',
      'actorId',
      'cursor',
      'annotationRevision',
      'committedAt',
    ]);
    const { actorId, cursor: position, annotationRevision, committedAt, ...body } = c;
    const decoded = operation(body);
    boundOperation(decoded, m);
    if (
      id(actorId) !== userId ||
      cursor(position) !== after + index + 1 ||
      cursor(annotationRevision) !== decoded.baseRevision + 1 ||
      (position as number) > currentCursor ||
      ids.has(decoded.operationId) ||
      (revisions.has(decoded.annotationId) &&
        revisions.get(decoded.annotationId) !== decoded.baseRevision) ||
      typeof committedAt !== 'string' ||
      !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(committedAt) ||
      !Number.isFinite(Date.parse(committedAt)) ||
      new Date(committedAt).toISOString() !== committedAt
    )
      return invalid();
    ids.add(decoded.operationId);
    revisions.set(decoded.annotationId, annotationRevision as number);
    return {
      ...decoded,
      actorId: userId,
      cursor: position as number,
      annotationRevision: annotationRevision as number,
      committedAt,
    };
  });
  if (
    nextCursor !== (operations.at(-1)?.cursor ?? after) ||
    hasMore !== nextCursor < currentCursor ||
    (hasMore && !operations.length)
  )
    return invalid();
  return {
    documentId: m.work.document.documentId,
    versionId: m.work.document.versionId,
    operations,
    nextCursor,
    currentCursor,
    hasMore,
  };
}
