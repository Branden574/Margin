import type { Annotation, AnnotationOperation } from '@margin/core';
import { operation as decodeOperation } from './decode';
import type { AppendOperation, CommittedOperation } from './types';
import type { AssignmentBinding, AssignmentIdentity } from './repositoryTypes';
import { AssignmentRepositoryError } from './repositoryTypes';
import type { VerifiedAssignmentData } from './client';

export function repositoryError(code: string, message: string): never {
  throw new AssignmentRepositoryError(code, message);
}
export function assignmentIdentity(data: VerifiedAssignmentData): AssignmentIdentity {
  const work = data.manifest.work;
  if (work?.status !== 'provisioned')
    return repositoryError('work_pending', 'Wait for the assignment document to be provisioned.');
  return {
    origin: data.origin,
    organizationId: data.session.organizationId,
    userId: data.session.userId,
    assignmentId: data.manifest.assignment.id,
    workId: work.id,
    documentId: work.document.documentId,
    versionId: work.document.versionId,
  };
}
export function sameAssignmentIdentity(a: AssignmentIdentity, b: AssignmentIdentity): boolean {
  return (
    (Object.keys(a) as (keyof AssignmentIdentity)[]).every((key) => a[key] === b[key]) &&
    Object.keys(a).length === 7 &&
    Object.keys(b).length === 7
  );
}
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(',')}}`;
  return JSON.stringify(value);
}
export function toAssignmentOperation(
  local: AnnotationOperation,
  binding: AssignmentBinding,
  baseRevision: number,
  pageId?: string,
): AppendOperation {
  if (
    local.documentId !== binding.localDocumentId ||
    !Number.isSafeInteger(local.timestamp) ||
    local.timestamp < 0 ||
    !['put', 'delete'].includes(local.kind)
  )
    return repositoryError(
      'invalid_local_operation',
      'The local edit does not belong to this assignment.',
    );
  if (
    Object.keys(local).some(
      (key) =>
        !['id', 'documentId', 'timestamp', 'kind', 'annotationId', 'annotation'].includes(key),
    )
  )
    return repositoryError(
      'unsupported_appearance',
      'The local edit contains unsupported properties.',
    );
  const work = binding.manifest.work;
  if (work?.status !== 'provisioned')
    return repositoryError('invalid_binding', 'The assignment binding is damaged.');
  let annotation: AppendOperation['annotation'];
  if (local.kind === 'put') {
    const a = local.annotation;
    if (
      !a ||
      a.id !== local.annotationId ||
      !Number.isInteger(a.pageIndex) ||
      !work.document.pages[a.pageIndex] ||
      !Number.isSafeInteger(a.createdAt) ||
      a.createdAt < 0 ||
      typeof a.author !== 'string' ||
      a.author.length > 200
    )
      return repositoryError('invalid_local_operation', 'The annotation metadata is invalid.');
    const { id: _, pageIndex, createdAt: _created, author: _author, lineStyle, ...appearance } = a;
    if (lineStyle !== undefined && lineStyle !== 'solid')
      return repositoryError(
        'unsupported_appearance',
        'Dashed and dotted lines are not supported by assignment synchronization. The original edit has not been changed.',
      );
    pageId = work.document.pages[pageIndex].id;
    annotation = appearance as AppendOperation['annotation'];
  } else if (local.annotation !== undefined)
    return repositoryError(
      'invalid_local_operation',
      'A deletion cannot contain annotation content.',
    );
  try {
    const result = decodeOperation({
      documentId: binding.identity.documentId,
      versionId: binding.identity.versionId,
      pageId,
      annotationId: local.annotationId,
      operationId: local.id,
      baseRevision,
      kind: local.kind,
      ...(annotation ? { annotation } : {}),
    });
    const tool = result.kind === 'delete' ? 'eraser' : result.annotation!.type;
    if (!binding.manifest.assignment.policy.allowedTools.includes(tool))
      return repositoryError(
        'assignment_tool_disabled',
        'This annotation tool is disabled for the assignment.',
      );
    return result;
  } catch (error) {
    if (error instanceof AssignmentRepositoryError) throw error;
    return repositoryError(
      'unsupported_appearance',
      'This edit cannot be represented by the assignment protocol. Its appearance has not been simplified.',
    );
  }
}
export function fromAssignmentOperation(
  operation: CommittedOperation,
  binding: AssignmentBinding,
  previous?: Annotation | null,
): Annotation | null {
  if (operation.kind === 'delete') return null;
  const work = binding.manifest.work;
  const pageIndex =
    work?.status === 'provisioned'
      ? work.document.pages.findIndex((page) => page.id === operation.pageId)
      : -1;
  if (pageIndex < 0)
    return repositoryError('page_mismatch', 'The annotation belongs to an unavailable page.');
  return {
    ...structuredClone(operation.annotation!),
    id: operation.annotationId,
    pageIndex,
    createdAt: previous?.createdAt ?? Date.parse(operation.committedAt),
    author: previous?.author ?? 'You',
  };
}
