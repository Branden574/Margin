import {
  chmodSync,
  constants,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createPrivateKey, X509Certificate } from 'node:crypto';

const names = ['key.pem', 'cert.pem'];

function inspectPair(keyPath, certPath, now, openssl) {
  if (!existsSync(keyPath) || !existsSync(certPath)) return 'incomplete certificate pair';
  try {
    const certificate = new X509Certificate(readFileSync(certPath));
    if (certificate.ca) return 'legacy CA certificate';
    if (new Date(certificate.validFrom).getTime() > now.getTime())
      return 'certificate is not valid yet';
    if (new Date(certificate.validTo).getTime() <= now.getTime()) return 'expired certificate';
    if (
      certificate.subject !== 'CN=127.0.0.1' ||
      certificate.subjectAltName !== 'IP Address:127.0.0.1' ||
      !certificate.checkIP('127.0.0.1')
    )
      return 'certificate scope is not exactly 127.0.0.1';
    if (!certificate.checkPrivateKey(createPrivateKey(readFileSync(keyPath))))
      return 'certificate and private key do not match';
    if (
      certificate.publicKey.asymmetricKeyType !== 'rsa' ||
      certificate.publicKey.asymmetricKeyDetails?.modulusLength !== 3072
    )
      return 'unexpected key algorithm or strength';
    if (certificate.issuer !== certificate.subject || !certificate.verify(certificate.publicKey))
      return 'certificate is not correctly self-signed';
    if (certificate.keyUsage?.length !== 1 || certificate.keyUsage[0] !== '1.3.6.1.5.5.7.3.1')
      return 'missing server-only extended key usage';
    const description = execFileSync(openssl, ['x509', '-in', certPath, '-noout', '-text'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (!/Signature Algorithm:\s*sha256WithRSAEncryption/.test(description))
      return 'unexpected certificate signature algorithm';
    if (!/X509v3 Basic Constraints:\s*critical\s+CA:FALSE/.test(description))
      return 'missing critical leaf constraint';
    const keyUsage = description
      .match(/X509v3 Key Usage:[ \t]*critical[ \t]*\r?\n[ \t]*([^\r\n]+)/)?.[1]
      .trim();
    if (keyUsage !== 'Digital Signature, Key Encipherment')
      return 'missing critical server key usages';
    return undefined;
  } catch {
    return 'unreadable or invalid certificate pair';
  }
}

/**
 * Create a private, self-signed development SERVER certificate. This helper never
 * alters operating-system trust and never reads or rewrites API configuration.
 * @param {string} directory
 * @param {{now?: Date; openssl?: string}} options
 * @returns {{keyPath: string; certPath: string; action: 'created'|'reused'|'regenerated'; reason?: string; backupDirectory?: string}}
 */
export function ensureLocalTls(directory, { now = new Date(), openssl = 'openssl' } = {}) {
  const dir = resolve(directory);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (lstatSync(dir).isSymbolicLink())
    throw new Error(
      'The local TLS directory must be a real private directory, not a symbolic link.',
    );
  chmodSync(dir, 0o700);
  const keyPath = join(dir, 'key.pem');
  const certPath = join(dir, 'cert.pem');
  for (const path of [keyPath, certPath]) {
    if (existsSync(path) && !lstatSync(path).isFile())
      throw new Error(
        'Local TLS certificate paths must be regular files. Existing paths were preserved.',
      );
  }
  const lockDirectory = join(dir, '.setup-lock');
  try {
    mkdirSync(lockDirectory, { mode: 0o700 });
  } catch (error) {
    if (error.code === 'EEXIST')
      throw new Error(
        'Another local TLS setup may be running. Retry after it finishes; if a previous process stopped unexpectedly, inspect .local/tls/.setup-lock.',
      );
    throw error;
  }
  let staging;
  try {
    const existing = names.filter((name) => existsSync(join(dir, name)));
    const reason = inspectPair(keyPath, certPath, now, openssl);
    if (!reason) {
      chmodSync(keyPath, 0o600);
      chmodSync(certPath, 0o600);
      return { keyPath, certPath, action: 'reused' };
    }
    staging = mkdtempSync(join(dir, '.tls-staging-'));
    chmodSync(staging, 0o700);
    const stagedKey = join(staging, 'key.pem');
    const stagedCert = join(staging, 'cert.pem');
    execFileSync(
      openssl,
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:3072',
        '-nodes',
        '-sha256',
        '-keyout',
        stagedKey,
        '-out',
        stagedCert,
        '-days',
        '30',
        '-subj',
        '/CN=127.0.0.1',
        '-addext',
        'basicConstraints=critical,CA:FALSE',
        '-addext',
        'keyUsage=critical,digitalSignature,keyEncipherment',
        '-addext',
        'extendedKeyUsage=serverAuth',
        '-addext',
        'subjectAltName=IP:127.0.0.1',
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    chmodSync(stagedKey, 0o600);
    chmodSync(stagedCert, 0o600);
    const generatedProblem = inspectPair(stagedKey, stagedCert, new Date(), openssl);
    if (generatedProblem)
      throw new Error(
        `The generated development certificate did not pass validation: ${generatedProblem}. Existing files were preserved.`,
      );
    let backupDirectory;
    if (existing.length) {
      const backups = join(dir, 'backups');
      mkdirSync(backups, { recursive: true, mode: 0o700 });
      chmodSync(backups, 0o700);
      backupDirectory = mkdtempSync(join(backups, `${now.toISOString().replace(/[:.]/g, '-')}-`));
      chmodSync(backupDirectory, 0o700);
      for (const name of existing) {
        copyFileSync(join(dir, name), join(backupDirectory, name), constants.COPYFILE_EXCL);
        chmodSync(join(backupDirectory, name), 0o600);
      }
    }
    const installed = [];
    try {
      for (const name of names) {
        renameSync(join(staging, name), join(dir, name));
        installed.push(name);
      }
    } catch (error) {
      // Two filenames cannot be renamed in one operation. Restore the preserved
      // pair if the second rename fails, instead of leaving mismatched files.
      for (const name of installed) {
        if (existing.includes(name)) {
          const restore = join(staging, `restore-${name}`);
          copyFileSync(join(backupDirectory, name), restore);
          chmodSync(restore, 0o600);
          renameSync(restore, join(dir, name));
        } else rmSync(join(dir, name), { force: true });
      }
      throw error;
    }
    return {
      keyPath,
      certPath,
      action: existing.length ? 'regenerated' : 'created',
      ...(existing.length ? { reason, backupDirectory } : {}),
    };
  } finally {
    if (staging) rmSync(staging, { recursive: true, force: true });
    rmSync(lockDirectory, { recursive: true, force: true });
  }
}
