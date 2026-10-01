import { open, readFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import {
  createIdentityService,
  PostgresIdentityRepository,
  type IdentityConfig,
  type IdentityFederation,
} from './identity/index.js';

function required(environment: NodeJS.ProcessEnv, name: string): string {
  const value = environment[name]?.trim();
  if (!value) throw new Error(`Required identity configuration is missing: ${name}.`);
  return value;
}
export async function secretFile(environment: NodeJS.ProcessEnv, name: string): Promise<string> {
  const path = required(environment, name);
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size > 8192 || metadata.size === 0)
      throw new Error(`${name} must reference a bounded nonempty secret file.`);
    if (process.platform !== 'win32' && (metadata.mode & 0o077) !== 0)
      throw new Error(`${name} must be accessible only to the service account (mode 0600).`);
    const buffer = Buffer.alloc(8193);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead === buffer.length) throw new Error(`${name} exceeds its secret size limit.`);
    const value = buffer.toString('utf8', 0, bytesRead).trim();
    buffer.fill(0);
    if (!value) throw new Error(`${name} must contain a nonempty secret.`);
    return value;
  } finally {
    await handle.close();
  }
}
function key(value: string, label: string): Buffer {
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length !== 32 || bytes.toString('base64') !== value)
    throw new Error(`${label} must contain a canonical base64-encoded 32-byte secret.`);
  return bytes;
}

/** Loads operator-configured OIDC credentials; does not create accounts or migrate databases. */
export async function configuredIdentity(
  environment: NodeJS.ProcessEnv = process.env,
  federation?: IdentityFederation,
) {
  const mode = environment.MARGIN_AUTH_MODE ?? 'local-bearer';
  if (mode === 'local-bearer') return undefined;
  if (mode !== 'oidc') throw new Error('MARGIN_AUTH_MODE must be local-bearer or oidc.');
  const [clientSecret, sessionSecret, identityHmacKey] = await Promise.all([
    secretFile(environment, 'MARGIN_OIDC_CLIENT_SECRET_FILE'),
    secretFile(environment, 'MARGIN_SESSION_SECRET_FILE'),
    secretFile(environment, 'MARGIN_IDENTITY_HMAC_KEY_FILE'),
  ]);
  const applicationOrigin = required(environment, 'MARGIN_APPLICATION_ORIGIN');
  const config: IdentityConfig = {
    issuerUrl: required(environment, 'MARGIN_OIDC_ISSUER'),
    clientId: required(environment, 'MARGIN_OIDC_CLIENT_ID'),
    clientSecret,
    applicationOrigin,
    redirectUri: `${applicationOrigin}/api/auth/callback`,
    sessionSecret: key(sessionSecret, 'MARGIN_SESSION_SECRET_FILE'),
    identityHmacKey: key(identityHmacKey, 'MARGIN_IDENTITY_HMAC_KEY_FILE'),
    allowedReturnPaths: ['/'],
    mfaAcrValues: environment.MARGIN_OIDC_MFA_ACR_VALUES?.split(',')
      .map((value) => value.trim())
      .filter(Boolean),
    allowedProviderOrigins: environment.MARGIN_OIDC_PROVIDER_ORIGINS?.split(',')
      .map((value) => value.trim())
      .filter(Boolean),
  };
  const repository = new PostgresIdentityRepository({
    connectionString: await secretFile(environment, 'MARGIN_IDENTITY_DATABASE_URL_FILE'),
    ssl: {
      rejectUnauthorized: true,
      ...(environment.MARGIN_IDENTITY_DATABASE_CA_FILE
        ? { ca: await readFile(environment.MARGIN_IDENTITY_DATABASE_CA_FILE, 'utf8') }
        : {}),
    },
    application_name: 'margin-identity',
  });
  try {
    return {
      service: await createIdentityService(config, repository, {}, federation),
      close: () => repository.close(),
    };
  } catch (error) {
    await repository.close();
    throw error;
  }
}
