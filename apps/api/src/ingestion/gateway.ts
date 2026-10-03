import { createHash } from 'node:crypto';
import type { AssignmentSourceGateway, ReadyAssignmentSource } from '../assignments/types.js';
import type { SessionPrincipal } from '../identity/types.js';
import { bounded } from '../cloud/limits.js';
import { canonical } from '../sync/validation.js';
import { PostgresIngestionRepository, type ReadyManifest } from './postgres.js';
import type { ArtifactReader } from './types.js';
/** The supplied storage reader must authenticate the exact pinned S3 version, never HEAD/latest. */
export class IngestionAssignmentSourceGateway implements AssignmentSourceGateway {
  constructor(
    private readonly runtime: PostgresIngestionRepository,
    private readonly reader: PostgresIngestionRepository,
    private readonly storage: ArtifactReader,
  ) {
    if (runtime.purpose !== 'runtime' || reader.purpose !== 'reader')
      throw new Error('Use separate runtime and readiness-reader ingestion credentials.');
  }
  private async objectAvailable(manifest: ReadyManifest) {
    let bytes: Buffer | undefined;
    try {
      const result = await bounded(
        20000,
        undefined,
        (signal) => this.storage.get(manifest.identity, manifest.receipt, signal),
        (late) => late.bytes.fill(0),
      );
      bytes = result.bytes;
      return (
        bytes.length >= 1 &&
        bytes.length <= 100 * 1024 * 1024 &&
        result.metadata.mimeType === 'application/pdf' &&
        createHash('sha256').update(bytes).digest('hex') === manifest.source.sha256
      );
    } catch {
      return false;
    } finally {
      bytes?.fill(0);
    }
  }
  async resolveForTeacher(
    principal: SessionPrincipal,
    reference: { documentId: string; versionId: string },
  ): Promise<ReadyAssignmentSource | null> {
    const before = await this.runtime.readyForTeacher(principal, reference);
    if (!before || !(await this.objectAvailable(before))) return null;
    // Recheck current session/course/document authority after the remote read.
    const after = await this.runtime.readyForTeacher(principal, reference);
    return after && canonical(after) === canonical(before) ? after.source : null;
  }
  /** Perform object I/O before a caller's database transaction; consume the returned gate only once inside it. */
  async prepareAvailability(
    source: ReadyAssignmentSource,
  ): Promise<((candidate: ReadyAssignmentSource) => Promise<boolean>) | null> {
    const snapshot = structuredClone(source),
      before = await this.reader.readySnapshot(snapshot);
    if (!before || !(await this.objectAvailable(before))) return null;
    const after = await this.reader.readySnapshot(snapshot);
    if (!after || canonical(after) !== canonical(before)) return null;
    const expires = Date.now() + 10000;
    let used = false;
    return async (candidate) => {
      if (used) return false;
      used = true;
      if (Date.now() >= expires || canonical(candidate) !== canonical(snapshot)) return false;
      try {
        return await bounded(1000, undefined, () =>
          this.reader.recheckApproval(snapshot, after.stateToken),
        );
      } catch {
        return false;
      }
    };
  }
  async stillAvailable(source: ReadyAssignmentSource): Promise<boolean> {
    const before = await this.reader.readySnapshot(source);
    if (!before || !(await this.objectAvailable(before))) return false;
    const after = await this.reader.readySnapshot(source);
    return after !== null && canonical(after) === canonical(before);
  }
}
