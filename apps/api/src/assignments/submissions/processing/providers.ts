import type { KeyManagementProvider } from '../../../encryption.js';
import { SubmissionProcessingError } from './types.js';

/** Counts supplied provider promises until they actually settle, including after caller deadlines.
 * Provider-internal detached transports are outside this boundary and require adapter-level limits. */
export class SubmissionProviderAdmission {
  private pending = 0;
  private closed = false;
  assertAvailable() {
    if (this.closed || this.pending >= 2) throw new SubmissionProcessingError('processor_busy');
  }
  close() {
    this.closed = true;
  }
  run<T>(invoke: () => Promise<T>): Promise<T> {
    this.assertAvailable();
    this.pending++;
    let raw: Promise<T>;
    try {
      raw = invoke();
    } catch (error) {
      this.pending--;
      return Promise.reject(error);
    }
    return Promise.resolve(raw).finally(() => {
      this.pending--;
    });
  }
  keys(provider: KeyManagementProvider): KeyManagementProvider {
    return {
      // Preserve the caller's deadline cleanup: a timed-out wrap may finish only with
      // a cleared input, and its result is discarded by the encryption helper.
      wrapKey: (key, context) => this.run(() => provider.wrapKey(key, context)),
      unwrapKey: (envelope, context) => this.run(() => provider.unwrapKey(envelope, context)),
    };
  }
}
