import type {
  ArtifactIdentity,
  ArtifactMetadata,
  ArtifactReceipt,
  ReadArtifact,
} from '../cloud/types.js';
export type IngestionStatus = 'pending' | 'quarantined' | 'ready' | 'rejected';
export const SOURCE_CATALOG_PAGE_SIZE = 5;
export const SOURCE_CATALOG_TIMEOUT_MS = 25_000;
/** Reservations are durable capacity claims; revoked/rejected sources are not reclaimed yet. */
export const SOURCE_UPLOAD_COUNT_LIMIT = 100;
export const SOURCE_UPLOAD_BYTE_LIMIT = 512 * 1024 * 1024;
export interface SourceCatalogPosition {
  documentId: string;
  versionId: string;
}
export interface SourceReservationInput {
  requestId: string;
  documentId: string;
  versionId: string;
  metadata: ArtifactMetadata;
  plaintextBytes: number;
  plaintextSha256: string;
}
export interface SourceReservation {
  identity: ArtifactIdentity;
  status: IngestionStatus;
  duplicate: boolean;
}
/** Identity and course scope are supplied only by the authenticated server session. */
export interface SourceUploadInput {
  requestId: string;
  metadata: ArtifactMetadata;
  plaintextBytes: number;
  plaintextSha256: string;
}
/** Server-only storage contract. Do not expose expected hashes or storage identities as a receipt. */
export interface SourceUploadDetails {
  identity: ArtifactIdentity;
  status: IngestionStatus;
  expected: SourceUploadInput;
}
export interface InspectionClaim {
  identity: ArtifactIdentity;
  claimId: string;
  token: string;
  attempt: number;
  expiresAt: number;
  receipt: ArtifactReceipt;
  expected: Pick<SourceReservationInput, 'metadata' | 'plaintextBytes' | 'plaintextSha256'>;
}
export interface InspectionReport {
  verdict: 'ready' | 'rejected';
  plaintextSha256: string;
  plaintextBytes: number;
  /** Bounded identifiers, not scanner logs, filenames, or document text. */
  engine: string;
  engineVersion: string;
  definitionsVersion: string;
  pageCount: number;
  /** Optional only for legacy approvals. Provisioning requires authenticated geometry for every page. */
  pageGeometry?: SourcePageGeometry[];
  reason: 'clean' | 'malware' | 'unsupported' | 'content_mismatch' | 'invalid_document';
}
export interface SourcePageGeometry {
  index: number;
  /** Effective PDF viewport dimensions at scale 1, including intrinsic rotation and user units. */
  width: number;
  height: number;
}
export interface InspectionReceipt {
  id: string;
  status: 'ready' | 'rejected';
  duplicate: boolean;
}
/** Exact-version authenticated storage; implementations must not substitute current/latest objects. */
export interface ArtifactReader {
  get(
    identity: ArtifactIdentity,
    receipt: ArtifactReceipt,
    signal?: AbortSignal,
  ): Promise<ReadArtifact>;
}
/** Implement in a resource-limited isolated scanner. This module supplies no malware engine. */
export interface SourceScanner {
  inspect(
    bytes: Uint8Array,
    signal: AbortSignal,
  ): Promise<
    Pick<
      InspectionReport,
      | 'verdict'
      | 'engine'
      | 'engineVersion'
      | 'definitionsVersion'
      | 'pageCount'
      | 'pageGeometry'
      | 'reason'
    >
  >;
}
export class IngestionError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'IngestionError';
  }
}
