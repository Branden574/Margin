import { RequestScope, Transport } from '../assignment-work/transport';
import { AuthorClientError } from './types';

/** Raw PDF transfer with the same origin, redirect, deadline and bounded JSON rules as author requests. */
export class AuthorUploadTransport {
  private readonly responseReader: Transport;
  constructor(
    private readonly origin: string,
    private readonly fetcher: typeof fetch,
  ) {
    this.responseReader = new Transport(origin, fetcher);
  }
  async put(scope: RequestScope, id: string, content: Blob, csrfToken: string): Promise<unknown> {
    scope.check();
    const url = `${this.origin}/api/assignments/source-uploads/${id}/content`;
    const cancel = (response: Response) => {
      void response.body?.cancel().catch(() => {});
    };
    const response = await scope.wait(
      this.fetcher(url, {
        method: 'PUT',
        mode: 'same-origin',
        credentials: 'same-origin',
        cache: 'no-store',
        redirect: 'error',
        referrerPolicy: 'no-referrer',
        signal: scope.controller.signal,
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/pdf',
          'X-CSRF-Token': csrfToken,
        },
        body: content,
      }),
      cancel,
    );
    if (
      response.redirected ||
      response.url !== url ||
      !['basic', 'default'].includes(response.type)
    ) {
      cancel(response);
      throw new AuthorClientError(
        'redirect_refused',
        'The upload service returned an unexpected destination.',
      );
    }
    if (![200, 202].includes(response.status)) {
      if (response.status < 400) {
        cancel(response);
        throw new AuthorClientError(
          'invalid_response',
          'The upload service returned an unexpected status.',
        );
      }
      let code = 'upload_error';
      // Server text is deliberately not used: an intermediary can return unrelated or sensitive errors.
      try {
        const body = (await this.responseReader.json(scope, response, 16384)) as {
          error?: { code?: unknown };
        };
        if (typeof body?.error?.code === 'string' && /^[a-z][a-z0-9_]{0,79}$/.test(body.error.code))
          code = body.error.code;
      } catch {
        scope.check();
      }
      throw new AuthorClientError(
        code,
        'The upload could not be confirmed. Its encrypted recovery copy is kept.',
        response.status,
      );
    }
    return this.responseReader.json(scope, response, 16384);
  }
}
