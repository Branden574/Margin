export type ArtifactKind = 'source-pdf' | 'pdf-export' | 'thumbnail' | 'ocr-text' | 'attachment';
/** Trusted control-plane identity, after document/version authorization. Never accept arbitrary paths. */
export interface ArtifactIdentity {
  organizationId: string;
  documentId: string;
  versionId: string;
  artifactId: string;
  kind: ArtifactKind;
}
export interface ArtifactMetadata {
  name: string;
  mimeType:
    | 'application/pdf'
    | 'image/png'
    | 'image/jpeg'
    | 'text/plain'
    | 'application/octet-stream';
}
/** Persist this receipt in the authorized document manifest before making an artifact discoverable. */
export interface ArtifactReceipt {
  objectVersionId: string;
  etag: string;
  ciphertextSha256: string;
  storedBytes: number;
}
export interface ReadArtifact {
  bytes: Buffer;
  metadata: ArtifactMetadata;
}
export type ArtifactSource = Uint8Array | AsyncIterable<Uint8Array>;
