import {
  AssignmentError,
  type AssignmentSourceCatalog,
  type AssignmentSourceCatalogPage,
} from '../assignments/types.js';
import type { SessionPrincipal } from '../identity/types.js';
import { bounded } from '../cloud/limits.js';
import { PostgresIngestionRepository } from './postgres.js';
import { IngestionError, SOURCE_CATALOG_TIMEOUT_MS, type SourceCatalogPosition } from './types.js';
import { id } from './validation.js';

/** Opaque positioning only: scope always comes from the live teacher session, never the cursor. */
function decodeCursor(after?: string): SourceCatalogPosition | undefined {
  if (after === undefined) return undefined;
  try {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(after)) throw new Error();
    const decoded = Buffer.from(after, 'base64url').toString('ascii');
    if (Buffer.from(decoded, 'ascii').toString('base64url') !== after) throw new Error();
    const parts = decoded.split(':');
    if (parts.length !== 2) throw new Error();
    return { documentId: id(parts[0]), versionId: id(parts[1]) };
  } catch {
    throw new AssignmentError(
      400,
      'invalid_source_cursor',
      'Use the cursor returned by source discovery.',
    );
  }
}

/** Metadata-only discovery. Assignment creation independently checks actual exact-object availability. */
export class IngestionAssignmentSourceCatalog implements AssignmentSourceCatalog {
  private active = 0;
  constructor(private readonly runtime: PostgresIngestionRepository) {
    if (runtime.purpose !== 'runtime')
      throw new Error('Source discovery requires dedicated runtime ingestion credentials.');
  }
  async list(
    principal: SessionPrincipal,
    after?: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<AssignmentSourceCatalogPage> {
    const position = decodeCursor(after),
      p = { ...principal };
    if (this.active >= 2)
      throw new AssignmentError(
        503,
        'source_catalog_busy',
        'Source discovery is busy. Retry shortly.',
      );
    this.active++;
    // Keep admission occupied until the underlying repository call settles, even
    // if a deadline wins while an in-flight key provider finishes its bounded call.
    let started = false;
    try {
      return await bounded(SOURCE_CATALOG_TIMEOUT_MS, options.signal, async (signal) => {
        started = true;
        try {
          const page = await this.runtime.inspectedCatalogPage(p, position, signal);
          if (signal.aborted) throw new Error('Source discovery was cancelled.');
          return {
            sources: page.sources,
            nextCursor: page.nextPosition
              ? Buffer.from(
                  `${page.nextPosition.documentId}:${page.nextPosition.versionId}`,
                ).toString('base64url')
              : null,
          };
        } finally {
          this.active--;
        }
      });
    } catch (error) {
      if (error instanceof AssignmentError) throw error;
      if (error instanceof IngestionError && [400, 403, 409].includes(error.status))
        throw new AssignmentError(error.status, error.code, error.message);
      throw new AssignmentError(
        503,
        'source_catalog_unavailable',
        'Inspected source discovery is unavailable. Retry without changing your documents.',
      );
    } finally {
      if (!started) this.active--;
    }
  }
}
