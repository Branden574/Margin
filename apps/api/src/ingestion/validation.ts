import type { ArtifactReceipt } from '../cloud/types.js';
import { IngestionError, type SourceReservationInput, type InspectionReport } from './types.js';
export const id = (v: unknown): string => {
  if (typeof v !== 'string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(v))
    throw new IngestionError(400, 'invalid_ingestion', 'A canonical identifier is required.');
  return v;
};
export const digest = (v: unknown): string => {
  if (typeof v !== 'string' || !/^[a-f0-9]{64}$/.test(v))
    throw new IngestionError(400, 'invalid_ingestion', 'A SHA-256 digest is required.');
  return v;
};
export const bytes = (v: unknown): number => {
  if (!Number.isSafeInteger(v) || (v as number) < 1 || (v as number) > 100 * 1024 * 1024)
    throw new IngestionError(
      400,
      'invalid_ingestion',
      'Source bytes must be within the supported bound.',
    );
  return v as number;
};
function text(v: unknown, max: number): string {
  if (typeof v !== 'string' || v.length < 1 || v.length > max || /[\u0000-\u001f\u007f]/.test(v))
    throw new IngestionError(400, 'invalid_ingestion', 'Invalid bounded metadata.');
  return v;
}
export function reservation(v: SourceReservationInput): SourceReservationInput {
  if (!v || v.metadata?.mimeType !== 'application/pdf')
    throw new IngestionError(400, 'invalid_ingestion', 'Only source PDF ingestion is supported.');
  return {
    requestId: id(v.requestId),
    documentId: id(v.documentId),
    versionId: id(v.versionId),
    metadata: { name: text(v.metadata.name, 240), mimeType: 'application/pdf' },
    plaintextBytes: bytes(v.plaintextBytes),
    plaintextSha256: digest(v.plaintextSha256),
  };
}
export function receipt(v: ArtifactReceipt): ArtifactReceipt {
  if (
    !v ||
    v.objectVersionId === 'null' ||
    !Number.isSafeInteger(v.storedBytes) ||
    v.storedBytes < 30 ||
    v.storedBytes > 100 * 1024 * 1024 + 65536
  )
    throw new IngestionError(
      400,
      'unconfirmed_artifact',
      'An exact confirmed encrypted object receipt is required.',
    );
  return {
    objectVersionId: text(v.objectVersionId, 1024),
    etag: text(v.etag, 256),
    ciphertextSha256: digest(v.ciphertextSha256),
    storedBytes: v.storedBytes,
  };
}
export function report(v: InspectionReport): InspectionReport {
  if (
    !v ||
    !['ready', 'rejected'].includes(v.verdict) ||
    !['clean', 'malware', 'unsupported', 'content_mismatch', 'invalid_document'].includes(
      v.reason,
    ) ||
    !Number.isSafeInteger(v.pageCount) ||
    v.pageCount < 0 ||
    v.pageCount > 2000 ||
    (v.verdict === 'ready' && (v.reason !== 'clean' || v.pageCount < 1)) ||
    (v.verdict === 'rejected' && v.reason === 'clean')
  )
    throw new IngestionError(
      400,
      'invalid_inspection',
      'Inspection result is invalid or exceeds its bound.',
    );
  const identifiers = [v.engine, v.engineVersion, v.definitionsVersion].map((v) => text(v, 120));
  if (identifiers.some((v) => !/^[a-zA-Z0-9_.:+-]+$/.test(v)))
    throw new IngestionError(
      400,
      'invalid_inspection',
      'Use bounded scanner identifiers, not report text.',
    );
  return {
    verdict: v.verdict,
    plaintextSha256: digest(v.plaintextSha256),
    plaintextBytes: bytes(v.plaintextBytes),
    engine: identifiers[0],
    engineVersion: identifiers[1],
    definitionsVersion: identifiers[2],
    pageCount: v.pageCount,
    reason: v.reason,
  };
}
