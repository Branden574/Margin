import { execFileSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  assertNoPendingCertificateMaintenance,
  CANVAS_CERTIFICATE_MAINTENANCE_MARKER,
} from '../apps/api/src/canvas-local/certificate-barrier';
import { loadCanvasLocalConfig } from '../apps/api/src/canvas-local/config';
import { loadLocalScannerConfig } from '../apps/api/src/scanner/local-config';

const observed = vi.hoisted(() => ({ opened: [] as string[], wrongOwner: '', failMarker: false }));
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    async open(...args: Parameters<typeof actual.open>) {
      observed.opened.push(String(args[0]));
      const handle = await actual.open(...args);
      if (String(args[0]) === observed.wrongOwner) {
        const stat = handle.stat.bind(handle);
        handle.stat = (async () => {
          const result = await stat();
          result.uid += 1;
          return result;
        }) as typeof handle.stat;
      }
      return handle;
    },
    async lstat(...args: Parameters<typeof actual.lstat>) {
      if (observed.failMarker && String(args[0]).endsWith('.certificate-renewal.pending.json'))
        throw Object.assign(new Error('private path diagnostic'), { code: 'EACCES' });
      return actual.lstat(...args);
    },
  };
});
let base: string, root: string, marker: string;
beforeEach(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), 'margin-certificate-barrier-')));
  root = join(base, 'canvas');
  await mkdir(root, { mode: 0o700 });
  marker = join(root, CANVAS_CERTIFICATE_MAINTENANCE_MARKER);
  observed.opened.length = 0;
  observed.wrongOwner = '';
  observed.failMarker = false;
});
afterEach(async () => {
  observed.failMarker = false;
  await rm(base, { recursive: true, force: true });
});

it('permits an existing private real root only when its marker is absent', async () => {
  await expect(assertNoPendingCertificateMaintenance(root)).resolves.toBeUndefined();
  expect(observed.opened).not.toContain(marker);
});
it.each(['empty', 'malformed', 'unreadable', 'symlink', 'directory', 'fifo'] as const)(
  'blocks a %s marker without opening or parsing any marker or staged body',
  async (kind) => {
    const staged = join(root, 'staged-secret');
    await writeFile(staged, 'never-read-this-private-secret', { mode: 0o600 });
    if (kind === 'symlink') await symlink(staged, marker);
    else if (kind === 'directory') await mkdir(marker, { mode: 0o700 });
    else if (kind === 'fifo') execFileSync('mkfifo', ['-m', '600', marker]);
    else {
      await writeFile(marker, kind === 'empty' ? '' : '{private malformed', { mode: 0o600 });
      if (kind === 'unreadable') await chmod(marker, 0o000);
    }
    await expect(assertNoPendingCertificateMaintenance(root)).rejects.toMatchObject({
      code: 'certificate_maintenance_pending',
    });
    expect(observed.opened).not.toContain(marker);
    expect(observed.opened).not.toContain(staged);
  },
);
it('refuses a dangling marker symlink', async () => {
  await symlink(join(root, 'missing-journal'), marker);
  await expect(assertNoPendingCertificateMaintenance(root)).rejects.toMatchObject({
    code: 'certificate_maintenance_pending',
  });
});
it.each(['missing', 'public', 'foreign-owner', 'symlink', 'symlink-ancestor'] as const)(
  'refuses a %s root rather than treating an unverifiable marker as absent',
  async (kind) => {
    let target = root;
    if (kind === 'missing') await rm(root, { recursive: true });
    if (kind === 'public') await chmod(root, 0o755);
    if (kind === 'foreign-owner') observed.wrongOwner = root;
    if (kind === 'symlink') {
      target = join(base, 'alias');
      await symlink(root, target);
    }
    if (kind === 'symlink-ancestor') {
      const alias = join(base, 'alias');
      await symlink(root, alias);
      await mkdir(join(root, 'child'), { mode: 0o700 });
      target = join(alias, 'child');
    }
    await expect(assertNoPendingCertificateMaintenance(target)).rejects.toMatchObject({
      code: 'certificate_maintenance_unavailable',
    });
  },
);
it('scrubs non-ENOENT marker lookup errors and fails closed', async () => {
  observed.failMarker = true;
  const error = await assertNoPendingCertificateMaintenance(root).catch((error: unknown) => error);
  expect(error).toMatchObject({ code: 'certificate_maintenance_unavailable' });
  expect(String(error)).not.toContain('private path diagnostic');
  expect(error).not.toHaveProperty('cause');
});
it.each(['api', 'scanner'] as const)(
  'blocks the %s loader before opening its config, bootstrap receipt or credentials',
  async (kind) => {
    await mkdir(join(root, 'scanner'), { mode: 0o700 });
    await writeFile(marker, 'malformed marker is still a barrier', { mode: 0o600 });
    const apiConfig = join(root, 'config.json');
    const scannerConfig = join(root, 'scanner/inspector.json');
    await writeFile(apiConfig, 'invalid private configuration', { mode: 0o600 });
    await writeFile(scannerConfig, 'invalid private configuration', { mode: 0o600 });
    const operation =
      kind === 'api' ? loadCanvasLocalConfig(apiConfig) : loadLocalScannerConfig(scannerConfig);
    await expect(operation).rejects.toMatchObject(
      kind === 'api'
        ? { code: 'certificate_maintenance_pending' }
        : { name: 'LocalScannerConfigurationError' },
    );
    expect(observed.opened).not.toContain(apiConfig);
    expect(observed.opened).not.toContain(scannerConfig);
    expect(observed.opened).not.toContain(join(root, 'bootstrap.json'));
    expect(observed.opened).not.toContain(marker);
  },
);
