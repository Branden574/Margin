import { existsSync, chmodSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { ensureLocalTls } from './local-tls.mjs';
const root = resolve(import.meta.dirname, '..');
const dir = resolve(root, '.local/tls');
const { keyPath: key, certPath: cert, action, backupDirectory } = ensureLocalTls(dir);
const env = resolve(root, '.local/api.env');
if (!existsSync(env)) {
  writeFileSync(
    env,
    [
      `MARGIN_MASTER_KEY=${randomBytes(32).toString('base64')}`,
      `MARGIN_API_TOKEN=${randomBytes(32).toString('base64url')}`,
      `MARGIN_TLS_KEY_FILE=${key}`,
      `MARGIN_TLS_CERT_FILE=${cert}`,
      'MARGIN_USER_ID=local-user',
      'MARGIN_TENANT_ID=local-workspace',
    ].join('\n') + '\n',
    { mode: 0o600 },
  );
}
chmodSync(env, 0o600);
process.stdout.write(
  `Local HTTPS server certificate ${action}; private API configuration is ready in .local/. Secrets were not printed.\n${backupDirectory ? `The previous certificate files were preserved in ${backupDirectory}.\n` : ''}Operating-system trust was not changed. On macOS, run npm run trust:dev to explicitly trust this local development certificate. See docs/LOCAL_SECURITY.md.\n`,
);
