#!/usr/bin/env node
import {
  enableCanvasLocalFeedback,
  CanvasFeedbackSetupError,
} from '../apps/api/src/canvas-local/feedback-companion.ts';
import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  bootCanvasLocal,
  CanvasBootstrapError,
  startCanvasLocal,
  stopCanvasLocal,
  upgradeCanvasLocal,
} from '../apps/api/src/canvas-local/bootstrap.ts';
import { CanvasLocalConfigError } from '../apps/api/src/canvas-local/protected-files.ts';
import { CanvasAdmissionError } from '../apps/api/src/canvas-local/maintenance.ts';

import {
  renewCanvasPostgresCertificate,
  CanvasCertificateMaintenanceError,
} from '../apps/api/src/canvas-local/certificate-maintenance.ts';

const repository = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
if (args.includes('--help')) {
  process.stdout.write(
    'Usage: node --import tsx scripts/setup-canvas-local.mjs [setup|start|stop|upgrade|enable-feedback|renew-postgres-cert] [--root PATH] [--postgres-port 55439] [--api-port 4101] [--application-origin https://127.0.0.1:5174] [--api-tls-key PATH] [--api-tls-cert PATH]\nSetup starts only its dedicated persistent PostgreSQL cluster. Explicit upgrade applies reviewed migration 013 after a private database backup; enable-feedback separately installs migration 014 and its own restricted login without rewriting original credentials; stop the API, workers and other database sessions first. The explicit renew-postgres-cert action preserves the PostgreSQL CA and server key, rebinds the owned scanner companion, and restores the database’s prior running state. Stop API and scanner runtimes before maintenance. Existing keys, configuration and artifacts are preserved. It never changes OS trust or another database.\n',
  );
} else {
  try {
    const action = args[0] && !args[0].startsWith('--') ? args.shift() : 'setup';
    if (
      !['setup', 'start', 'stop', 'upgrade', 'enable-feedback', 'renew-postgres-cert'].includes(
        action,
      )
    )
      throw new CanvasBootstrapError(
        'Choose setup, start, stop, upgrade, enable-feedback, or renew-postgres-cert.',
      );
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
      throw new CanvasBootstrapError('Maintenance actions accept only the saved --root.');
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
    } else if (action === 'renew-postgres-cert') {
      const result = await renewCanvasPostgresCertificate(rootDirectory);
      process.stdout.write(
        result.completedPreviously
          ? `Recovered the completed PostgreSQL leaf renewal record and retired its interrupted ownership lock. Saved leaf expires ${result.expiresAt}. No new live database verification or running-state change was performed.\n`
          : `Owned PostgreSQL leaf renewal ${result.resumed ? 'was recovered and verified' : 'completed'}. Leaf expires ${result.expiresAt}. The database is ${result.wasRunning ? 'running' : 'stopped'}; CA, server key, credentials and data were preserved. Browser/API certificates and OS trust were unchanged.\n`,
      );
    } else if (action === 'enable-feedback') {
      const result = await enableCanvasLocalFeedback(rootDirectory);
      process.stdout.write(
        `Feedback migration 014 and its dedicated credential are ${result.changed ? 'installed and verified' : 'already installed and verified'}. Original Canvas files and credentials were preserved.\nPrivate pre-upgrade backup: ${result.backup.directory}\n`,
      );
    } else if (action === 'upgrade') {
      const result = await upgradeCanvasLocal(rootDirectory);
      process.stdout.write(
        `Canvas migration 013 is ${result.changed ? 'installed' : 'already installed and verified'}. Keys, configuration and application data were preserved.\n${result.backup ? `Private database recovery point: ${result.backup.directory}\nRetain the original private root and artifacts; restoration instructions are in its manifest.json.\n` : ''}`,
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
      error instanceof CanvasCertificateMaintenanceError ||
      error instanceof CanvasBootstrapError ||
      error instanceof CanvasFeedbackSetupError ||
      error instanceof CanvasLocalConfigError ||
      error instanceof CanvasAdmissionError
        ? error.message
        : 'The local setup operation failed. Existing files were preserved; inspect the private setup or PostgreSQL log.';
    process.stderr.write(`Canvas setup did not complete: ${message}\n`);
    process.exitCode = 1;
  }
}
