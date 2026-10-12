import { createHash } from 'node:crypto';
import { canonical } from '../sync/validation.js';
import { PostgresIngestionRepository } from './postgres.js';
import {
  IngestionError,
  type ArtifactReader,
  type SourceScanner,
  type InspectionClaim,
  type InspectionReport,
  type InspectionReceipt,
} from './types.js';
import { report } from './validation.js';

function interrupted() {
  return new IngestionError(503, 'operation_aborted', 'Source inspection was interrupted.');
}
function check(signal: AbortSignal) {
  if (signal.aborted) throw interrupted();
}

/** One execution slot. Caller deadlines do not release real work, plaintext or shutdown admission. */
export class SourceInspectionWorker {
  private readonly stopping = new AbortController();
  private active: Promise<void> | undefined;
  private closing: Promise<void> | undefined;

  constructor(
    private readonly repository: PostgresIngestionRepository,
    private readonly storage: ArtifactReader,
    private readonly scanner: SourceScanner,
  ) {
    if (repository.purpose !== 'inspector')
      throw new Error('Use dedicated inspection credentials.');
  }

  runOne(external?: AbortSignal): Promise<InspectionReceipt | null> {
    if (this.stopping.signal.aborted)
      return Promise.reject(
        new IngestionError(503, 'inspection_closed', 'The inspection worker is closed.'),
      );
    if (this.active)
      return Promise.reject(
        new IngestionError(503, 'inspection_busy', 'The inspection worker is already active.'),
      );
    if (external?.aborted) return Promise.reject(interrupted());
    const deadline = new AbortController();
    const signal = AbortSignal.any([
      this.stopping.signal,
      deadline.signal,
      ...(external ? [external] : []),
    ]);
    let resolve!: (value: InspectionReceipt | null) => void;
    let reject!: (error: unknown) => void;
    const caller = new Promise<InspectionReceipt | null>((done, fail) => {
      resolve = done;
      reject = fail;
    });
    const abort = () => reject(interrupted());
    signal.addEventListener('abort', abort, { once: true });
    const release = () => {
      signal.removeEventListener('abort', abort);
      this.active = undefined;
    };
    // Keep the actual job separate from the caller's early cancellation result. It owns every
    // claim/storage/scanner/completion/retry promise until settlement and clears its own plaintext.
    this.active = Promise.resolve()
      .then(() => this.execute(signal, () => deadline.abort(), reject))
      .then(
        (value) => {
          release();
          resolve(value);
        },
        (error) => {
          release();
          reject(error);
        },
      );
    return caller;
  }

  /** Scheduler boundary: retain serial admission through late transport, inspection and retry cleanup. */
  async runOneAndDrain(external?: AbortSignal): Promise<InspectionReceipt | null> {
    try {
      return await this.runOne(external);
    } finally {
      await this.active;
    }
  }

  /** Borrowed repository, storage and scanner remain owned by the composition root. */
  close(): Promise<void> {
    this.stopping.abort();
    return (this.closing ??= Promise.resolve().then(async () => {
      await this.active;
    }));
  }

  private async execute(
    signal: AbortSignal,
    timeout: () => void,
    failCaller: (error: unknown) => void,
  ): Promise<InspectionReceipt | null> {
    // The timer aborts the caller and signals cooperative work. Awaiting the original promise
    // still matters: transports and subprocess providers are allowed to ignore cancellation.
    const phase = async <T>(milliseconds: number, work: () => Promise<T>): Promise<T> => {
      check(signal);
      const timer = setTimeout(timeout, milliseconds);
      timer.unref();
      try {
        return await work();
      } finally {
        clearTimeout(timer);
      }
    };
    let claim: InspectionClaim | null = null;
    let bytes: Buffer | undefined;
    let completed = false;
    try {
      await phase(10000, () => this.scanner.ready?.(signal) ?? Promise.resolve());
      check(signal);
      claim = await phase(15000, () => this.repository.claimNext());
      check(signal);
      if (!claim) return null;
      const recovered = await phase(20000, () =>
        this.storage.get(claim!.identity, claim!.receipt, signal),
      );
      bytes = recovered.bytes;
      check(signal);
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
        const scanned = await phase(45000, () => this.scanner.inspect(bytes!, signal));
        check(signal);
        if (createHash('sha256').update(bytes).digest('hex') !== sha)
          throw new IngestionError(
            409,
            'scanner_mutated_source',
            'The inspection engine changed its source bytes.',
          );
        result = report({ ...scanned, ...observed });
      }
      // No provider holds the plaintext now. Do not retain it during database completion/retry.
      bytes.fill(0);
      bytes = undefined;
      check(signal);
      const receipt = await phase(15000, () => this.repository.complete(claim!, result));
      completed = true;
      check(signal);
      return receipt;
    } catch (error) {
      // Any uncooperative scanner has settled before this path can wipe its borrowed bytes.
      bytes?.fill(0);
      bytes = undefined;
      if (claim && !completed) {
        failCaller(error);
        try {
          await this.repository.retry(claim, Math.min(3600, 15 * 2 ** Math.min(claim.attempt, 8)));
        } catch {
          // Unknown completion, expired or revoked claims are resolved by existing queue guards.
          // Never replay approval or overwrite an already committed inspection decision.
        }
      }
      throw error;
    } finally {
      bytes?.fill(0);
    }
  }
}
