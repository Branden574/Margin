import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createPrivateKey, X509Certificate } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

type Result = {
  keyPath: string;
  certPath: string;
  action: 'created' | 'reused' | 'regenerated';
  reason?: string;
  backupDirectory?: string;
};
const helperUrl = new URL('../scripts/local-tls.mjs', import.meta.url);
const { ensureLocalTls } = (await import(helperUrl.href)) as {
  ensureLocalTls: (directory: string, options?: { now?: Date }) => Result;
};
let root: string;
let fixture: Result;
const permissions = (path: string) => statSync(path).mode & 0o777;
const certificate = (result: Result) => new X509Certificate(readFileSync(result.certPath));
function copyFixture(name: string) {
  const directory = join(root, name);
  mkdirSync(directory);
  copyFileSync(fixture.keyPath, join(directory, 'key.pem'));
  copyFileSync(fixture.certPath, join(directory, 'cert.pem'));
  return directory;
}
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'margin-local-tls-test-'));
  fixture = ensureLocalTls(join(root, 'fixture'));
});
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('local HTTPS leaf certificate setup', () => {
  it('creates the required server leaf, valid hostnames, matching private key, and private permissions', () => {
    const result = ensureLocalTls(join(root, 'new'));
    const leaf = certificate(result);
    const details = execFileSync('openssl', ['x509', '-in', result.certPath, '-noout', '-text'], {
      encoding: 'utf8',
    });
    expect(result.action).toBe('created');
    expect(leaf.ca).toBe(false);
    expect(leaf.checkHost('localhost')).toBeTruthy();
    expect(leaf.checkIP('127.0.0.1')).toBeTruthy();
    expect(leaf.checkIP('::1')).toBeTruthy();
    expect(leaf.checkHost('example.com')).toBeUndefined();
    expect(leaf.checkPrivateKey(createPrivateKey(readFileSync(result.keyPath)))).toBe(true);
    expect(leaf.publicKey.asymmetricKeyDetails?.modulusLength).toBe(3072);
    expect(leaf.keyUsage).toEqual(['1.3.6.1.5.5.7.3.1']);
    expect(details).toMatch(/Signature Algorithm:\s*sha256WithRSAEncryption/);
    expect(details).toMatch(/X509v3 Basic Constraints:\s*critical\s+CA:FALSE/);
    expect(details).toMatch(/X509v3 Key Usage:\s*critical\s+Digital Signature, Key Encipherment/);
    expect(
      (new Date(leaf.validTo).getTime() - new Date(leaf.validFrom).getTime()) / 86_400_000,
    ).toBe(30);
    expect(permissions(join(root, 'new'))).toBe(0o700);
    expect(permissions(result.keyPath)).toBe(0o600);
    expect(permissions(result.certPath)).toBe(0o600);
  });
  it('reuses a valid matching pair byte-for-byte and tightens its file permissions', () => {
    const directory = copyFixture('reuse');
    const before = [
      readFileSync(join(directory, 'cert.pem')),
      readFileSync(join(directory, 'key.pem')),
    ];
    chmodSync(directory, 0o755);
    chmodSync(join(directory, 'key.pem'), 0o644);
    chmodSync(join(directory, 'cert.pem'), 0o644);
    const result = ensureLocalTls(directory);
    expect(result.action).toBe('reused');
    expect(result.backupDirectory).toBeUndefined();
    expect(readFileSync(result.certPath)).toEqual(before[0]);
    expect(readFileSync(result.keyPath)).toEqual(before[1]);
    expect(permissions(directory)).toBe(0o700);
    expect(permissions(result.keyPath)).toBe(0o600);
    expect(permissions(result.certPath)).toBe(0o600);
  });
  it('migrates an old CA certificate with timestamped private backups and preserves API secrets', () => {
    const workspace = join(root, 'migration');
    const tls = join(workspace, '.local/tls');
    const scripts = join(workspace, 'scripts');
    mkdirSync(tls, { recursive: true });
    mkdirSync(scripts);
    execFileSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-sha256',
        '-keyout',
        join(tls, 'key.pem'),
        '-out',
        join(tls, 'cert.pem'),
        '-days',
        '30',
        '-subj',
        '/CN=localhost',
        '-addext',
        'basicConstraints=critical,CA:TRUE',
      ],
      { stdio: 'pipe' },
    );
    const prior = {
      key: readFileSync(join(tls, 'key.pem')),
      cert: readFileSync(join(tls, 'cert.pem')),
    };
    const env =
      'MARGIN_MASTER_KEY=synthetic-secret-preserve-me\nMARGIN_API_TOKEN=synthetic-token-preserve-me\n';
    writeFileSync(join(workspace, '.local/api.env'), env, { mode: 0o600 });
    copyFileSync(fileURLToPath(helperUrl), join(scripts, 'local-tls.mjs'));
    copyFileSync(
      fileURLToPath(new URL('../scripts/setup-dev.mjs', import.meta.url)),
      join(scripts, 'setup-dev.mjs'),
    );
    const output = execFileSync(process.execPath, [join(scripts, 'setup-dev.mjs')], {
      encoding: 'utf8',
    });
    expect(new X509Certificate(readFileSync(join(tls, 'cert.pem'))).ca).toBe(false);
    expect(readFileSync(join(workspace, '.local/api.env'), 'utf8')).toBe(env);
    expect(output).not.toContain('synthetic-secret');
    expect(output).not.toContain('synthetic-token');
    expect(output).toContain('Operating-system trust was not changed');
    expect(output).toContain('npm run trust:dev');
    const [backup] = readdirSync(join(tls, 'backups'));
    expect(backup).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    const preserved = join(tls, 'backups', backup);
    expect(readFileSync(join(preserved, 'key.pem'))).toEqual(prior.key);
    expect(readFileSync(join(preserved, 'cert.pem'))).toEqual(prior.cert);
    expect(permissions(preserved)).toBe(0o700);
    expect(permissions(join(preserved, 'key.pem'))).toBe(0o600);
    expect(permissions(join(preserved, 'cert.pem'))).toBe(0o600);
  });
  it('preserves incomplete, mismatched, and expired pairs before regeneration', () => {
    const incomplete = join(root, 'incomplete');
    mkdirSync(incomplete);
    copyFileSync(fixture.certPath, join(incomplete, 'cert.pem'));
    const repaired = ensureLocalTls(incomplete);
    expect(repaired.action).toBe('regenerated');
    expect(repaired.reason).toContain('incomplete');
    expect(readdirSync(repaired.backupDirectory!)).toEqual(['cert.pem']);
    const mismatch = copyFixture('mismatch');
    copyFileSync(repaired.keyPath, join(mismatch, 'key.pem'));
    const mismatchedKey = readFileSync(join(mismatch, 'key.pem'));
    const matched = ensureLocalTls(mismatch);
    expect(matched.reason).toContain('do not match');
    expect(readFileSync(join(matched.backupDirectory!, 'key.pem'))).toEqual(mismatchedKey);
    expect(
      certificate(matched).checkPrivateKey(createPrivateKey(readFileSync(matched.keyPath))),
    ).toBe(true);
    const expired = copyFixture('expired');
    const renewed = ensureLocalTls(expired, {
      now: new Date(new Date(certificate(fixture).validTo).getTime() + 1000),
    });
    expect(renewed.reason).toBe('expired certificate');
    expect(readFileSync(join(renewed.backupDirectory!, 'cert.pem'))).toEqual(
      readFileSync(fixture.certPath),
    );
    expect(new Date(certificate(renewed).validTo).getTime()).toBeGreaterThan(Date.now());
  });
});
