import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Agent } from 'node:https';
const keyFile = fileURLToPath(new URL('../../.local/tls/key.pem', import.meta.url));
const certFile = fileURLToPath(new URL('../../.local/tls/cert.pem', import.meta.url));
const tls =
  existsSync(keyFile) && existsSync(certFile)
    ? { key: readFileSync(keyFile), cert: readFileSync(certFile), minVersion: 'TLSv1.2' as const }
    : undefined;
const baseHeaders = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
};
const previewHeaders = {
  ...baseHeaders,
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self'; style-src 'self'; style-src-attr 'unsafe-inline'; font-src 'self'; img-src 'self' blob: data:; worker-src 'self' blob:; connect-src 'self' https:; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
};
export default defineConfig(({ command }) => {
  if (command === 'serve' && !tls)
    throw new Error(
      'HTTPS is required. Run npm run setup:dev to create your local certificate first.',
    );
  return {
    plugins: [react()],
    server: {
      port: 5173,
      host: '127.0.0.1',
      https: tls,
      headers: baseHeaders,
      proxy: {
        '/api': {
          target: 'https://127.0.0.1:4100',
          agent: tls ? new Agent({ ca: tls.cert, minVersion: 'TLSv1.2' }) : undefined,
        },
      },
    },
    preview: { port: 4173, host: '127.0.0.1', https: tls, headers: previewHeaders },
    build: { target: 'es2022' },
  };
});
