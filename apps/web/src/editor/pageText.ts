import { PermissionFlag, type PDFDocumentProxy, type PDFPageProxy } from 'pdfjs-dist';
import type { TextContent } from 'pdfjs-dist/types/src/display/api';

export const PAGE_TEXT_MAX_CHARACTERS = 200_000;
export const PAGE_TEXT_MAX_ITEMS = 20_000;
export const PAGE_TEXT_TIMEOUT_MS = 20_000;
const MAX_CHUNKS = 20_000;
const MAX_EMPTY_CHUNKS = 100;
export interface PageTextResult {
  text: string;
  canCopy: boolean;
}
export class PageTextError extends Error {
  constructor(
    public readonly code: 'permission_denied' | 'text_limit' | 'text_timeout' | 'text_unavailable',
    message: string,
  ) {
    super(message);
    this.name = 'PageTextError';
  }
}
const cancelled = () => new DOMException('Page text reading was cancelled.', 'AbortError');
/** Streams one page in worker order. Never return partial text on a limit, failure, or cancellation. */
export async function readPageText(
  pdf: PDFDocumentProxy,
  pageIndex: number,
  options: {
    signal?: AbortSignal;
    /** Search can release page render objects. PDF.js defers cleanup while rendering is active. */
    cleanup?: boolean;
  } = {},
): Promise<PageTextResult> {
  if (!Number.isSafeInteger(pageIndex) || pageIndex < 0 || pageIndex >= pdf.numPages)
    throw new PageTextError('text_unavailable', 'This page is unavailable.');
  if (options.signal?.aborted) throw cancelled();
  let reader: ReadableStreamDefaultReader<TextContent> | undefined;
  let acquiredPage: PDFPageProxy | undefined;
  const cleanupPage = () => {
    if (!options.cleanup || !acquiredPage) return;
    const page = acquiredPage;
    acquiredPage = undefined;
    try {
      page.cleanup();
    } catch {
      /* Cache cleanup must not mask an extraction result or cancellation. */
    }
  };
  let stopped: Error | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let rejectStop!: (reason: Error) => void;
  const interruption = new Promise<never>((_, reject) => {
    rejectStop = reject;
  });
  let readerCancelled = false;
  const cancelReader = () => {
    if (!reader || readerCancelled) return;
    readerCancelled = true;
    try {
      void reader.cancel(stopped).catch(() => {});
    } catch {
      /* Preserve the extraction error. */
    }
  };
  const releaseReader = () => {
    try {
      reader?.releaseLock();
      reader = undefined;
    } catch {
      /* Retry once the pending read settles. */
    }
  };
  const wait = <T>(value: Promise<T>): Promise<T> => Promise.race([value, interruption]);
  const stop = (reason: Error) => {
    if (stopped) return;
    stopped = reason;
    cancelReader();
    rejectStop(reason);
  };
  const onAbort = () => stop(cancelled());
  const ensureCurrent = () => {
    if (stopped) throw stopped;
  };
  options.signal?.addEventListener('abort', onAbort, { once: true });
  timer = setTimeout(
    () =>
      stop(
        new PageTextError(
          'text_timeout',
          'Reading this page took too long. Try another page or reopen the document.',
        ),
      ),
    PAGE_TEXT_TIMEOUT_MS,
  );
  const work = (async () => {
    const permissions = await wait(pdf.getPermissions());
    ensureCurrent();
    const canCopy = permissions === null || permissions.has(PermissionFlag.COPY);
    if (!canCopy && !permissions?.has(PermissionFlag.COPY_FOR_ACCESSIBILITY))
      throw new PageTextError(
        'permission_denied',
        'This PDF does not allow copying or accessibility text extraction.',
      );
    const page = await wait(
      pdf.getPage(pageIndex + 1).then((value) => {
        acquiredPage = value;
        // A cancelled getPage RPC may settle after our outer finally already ran.
        if (stopped) cleanupPage();
        return value;
      }),
    );
    ensureCurrent();
    // Do not aggregate styles, font dictionaries, or every page's text in the UI thread.
    reader = (
      page.streamTextContent({
        includeMarkedContent: false,
        disableNormalization: false,
      }) as ReadableStream<TextContent>
    ).getReader();
    const parts: string[] = [];
    let characters = 0,
      items = 0,
      chunks = 0,
      empty = 0;
    try {
      while (true) {
        ensureCurrent();
        const chunk = await wait(reader.read());
        ensureCurrent();
        if (chunk.done) break;
        if (++chunks > MAX_CHUNKS || !Array.isArray(chunk.value?.items))
          throw new PageTextError(
            'text_limit',
            'This page exceeds the supported reading text limits.',
          );
        if (chunk.value.items.length === 0) {
          if (++empty > MAX_EMPTY_CHUNKS)
            throw new PageTextError(
              'text_limit',
              'This page exceeds the supported reading text limits.',
            );
        } else empty = 0;
        items += chunk.value.items.length;
        if (items > PAGE_TEXT_MAX_ITEMS)
          throw new PageTextError(
            'text_limit',
            'This page has too many text fragments to read safely.',
          );
        for (const item of chunk.value.items) {
          if (!('str' in item)) continue;
          if (typeof item.str !== 'string')
            throw new PageTextError('text_unavailable', 'This page contains invalid text data.');
          const separator = item.hasEOL ? '\n' : ' ';
          // Count the exact final string, including separators, before retaining another fragment.
          characters += item.str.length + separator.length;
          if (characters > PAGE_TEXT_MAX_CHARACTERS)
            throw new PageTextError(
              'text_limit',
              'This page contains more text than the reading view supports.',
            );
          parts.push(item.str, separator);
        }
        // A ready stream can otherwise starve timers/AbortSignal delivery through microtasks.
        if (chunks % 32 === 0) {
          await new Promise((resolve) => setTimeout(resolve, 0));
          ensureCurrent();
        }
      }
      return { text: parts.join(''), canCopy };
    } catch (error) {
      stopped = error instanceof Error ? error : new Error('Text extraction failed.');
      cancelReader();
      throw error;
    } finally {
      parts.length = 0;
      releaseReader();
    }
  })();
  try {
    return await Promise.race([work, interruption]);
  } catch (error) {
    stopped = error instanceof Error ? error : new Error('Text extraction failed.');
    cancelReader();
    if (stopped.name === 'AbortError' || stopped instanceof PageTextError) throw stopped;
    throw new PageTextError(
      'text_unavailable',
      'Page text could not be read. Try another page or reopen the document.',
    );
  } finally {
    if (timer) clearTimeout(timer);
    options.signal?.removeEventListener('abort', onAbort);
    releaseReader();
    cleanupPage();
  }
}
