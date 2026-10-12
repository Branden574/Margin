import { execFileSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CANVAS_DATABASE_PURPOSES,
  CanvasLocalConfigError,
  loadCanvasLocalConfig,
} from '../apps/api/src/canvas-local/config';

const hooks = vi.hoisted(() => ({
  observed: [] as Buffer[],
  wrongOwnerPath: '',
  afterRead: undefined as ((path: string) => Promise<void>) | undefined,
}));
vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof import('node:fs/promises')>();
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args),
        read = handle.read.bind(handle),
        stat = handle.stat.bind(handle);
      handle.read = (async (
        buffer: Buffer,
        offset: number,
        length: number,
        position: number | null,
      ) => {
        hooks.observed.push(buffer);
        const result = await read(buffer, offset, length, position);
        await hooks.afterRead?.(String(args[0]));
        return result;
      }) as typeof handle.read;
      handle.stat = (async (...statArgs: Parameters<typeof stat>) => {
        const result = await stat(...statArgs);
        if (String(args[0]) === hooks.wrongOwnerPath) result.uid = Number(result.uid) + 1;
        return result;
      }) as typeof handle.stat;
      return handle;
    },
  };
});
let base: string, directory: string, configPath: string;
let signingPem: Buffer, serverKey: Buffer, serverCert: Buffer, caCert: Buffer;
const loaded: Array<Awaited<ReturnType<typeof loadCanvasLocalConfig>>> = [];
type Input = {
  schema: number;
  applicationOrigin: string;
  listener: { host: string; port: number };
  artifactDirectory: string;
  dataDirectory: string;
  captureEnabled: boolean;
  wrappingKeyId: string;
  secrets: Record<'wrapping' | 'session' | 'identity' | 'lms' | 'resource', string>;
  toolSigning: { kid: string; privateKeyFile: string };
  tls: { keyFile: string; certFile: string };
  databaseCaFile: string;
  databases: Record<(typeof CANVAS_DATABASE_PURPOSES)[number], string>;
};
let input: Input;
async function protectedWrite(path: string, value: string | Buffer) {
  await writeFile(path, value, { mode: 0o600 });
}
async function save(value: unknown = input) {
  await protectedWrite(configPath, JSON.stringify(value));
}
async function load() {
  const result = await loadCanvasLocalConfig(configPath);
  loaded.push(result);
  return result;
}
async function url(purpose: (typeof CANVAS_DATABASE_PURPOSES)[number], value: string) {
  await protectedWrite(input.databases[purpose], value + '\n');
}
const databaseUrl = (user = 'canvas_identity') =>
  `postgresql://${user}:generated-test-password@127.0.0.1:55439/margin_canvas`;
