import type {
  ArtifactIdentity,
  ArtifactMetadata,
  ArtifactReceipt,
  ReadArtifact,
} from '../cloud/types.js';
export type IngestionStatus = 'pending' | 'quarantined' | 'ready' | 'rejected';
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
  reason: 'clean' | 'malware' | 'unsupported' | 'content_mismatch' | 'invalid_document';
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
      'verdict' | 'engine' | 'engineVersion' | 'definitionsVersion' | 'pageCount' | 'reason'
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
