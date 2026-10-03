import { createHash } from 'node:crypto';
import { bounded } from '../cloud/limits.js';
import { canonical } from '../sync/validation.js';
import { PostgresIngestionRepository } from './postgres.js';
import {
  IngestionError,
  type ArtifactReader,
  type SourceScanner,
  type InspectionReport,
  type InspectionReceipt,
} from './types.js';
import { report } from './validation.js';
/** One local execution slot; process-wide scheduler/isolated scanner deployment remains a composition responsibility. */
export class SourceInspectionWorker {
  private busy = false;
  private running = false;
  private pending = new Set<Promise<unknown>>();
  private track<T>(work: Promise<T>): Promise<T> {
    this.pending.add(work);
    const settled = () => {
      this.pending.delete(work);
      if (!this.running && this.pending.size === 0) this.busy = false;
    };
    void work.then(settled, settled);
    return work;
  }
  constructor(
    private readonly repository: PostgresIngestionRepository,
    private readonly storage: ArtifactReader,
    private readonly scanner: SourceScanner,
  ) {
    if (repository.purpose !== 'inspector')
      throw new Error('Use dedicated inspection credentials.');
  }
  async runOne(): Promise<InspectionReceipt | null> {
    if (this.busy)
      throw new IngestionError(503, 'inspection_busy', 'The inspection worker is already active.');
    this.busy = true;
    this.running = true;
    let bytes: Buffer | undefined;
    try {
      const claim = await this.repository.claimNext();
      if (!claim) return null;
      try {
        const recovered = await bounded(
          20000,
          undefined,
          (signal) => this.track(this.storage.get(claim.identity, claim.receipt, signal)),
          (late) => late.bytes.fill(0),
        );
        bytes = recovered.bytes;
        if (bytes.length < 1 || bytes.length > 100 * 1024 * 1024)
          throw new IngestionError(
            413,
            'inspection_bytes',
            'Source bytes exceed the inspection bound.',
          );
        const sha = createHash('sha256').update(bytes).digest('hex');
        const observed = { plaintextSha256: sha, plaintextBytes: bytes.length };
        let result: InspectionReport;
        if (
          sha !== claim.expected.plaintextSha256 ||
          bytes.length !== claim.expected.plaintextBytes ||
          canonical(recovered.metadata) !== canonical(claim.expected.metadata)
        ) {
          result = {
            ...observed,
            verdict: 'rejected',
            engine: 'margin-integrity',
            engineVersion: '1',
            definitionsVersion: 'none',
            reason: 'content_mismatch',
            pageCount: 0,
          };
        } else {
          const scanned = await bounded(45000, undefined, (signal) =>
            this.track(this.scanner.inspect(bytes!, signal)),
          );
          if (createHash('sha256').update(bytes).digest('hex') !== sha)
            throw new IngestionError(
              409,
              'scanner_mutated_source',
              'The inspection engine changed its source bytes.',
            );
          result = report({ ...scanned, ...observed });
        }
        return await this.repository.complete(claim, result);
      } catch (error) {
        // Unknown storage/scanner outcome stays quarantined. No approval is fabricated.
        try {
          await this.repository.retry(claim, Math.min(3600, 15 * 2 ** Math.min(claim.attempt, 8)));
        } catch {
          /* Expired/revoked claims remain unavailable and can be reclaimed only by the queue rules. */
        }
        throw error;
      }
    } finally {
      bytes?.fill(0);
      this.running = false;
      if (this.pending.size === 0) this.busy = false;
    }
  }
}
