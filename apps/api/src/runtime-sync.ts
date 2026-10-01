import { readFile } from 'node:fs/promises';
import type { KeyManagementProvider } from './encryption.js';
import { secretFile } from './runtime-identity.js';
import { PostgresSyncService } from './sync/index.js';

/** No migration or document grants occur at startup; separate operator credentials provision them. */
export async function configuredSync(
  keyManagementProvider: KeyManagementProvider,
  authenticatedSessions: boolean,
  environment: NodeJS.ProcessEnv = process.env,
) {
  const enabled = environment.MARGIN_SYNC_ENABLED ?? 'false';
  if (enabled === 'false') return undefined;
  if (enabled !== 'true') throw new Error('MARGIN_SYNC_ENABLED must be true or false.');
  if (!authenticatedSessions)
    throw new Error('Document synchronization requires organization sessions.');
  return new PostgresSyncService({
    keyManagementProvider,
    database: {
      connectionString: await secretFile(environment, 'MARGIN_SYNC_DATABASE_URL_FILE'),
      ssl: {
        rejectUnauthorized: true,
        ...(environment.MARGIN_SYNC_DATABASE_CA_FILE
          ? { ca: await readFile(environment.MARGIN_SYNC_DATABASE_CA_FILE, 'utf8') }
          : {}),
      },
      application_name: 'margin-document-sync',
    },
  });
}
