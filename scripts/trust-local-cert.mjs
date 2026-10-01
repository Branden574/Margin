import { spawnSync } from 'node:child_process';
import { readFileSync, existsSync, mkdirSync, rmdirSync, writeFileSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { X509Certificate } from 'node:crypto';

const root = resolve(import.meta.dirname, '..');
const activeCertificatePath = resolve(root, '.local/tls/cert.pem');
const trustedCertificatePath = resolve(root, '.local/tls/trusted-cert.pem');
const lockPath = resolve(root, '.local/tls/.trust-lock');
const command = process.argv[2] || '--status';
if (!['--status', '--trust', '--trust-ssl', '--remove'].includes(command)) {
  throw new Error(
    'Usage: node scripts/trust-local-cert.mjs [--status|--trust|--trust-ssl|--remove]',
  );
}
const requestingTrust = command === '--trust' || command === '--trust-ssl';
if (process.platform !== 'darwin') {
  throw new Error(
    'This helper is for macOS user certificate trust. It does not change trust on other operating systems.',
  );
}
let locked = false;
try {
  if (command !== '--status') {
    try {
      mkdirSync(lockPath, { mode: 0o700 });
      locked = true;
    } catch (error) {
      if (error.code === 'EEXIST')
        throw new Error(
          'Another certificate trust operation may be running. Wait for it to finish; if it stopped unexpectedly, inspect .local/tls/.trust-lock before retrying.',
        );
      throw error;
    }
  }
  const certificatePath =
    command === '--remove' && existsSync(trustedCertificatePath)
      ? trustedCertificatePath
      : activeCertificatePath;
  const certificateBytes = readFileSync(certificatePath);
  const certificate = new X509Certificate(certificateBytes);
  if (certificate.issuer !== certificate.subject || !certificate.verify(certificate.publicKey))
    throw new Error('Expected the project’s self-signed local server certificate.');
  if (
    certificate.ca ||
    certificate.checkIP('127.0.0.1') !== '127.0.0.1' ||
    !certificate.keyUsage?.includes('1.3.6.1.5.5.7.3.1')
  ) {
    throw new Error('Expected a localhost server-only certificate. Run npm run setup:dev first.');
  }
  if (
    command !== '--remove' &&
    (Date.parse(certificate.validTo) <= Date.now() ||
      Date.parse(certificate.validFrom) > Date.now())
  ) {
    throw new Error(
      'The local server certificate is not currently valid. Run npm run setup:dev first.',
    );
  }
  if (
    requestingTrust &&
    certificate.subjectAltName !== 'DNS:localhost, IP Address:127.0.0.1, IP Address:0:0:0:0:0:0:0:1'
  )
    throw new Error(
      'Refusing trust: the certificate names must be exactly localhost, 127.0.0.1 and ::1.',
    );
  console.log(`Certificate: ${certificatePath}\nSHA-256: ${certificate.fingerprint256}`);
  const verify = (path) =>
    spawnSync(
      '/usr/bin/security',
      ['verify-cert', '-c', path, '-p', 'ssl', '-n', '127.0.0.1', '-L', '-q'],
      { stdio: 'pipe' },
    );
  if (command === '--status') {
    const result = verify(certificatePath);
    console.log(
      result.status === 0
        ? 'macOS trusts this certificate for HTTPS on 127.0.0.1.'
        : 'macOS does not yet trust this certificate for HTTPS on 127.0.0.1.',
    );
    process.exitCode = result.status === 0 ? 0 : 1;
  } else {
    if (requestingTrust) {
      if (
        existsSync(trustedCertificatePath) &&
        new X509Certificate(readFileSync(trustedCertificatePath)).fingerprint256 !==
          certificate.fingerprint256
      )
        throw new Error(
          'A previous certificate trust request is recorded. Run npm run untrust:dev before trusting this replacement.',
        );
    }
    // Retain the exact validated bytes before an OS change. Setup may rotate the
    // active cert.pem while the authentication dialog is open. Never overwrite
    // this receipt, and keep it if the OS result is rejected or uncertain.
    if (!existsSync(trustedCertificatePath))
      writeFileSync(trustedCertificatePath, certificateBytes, {
        flag: 'wx',
        mode: 0o600,
        flush: true,
      });
    if (requestingTrust) {
      console.log(
        command === '--trust-ssl'
          ? 'Requesting user-account SSL trust for this exact certificate, without a macOS hostname-policy restriction, for Chromium compatibility. This is broader than --trust.\nThe certificate names are: ' +
              certificate.subjectAltName +
              '.\nApprove the macOS prompt yourself if shown. No private key is imported and no system-wide trust is changed.'
          : 'Requesting user-account trust for this exact server certificate, SSL policy, host 127.0.0.1 only.\nApprove the macOS prompt yourself if shown. No private key is imported and no system-wide trust is changed.',
      );
      const result = spawnSync(
        '/usr/bin/security',
        [
          'add-trusted-cert',
          '-r',
          'trustRoot',
          '-p',
          'ssl',
          ...(command === '--trust' ? ['-s', '127.0.0.1'] : []),
          '-k',
          resolve(homedir(), 'Library/Keychains/login.keychain-db'),
          trustedCertificatePath,
        ],
        { stdio: 'inherit' },
      );
      if (result.status !== 0)
        throw new Error(
          'macOS did not confirm the local certificate trust request. The exact certificate was retained for retry or removal. No browser certificate bypass was applied.',
        );
      if (verify(trustedCertificatePath).status !== 0)
        throw new Error(
          'Trust was requested but macOS verification still failed. The exact certificate was retained for removal. Keep certificate checks enabled and inspect the trust settings.',
        );
      console.log(
        'Verified macOS trust for 127.0.0.1. Reload the Margin preview. Undo with npm run untrust:dev.',
      );
    } else {
      const result = spawnSync(
        '/usr/bin/security',
        ['remove-trusted-cert', trustedCertificatePath],
        {
          stdio: 'inherit',
        },
      );
      if (result.status !== 0)
        throw new Error(
          'The local certificate trust settings could not be removed. The exact certificate was retained for retry.',
        );
      if (existsSync(trustedCertificatePath)) unlinkSync(trustedCertificatePath);
      console.log(
        'Removed this certificate’s user trust settings. The local server files and encrypted vault are unchanged.',
      );
    }
  }
} finally {
  if (locked) rmdirSync(lockPath);
}
