import { readFile } from 'node:fs/promises';
import { PostgresLmsRepository } from './lms/index.js';
import { secretFile } from './runtime-identity.js';

/** Enables only explicitly provisioned installations; never discovers or creates a tenant. */
export async function configuredLmsRepository(
  authenticatedSessions: boolean,
  environment: NodeJS.ProcessEnv = process.env,
) {
  const enabled = environment.MARGIN_LMS_ENABLED ?? 'false';
  if (enabled === 'false') return undefined;
  if (enabled !== 'true') throw new Error('MARGIN_LMS_ENABLED must be true or false.');
  if (!authenticatedSessions) throw new Error('Canvas launches require organization sessions.');
  const encoded = await secretFile(environment, 'MARGIN_LMS_LOOKUP_KEY_FILE');
  const key = Buffer.from(encoded, 'base64');
  if (key.length !== 32 || key.toString('base64') !== encoded)
    throw new Error(
      'MARGIN_LMS_LOOKUP_KEY_FILE must contain a canonical base64-encoded 32-byte secret.',
    );
  try {
    return new PostgresLmsRepository(
      {
        connectionString: await secretFile(environment, 'MARGIN_LMS_DATABASE_URL_FILE'),
        ssl: {
          rejectUnauthorized: true,
          ...(environment.MARGIN_LMS_DATABASE_CA_FILE
            ? { ca: await readFile(environment.MARGIN_LMS_DATABASE_CA_FILE, 'utf8') }
            : {}),
        },
        application_name: 'margin-canvas-lms',
      },
      key,
    );
  } finally {
    key.fill(0);
  }
}
