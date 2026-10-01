import { spawn } from 'node:child_process';
import { access, readFile } from 'node:fs/promises';
import { get } from 'node:https';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
const workspace = fileURLToPath(root);
const web = fileURLToPath(new URL('apps/web/', root));
await access(new URL('apps/web/dist/index.html', root)).catch(() => {
  throw new Error('Build the web app before offline verification: npm run build -w @margin/web');
});
const localCA = await readFile(new URL('.local/tls/cert.pem', root)).catch(() => {
  throw new Error('Create the local HTTPS certificate first: npm run setup:dev');
});

async function freePort(preferred = 4175) {
  const probe = createServer();
  const listen = (port) =>
    new Promise((resolve, reject) => {
      const error = (reason) => {
        probe.removeListener('listening', listening);
        reject(reason);
      };
      const listening = () => {
        probe.removeListener('error', error);
        resolve();
      };
      probe.once('error', error);
      probe.once('listening', listening);
      probe.listen(port, '127.0.0.1');
    });
  try {
    await listen(preferred);
  } catch (error) {
    if (error.code !== 'EADDRINUSE') throw error;
    await listen(0);
  }
  const port = probe.address().port;
  await new Promise((resolve, reject) =>
    probe.close((error) => (error ? reject(error) : resolve())),
  );
  return port;
}
function check(url) {
  return new Promise((resolve, reject) => {
    const request = get(
      url,
      { ca: localCA, minVersion: 'TLSv1.2', rejectUnauthorized: true, timeout: 1500 },
      (response) => {
        response.resume();
        if (response.statusCode === 200) resolve();
        else reject(new Error(`Preview returned HTTP ${response.statusCode}.`));
      },
    );
    request.on('error', reject);
    request.on('timeout', () => request.destroy(new Error('Preview readiness timed out.')));
  });
}
async function stop(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const ended = new Promise((resolve) => child.once('exit', resolve));
  child.kill('SIGTERM');
  const timer = setTimeout(() => child.kill('SIGKILL'), 3000);
  await ended;
  clearTimeout(timer);
}

const port = await freePort();
const url = `https://127.0.0.1:${port}`;
let preview;
let verification;
let logs = '';
try {
  preview = spawn(
    process.execPath,
    [
      fileURLToPath(new URL('node_modules/vite/bin/vite.js', root)),
      'preview',
      '--host',
      '127.0.0.1',
      '--port',
      String(port),
      '--strictPort',
    ],
    { cwd: web, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  preview.stdout.on('data', (chunk) => {
    logs = (logs + chunk).slice(-4000);
  });
  preview.stderr.on('data', (chunk) => {
    logs = (logs + chunk).slice(-4000);
  });
  let ready = false;
  let lastError;
  const deadline = Date.now() + 25_000;
  while (Date.now() < deadline && !ready) {
    if (preview.exitCode !== null)
      throw new Error(`HTTPS preview exited before becoming ready. ${logs}`);
    try {
      await check(url);
      ready = true;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  }
  if (!ready)
    throw new Error(
      `The pinned-certificate HTTPS preview did not start: ${String(lastError)} ${logs}`,
    );
  console.log(`Verifying offline workspace against a temporary HTTPS preview on port ${port}.`);
  for (const script of ['tests/storage.offline.mjs', 'scripts/check-accessibility.mjs']) {
    verification = spawn(process.execPath, [fileURLToPath(new URL(script, root))], {
      cwd: workspace,
      env: { ...process.env, MARGIN_OFFLINE_URL: url, MARGIN_CHECK_URL: url },
      stdio: 'inherit',
    });
    const timer = setTimeout(() => verification.kill('SIGTERM'), 120_000);
    const exitCode = await new Promise((resolve, reject) => {
      verification.once('error', reject);
      verification.once('exit', (code, signal) => resolve(signal ? 1 : code));
    });
    clearTimeout(timer);
    if (exitCode !== 0)
      throw new Error(`Browser verification failed for ${script}. See the test diagnostics above.`);
  }
} finally {
  await stop(verification);
  await stop(preview);
}