beforeAll(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), 'margin-canvas-config-')));
  const tls = join(base, 'generated');
  await mkdir(tls, { mode: 0o700 });
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-sha256',
      '-days',
      '2',
      '-subj',
      '/CN=127.0.0.1',
      '-keyout',
      join(tls, 'server.key'),
      '-out',
      join(tls, 'server.crt'),
      '-addext',
      'basicConstraints=critical,CA:FALSE',
      '-addext',
      'extendedKeyUsage=serverAuth',
      '-addext',
      'subjectAltName=IP:127.0.0.1',
    ],
    { stdio: 'pipe' },
  );
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-sha256',
      '-days',
      '2',
      '-subj',
      '/CN=CanvasTestCA',
      '-keyout',
      join(tls, 'ca.key'),
      '-out',
      join(tls, 'ca.crt'),
      '-addext',
      'basicConstraints=critical,CA:TRUE,pathlen:0',
      '-addext',
      'keyUsage=critical,keyCertSign,cRLSign',
    ],
    { stdio: 'pipe' },
  );
  serverKey = await readFile(join(tls, 'server.key'));
  serverCert = await readFile(join(tls, 'server.crt'));
  caCert = await readFile(join(tls, 'ca.crt'));
  signingPem = Buffer.from(
    generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({
      type: 'pkcs8',
      format: 'pem',
    }),
  );
});
afterAll(async () => {
  for (const bytes of [signingPem, serverKey, serverCert, caCert]) bytes.fill(0);
  await rm(base, { recursive: true, force: true });
});
beforeEach(async () => {
  hooks.observed.length = 0;
  hooks.wrongOwnerPath = '';
  hooks.afterRead = undefined;
  directory = await mkdtemp(join(base, 'case-'));
  configPath = join(directory, 'config.json');
  input = {
    schema: 1,
    applicationOrigin: 'https://127.0.0.1:5174',
    listener: { host: '127.0.0.1', port: 4101 },
    artifactDirectory: join(directory, 'artifacts'),
    dataDirectory: join(directory, 'data'),
    captureEnabled: true,
    wrappingKeyId: 'canvas-wrapping-v1',
    secrets: {
      wrapping: join(directory, 'wrapping.key'),
      session: join(directory, 'session.key'),
      identity: join(directory, 'identity.key'),
      lms: join(directory, 'lms.key'),
      resource: join(directory, 'resource.key'),
    },
    toolSigning: { kid: 'canvas-tool-v1', privateKeyFile: join(directory, 'signing.pem') },
    tls: { keyFile: join(directory, 'api.key'), certFile: join(directory, 'api.crt') },
    databaseCaFile: join(directory, 'database-ca.pem'),
    databases: Object.fromEntries(
      CANVAS_DATABASE_PURPOSES.map((name) => [name, join(directory, name + '.url')]),
    ) as Input['databases'],
  };
  for (const [index, path] of Object.values(input.secrets).entries())
    await protectedWrite(path, Buffer.alloc(32, index + 1).toString('base64') + '\n');
  await protectedWrite(input.toolSigning.privateKeyFile, signingPem);
  await protectedWrite(input.tls.keyFile, serverKey);
  await protectedWrite(input.tls.certFile, serverCert);
  await protectedWrite(input.databaseCaFile, caCert);
  for (const name of CANVAS_DATABASE_PURPOSES) await url(name, databaseUrl('canvas_' + name));
  await save();
});
afterEach(async () => {
  hooks.afterRead = undefined;
  hooks.wrongOwnerPath = '';
  for (const result of loaded.splice(0)) result.dispose();
  vi.unstubAllEnvs();
  await rm(directory, { recursive: true, force: true });
});

