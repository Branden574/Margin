import type { ProcessingFailureCode } from './types.js';
/** Only precise non-transient evidence becomes terminal immediately. Authentication helpers
 * can conflate provider outages and invalid envelopes; those conservatively use bounded retries. */
export function terminalProcessingFailure(error: unknown): ProcessingFailureCode | null {
  const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
  if (code === 'authority_revoked') return 'authority_revoked';
  if (code === 'source_changed') return 'source_unavailable';
  if (
    [
      'snapshot_invalid',
      'source_content_mismatch',
      'operation_prefix_invalid',
      'encrypted_operation_unavailable',
      'materialization_batch_invalid',
      'materialization_chunk_invalid',
      'materialization_summary_mismatch',
      'materialization_limit',
      'materialization_manifest_limit',
      'staged_chunks_changed',
      'chunk_conflict',
    ].includes(String(code))
  )
    return 'snapshot_invalid';
  return null;
}
