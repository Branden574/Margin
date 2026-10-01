import { SyncError, type AppendOperation, type SyncAnnotation } from './types.js';
export const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const MAX_OPERATION_BYTES = 65536;
export function identifier(value: unknown): string {
  if (typeof value !== 'string' || !uuidPattern.test(value))
    throw new SyncError(
      400,
      'invalid_identifier',
      'Use valid document, version, page and operation identifiers.',
    );
  return value.toLowerCase();
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new SyncError(400, 'invalid_operation', 'The annotation operation must be an object.');
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, allowed: readonly string[]) {
  if (Object.keys(value).some((key) => !allowed.includes(key)))
    throw new SyncError(
      400,
      'unexpected_field',
      'The operation contains an unsupported or server-owned field.',
    );
}
function number(value: unknown, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max)
    throw new SyncError(
      400,
      'invalid_annotation',
      'Annotation coordinates or drawing controls exceed their limits.',
    );
  return value;
}
export function revision(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > 100000)
    throw new SyncError(400, 'invalid_revision', 'The annotation revision is invalid.');
  return value as number;
}
export function parseOperation(value: unknown): AppendOperation {
  const input = object(value);
  keys(input, [
    'documentId',
    'versionId',
    'pageId',
    'annotationId',
    'operationId',
    'baseRevision',
    'kind',
    'annotation',
  ]);
  if (input.kind !== 'put' && input.kind !== 'delete')
    throw new SyncError(400, 'invalid_operation', 'Choose a supported annotation operation.');
  const result: AppendOperation = {
    documentId: identifier(input.documentId),
    versionId: identifier(input.versionId),
    pageId: identifier(input.pageId),
    annotationId: identifier(input.annotationId),
    operationId: identifier(input.operationId),
    baseRevision: revision(input.baseRevision),
    kind: input.kind,
  };
  if (input.kind === 'delete') {
    if (input.annotation !== undefined)
      throw new SyncError(
        400,
        'unexpected_field',
        'Delete operations do not accept annotation content.',
      );
    return result;
  }
  const a = object(input.annotation);
  keys(a, [
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
    typeof a.type !== 'string' ||
    !['text', 'pen', 'highlight', 'comment', 'rectangle', 'ellipse', 'line'].includes(a.type)
  )
    throw new SyncError(400, 'invalid_annotation', 'This annotation type is unsupported.');
  if (typeof a.color !== 'string' || !/^#[0-9a-f]{6}$/i.test(a.color))
    throw new SyncError(400, 'invalid_annotation', 'Use a six-digit annotation color.');
  const annotation: SyncAnnotation = {
    type: a.type as SyncAnnotation['type'],
    x: number(a.x, -100000, 100000),
    y: number(a.y, -100000, 100000),
    color: a.color.toLowerCase(),
    strokeWidth: number(a.strokeWidth, 0.1, 100),
    opacity: number(a.opacity, 0, 1),
  };
  if (a.width !== undefined) annotation.width = number(a.width, 0, 100000);
  if (a.height !== undefined) annotation.height = number(a.height, 0, 100000);
  if (a.rotation !== undefined) annotation.rotation = number(a.rotation, 0, 359.999);
  if (a.text !== undefined) {
    if (typeof a.text !== 'string' || a.text.length > 16000 || a.text.includes('\u0000'))
      throw new SyncError(400, 'invalid_annotation', 'Annotation text exceeds its limit.');
    annotation.text = a.text;
  }
  if (a.points !== undefined) {
    if (!Array.isArray(a.points) || a.points.length > 2000 || a.points.length < 1)
      throw new SyncError(
        400,
        'invalid_annotation',
        'A stroke must contain between one and 2,000 points.',
      );
    annotation.points = a.points.map((value) => {
      const p = object(value);
      keys(p, ['x', 'y', 'pressure']);
      return {
        x: number(p.x, -100000, 100000),
        y: number(p.y, -100000, 100000),
        ...(p.pressure !== undefined ? { pressure: number(p.pressure, 0, 1) } : {}),
      };
    });
  }
  if (a.type === 'pen' && !annotation.points)
    throw new SyncError(400, 'invalid_annotation', 'Pen strokes require points.');
  result.annotation = annotation;
  if (Buffer.byteLength(JSON.stringify(result)) > MAX_OPERATION_BYTES)
    throw new SyncError(
      413,
      'operation_too_large',
      'The annotation operation exceeds 64 KiB. Keep this edit locally and reduce its size.',
    );
  return result;
}
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(',')}}`;
  return JSON.stringify(value);
}
