import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createApi } from './server.js';

if (process.env.NODE_ENV === 'production')
  throw new Error(
    'This encrypted local service is not a production deployment. Configure managed identity, KMS and scanning before deployment.',
  );
const token = process.env.MARGIN_API_TOKEN;
const encodedKey = process.env.MARGIN_MASTER_KEY;
const keyFile = process.env.MARGIN_TLS_KEY_FILE;
const certFile = process.env.MARGIN_TLS_CERT_FILE;
if (!token || !encodedKey || !keyFile || !certFile)
  throw new Error(
    'Secure configuration is missing. Run npm run setup:dev and supply the protected .local/api.env file.',
  );
const masterKey = Buffer.from(encodedKey, 'base64');
if (masterKey.length !== 32 || masterKey.toString('base64') !== encodedKey)
  throw new Error('MARGIN_MASTER_KEY must be a canonical base64-encoded 32-byte secret.');
const port = Number(process.env.MARGIN_API_PORT || 4100);
if (!Number.isInteger(port) || port < 1024 || port > 65535)
  throw new Error('MARGIN_API_PORT must be a port from 1024–65535.');
const server = createApi({
  dataDirectory: resolve(process.env.MARGIN_DATA_DIR || '.margin-data'),
  keyEncryptionKey: masterKey,
  identities: [
    {
      token,
      tenantId: process.env.MARGIN_TENANT_ID || 'local-workspace',
      userId: process.env.MARGIN_USER_ID || 'local-user',
      expiresAt: Date.now() + 60 * 60 * 1000,
    },
  ],
  tls: { key: readFileSync(keyFile), cert: readFileSync(certFile) },
});
masterKey.fill(0);
server.listen(port, '127.0.0.1', () =>
  process.stdout.write(
    `Margin encrypted local API: https://127.0.0.1:${port}\nSession expires in one hour. Uploaded files remain quarantined until isolated validation and malware scanning are configured.\n`,
  ),
);
function shutdown() {
  server.close(() => process.exit(0));
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
