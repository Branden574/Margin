import { afterEach, describe, expect, it } from 'vitest';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configuredIdentity } from '../apps/api/src/runtime-identity';

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'margin-identity-config-'));
  directories.push(directory);
  const secret = join(directory, 'client-secret');
  const session = join(directory, 'session-key');
  const identity = join(directory, 'identity-key');
  await Promise.all([
    writeFile(secret, 'synthetic-test-client', { mode: 0o600 }),
    writeFile(session, Buffer.alloc(32, 1).toString('base64'), { mode: 0o600 }),
    writeFile(identity, Buffer.alloc(32, 2).toString('base64'), { mode: 0o600 }),
  ]);
  return {
    secret,
    session,
    environment: {
      MARGIN_AUTH_MODE: 'oidc',
      MARGIN_APPLICATION_ORIGIN: 'https://workspace.example',
      MARGIN_OIDC_ISSUER: 'https://issuer.example',
      MARGIN_OIDC_CLIENT_ID: 'fixture',
      MARGIN_OIDC_CLIENT_SECRET_FILE: secret,
      MARGIN_SESSION_SECRET_FILE: session,
      MARGIN_IDENTITY_HMAC_KEY_FILE: identity,
    },
  };
}
describe('operator identity configuration', () => {
  it('preserves explicit local mode without reading identity secrets', async () => {
    expect(await configuredIdentity({})).toBeUndefined();
    expect(await configuredIdentity({ MARGIN_AUTH_MODE: 'local-bearer' })).toBeUndefined();
  });
  it('rejects a misspelled authentication mode instead of falling back to bearer auth', async () => {
    await expect(configuredIdentity({ MARGIN_AUTH_MODE: 'oidc-session' })).rejects.toThrow(
      'MARGIN_AUTH_MODE',
    );
  });
  it.skipIf(process.platform === 'win32')(
    'rejects a secret readable by another local account',
    async () => {
      const { secret, environment } = await fixture();
      await chmod(secret, 0o644);
      await expect(configuredIdentity(environment)).rejects.toThrow('mode 0600');
    },
  );
  it('rejects malformed key material before discovery or database connection', async () => {
    const { session, environment } = await fixture();
    await writeFile(session, 'not-a-secret-key');
    await expect(configuredIdentity(environment)).rejects.toThrow('32-byte');
  });
  it('rejects empty client credentials before discovery', async () => {
    const { secret, environment } = await fixture();
    await writeFile(secret, '\n');
    await expect(configuredIdentity(environment)).rejects.toThrow('nonempty secret');
  });
});
