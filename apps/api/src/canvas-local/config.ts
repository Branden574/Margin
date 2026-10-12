import { constants } from 'node:fs';
import { createPrivateKey, createPublicKey, X509Certificate } from 'node:crypto';
import { sep } from 'node:path';
import type { PoolConfig } from 'pg';
import {
  absolutePath,
  CanvasLocalConfigError,
  checkDedicatedDirectory,
  invalid,
  readProtectedFile,
  utf8,
} from './protected-files.js';

export { CanvasLocalConfigError } from './protected-files.js';
export const CANVAS_DATABASE_PURPOSES = [
  'identity',
  'lms',
  'assignments',
  'work',
  'ingestion',
  'sourceReader',
  'capture',
  'processor',
  'reviewer',
  'provisioner',
] as const;
export type CanvasDatabasePurpose = (typeof CANVAS_DATABASE_PURPOSES)[number];
const SECRET_PURPOSES = ['wrapping', 'session', 'identity', 'lms', 'resource'] as const;
type SecretPurpose = (typeof SECRET_PURPOSES)[number];
/** JSON.parse alone silently accepts duplicate keys, including escaped spellings. */
function strictJson(text: string): unknown {
  const parsed: unknown = JSON.parse(text);
  const scopes: Array<Set<string> | null> = [];
  for (let index = 0; index < text.length; index++) {
    const character = text[index];
    if (character === '{' || character === '[') {
      scopes.push(character === '{' ? new Set() : null);
      if (scopes.length > 16) throw new Error();
    } else if (character === '}' || character === ']') scopes.pop();
    else if (character === '"') {
      const start = index++;
      while (index < text.length && text[index] !== '"') {
        if (text[index] === '\\') index++;
        index++;
      }
      let after = index + 1;
      while (/\s/.test(text[after] ?? '') && after < text.length) after++;
      if (text[after] === ':') {
        const key = JSON.parse(text.slice(start, index + 1)) as string,
          keys = scopes.at(-1);
        if (!keys || keys.has(key)) throw new Error();
        keys.add(key);
      }
    }
  }
  return parsed;
}
export interface CanvasLocalConfiguration {
  schema: 1;
  applicationOrigin: string;
  listener: { host: '127.0.0.1'; port: number };
  artifactDirectory: string;
  dataDirectory: string;
  captureEnabled: boolean;
  wrappingKeyId: string;
  secrets: Record<SecretPurpose, Buffer>;
  toolSigning: { kid: string; privateKeyPem: Buffer };
  tls: { key: Buffer; cert: Buffer };
  databases: Record<CanvasDatabasePurpose, PoolConfig>;
}
interface References
  extends Omit<CanvasLocalConfiguration, 'secrets' | 'toolSigning' | 'tls' | 'databases'> {
  secrets: Record<SecretPurpose, string>;
  toolSigning: { kid: string; privateKeyFile: string };
  tls: { keyFile: string; certFile: string };
  databaseCaFile: string;
  databases: Record<CanvasDatabasePurpose, string>;
}
function object(value: unknown, names: readonly string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).length !== names.length ||
    !names.every((name) => Object.hasOwn(value, name))
  )
    invalid(
      'invalid_schema',
      'Canvas configuration must use the exact supported schema without extra or missing fields.',
    );
  return value as Record<string, unknown>;
}
function keyId(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(value))
    invalid(
      'invalid_key_id',
      'Configure a stable bounded wrapping key ID and tool signing key ID.',
    );
  return value;
}
function origin(value: unknown): string {
  try {
    if (typeof value !== 'string' || value.length > 2048 || /[\u0000-\u0020\u007f]/.test(value))
      throw new Error();
    const parsed = new URL(value);
    if (
      parsed.protocol !== 'https:' ||
      parsed.hostname !== '127.0.0.1' ||
      !parsed.port ||
      Number(parsed.port) < 1024 ||
      Number(parsed.port) > 65535 ||
      parsed.origin !== value ||
      parsed.username ||
      parsed.password ||
      parsed.hash ||
      parsed.search
    )
      throw new Error();
    return value;
  } catch {
    return invalid(
      'invalid_origin',
      'Configure an exact HTTPS 127.0.0.1 origin with an explicit port from 1024 to 65535 and no path or query.',
    );
  }
}
function contains(directory: string, path: string) {
  return path === directory || path.startsWith(directory + sep);
}
function references(value: unknown, configPath: string): References {
  const root = object(value, [
    'schema',
    'applicationOrigin',
    'listener',
    'artifactDirectory',
    'dataDirectory',
    'captureEnabled',
    'secrets',
    'wrappingKeyId',
    'toolSigning',
    'tls',
    'databaseCaFile',
    'databases',
  ]);
  const listener = object(root.listener, ['host', 'port']),
    signing = object(root.toolSigning, ['kid', 'privateKeyFile']),
    tls = object(root.tls, ['keyFile', 'certFile']),
    rawSecrets = object(root.secrets, SECRET_PURPOSES),
    rawDatabases = object(root.databases, CANVAS_DATABASE_PURPOSES);
  if (root.schema !== 1 || typeof root.captureEnabled !== 'boolean')
    invalid('invalid_schema', 'Configure schema 1 and an explicit boolean capture policy.');
  if (
    listener.host !== '127.0.0.1' ||
    !Number.isSafeInteger(listener.port) ||
    (listener.port as number) < 1024 ||
    (listener.port as number) > 65535
  )
    invalid(
      'invalid_listener',
      'The local Canvas listener must use 127.0.0.1 and a port from 1024 to 65535.',
    );
  const parsed: References = {
    schema: 1,
    applicationOrigin: origin(root.applicationOrigin),
    listener: { host: '127.0.0.1', port: listener.port as number },
    artifactDirectory: absolutePath(root.artifactDirectory),
    dataDirectory: absolutePath(root.dataDirectory),
    captureEnabled: root.captureEnabled,
    wrappingKeyId: keyId(root.wrappingKeyId),
    secrets: Object.fromEntries(
      SECRET_PURPOSES.map((name) => [name, absolutePath(rawSecrets[name])]),
    ) as Record<SecretPurpose, string>,
    toolSigning: { kid: keyId(signing.kid), privateKeyFile: absolutePath(signing.privateKeyFile) },
    tls: { keyFile: absolutePath(tls.keyFile), certFile: absolutePath(tls.certFile) },
    databaseCaFile: absolutePath(root.databaseCaFile),
    databases: Object.fromEntries(
      CANVAS_DATABASE_PURPOSES.map((name) => [name, absolutePath(rawDatabases[name])]),
    ) as Record<CanvasDatabasePurpose, string>,
  };
  if (Number(new URL(parsed.applicationOrigin).port) === parsed.listener.port)
    invalid(
      'listener_collision',
      'The workspace and local Canvas API must use separate loopback ports.',
    );
  const protectedPaths = [
    configPath,
    ...Object.values(parsed.secrets),
    parsed.toolSigning.privateKeyFile,
    ...Object.values(parsed.tls),
    parsed.databaseCaFile,
    ...Object.values(parsed.databases),
  ];
  if (
    contains(parsed.artifactDirectory, parsed.dataDirectory) ||
    contains(parsed.dataDirectory, parsed.artifactDirectory) ||
    protectedPaths.some(
      (path) => contains(parsed.artifactDirectory, path) || contains(parsed.dataDirectory, path),
    )
  )
    invalid(
      'invalid_directory',
      'Artifact and API data directories must be separate and must not contain protected configuration files.',
    );
  if (new Set(protectedPaths).size !== protectedPaths.length)
    invalid('aliased_file', 'Each protected configuration input must have its own file reference.');
  return parsed;
}
function secret(bytes: Buffer): Buffer {
  const value = utf8(bytes).replace(/\r?\n$/, '');
  const key = Buffer.from(value, 'base64');
  if (key.length !== 32 || key.toString('base64') !== value) {
    key.fill(0);
    invalid(
      'invalid_secret',
      'Each secret file must contain one canonical base64-encoded 32-byte key.',
    );
  }
  return key;
}
function privatePem(bytes: Buffer) {
  try {
    const pem = utf8(bytes);
    if (
      !/^-----BEGIN PRIVATE KEY-----\r?\n[A-Za-z0-9+/=\r\n]+-----END PRIVATE KEY-----\r?\n?$/.test(
        pem,
      )
    )
      throw new Error();
    return createPrivateKey(pem);
  } catch {
    return invalid(
      'invalid_private_key',
      'Configure an unencrypted PKCS8 private key in a protected file.',
    );
  }
}
function certificates(bytes: Buffer, ca: boolean): X509Certificate[] {
  try {
    const pem = utf8(bytes),
      blocks = pem.match(
        /-----BEGIN CERTIFICATE-----\r?\n[A-Za-z0-9+/=\r\n]+-----END CERTIFICATE-----/g,
      );
    if (
      !blocks?.length ||
      blocks.length > 8 ||
      blocks.join('').replace(/\s/g, '') !== pem.replace(/\s/g, '')
    )
      throw new Error();
    const now = Date.now(),
      parsed = blocks.map((block) => new X509Certificate(block));
    if (
      parsed.some(
        (cert) =>
          cert.ca !== ca || Date.parse(cert.validFrom) > now || Date.parse(cert.validTo) <= now,
      )
    )
      throw new Error();
    return parsed;
  } catch {
    return invalid(
      'invalid_certificate',
      'Configure current certificates with the correct server or CA purpose.',
    );
  }
}
function database(bytes: Buffer, ca: string, purpose: CanvasDatabasePurpose): PoolConfig {
  try {
    const value = utf8(bytes).replace(/\r?\n$/, ''),
      url = new URL(value);
    if (
      value.length > 8192 ||
      /[\u0000-\u0020\u007f]/.test(value) ||
      url.href !== value ||
      url.protocol !== 'postgresql:' ||
      !url.hostname ||
      !url.port ||
      url.search ||
      url.hash
    )
      throw new Error();
    const user = decodeURIComponent(url.username),
      password = decodeURIComponent(url.password),
      db = decodeURIComponent(url.pathname.slice(1));
    if (
      !/^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/.test(user) ||
      !password ||
      password.length > 1024 ||
      /[\u0000-\u001f\u007f]/.test(password) ||
      !/^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/.test(db) ||
      url.username !== encodeURIComponent(user) ||
      url.password !== encodeURIComponent(password) ||
      url.pathname !== '/' + encodeURIComponent(db) ||
      url.hostname !== url.hostname.toLowerCase() ||
      Number(url.port) < 1 ||
      Number(url.port) > 65535 ||
      String(Number(url.port)) !== url.port
    )
      throw new Error();
    return {
      host: url.hostname.replace(/^\[|\]$/g, ''),
      port: Number(url.port),
      user,
      password,
      database: db,
      ssl: { ca, rejectUnauthorized: true },
      sslnegotiation: 'postgres',
      options: '-c search_path=pg_catalog',
      client_encoding: 'UTF8',
      connectionTimeoutMillis: 5000,
      application_name: 'margin-canvas-' + purpose,
    };
  } catch {
    return invalid(
      'invalid_database',
      'Configure canonical PostgreSQL URLs with explicit host, port, database and credentials, without query or fragment overrides.',
    );
  }
}

