import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import {
  createServer,
  preview,
  type ViteDevServer,
  type PreviewServer,
  type UserConfig,
} from 'vite';
import { mkdtemp, mkdir, writeFile, readFile, cp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { get } from 'node:https';
import { createHash } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import configFactory from '../apps/web/vite.config';
import {
  OCR_BASE_URL,
  OCR_WORKER_CSP,
  validateOcrManifest,
} from '../apps/web/src/editor/ocrAssets';

const { prepareOcrAssets } = await import(
  new URL('../scripts/prepare-ocr.mjs', import.meta.url).href
);
const { ensureLocalTls } = await import(new URL('../scripts/local-tls.mjs', import.meta.url).href);
let directory: string, certificate: Buffer, expectedModel: Buffer;
let development: ViteDevServer | undefined, production: PreviewServer | undefined;
const digest = (value: Buffer) => createHash('sha256').update(value).digest('hex');

function request(server: ViteDevServer | PreviewServer, path: string) {
  const port = (server.httpServer!.address() as AddressInfo).port;
  return new Promise<{
    headers: import('node:http').IncomingHttpHeaders;
    bytes: Buffer;
    status: number;
  }>((resolve, reject) => {
    const call = get(
      `https://127.0.0.1:${port}${path}`,
      { ca: certificate, rejectUnauthorized: true },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () =>
          resolve({
            headers: response.headers,
            bytes: Buffer.concat(chunks),
            status: response.statusCode!,
          }),
        );
        response.on('error', reject);
      },
    );
    call.on('error', reject);
    call.setTimeout(5000, () => call.destroy(new Error('OCR asset response timed out.')));
  });
}

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'margin-ocr-http-'));
  const tls = ensureLocalTls(join(directory, 'tls'));
  certificate = await readFile(tls.certPath);
  const https = {
    cert: certificate,
    key: await readFile(tls.keyPath),
    minVersion: 'TLSv1.2' as const,
  };
  const publicDir = join(directory, 'public');
  await prepareOcrAssets({ outputRoot: join(publicDir, 'ocr') });
  expectedModel = await readFile(join(publicDir, `.${OCR_BASE_URL}lang/eng.traineddata.gz`));
  await writeFile(
    join(directory, 'index.html'),
    '<!doctype html><title>Synthetic OCR server test</title>',
  );
  await mkdir(join(directory, 'dist'));
  await cp(publicDir, join(directory, 'dist'), { recursive: true });
  await cp(join(directory, 'index.html'), join(directory, 'dist/index.html'));
  const config = await (configFactory as (environment: object) => UserConfig)({
    command: 'build',
    mode: 'test',
  });
  const common = {
    ...config,
    root: directory,
    publicDir,
    configFile: false as const,
    logLevel: 'silent' as const,
  };
  development = await createServer({
    ...common,
    server: { ...config.server, https, port: 0, host: '127.0.0.1', hmr: false, proxy: undefined },
  });
  await development.listen();
  production = await preview({
    ...common,
    preview: { ...config.preview, https, port: 0, host: '127.0.0.1' },
  });
}, 20_000);

afterAll(async () => {
  await development?.close();
  if (production)
    await new Promise<void>((resolve, reject) =>
      production!.httpServer.close((error) => (error ? reject(error) : resolve())),
    );
  if (directory) await rm(directory, { recursive: true, force: true });
});

describe('exact local OCR asset responses', () => {
  it.each(['development', 'production'] as const)(
    'preserves gzip bytes and worker-only WebAssembly CSP in %s',
    async (mode) => {
      const server = mode === 'development' ? development! : production!;
      const model = await request(server, `${OCR_BASE_URL}lang/eng.traineddata.gz`);
      expect(model.status).toBe(200);
      expect(model.headers['content-type']).toBe('application/gzip');
      expect(model.headers['content-encoding']).toBeUndefined();
      expect(model.headers['content-length']).toBe(String(expectedModel.length));
      expect(model.bytes.subarray(0, 2)).toEqual(Buffer.from([0x1f, 0x8b]));
      expect(digest(model.bytes)).toBe(digest(expectedModel));
      const manifest = validateOcrManifest(
        JSON.parse((await request(server, `${OCR_BASE_URL}manifest.json`)).bytes.toString()),
      );
      expect(
        manifest.assets.find((asset) => asset.path.endsWith('eng.traineddata.gz'))?.sha256,
      ).toBe(digest(model.bytes));
      const worker = await request(server, `${OCR_BASE_URL}worker.min.js`);
      expect(worker.status).toBe(200);
      expect(worker.headers['content-security-policy']).toBe(OCR_WORKER_CSP);
      expect(worker.headers['content-security-policy']).not.toMatch(/(?:^|\s)'unsafe-eval'/);
      expect(worker.headers['content-type']).toContain('text/javascript');
      if (mode === 'production') {
        const document = await request(server, '/');
        expect(document.headers['content-security-policy']).toContain("script-src 'self';");
        expect(document.headers['content-security-policy']).not.toContain('wasm-unsafe-eval');
      }
    },
  );
});
