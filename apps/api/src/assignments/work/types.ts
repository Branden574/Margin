import type { SessionPrincipal } from '../../identity/types.js';
import type { AppendReceipt, CatchUpResult, DocumentDescription } from '../../sync/types.js';
import type { AssignmentPolicy } from '../types.js';
export interface WorkRequestOptions {
  signal?: AbortSignal;
}
export interface WorkManifest {
  assignment: { id: string; title: string; instructions: string; policy: AssignmentPolicy };
  work:
    | null
    | { id: string; status: 'pending' }
    | { id: string; status: 'provisioned'; document: DocumentDescription };
}
/** No artifact IDs, teacher IDs, key material, object URLs or worker claims cross this contract. */
export interface AssignmentWorkService {
  describe(principal: SessionPrincipal, options?: WorkRequestOptions): Promise<WorkManifest>;
  /** Caller owns the plaintext buffer and must dispose it after response finish/close. */
  source(principal: SessionPrincipal, options?: WorkRequestOptions): Promise<Buffer>;
  append(
    principal: SessionPrincipal,
    value: unknown,
    options?: WorkRequestOptions,
  ): Promise<AppendReceipt>;
  catchUp(
    principal: SessionPrincipal,
    input: { afterCursor?: number; limit?: number },
    options?: WorkRequestOptions,
  ): Promise<CatchUpResult>;
}