/** Reads only. No environment fallback, database connection, directory creation, or provider construction. */
export async function loadCanvasLocalConfig(
  configPath: string,
): Promise<{ configuration: CanvasLocalConfiguration; dispose(): void }> {
  if (
    process.env.NODE_ENV === 'production' ||
    process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0' ||
    process.env.PGREPLICATION ||
    process.env.PGBINARY
  )
    invalid(
      'unsafe_environment',
      'Local Canvas configuration is unavailable in production or with TLS verification disabled.',
    );
  if (!process.getuid || !constants.O_NOFOLLOW || !constants.O_DIRECTORY)
    invalid(
      'unsupported_filesystem',
      'Protected local Canvas configuration requires POSIX ownership and no-follow support.',
    );
  const buffers: Buffer[] = [],
    retained = new Set<Buffer>();
  const dispose = () => {
    for (const bytes of buffers) bytes.fill(0);
  };
  const read = async (path: string, maximum: number) => {
    const bytes = await readProtectedFile(path, maximum);
    buffers.push(bytes);
    return bytes;
  };
  try {
    const raw = await read(absolutePath(configPath), 65536);
    let json: unknown;
    try {
      json = strictJson(utf8(raw));
    } catch {
      invalid('invalid_json', 'The protected Canvas configuration must contain valid UTF-8 JSON.');
    }
    const refs = references(json, configPath);
    raw.fill(0);
    await checkDedicatedDirectory(refs.artifactDirectory);
    await checkDedicatedDirectory(refs.dataDirectory);
    const secrets = {} as Record<SecretPurpose, Buffer>;
    for (const name of SECRET_PURPOSES) {
      const encoded = await read(refs.secrets[name], 8192),
        key = secret(encoded);
      encoded.fill(0);
      buffers.push(key);
      retained.add(key);
      secrets[name] = key;
    }
    if (
      SECRET_PURPOSES.some((name, i) =>
        SECRET_PURPOSES.slice(0, i).some((previous) => secrets[previous].equals(secrets[name])),
      )
    )
      invalid(
        'shared_secret',
        'Wrapping, session, identity, LMS and resource keys must be independent.',
      );
    const signingPem = await read(refs.toolSigning.privateKeyFile, 16384),
      signer = privatePem(signingPem);
    if (
      signer.asymmetricKeyType !== 'rsa' ||
      (signer.asymmetricKeyDetails?.modulusLength ?? 0) < 2048 ||
      (signer.asymmetricKeyDetails?.modulusLength ?? 0) > 4096
    )
      invalid('invalid_signing_key', 'The tool signing key must be RSA with 2048 to 4096 bits.');
    const tlsKey = await read(refs.tls.keyFile, 16384),
      tlsCert = await read(refs.tls.certFile, 65536),
      transportKey = privatePem(tlsKey),
      leaves = certificates(tlsCert, false);
    if (
      leaves.length !== 1 ||
      !leaves[0].checkPrivateKey(transportKey) ||
      !leaves[0].checkIP('127.0.0.1') ||
      !leaves[0].keyUsage?.includes('1.3.6.1.5.5.7.3.1')
    )
      invalid(
        'invalid_tls_pair',
        'The API server certificate must match its key and allow HTTPS on 127.0.0.1.',
      );
    if (
      createPublicKey(signer)
        .export({ type: 'spki', format: 'der' })
        .equals(createPublicKey(transportKey).export({ type: 'spki', format: 'der' }))
    )
      invalid(
        'shared_private_key',
        'Tool signing and API transport must use separate private keys.',
      );
    const caBytes = await read(refs.databaseCaFile, 65536);
    certificates(caBytes, true);
    const ca = utf8(caBytes),
      databases = {} as Record<CanvasDatabasePurpose, PoolConfig>;
    for (const name of CANVAS_DATABASE_PURPOSES) {
      const bytes = await read(refs.databases[name], 8192);
      databases[name] = database(bytes, ca, name);
      bytes.fill(0);
    }
    const expected = databases.identity;
    if (
      new Set(Object.values(databases).map((db) => db.user)).size !==
        CANVAS_DATABASE_PURPOSES.length ||
      Object.values(databases).some(
        (db) =>
          db.host !== expected.host ||
          db.port !== expected.port ||
          db.database !== expected.database,
      )
    )
      invalid(
        'database_isolation',
        'Use distinct database logins for every purpose on the same explicit server, port and database.',
      );
    for (const bytes of [signingPem, tlsKey, tlsCert]) retained.add(bytes);
    for (const bytes of buffers) if (!retained.has(bytes)) bytes.fill(0);
    const configuration: CanvasLocalConfiguration = {
      schema: 1,
      applicationOrigin: refs.applicationOrigin,
      listener: refs.listener,
      artifactDirectory: refs.artifactDirectory,
      dataDirectory: refs.dataDirectory,
      captureEnabled: refs.captureEnabled,
      wrappingKeyId: refs.wrappingKeyId,
      secrets,
      toolSigning: { kid: refs.toolSigning.kid, privateKeyPem: signingPem },
      tls: { key: tlsKey, cert: tlsCert },
      databases,
    };
    // Callers own their provider snapshots. Disposal clears our byte buffers; immutable strings/KeyObjects remain subject to GC.
    return { configuration, dispose };
  } catch (reason) {
    dispose();
    if (reason instanceof CanvasLocalConfigError) throw reason;
    return invalid(
      'configuration_unavailable',
      'Protected Canvas configuration could not be loaded.',
    );
  }
}
