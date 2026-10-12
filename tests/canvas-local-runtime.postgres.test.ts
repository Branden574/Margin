import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { request } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from 'pg';
import { postgresTlsToolsAvailable } from './helpers/postgres-tools';
import {
  bootCanvasLocal,
  stopCanvasLocal,
  type CanvasBootstrapReceipt,
} from '../apps/api/src/canvas-local/bootstrap';
import { startCanvasLocalApi } from '../apps/api/src/runtime-canvas-local';

const available = postgresTlsToolsAvailable('persistent Canvas runtime');
async function freePort(excluded: number[] = []) {
  for (let attempt = 0; attempt < 10; attempt++) {
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    if (![5174, 5432, ...excluded].includes(port)) return port;
  }
  throw new Error('Could not select separate loopback ports for the disposable fixture.');
}
let directory: string, saved: CanvasBootstrapReceipt, ca: Buffer, apiPort: number;
let runtime: Awaited<ReturnType<typeof startCanvasLocalApi>> | undefined;
let admin: Client;
function get(
  path: string,
  trusted = true,
): Promise<{ status: number; body: any; headers: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        hostname: '127.0.0.1',
        port: apiPort,
        path,
        method: 'GET',
        ca: trusted ? ca : undefined,
        rejectUnauthorized: true,
        timeout: 3000,
      },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          text += chunk;
        });
        res.on('end', () =>
          resolve({ status: res.statusCode!, body: JSON.parse(text), headers: res.headers }),
        );
      },
    );
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('Test request timeout.')));
    req.end();
  });
}

describe.skipIf(!available)(
  'persistent Canvas HTTPS startup against an isolated real TLS database',
  { timeout: 30000 },
  () => {
    beforeAll(async () => {
      directory = await realpath(await mkdtemp(join(tmpdir(), 'margin-canvas-runtime-')));
      const { ensureLocalTls } = await import(
        new URL('../scripts/local-tls.mjs', import.meta.url).href
      );
      const tls = ensureLocalTls(join(directory, 'tls'));
      ca = await readFile(tls.certPath);
      apiPort = await freePort();
      saved = await bootCanvasLocal({
        rootDirectory: join(directory, 'canvas'),
        postgresPort: await freePort([apiPort]),
        apiPort,
        applicationOrigin: 'https://127.0.0.1:5174',
        apiTls: { keyFile: tls.keyPath, certFile: tls.certPath },
      });
      const url = new URL(
        (await readFile(join(saved.rootDirectory, 'operator/database.url'), 'utf8')).trim(),
      );
      admin = new Client({
        host: url.hostname,
        port: Number(url.port),
        user: url.username,
        password: url.password,
        database: url.pathname.slice(1),
        ssl: {
          ca: await readFile(join(saved.rootDirectory, 'postgres-tls/ca.pem')),
          rejectUnauthorized: true,
        },
      });
      await admin.connect();
    }, 60000);
    afterAll(async () => {
      await runtime?.close();
      await admin?.end();
      if (saved) await stopCanvasLocal(saved.rootDirectory);
      if (directory) await rm(directory, { recursive: true, force: true });
    });

    it('loads persistent services, retains fail-closed authentication and reports missing scanning', async () => {
      runtime = await startCanvasLocalApi(saved.configPath);
      expect(runtime.applicationOrigin).toBe('https://127.0.0.1:5174');
      const health = await get('/api/health');
      expect(health.status).toBe(200);
      expect(health.body).toMatchObject({
        authentication: 'lti-session',
        canvasConfigured: true,
        assignmentsConfigured: true,
        assignmentWorkConfigured: true,
        assignmentSubmissionsConfigured: true,
        assignmentReviewConfigured: true,
        scanningConfigured: false,
      });
      const session = await get('/api/auth/session');
      expect(session.status).toBe(401);
      const login = await get('/api/auth/login');
      expect(login.status).toBe(503);
      expect(login.body.error.code).toBe('oidc_unconfigured');
      expect(health.headers['x-content-type-options']).toBe('nosniff');
      await expect(get('/api/health', false)).rejects.toBeDefined();
      expect(
        (await admin.query('SELECT count(*) FROM margin_lms.installations')).rows[0].count,
      ).toBe('0');
    });

    it('stops the listener and workers, then reuses the same public signing identity on restart', async () => {
      const jwks = runtime!.publicJwks();
      expect(jwks.keys).toHaveLength(1);
      expect(jwks.keys[0]).not.toHaveProperty('d');
      await runtime!.close();
      await runtime!.close();
      await expect(get('/api/health')).rejects.toBeDefined();
      runtime = await startCanvasLocalApi(saved.configPath);
      expect(runtime.publicJwks()).toEqual(jwks);
      expect((await get('/api/health')).status).toBe(200);
      await runtime.close();
      runtime = undefined;
    });

    it('refuses migration drift before opening the listener and can recover after operator repair', async () => {
      const old = (await admin.query('SELECT sha256 FROM margin_local.migrations WHERE position=1'))
        .rows[0].sha256;
      try {
        await admin.query(
          "UPDATE margin_local.migrations SET sha256=repeat('0',64) WHERE position=1",
        );
        await expect(startCanvasLocalApi(saved.configPath)).rejects.toThrow();
        await expect(get('/api/health')).rejects.toBeDefined();
      } finally {
        await admin.query('UPDATE margin_local.migrations SET sha256=$1 WHERE position=1', [old]);
      }
      runtime = await startCanvasLocalApi(saved.configPath);
      await runtime.close();
      runtime = undefined;
    });

    it('refuses invalid configuration and an already aborted startup without opening the listener', async () => {
      const copied = join(saved.rootDirectory, 'invalid-runtime.json');
      const json = JSON.parse(await readFile(saved.configPath, 'utf8'));
      json.listener.host = '0.0.0.0';
      await writeFile(copied, JSON.stringify(json), { mode: 0o600 });
      await expect(startCanvasLocalApi(copied)).rejects.toThrow('127.0.0.1');
      const cancelled = new AbortController();
      cancelled.abort();
      await expect(
        startCanvasLocalApi(saved.configPath, { signal: cancelled.signal }),
      ).rejects.toBeDefined();
      await expect(get('/api/health')).rejects.toBeDefined();
    });

    it('cleans up a bind failure so a subsequent startup can use the same configuration', async () => {
      const occupied = createServer();
      await new Promise<void>((resolve) => occupied.listen(apiPort, '127.0.0.1', resolve));
      try {
        await expect(startCanvasLocalApi(saved.configPath)).rejects.toMatchObject({
          code: 'EADDRINUSE',
        });
      } finally {
        await new Promise<void>((resolve) => occupied.close(() => resolve()));
      }
      runtime = await startCanvasLocalApi(saved.configPath);
      expect((await get('/api/health')).status).toBe(200);
      await runtime.close();
      runtime = undefined;
    });
  },
);
