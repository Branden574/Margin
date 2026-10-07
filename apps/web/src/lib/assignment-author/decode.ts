import { id as workId, object as workObject } from '../assignment-work/decode';
import {
  AuthorClientError,
  authorTools,
  type AuthorAssignment,
  type AuthorDraft,
  type AuthorSession,
  type AuthorSource,
  type AuthorSourcePage,
  type AuthorContext,
} from './types';
export function id(value: unknown): string {
  try {
    return workId(value);
  } catch {
    return invalid();
  }
}
function object(value: unknown, allowed: readonly string[]) {
  try {
    return workObject(value, allowed);
  } catch {
    return invalid();
  }
}
export function invalid(): never {
  throw new AuthorClientError(
    'invalid_response',
    'The assignment service returned an invalid response.',
  );
}
function number(value: unknown, min: number, max = Number.MAX_SAFE_INTEGER) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max)
    return invalid();
  return value;
}
function text(value: unknown, max: number, empty = false) {
  if (
    typeof value !== 'string' ||
    value.length > max ||
    (!empty && !value.trim()) ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)
  )
    return invalid();
  return value;
}
export function session(value: unknown, now: number): AuthorSession & { csrfToken: string } {
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
  if (s.authenticated !== true || s.role !== 'teacher' || s.authenticationMethod !== 'lti')
    throw new AuthorClientError(
      'teacher_launch_required',
      'Open assignment setup through a verified Canvas teacher launch.',
    );
  const createdAt = number(s.createdAt, 0),
    lastSeenAt = number(s.lastSeenAt, createdAt),
    expiresAt = number(s.expiresAt, lastSeenAt + 1);
  if (expiresAt <= now)
    throw new AuthorClientError(
      'session_expired',
      'Your Canvas session expired. Reopen assignment setup from Canvas.',
    );
  if (
    typeof s.mfa !== 'boolean' ||
    typeof s.csrfToken !== 'string' ||
    !/^[A-Za-z0-9_-]{43}$/.test(s.csrfToken)
  )
    return invalid();
  return {
    authenticated: true,
    sessionId: id(s.sessionId),
    userId: id(s.userId),
    organizationId: id(s.organizationId),
    role: 'teacher',
    authenticationMethod: 'lti',
    mfa: s.mfa,
    createdAt,
    lastSeenAt,
    expiresAt,
    csrfToken: s.csrfToken,
  };
}
export function selection(value: unknown, now: number): AuthorContext['selection'] {
  const envelope = object(value, ['selection']);
  if (envelope.selection === null)
    throw new AuthorClientError(
      'selection_expired',
      'This Canvas selection expired or was completed. Reopen assignment setup from Canvas.',
    );
  const s = object(envelope.selection, ['id', 'courseId', 'expiresAt']);
  const expiresAt = number(s.expiresAt, 0);
  if (expiresAt <= now)
    throw new AuthorClientError(
      'selection_expired',
      'This Canvas selection expired. Reopen assignment setup from Canvas.',
    );
  return { id: id(s.id), courseId: id(s.courseId), expiresAt };
}
export function cursor(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) return invalid();
  return value;
}
export function decodeAuthorSource(value: unknown): AuthorSource {
  const s = object(value, [
    'documentId',
    'versionId',
    'name',
    'pageCount',
    'bytes',
    'inspection',
    'availability',
  ]);
  if (
    s.inspection !== 'approved' ||
    s.availability !== 'not-checked' ||
    typeof s.name !== 'string' ||
    /[\u0000-\u001f\u007f]/.test(s.name)
  )
    return invalid();
  return {
    documentId: id(s.documentId),
    versionId: id(s.versionId),
    name: text(s.name, 240),
    pageCount: number(s.pageCount, 1, 2000),
    bytes: number(s.bytes, 1, 104857600),
    inspection: 'approved',
    availability: 'not-checked',
  };
}
export function sources(value: unknown): AuthorSourcePage {
  const page = object(value, ['sources', 'nextCursor']);
  if (!Array.isArray(page.sources) || page.sources.length > 5) return invalid();
  const sources = page.sources.map(decodeAuthorSource);
  if (new Set(sources.map((s) => `${s.documentId}:${s.versionId}`)).size !== sources.length)
    return invalid();
  return { sources, nextCursor: page.nextCursor === null ? null : cursor(page.nextCursor) };
}
function policy(value: unknown): AuthorDraft['policy'] {
  const p = object(value, [
    'allowedTools',
    'allowExport',
    'allowCopyPaste',
    'allowReadAloud',
    'assessment',
  ]);
  if (
    p.allowExport !== true ||
    p.allowCopyPaste !== true ||
    p.allowReadAloud !== true ||
    p.assessment !== false ||
    !Array.isArray(p.allowedTools) ||
    p.allowedTools.length < 1 ||
    p.allowedTools.length > authorTools.length ||
    new Set(p.allowedTools).size !== p.allowedTools.length ||
    p.allowedTools.some((t) => !authorTools.includes(t))
  )
    return invalid();
  return {
    allowedTools: authorTools.filter((t) => (p.allowedTools as unknown[]).includes(t)),
    allowExport: true,
    allowCopyPaste: true,
    allowReadAloud: true,
    assessment: false,
  };
}
export function decodeAuthorDraft(value: unknown): AuthorDraft {
  const d = object(value, ['documentId', 'versionId', 'title', 'instructions', 'policy']);
  return {
    documentId: id(d.documentId),
    versionId: id(d.versionId),
    title: text(d.title, 200),
    instructions: text(d.instructions, 10000, true),
    policy: policy(d.policy),
  };
}
export function decodeAuthorAssignment(value: unknown): AuthorAssignment {
  const a = object(value, ['id', 'title', 'instructions', 'policy', 'createdAt']);
  const createdAt = text(a.createdAt, 40);
  if (
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(createdAt) ||
    !Number.isFinite(Date.parse(createdAt))
  )
    return invalid();
  return {
    id: id(a.id),
    title: text(a.title, 200),
    instructions: text(a.instructions, 10000, true),
    policy: policy(a.policy),
    createdAt,
  };
}
