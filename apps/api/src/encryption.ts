import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';

export interface WrappedDataKey {
  provider: string;
  keyId: string;
  iv: string;
  tag: string;
  ciphertext: string;
}
/** Cloud adapters must call their KMS wrap/unwrap APIs and bind the same context. No cloud KMS is configured here. */
export interface KeyManagementProvider {
  wrapKey(key: Buffer, context: string): Promise<WrappedDataKey>;
  unwrapKey(envelope: WrappedDataKey, context: string): Promise<Buffer>;
}
function seal(key: Buffer, plain: Buffer, context: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: 16 });
  cipher.setAAD(Buffer.from(context));
  const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()]);
  return { ciphertext, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64') };
}
function unseal(key: Buffer, ciphertext: Buffer, iv: string, tag: string, context: string) {
  const nonce = Buffer.from(iv, 'base64');
  const authTag = Buffer.from(tag, 'base64');
  if (nonce.length !== 12 || authTag.length !== 16) throw new Error('Invalid encryption envelope.');
  const decipher = createDecipheriv('aes-256-gcm', key, nonce, { authTagLength: 16 });
  decipher.setAAD(Buffer.from(context));
  decipher.setAuthTag(authTag);
  // Do not expose update() output before final() authenticates the ciphertext.
  const pending = decipher.update(ciphertext);
  try {
    return Buffer.concat([pending, decipher.final()]);
  } catch (error) {
    pending.fill(0);
    throw error;
  }
}
/** Development-only KEK provider using standard Node/OpenSSL AES-256-GCM. Replace with managed KMS before deployment. */
export class LocalKeyProvider implements KeyManagementProvider {
  private readonly key: Buffer;
  constructor(
    key: Buffer,
    private readonly keyId = 'local-development-key-v1',
  ) {
    if (key.length !== 32)
      throw new Error('The local encryption master key must contain exactly 32 bytes.');
    this.key = Buffer.from(key);
  }
  async wrapKey(key: Buffer, context: string): Promise<WrappedDataKey> {
    const sealed = seal(this.key, key, `margin-wrap-v1:${context}`);
    return {
      provider: 'local-aes-256-gcm',
      keyId: this.keyId,
      iv: sealed.iv,
      tag: sealed.tag,
      ciphertext: sealed.ciphertext.toString('base64'),
    };
  }
  async unwrapKey(envelope: WrappedDataKey, context: string) {
    if (envelope.provider !== 'local-aes-256-gcm' || envelope.keyId !== this.keyId)
      throw new Error('The encryption key provider does not match this object.');
    const key = unseal(
      this.key,
      Buffer.from(envelope.ciphertext, 'base64'),
      envelope.iv,
      envelope.tag,
      `margin-wrap-v1:${context}`,
    );
    if (key.length !== 32) {
      key.fill(0);
      throw new Error('Invalid data encryption key.');
    }
    return key;
  }
}
interface Envelope {
  version: 1;
  algorithm: 'AES-256-GCM';
  iv: string;
  tag: string;
  wrappedKey: WrappedDataKey;
}
async function atomicWrite(path: string, bytes: Buffer) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${randomUUID()}.tmp`;
  const file = await open(temp, 'wx', 0o600);
  try {
    await file.writeFile(bytes);
    await file.sync();
  } finally {
    await file.close();
  }
  await rename(temp, path);
}
/** Each artifact gets a new 256-bit DEK. Only ciphertext and wrapped-key metadata reach disk. */
export class EncryptedStore {
  private readonly root: string;
  constructor(
    root: string,
    private readonly provider: KeyManagementProvider,
  ) {
    this.root = resolve(root);
  }
  private context(path: string) {
    const value = relative(this.root, resolve(path));
    if (!value || value.startsWith('..') || value.startsWith('/'))
      throw new Error('Encrypted object path is outside the storage namespace.');
    return value;
  }
  private envelopePath(generation: string) {
    if (!/^[a-f0-9]{32}$/.test(generation)) throw new Error('Invalid encrypted object header.');
    return join(this.root, 'key-envelopes', `${generation}.json`);
  }
  async write(path: string, plaintext: Buffer) {
    const context = this.context(path);
    const generation = randomUUID().replaceAll('-', '');
    const boundContext = `${context}:${generation}`;
    const key = randomBytes(32);
    let priorGeneration: string | undefined;
    try {
      priorGeneration = (await readFile(path)).subarray(4, 36).toString('ascii');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    try {
      const sealed = seal(key, plaintext, boundContext);
      const envelope: Envelope = {
        version: 1,
        algorithm: 'AES-256-GCM',
        iv: sealed.iv,
        tag: sealed.tag,
        wrappedKey: await this.provider.wrapKey(key, boundContext),
      };
      // Sidecar first, then atomically replace ciphertext. A crash never points old ciphertext at a new key.
      await atomicWrite(this.envelopePath(generation), Buffer.from(JSON.stringify(envelope)));
      await atomicWrite(
        path,
        Buffer.concat([Buffer.from(`MGE1${generation}`, 'ascii'), sealed.ciphertext]),
      );
      if (priorGeneration && /^[a-f0-9]{32}$/.test(priorGeneration))
        await rm(this.envelopePath(priorGeneration), { force: true });
    } finally {
      key.fill(0);
    }
  }
  async read(path: string): Promise<Buffer> {
    const bytes = await readFile(path);
    if (bytes.subarray(0, 4).toString('ascii') !== 'MGE1')
      throw new Error('Plaintext or unsupported storage objects are not accepted.');
    const generation = bytes.subarray(4, 36).toString('ascii');
    const context = `${this.context(path)}:${generation}`;
    const envelope = JSON.parse(await readFile(this.envelopePath(generation), 'utf8')) as Envelope;
    if (envelope.version !== 1 || envelope.algorithm !== 'AES-256-GCM')
      throw new Error('Unsupported encryption envelope.');
    const key = await this.provider.unwrapKey(envelope.wrappedKey, context);
    try {
      return unseal(key, bytes.subarray(36), envelope.iv, envelope.tag, context);
    } finally {
      key.fill(0);
    }
  }
  async writeJson(path: string, value: unknown) {
    const bytes = Buffer.from(JSON.stringify(value));
    try {
      await this.write(path, bytes);
    } finally {
      bytes.fill(0);
    }
  }
  async readJson<T>(path: string): Promise<T> {
    const bytes = await this.read(path);
    try {
      return JSON.parse(bytes.toString('utf8')) as T;
    } finally {
      bytes.fill(0);
    }
  }
  async delete(path: string) {
    try {
      const generation = (await readFile(path)).subarray(4, 36).toString('ascii');
      await rm(path, { force: true });
      if (/^[a-f0-9]{32}$/.test(generation))
        await rm(this.envelopePath(generation), { force: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
}
