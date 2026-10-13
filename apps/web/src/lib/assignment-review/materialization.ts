import type { Annotation } from '@margin/core';
import type { RequestScope, Transport } from '../assignment-work/transport';
import * as decode from './decode';
import {
  MAX_REVIEW_BYTES,
  MAX_REVIEW_CHUNK_BYTES,
  ReviewClientError,
  type ReviewSnapshot,
} from './types';

export const digestReviewBytes = async (bytes: Uint8Array<ArrayBuffer>, scope: RequestScope) =>
  [...new Uint8Array(await scope.wait(crypto.subtle.digest('SHA-256', bytes)))]
    .map((n) => n.toString(16).padStart(2, '0'))
    .join('');

/** Shared integrity boundary for teacher review and an owning student's returned capture. */
export async function readMaterializedAnnotations({
  detail,
  scope,
  transport,
  path,
  check,
  progress,
}: {
  detail: ReviewSnapshot;
  scope: RequestScope;
  transport: Transport;
  path: (index: number) => string;
  check: () => void;
  progress: (completed: number, total: number) => void;
}): Promise<Annotation[]> {
  if (detail.outputBytes > MAX_REVIEW_BYTES)
    throw new ReviewClientError(
      'review_too_large',
      'This retained submission exceeds the browser annotation limit (32 MiB). Its saved capture remains available.',
    );
  const joined = new Uint8Array(detail.outputBytes);
  const ordered: Array<{ layerOrder: number; annotation: Annotation }> = [];
  const pageIndexes = new Map(detail.pages.map((page) => [page.id, page.index]));
  const cursorOwners = new Map<number, string>();
  let lastId = '',
    entryCount = 0,
    revisions = 0,
    latestCursor = 0,
    offset = 0;
  try {
    for (const descriptor of detail.chunks) {
      check();
      const response = await transport.request(scope, path(descriptor.index), 200);
      if (
        !/^application\/json(?:\s*;\s*charset=utf-8)?\s*$/i.test(
          response.headers.get('content-type') ?? '',
        )
      ) {
        void response.body?.cancel().catch(() => {});
        decode.invalid();
      }
      const bytes = await transport.bytes(scope, response, MAX_REVIEW_CHUNK_BYTES);
      try {
        check();
        if (
          bytes.length !== descriptor.bytes ||
          (await digestReviewBytes(bytes, scope)) !== descriptor.sha256
        )
          decode.invalid();
        let text: string, value: unknown;
        try {
          text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
          value = JSON.parse(text);
        } catch {
          decode.invalid();
        }
        const chunk = decode.chunk(value, detail, descriptor.index);
        if (decode.canonical(chunk) !== text) decode.invalid();
        joined.set(bytes, offset);
        offset += bytes.length;
        for (const entry of chunk.entries) {
          if (entry.annotationId <= lastId || ++entryCount > detail.annotationCount)
            decode.invalid();
          lastId = entry.annotationId;
          revisions += entry.revision;
          latestCursor = Math.max(latestCursor, entry.latestCursor);
          for (const cursor of [
            entry.latestCursor,
            ...(entry.layerOrder === null ? [] : [entry.layerOrder]),
          ]) {
            const owner = cursorOwners.get(cursor);
            if (owner && owner !== entry.annotationId) decode.invalid();
            cursorOwners.set(cursor, entry.annotationId);
          }
          if (entry.annotation && entry.layerOrder !== null)
            ordered.push({
              layerOrder: entry.layerOrder,
              annotation: {
                ...entry.annotation,
                id: entry.annotationId,
                pageIndex: pageIndexes.get(entry.pageId)!,
                createdAt: 0,
                author: '',
              },
            });
        }
      } finally {
        bytes.fill(0);
      }
      progress(descriptor.index + 1, detail.chunks.length);
      await scope.wait(new Promise<void>((resolve) => setTimeout(resolve, 0)));
    }
    if (
      entryCount !== detail.annotationCount ||
      revisions !== detail.submission.frozenCursor ||
      latestCursor !== detail.submission.frozenCursor ||
      offset !== detail.outputBytes ||
      (await digestReviewBytes(joined, scope)) !== detail.outputSha256
    )
      decode.invalid();
    check();
    ordered.sort((a, b) => a.layerOrder - b.layerOrder);
    return ordered.map((entry) => entry.annotation);
  } finally {
    joined.fill(0);
    ordered.length = 0;
    cursorOwners.clear();
    pageIndexes.clear();
  }
}
