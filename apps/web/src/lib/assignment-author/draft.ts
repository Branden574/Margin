import { createVaultGuard, vaultTransaction } from '../vault';
import { readAuthorContext } from './client';
import { decodeAuthorAssignment, decodeAuthorDraft, decodeAuthorSource } from './decode';
import type {
  AuthorAssignment,
  AuthorContext,
  AuthorDraft,
  AuthorSource,
  AuthorTool,
} from './types';

export interface AuthorFormDraft {
  source: AuthorSource | null;
  title: string;
  instructions: string;
  allowedTools: AuthorTool[];
}
export type AuthorDraftValue =
  | { phase: 'editing'; form: AuthorFormDraft }
  | { phase: 'prepared'; form: AuthorFormDraft; request: { requestId: string; draft: AuthorDraft } }
  | {
      phase: 'created';
      form: AuthorFormDraft;
      request: { requestId: string; draft: AuthorDraft };
      assignment: AuthorAssignment;
    };
export type AuthorDraftRecord = AuthorDraftValue & { revision: string };
const tools: readonly AuthorTool[] = [
  'text',
  'pen',
  'highlight',
  'comment',
  'rectangle',
  'ellipse',
  'line',
  'eraser',
];
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const bad = () =>
  new Error(
    'The saved assignment draft is damaged or unsupported. Its encrypted copy has not been changed.',
  );
export class AuthorDraftConflict extends Error {
  constructor() {
    super(
      'This assignment draft changed in another tab. Reopen the selection before editing; your current changes have not overwritten it.',
    );
  }
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw bad();
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, allowed: string[]) {
  if (Object.keys(value).some((key) => !allowed.includes(key))) throw bad();
}
function text(value: unknown, max: number): string {
  if (
    typeof value !== 'string' ||
    value.length > max ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)
  )
    throw bad();
  return value;
}
function id(value: unknown): string {
  if (typeof value !== 'string' || !uuid.test(value)) throw bad();
  return value;
}
function source(value: unknown): AuthorSource | null {
  return value === null ? null : decodeAuthorSource(value);
}
function form(value: unknown): AuthorFormDraft {
  const row = object(value);
  keys(row, ['source', 'title', 'instructions', 'allowedTools']);
  if (
    !Array.isArray(row.allowedTools) ||
    row.allowedTools.length > tools.length ||
    new Set(row.allowedTools).size !== row.allowedTools.length ||
    row.allowedTools.some((tool) => !tools.includes(tool as AuthorTool))
  )
    throw bad();
  return {
    source: source(row.source),
    title: text(row.title, 200),
    instructions: text(row.instructions, 10000),
    allowedTools: tools.filter((tool) => (row.allowedTools as unknown[]).includes(tool)),
  };
}
export function authorFormPayload(value: AuthorFormDraft): AuthorDraft {
  const parsed = form(value);
  if (!parsed.source) throw new Error('Choose an approved document.');
  return decodeAuthorDraft({
    documentId: parsed.source.documentId,
    versionId: parsed.source.versionId,
    title: parsed.title,
    instructions: parsed.instructions,
    policy: {
      allowedTools: parsed.allowedTools,
      allowExport: true,
      allowCopyPaste: true,
      allowReadAloud: true,
      assessment: false,
    },
  });
}
function parse(value: unknown): AuthorDraftValue {
  const row = object(value);
  keys(row, ['phase', 'form', 'request', 'assignment']);
  const fields = form(row.form);
  if (row.phase === 'editing') {
    if ('request' in row || 'assignment' in row) throw bad();
    return { phase: 'editing', form: fields };
  }
  if (row.phase !== 'prepared' && row.phase !== 'created') throw bad();
  const request = object(row.request);
  keys(request, ['requestId', 'draft']);
  const frozen = { requestId: id(request.requestId), draft: decodeAuthorDraft(request.draft) };
  if (JSON.stringify(frozen.draft) !== JSON.stringify(authorFormPayload(fields))) throw bad();
  if (row.phase === 'prepared') {
    if ('assignment' in row) throw bad();
    return { phase: 'prepared', form: fields, request: frozen };
  }
  const assignment = decodeAuthorAssignment(row.assignment);
  if (
    assignment.title !== frozen.draft.title ||
    assignment.instructions !== frozen.draft.instructions ||
    JSON.stringify(assignment.policy) !== JSON.stringify(frozen.draft.policy)
  )
    throw bad();
  return { phase: 'created', form: fields, request: frozen, assignment };
}
function binding(context: AuthorContext) {
  const { origin, session, selection } = readAuthorContext(context);
  return [
    origin,
    session.sessionId,
    session.organizationId,
    session.userId,
    selection.id,
    selection.courseId,
    selection.expiresAt,
  ] as const;
}
function stored(value: unknown, identity: ReturnType<typeof binding>): AuthorDraftRecord {
  const row = object(value);
  keys(row, ['schema', 'binding', 'revision', 'value']);
  if (row.schema !== 1 || JSON.stringify(row.binding) !== JSON.stringify(identity)) throw bad();
  return { ...parse(row.value), revision: id(row.revision) };
}
function lifecycle(context: AuthorContext) {
  const identity = binding(context),
    vault = createVaultGuard();
  const guard = () => {
    vault();
    if (JSON.stringify(binding(context)) !== JSON.stringify(identity))
      throw new Error('The Canvas selection changed. Reopen it from Canvas.');
  };
  return { identity, guard, key: JSON.stringify(identity) };
}
/** A verified context is a live capability, never a deserialized local identity. */
export async function readAuthorDraft(
  context: AuthorContext,
): Promise<AuthorDraftRecord | undefined> {
  const { identity, guard, key } = lifecycle(context);
  const result = await vaultTransaction(
    async (tx) => {
      guard();
      const found = await tx.get<unknown>('author-drafts', key);
      return found === undefined ? undefined : stored(found, identity);
    },
    { guard },
  );
  guard();
  return result;
}
async function write(
  context: AuthorContext,
  value: AuthorDraftValue,
  expectedRevision: string | null,
): Promise<AuthorDraftRecord> {
  const { identity, guard, key } = lifecycle(context);
  if (expectedRevision !== null) id(expectedRevision);
  const snapshot = parse(value);
  const result = await vaultTransaction(
    async (tx) => {
      guard();
      const found = await tx.get<unknown>('author-drafts', key);
      const previous = found === undefined ? undefined : stored(found, identity);
      if ((previous?.revision ?? null) !== expectedRevision) throw new AuthorDraftConflict();
      const next = snapshot;
      if (previous && previous.phase !== 'editing') {
        if (
          !next ||
          next.phase === 'editing' ||
          JSON.stringify(next.request) !== JSON.stringify(previous.request) ||
          (previous.phase === 'created' &&
            (next.phase !== 'created' ||
              JSON.stringify(next.assignment) !== JSON.stringify(previous.assignment)))
        )
          throw new Error(
            'Keep the exact saved assignment request until its outcome is confirmed.',
          );
      }
      if (!next) throw bad();
      const revision = crypto.randomUUID();
      tx.put('author-drafts', key, { schema: 1, binding: identity, revision, value: next });
      return { ...next, revision };
    },
    { guard },
  );
  guard();
  return result;
}
export function saveAuthorDraft(
  context: AuthorContext,
  value: AuthorDraftValue,
  expectedRevision: string | null,
): Promise<AuthorDraftRecord> {
  return write(context, value, expectedRevision);
}
