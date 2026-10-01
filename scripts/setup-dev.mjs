import { mkdirSync, existsSync, chmodSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
const root = resolve(import.meta.dirname, '..');
const dir = resolve(root, '.local/tls');
mkdirSync(dir, { recursive: true, mode: 0o700 });
const key = resolve(dir, 'key.pem'),
  cert = resolve(dir, 'cert.pem');
if (!existsSync(key) || !existsSync(cert)) {
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:3072',
      '-nodes',
      '-keyout',
      key,
      '-out',
      cert,
      '-days',
      '30',
      '-subj',
      '/CN=localhost',
      '-addext',
      'subjectAltName=DNS:localhost,IP:127.0.0.1,IP:::1',
    ],
    { stdio: 'pipe' },
  );
  chmodSync(key, 0o600);
  chmodSync(cert, 0o600);
}
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
process.stdout.write(
  'Local HTTPS certificate and private API configuration are ready in .local/. Secrets were not printed.\nThe certificate is self-signed; trust it explicitly for local development only. See docs/LOCAL_SECURITY.md.\n',
);