describe('protected Canvas local configuration', () => {
  it('rejects duplicate JSON properties including escaped spellings and nested keys', async () => {
    const text = JSON.stringify(input);
    for (const duplicate of [
      text.slice(0, -1) + ',"applicationOrigin":"https://127.0.0.1:8888"}',
      text.slice(0, -1) + ',"application\\u004frigin":"https://127.0.0.1:8888"}',
      text.replace('"port":4101', '"port":4101,"port":4102'),
    ]) {
      await protectedWrite(configPath, duplicate);
      await expect(load()).rejects.toMatchObject({ code: 'invalid_json' });
    }
  });
  it('loads explicit isolated pool settings and owned key buffers without changing files or creating data directories', async () => {
    const before = await readFile(configPath),
      keyBefore = await readFile(input.secrets.wrapping),
      result = await load();
    expect(result.configuration.applicationOrigin).toBe(input.applicationOrigin);
    expect(result.configuration.listener).toEqual(input.listener);
    expect(result.configuration.secrets.wrapping).toEqual(Buffer.alloc(32, 1));
    expect(result.configuration.toolSigning.privateKeyPem).toEqual(signingPem);
    expect(result.configuration.tls).toEqual({ key: serverKey, cert: serverCert });
    for (const name of CANVAS_DATABASE_PURPOSES)
      expect(result.configuration.databases[name]).toMatchObject({
        host: '127.0.0.1',
        port: 55439,
        user: 'canvas_' + name,
        database: 'margin_canvas',
        password: 'generated-test-password',
        ssl: { ca: caCert.toString(), rejectUnauthorized: true },
        sslnegotiation: 'postgres',
        options: '-c search_path=pg_catalog',
        client_encoding: 'UTF8',
      });
    expect(await readFile(configPath)).toEqual(before);
    expect(await readFile(input.secrets.wrapping)).toEqual(keyBefore);
    await expect(lstat(input.artifactDirectory)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(lstat(input.dataDirectory)).rejects.toMatchObject({ code: 'ENOENT' });
    const bytes = [
      ...Object.values(result.configuration.secrets),
      result.configuration.toolSigning.privateKeyPem,
      result.configuration.tls.key,
      result.configuration.tls.cert,
    ];
    result.dispose();
    result.dispose();
    expect(bytes.every((buffer) => buffer.every((byte) => byte === 0))).toBe(true);
    expect(await readFile(input.toolSigning.privateKeyFile)).toEqual(signingPem);
  });
  it('snapshots configuration references before later asynchronous file reads', async () => {
    const expected = input.applicationOrigin;
    hooks.afterRead = async (path) => {
      if (path !== input.secrets.wrapping) return;
      hooks.afterRead = undefined;
      input.applicationOrigin = 'https://127.0.0.1:8888';
      input.secrets.resource = '/unavailable/mutated-secret';
      await save();
    };
    expect((await load()).configuration.applicationOrigin).toBe(expected);
  });
  it('does not inherit PostgreSQL or application configuration from ambient environment', async () => {
    for (const [name, value] of Object.entries({
      PGHOST: 'wrong.invalid',
      PGPORT: '1',
      PGDATABASE: 'wrong',
      PGUSER: 'wrong',
      PGPASSWORD: 'wrong',
      PGSSLMODE: 'disable',
      PGOPTIONS: '-c search_path=public',
      PGCLIENT_ENCODING: 'LATIN1',
      PGSSLNEGOTIATION: 'direct',
      MARGIN_MASTER_KEY: 'not-used',
      MARGIN_APPLICATION_ORIGIN: 'https://wrong.invalid',
    }))
      vi.stubEnv(name, value);
    const result = await load();
    expect(result.configuration.databases.identity).toMatchObject({
      host: '127.0.0.1',
      port: 55439,
      user: 'canvas_identity',
      options: '-c search_path=pg_catalog',
      sslnegotiation: 'postgres',
      client_encoding: 'UTF8',
      ssl: { rejectUnauthorized: true },
    });
    expect(result.configuration.applicationOrigin).toBe(input.applicationOrigin);
  });
  it.each([
    ['NODE_ENV', 'production'],
    ['NODE_TLS_REJECT_UNAUTHORIZED', '0'],
    ['PGREPLICATION', 'database'],
    ['PGBINARY', '1'],
  ])('fails closed for %s without opening input', async (name, value) => {
    vi.stubEnv(name, value);
    await expect(loadCanvasLocalConfig('/nonexistent/config.json')).rejects.toMatchObject({
      code: 'unsafe_environment',
    });
    expect(hooks.observed).toEqual([]);
  });
  it.each(['schema', 'listener', 'secrets', 'databases', 'captureEnabled'])(
    'rejects missing %s',
    async (field) => {
      const changed = { ...input } as Record<string, unknown>;
      delete changed[field];
      await save(changed);
      await expect(load()).rejects.toMatchObject({ code: 'invalid_schema' });
    },
  );
  it.each(['operatorDatabase', '__proto__', 'scanner', 'developmentBypass'])(
    'rejects unsupported root field %s',
    async (field) => {
      await protectedWrite(
        configPath,
        JSON.stringify(input).slice(0, -1) + `,${JSON.stringify(field)}:"disallowed"}`,
      );
      await expect(load()).rejects.toMatchObject({ code: 'invalid_schema' });
    },
  );
  it('rejects unknown nested fields and nonboolean policy', async () => {
    await save({ ...input, tls: { ...input.tls, rejectUnauthorized: false } });
    await expect(load()).rejects.toMatchObject({ code: 'invalid_schema' });
    await save({ ...input, captureEnabled: 'false' });
    await expect(load()).rejects.toMatchObject({ code: 'invalid_schema' });
  });
  it.each([
    'http://127.0.0.1:5174',
    'https://localhost:5174',
    'https://127.0.0.1',
    'https://127.0.0.1:443',
    'https://127.0.0.1:99',
    'https://127.0.0.1:5174/',
    'https://127.0.0.1:5174?x=1',
    'https://u:p@127.0.0.1:5174',
    'https://127.0.0.1:5174#fragment',
  ])('rejects application origin %s', async (value) => {
    input.applicationOrigin = value;
    await save();
    await expect(load()).rejects.toMatchObject({ code: 'invalid_origin' });
  });
  it.each([
    { host: '0.0.0.0', port: 4101 },
    { host: 'localhost', port: 4101 },
    { host: '127.0.0.1', port: 443 },
    { host: '127.0.0.1', port: 65536 },
    { host: '127.0.0.1', port: 4101.5 },
  ])('rejects unsafe listener %#', async (value) => {
    input.listener = value;
    await save();
    await expect(load()).rejects.toMatchObject({ code: 'invalid_listener' });
  });
  it('rejects a workspace origin on the API listener port', async () => {
    input.applicationOrigin = 'https://127.0.0.1:4101';
    await save();
    await expect(load()).rejects.toMatchObject({ code: 'listener_collision' });
  });
  it.each(['relative/key', '/', '/some/../key', '/some/key/'])(
    'rejects noncanonical file reference %s',
    async (value) => {
      input.secrets.wrapping = value;
      await save();
      await expect(load()).rejects.toMatchObject({ code: 'invalid_path' });
    },
  );
  it('rejects overlapping data directories and protected files inside data storage', async () => {
    input.dataDirectory = input.artifactDirectory;
    await save();
    await expect(load()).rejects.toMatchObject({ code: 'invalid_directory' });
    input.dataDirectory = join(directory, 'data');
    input.artifactDirectory = directory;
    await save();
    await expect(load()).rejects.toMatchObject({ code: 'invalid_directory' });
  });
  it('rejects existing data directories with unsafe permissions without changing them', async () => {
    await mkdir(input.artifactDirectory, { mode: 0o755 });
    await expect(load()).rejects.toMatchObject({ code: 'unsafe_file' });
    expect((await lstat(input.artifactDirectory)).mode & 0o777).toBe(0o755);
  });
  it.each(['config', 'secret', 'url', 'certificate'])(
    'refuses a world-readable %s file',
    async (kind) => {
      const path =
        kind === 'config'
          ? configPath
          : kind === 'secret'
            ? input.secrets.wrapping
            : kind === 'url'
              ? input.databases.identity
              : input.tls.certFile;
      await chmod(path, 0o644);
      await expect(load()).rejects.toMatchObject({ code: 'unsafe_file' });
      expect((await lstat(path)).mode & 0o777).toBe(0o644);
    },
  );
  it('refuses a file owned by another uid', async () => {
    hooks.wrongOwnerPath = input.secrets.wrapping;
    await expect(load()).rejects.toMatchObject({ code: 'unsafe_file' });
  });
  it.each(['config', 'secret'])('rejects a symbolic link for %s', async (kind) => {
    const path = kind === 'config' ? configPath : input.secrets.wrapping,
      original = path + '.original';
    await protectedWrite(original, await readFile(path));
    await unlink(path);
    await symlink(original, path);
    await expect(load()).rejects.toMatchObject({ code: 'unsafe_file' });
  });
  it('rejects symbolic-link ancestors', async () => {
    const alias = join(base, 'alias-' + directory.split('/').at(-1));
    await symlink(directory, alias);
    try {
      await expect(loadCanvasLocalConfig(join(alias, 'config.json'))).rejects.toMatchObject({
        code: 'unsafe_file',
      });
    } finally {
      await unlink(alias);
    }
  });
  it('rejects a FIFO promptly without waiting for a writer', async () => {
    await unlink(input.secrets.wrapping);
    execFileSync('mkfifo', [input.secrets.wrapping]);
    await chmod(input.secrets.wrapping, 0o600);
    await expect(load()).rejects.toMatchObject({ code: 'unsafe_file' });
  }, 2000);
  it('rejects a file changed during a bounded read and clears its temporary buffer', async () => {
    hooks.afterRead = async (path) => {
      if (path !== input.secrets.wrapping) return;
      hooks.afterRead = undefined;
      await protectedWrite(path, Buffer.alloc(100, 65));
    };
    await expect(load()).rejects.toMatchObject({ code: 'file_changed' });
    expect(hooks.observed.every((buffer) => buffer.every((byte) => byte === 0))).toBe(true);
  });
  it.each([
    Buffer.alloc(0),
    Buffer.alloc(65537, 32),
    Buffer.from([123, 255, 125]),
    Buffer.from('{invalid json}'),
  ])('rejects malformed or unbounded configuration %# without echoing it', async (bytes) => {
    await protectedWrite(configPath, bytes);
    await expect(load()).rejects.toBeInstanceOf(CanvasLocalConfigError);
  });
  it.each([
    'not-base64',
    Buffer.alloc(31).toString('base64'),
    Buffer.alloc(33).toString('base64'),
    Buffer.alloc(32).toString('base64') + ' ',
    ' ' + Buffer.alloc(32).toString('base64'),
  ])('rejects malformed secret %#', async (value) => {
    await protectedWrite(input.secrets.wrapping, value);
    await expect(load()).rejects.toMatchObject({ code: 'invalid_secret' });
  });
  it('rejects aliased secret files and equal key material even with separate paths', async () => {
    input.secrets.session = input.secrets.wrapping;
    await save();
    await expect(load()).rejects.toMatchObject({ code: 'aliased_file' });
    input.secrets.session = join(directory, 'session.key');
    await save();
    await protectedWrite(input.secrets.session, await readFile(input.secrets.wrapping));
    await expect(load()).rejects.toMatchObject({ code: 'shared_secret' });
    expect(hooks.observed.every((buffer) => buffer.every((byte) => byte === 0))).toBe(true);
  });
  it.each(['../bad-id', '', 'x'.repeat(81)])(
    'rejects invalid wrapping/signing key IDs %#',
    async (value) => {
      input.wrappingKeyId = value;
      await save();
      await expect(load()).rejects.toMatchObject({ code: 'invalid_key_id' });
    },
  );
  it('rejects non-RSA tool signing keys and trailing private-key content', async () => {
    const ec = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    await protectedWrite(
      input.toolSigning.privateKeyFile,
      ec.privateKey.export({ type: 'pkcs8', format: 'pem' }),
    );
    await expect(load()).rejects.toMatchObject({ code: 'invalid_signing_key' });
    await protectedWrite(
      input.toolSigning.privateKeyFile,
      Buffer.concat([signingPem, Buffer.from('hidden content')]),
    );
    await expect(load()).rejects.toMatchObject({ code: 'invalid_private_key' });
  });
  it('rejects mismatched API keys, shared signing keys and leaf certificates supplied as a DB CA', async () => {
    await protectedWrite(input.tls.keyFile, signingPem);
    await expect(load()).rejects.toMatchObject({ code: 'invalid_tls_pair' });
    await protectedWrite(input.tls.keyFile, serverKey);
    await protectedWrite(input.toolSigning.privateKeyFile, serverKey);
    await expect(load()).rejects.toMatchObject({ code: 'shared_private_key' });
    await protectedWrite(input.toolSigning.privateKeyFile, signingPem);
    await protectedWrite(input.databaseCaFile, serverCert);
    await expect(load()).rejects.toMatchObject({ code: 'invalid_certificate' });
  });
  it.each([
    'postgres://canvas_identity:secret@127.0.0.1:55439/margin_canvas',
    'postgresql://canvas_identity:secret@127.0.0.1/margin_canvas',
    'postgresql://canvas_identity@127.0.0.1:55439/margin_canvas',
    databaseUrl() + '?sslmode=no-verify',
    databaseUrl() + '?application_name=x',
    databaseUrl() + '#x',
    'postgresql://canvas_identity:secret@127.0.0.1:55439/',
    'postgresql://%63anvas_identity:secret@127.0.0.1:55439/margin_canvas',
    'postgresql://canvas_identity:secret@127.0.0.1:55439/margin_canvas/other',
    'postgresql://canvas_identity:secret%0a@127.0.0.1:55439/margin_canvas',
  ])('rejects malformed or override-bearing database URL %#', async (value) => {
    await url('identity', value);
    await expect(load()).rejects.toMatchObject({ code: 'invalid_database' });
  });
  it.each(['user', 'host', 'port', 'database'])(
    'rejects database scope/login mismatch %s',
    async (field) => {
      const value =
        field === 'user'
          ? databaseUrl()
          : field === 'host'
            ? databaseUrl('canvas_lms').replace('127.0.0.1', 'localhost')
            : field === 'port'
              ? databaseUrl('canvas_lms').replace('55439', '55440')
              : databaseUrl('canvas_lms').replace('margin_canvas', 'other_database');
      await url('lms', value);
      await expect(load()).rejects.toMatchObject({ code: 'database_isolation' });
    },
  );
  it('does not leak protected bytes, file paths or a credential URL through errors and clears all read buffers on late failure', async () => {
    const marker = 'do-not-echo-this-credential';
    await url(
      'provisioner',
      'postgresql://canvas_provisioner:' +
        marker +
        '@127.0.0.1:55439/margin_canvas?sslmode=disable',
    );
    let failure: unknown;
    try {
      await load();
    } catch (reason) {
      failure = reason;
    }
    expect(failure).toBeInstanceOf(CanvasLocalConfigError);
    expect(String(failure)).not.toContain(marker);
    expect(String(failure)).not.toContain(directory);
    expect(hooks.observed.every((buffer) => buffer.every((byte) => byte === 0))).toBe(true);
  });
});
