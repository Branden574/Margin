import { AssignmentWorkClientError, MAX_JSON_BYTES } from './types';

const fail = (code: string, message: string) => new AssignmentWorkClientError(code, message);
const cancel = (response: Response) => {
  void response.body?.cancel().catch(() => {});
};

/** One deadline spans headers, every body chunk, and any session checks in the call. */
export class RequestScope {
  readonly controller = new AbortController();
  private readonly timer: ReturnType<typeof setTimeout>;
  private readonly externalAbort = () =>
    this.controller.abort(fail('cancelled', 'The assignment request was cancelled.'));
  constructor(
    timeout: number,
    private readonly external?: AbortSignal,
  ) {
    this.timer = setTimeout(
      () => this.controller.abort(fail('timeout', 'The assignment request exceeded its deadline.')),
      timeout,
    );
    external?.addEventListener('abort', this.externalAbort, { once: true });
    if (external?.aborted) this.externalAbort();
  }
  check() {
    if (this.controller.signal.aborted) throw this.controller.signal.reason;
  }
  close() {
    clearTimeout(this.timer);
    this.external?.removeEventListener('abort', this.externalAbort);
  }
  async wait<T>(work: Promise<T>, late?: (value: T) => void): Promise<T> {
    if (this.controller.signal.aborted) {
      void work.then((value) => late?.(value)).catch(() => {});
      this.check();
    }
    let abort!: () => void;
    const interrupted = new Promise<never>((_, reject) => {
      abort = () => reject(this.controller.signal.reason);
      this.controller.signal.addEventListener('abort', abort, { once: true });
    });
    try {
      return await Promise.race([
        work.then((value) => {
          if (this.controller.signal.aborted) {
            late?.(value);
            this.check();
          }
          return value;
        }),
        interrupted,
      ]);
    } finally {
      this.controller.signal.removeEventListener('abort', abort);
    }
  }
}

export class Transport {
  constructor(
    private readonly origin: string,
    private readonly fetcher: typeof fetch,
  ) {}
  async request(
    scope: RequestScope,
    path: string,
    expectedStatus: number | readonly number[],
    body?: string,
    csrf?: string,
  ) {
    scope.check();
    const url = `${this.origin}${path}`;
    const response = await scope.wait(
      this.fetcher(url, {
        method: body === undefined ? 'GET' : 'POST',
        mode: 'same-origin',
        credentials: 'same-origin',
        cache: 'no-store',
        redirect: 'error',
        referrerPolicy: 'no-referrer',
        signal: scope.controller.signal,
        headers: {
          Accept: path.endsWith('/source') ? 'application/pdf' : 'application/json',
          ...(body === undefined
            ? {}
            : { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf! }),
        },
        ...(body === undefined ? {} : { body }),
      }),
      cancel,
    );
    if (
      response.redirected ||
      response.url !== url ||
      !['basic', 'default'].includes(response.type)
    ) {
      cancel(response);
      throw fail('redirect_refused', 'The assignment service returned an unexpected destination.');
    }
    if (
      !(typeof expectedStatus === 'number' ? [expectedStatus] : expectedStatus).includes(
        response.status,
      )
    ) {
      if (response.status >= 300 && response.status < 400) {
        cancel(response);
        throw fail('redirect_refused', 'Assignment redirects are not followed.');
      }
      if (response.status < 400) {
        cancel(response);
        throw fail('invalid_response', 'The assignment service returned an unexpected status.');
      }
      let code = 'http_error',
        message = 'The assignment service could not complete the request.';
      try {
        const value = (await this.json(scope, response, 16_384)) as {
          error?: { code?: unknown; message?: unknown };
        };
        if (
          value?.error &&
          typeof value.error.code === 'string' &&
          /^[a-z][a-z0-9_]{0,79}$/.test(value.error.code)
        )
          code = value.error.code;
        if (
          typeof value?.error?.message === 'string' &&
          value.error.message.length <= 500 &&
          !/[\u0000-\u001f]/.test(value.error.message)
        )
          message = value.error.message;
      } catch {
        scope.check();
      }
      throw new AssignmentWorkClientError(code, message, response.status);
    }
    return response;
  }
  async bytes(
    scope: RequestScope,
    response: Response,
    maximum: number,
  ): Promise<Uint8Array<ArrayBuffer>> {
    const length = response.headers.get('content-length');
    if (
      length !== null &&
      (!/^(0|[1-9][0-9]*)$/.test(length) ||
        !Number.isSafeInteger(Number(length)) ||
        Number(length) > maximum)
    ) {
      cancel(response);
      throw fail('response_too_large', 'The assignment response exceeds its size limit.');
    }
    if (!response.body) throw fail('invalid_response', 'The assignment response has no body.');
    const reader = response.body.getReader(),
      chunks: Uint8Array<ArrayBuffer>[] = [];
    const abort = () => {
      void reader.cancel().catch(() => {});
    };
    scope.controller.signal.addEventListener('abort', abort, { once: true });
    let size = 0,
      count = 0,
      empty = 0,
      complete = false;
    try {
      while (true) {
        scope.check();
        const next = await scope.wait(reader.read(), (late) => late.value?.fill(0));
        scope.check();
        if (next.done) {
          complete = true;
          break;
        }
        if (
          !(next.value instanceof Uint8Array) ||
          ++count > 65_536 ||
          (next.value.length === 0 && ++empty > 1024)
        )
          throw fail('invalid_response', 'The assignment response stream is invalid.');
        size += next.value.byteLength;
        if (size > maximum)
          throw fail('response_too_large', 'The assignment response exceeds its size limit.');
        chunks.push(new Uint8Array(next.value));
        if (count % 64 === 0)
          await scope.wait(new Promise<void>((resolve) => setTimeout(resolve, 0)));
      }
      // Content-Length can describe compressed transfer bytes; enforce exact size only for identity encoding.
      const encoding = response.headers.get('content-encoding');
      if (length !== null && (!encoding || encoding === 'identity') && Number(length) !== size)
        throw fail('invalid_response', 'The assignment response ended before its declared length.');
      const joined = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        joined.set(chunk, offset);
        offset += chunk.length;
      }
      return joined;
    } finally {
      scope.controller.signal.removeEventListener('abort', abort);
      if (!complete) abort();
      for (const chunk of chunks) chunk.fill(0);
      try {
        reader.releaseLock();
      } catch {
        /* An abort-ignoring reader can still have a pending read. */
      }
    }
  }
  async json(scope: RequestScope, response: Response, maximum = MAX_JSON_BYTES): Promise<unknown> {
    if (
      !/^application\/json(?:\s*;\s*charset=utf-8)?\s*$/i.test(
        response.headers.get('content-type') ?? '',
      )
    ) {
      cancel(response);
      throw fail('invalid_response', 'The assignment service did not return JSON.');
    }
    const bytes = await this.bytes(scope, response, maximum);
    try {
      return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    } catch {
      throw fail('invalid_response', 'The assignment service returned invalid JSON.');
    } finally {
      bytes.fill(0);
    }
  }
}
