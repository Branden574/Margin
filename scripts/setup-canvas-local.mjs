#!/usr/bin/env node
import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  bootCanvasLocal,
  CanvasBootstrapError,
  startCanvasLocal,
  stopCanvasLocal,
} from '../apps/api/src/canvas-local/bootstrap.ts';
import { CanvasLocalConfigError } from '../apps/api/src/canvas-local/protected-files.ts';

const repository = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
if (args.includes('--help')) {
  process.stdout.write(
    'Usage: node --import tsx scripts/setup-canvas-local.mjs [setup|start|stop] [--root PATH] [--postgres-port 55439] [--api-port 4101] [--application-origin https://127.0.0.1:5174] [--api-tls-key PATH] [--api-tls-cert PATH]\nSetup starts only its dedicated persistent PostgreSQL cluster. It never changes OS trust or another database. API/Canvas registration and source inspection are separate explicit actions.\n',
  );
} else {
  try {
    const action = args[0] && !args[0].startsWith('--') ? args.shift() : 'setup';
    if (!['setup', 'start', 'stop'].includes(action))
      throw new CanvasBootstrapError('Choose setup, start, or stop.');
    const known = new Set([
      '--root',
      '--postgres-port',
      '--api-port',
      '--application-origin',
      '--api-tls-key',
      '--api-tls-cert',
    ]);
    const values = new Map();
    for (let index = 0; index < args.length; index += 2) {
      const name = args[index],
        value = args[index + 1];
      if (!known.has(name) || !value || value.startsWith('--') || values.has(name))
        throw new CanvasBootstrapError('Use each supported option once with an explicit value.');
      values.set(name, value);
    }
    if (action !== 'setup' && [...values.keys()].some((name) => name !== '--root'))
      throw new CanvasBootstrapError('Start and stop accept only the saved --root.');
    const rootDirectory = resolve(values.get('--root') ?? resolve(repository, '.local/canvas'));
    if (action === 'setup') {
      // Only the default parent may be created automatically. Custom parents are operator-owned.
      if (!values.has('--root')) {
        try {
          await mkdir(dirname(rootDirectory), { mode: 0o700 });
        } catch (error) {
          if (error.code !== 'EEXIST') throw error;
        }
      }
      const result = await bootCanvasLocal({
        rootDirectory,
        postgresPort: Number(values.get('--postgres-port') ?? 55439),
        apiPort: Number(values.get('--api-port') ?? 4101),
        applicationOrigin: values.get('--application-origin') ?? 'https://127.0.0.1:5174',
        apiTls: {
          keyFile: resolve(
            values.get('--api-tls-key') ?? resolve(repository, '.local/tls/key.pem'),
          ),
          certFile: resolve(
            values.get('--api-tls-cert') ?? resolve(repository, '.local/tls/cert.pem'),
          ),
        },
      });
      process.stdout.write(
        `Isolated Canvas PostgreSQL is ${result.started ? 'started' : 'already running'} on 127.0.0.1:${result.postgresPort}.\nRuntime configuration: ${result.configPath}\nCredentials remain private; operator credentials are separate. No OS trust, Canvas installation, accounts, or scan approvals were created.\nUse the same command with stop --root <dedicated-root> to stop this owned cluster.\n`,
      );
    } else if (action === 'start') {
      const result = await startCanvasLocal(rootDirectory);
      process.stdout.write(
        `Owned Canvas PostgreSQL is ${result.started ? 'started' : 'already running'} on 127.0.0.1:${result.postgresPort}.\n`,
      );
    } else {
      const stopped = await stopCanvasLocal(rootDirectory);
      process.stdout.write(
        `Owned Canvas PostgreSQL is ${stopped ? 'stopped' : 'already stopped'}. Its data and credentials were preserved.\n`,
      );
    }
  } catch (error) {
    // Never serialize command arguments, connection options, keys or PostgreSQL error objects.
    const message =
      error instanceof CanvasBootstrapError || error instanceof CanvasLocalConfigError
        ? error.message
        : 'The local setup operation failed. Existing files were preserved; inspect the private setup or PostgreSQL log.';
    process.stderr.write(`Canvas setup did not complete: ${message}\n`);
    process.exitCode = 1;
  }
}
