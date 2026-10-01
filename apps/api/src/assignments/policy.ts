import {
  AssignmentError,
  assignmentTools,
  type AssignmentInput,
  type AssignmentPolicy,
  type ReadyAssignmentSource,
} from './types.js';
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
export function assignmentId(value: unknown): string {
  if (typeof value !== 'string' || !uuid.test(value))
    throw new AssignmentError(400, 'invalid_identifier', 'Choose a valid assignment resource.');
  return value;
}
function plain(value: unknown, max: number, allowEmpty = false): string {
  if (
    typeof value !== 'string' ||
    value.length > max ||
    (!allowEmpty && !value.trim()) ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)
  )
    throw new AssignmentError(400, 'invalid_text', 'Assignment text is invalid or too long.');
  return value;
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new AssignmentError(400, 'invalid_assignment', 'Provide a valid assignment.');
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, allowed: string[]) {
  if (Object.keys(value).some((key) => !allowed.includes(key)))
    throw new AssignmentError(
      400,
      'unknown_field',
      'This assignment contains an unsupported field.',
    );
}
export function parseAssignmentPolicy(value: unknown): AssignmentPolicy {
  const input = object(value);
  keys(input, ['allowedTools', 'allowExport', 'allowCopyPaste', 'allowReadAloud', 'assessment']);
  if (
    !Array.isArray(input.allowedTools) ||
    input.allowedTools.length < 1 ||
    input.allowedTools.length > assignmentTools.length ||
    new Set(input.allowedTools).size !== input.allowedTools.length ||
    input.allowedTools.some(
      (tool) => !assignmentTools.includes(tool as (typeof assignmentTools)[number]),
    )
  )
    throw new AssignmentError(
      400,
      'invalid_tools',
      'Select supported assignment tools without duplicates.',
    );
  for (const key of ['allowExport', 'allowCopyPaste', 'allowReadAloud', 'assessment'])
    if (typeof input[key] !== 'boolean')
      throw new AssignmentError(
        400,
        'invalid_policy',
        'Assignment policy values must be explicit booleans.',
      );
  return {
    allowedTools: assignmentTools.filter((tool) =>
      (input.allowedTools as unknown[]).includes(tool),
    ),
    allowExport: input.allowExport as boolean,
    allowCopyPaste: input.allowCopyPaste as boolean,
    allowReadAloud: input.allowReadAloud as boolean,
    assessment: input.assessment as boolean,
  };
}
export function parseAssignmentInput(value: unknown): AssignmentInput {
  const input = object(value);
  keys(input, ['requestId', 'documentId', 'versionId', 'title', 'instructions', 'policy']);
  return {
    requestId: assignmentId(input.requestId),
    documentId: assignmentId(input.documentId),
    versionId: assignmentId(input.versionId),
    title: plain(input.title, 200),
    instructions: plain(input.instructions, 10000, true),
    policy: parseAssignmentPolicy(input.policy),
  };
}
export function verifyReadySource(
  source: ReadyAssignmentSource,
  expected: { organizationId: string; ownerId: string; documentId: string; versionId: string },
): ReadyAssignmentSource {
  if (
    !source ||
    source.organizationId !== expected.organizationId ||
    source.ownerId !== expected.ownerId ||
    source.documentId !== expected.documentId ||
    source.versionId !== expected.versionId ||
    source.encrypted !== true ||
    source.inspectionStatus !== 'ready' ||
    !Number.isInteger(source.pageCount) ||
    source.pageCount < 1 ||
    source.pageCount > 2000 ||
    !/^[a-f0-9]{64}$/.test(source.sha256)
  )
    throw new AssignmentError(
      409,
      'source_not_ready',
      'The selected immutable document has not passed required inspection or ownership checks.',
    );
  assignmentId(source.artifactId);
  assignmentId(source.scanReceiptId);
  plain(source.artifactVersion, 1024);
  return structuredClone(source);
}
