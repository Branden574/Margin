import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Agent } from 'node:https';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
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
const OCR_WORKER = '/ocr/tesseract-7.0.0-eng-1/worker.min.js';
const OCR_MODEL = '/ocr/tesseract-7.0.0-eng-1/lang/eng.traineddata.gz';
const OCR_WORKER_CSP =
  "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'self'; worker-src 'none'; object-src 'none'; base-uri 'none'";
/** Dedicated same-origin workers use their own response policy; the document keeps script-src self. */
function localOcrWorkerPolicy(): Plugin {
  const middleware =
    (directory: string) =>
    async (
      request: import('node:http').IncomingMessage,
      response: import('node:http').ServerResponse,
      next: () => void,
    ) => {
      const path = request.url?.split('?')[0];
      if (path !== OCR_WORKER && path !== OCR_MODEL) return next();
      if (path === OCR_WORKER) response.setHeader('Content-Security-Policy', OCR_WORKER_CSP);
      response.setHeader('X-Content-Type-Options', 'nosniff');
      response.setHeader(
        'Content-Type',
        path === OCR_WORKER ? 'text/javascript; charset=utf-8' : 'application/gzip',
      );
      // This gzip is a file consumed by the OCR engine, not HTTP transfer compression.
      // Vite otherwise advertises Content-Encoding:gzip, changing the fetched bytes.
      response.removeHeader('Content-Encoding');
      response.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      if (!['GET', 'HEAD'].includes(request.method || '')) {
        response.statusCode = 405;
        response.end();
        return;
      }
      try {
        const bytes = await readFile(resolve(directory, `.${path}`));
        response.setHeader('Content-Length', bytes.length);
        response.end(request.method === 'HEAD' ? undefined : bytes);
      } catch {
        response.statusCode = 404;
        response.setHeader('Cache-Control', 'no-store');
        response.end('Local OCR assets are missing. Run npm run prepare:ocr -w @margin/web.');
      }
    };
  return {
    name: 'margin-local-ocr-worker-policy',
    configureServer(server) {
      server.middlewares.use(middleware(server.config.publicDir));
    },
    configurePreviewServer(server) {
      server.middlewares.use(middleware(resolve(server.config.root, server.config.build.outDir)));
    },
  };
}
export default defineConfig(({ command }) => {
  if (command === 'serve' && !tls)
    throw new Error(
      'HTTPS is required. Run npm run setup:dev to create your local certificate first.',
    );
  return {
    plugins: [react(), localOcrWorkerPolicy()],
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
