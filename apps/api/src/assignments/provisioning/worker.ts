import type { PostgresIngestionRepository } from '../../ingestion/postgres.js';
import type { ArtifactReader } from '../../ingestion/types.js';
import { PostgresStudentWorkProvisioner } from './postgres.js';
import { StudentWorkError, type StudentWorkCompletion } from './types.js';
/** Explicitly invoked worker. Provider wiring and scheduling are intentionally external. */
export class StudentWorkProvisioningWorker {
  private running = false;
  constructor(
    private readonly repository: PostgresStudentWorkProvisioner,
    private readonly reader: PostgresIngestionRepository,
    private readonly storage: ArtifactReader,
  ) {}
  async runOne(signal?: AbortSignal): Promise<StudentWorkCompletion | null> {
    if (this.running)
      throw new StudentWorkError('worker_busy', 'This worker already has an active job.');
    if (signal?.aborted)
      throw new StudentWorkError('worker_cancelled', 'The worker was cancelled.');
    this.running = true;
    try {
      const claim = await this.repository.claimNext();
      if (!claim) return null;
      try {
        const prepared = await this.repository.prepare(claim, this.reader, this.storage, signal);
        return await this.repository.completePrepared(claim, prepared, signal);
      } catch (error) {
        // COMMIT acknowledgement can be lost. Only the durable receipt reconciles success.
        const completed = await this.repository.receipt(claim).catch(() => null);
        if (completed) return completed;
        await this.repository
          .retry(claim, Math.min(3600, 30 * 2 ** (claim.attempt - 1)))
          .catch(() => {});
        throw error;
      }
    } finally {
      this.running = false;
    }
  }
}
