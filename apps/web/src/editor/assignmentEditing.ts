import type { Annotation, AnnotationTool } from '@margin/core';
import { operation as validateOperation } from '../lib/assignment-work/decode';

export interface AssignmentEditingPolicy {
  allowedTools: readonly AnnotationTool[];
  readOnly: boolean;
}
type AssignmentActionTool = AnnotationTool | Annotation['type'];
const supported = new Set<AssignmentActionTool>([
  'text',
  'pen',
  'highlight',
  'comment',
  'rectangle',
  'ellipse',
  'line',
  'eraser',
]);
export function assignmentToolAllowed(
  policy: AssignmentEditingPolicy | undefined,
  tool: AssignmentActionTool,
): boolean {
  return (
    !policy ||
    tool === 'select' ||
    (!policy.readOnly &&
      supported.has(tool) &&
      policy.allowedTools.includes(tool as AnnotationTool))
  );
}

/** Check the complete proposed change before changing history, drafts or persistence. */
export function assertAssignmentEdit(
  before: readonly Annotation[],
  after: readonly Annotation[],
  policy: AssignmentEditingPolicy | undefined,
  structuralChange = false,
): void {
  if (!policy) return;
  if (structuralChange) throw new Error('Assignment PDF pages and form fields cannot be changed.');
  const old = new Map(before.map((item) => [item.id, item]));
  const next = new Set(after.map((item) => item.id));
  const changed = after.filter((item) => item !== old.get(item.id));
  const deleted = before.some((item) => !next.has(item.id));
  if (policy.readOnly && (changed.length || deleted))
    throw new Error('Assignment editing is paused. Your draft has been kept.');
  if (deleted && !assignmentToolAllowed(policy, 'eraser'))
    throw new Error('This assignment does not allow erasing annotations.');
  for (const item of changed) {
    if (!assignmentToolAllowed(policy, item.type))
      throw new Error(`This assignment does not allow the ${item.type} tool.`);
    if (item.lineStyle !== undefined && item.lineStyle !== 'solid')
      throw new Error('Assignment annotations support solid lines only. Your draft has been kept.');
    const {
      id,
      pageIndex: _,
      createdAt: _time,
      author: _author,
      lineStyle: _style,
      ...appearance
    } = item;
    try {
      // Validate the unchanged appearance using the browser protocol codec. These
      // placeholder routing IDs confer no authority and are never persisted or sent.
      const routing = '00000000-0000-4000-8000-000000000000';
      validateOperation({
        documentId: routing,
        versionId: routing,
        pageId: routing,
        operationId: routing,
        annotationId: id,
        baseRevision: 0,
        kind: 'put',
        annotation: Object.fromEntries(
          Object.entries(appearance).filter(([, value]) => value !== undefined),
        ),
      });
    } catch {
      throw new Error(
        'This annotation appearance exceeds assignment support or limits. Your draft has been kept.',
      );
    }
  }
}
