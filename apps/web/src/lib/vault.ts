import { openDB, type DBSchema, type IDBPDatabase, type IDBPTransaction } from 'idb';

export const VAULT_DATABASE = 'margin-vault-v1';
export const VAULT_CHANGE_EVENT = 'margin-vault-change';
export const KDF_ITERATIONS = 600_000;
export type VaultStore =
  | 'documents'
  | 'blobs'
  | 'folders'
  | 'annotations'
  | 'assignments'
  | 'uploads'
  | 'settings';
export type VaultStatus = 'new' | 'locked' | 'unlocked';
interface Ciphertext {
  iv: Uint8Array<ArrayBuffer>;
  bytes: Uint8Array<ArrayBuffer>;
}
interface VaultConfiguration {
  id: 'vault';
  version: 1;
  vaultId: string;
  salt: Uint8Array<ArrayBuffer>;
  iterations: number;
  verifier: Ciphertext;
  revision: number;
}
interface EncryptedRecord {
  storageKey: string;
  store: VaultStore;
  vaultId: string;
  ciphertext: Ciphertext;
}
interface VaultDatabase extends DBSchema {
  public: { key: string; value: VaultConfiguration };
  records: { key: string; value: EncryptedRecord; indexes: { 'by-store': VaultStore } };
}
interface VaultSession {
  key: CryptoKey;
  config: VaultConfiguration;
  generation: number;
}
let connection: Promise<IDBPDatabase<VaultDatabase>> | undefined;
let session: VaultSession | undefined;
let generation = 0;
let lockChannel: BroadcastChannel | undefined;
let writeQueue: Promise<unknown> = Promise.resolve();
const activeWrites = new Set<
  IDBPTransaction<VaultDatabase, ('public' | 'records')[], 'readwrite'>
>();
const lockHandlers = new Set<() => void>();
const beforeLockHandlers = new Set<() => Promise<void>>();
const tabId = crypto.randomUUID();
const peers = new Set<string>();
const preparedLocks = new Set<string>();
const incomingLocks = new Map<string, string>();
const incomingLockTimers = new Map<string, ReturnType<typeof setTimeout>>();
let locking: Promise<void> | undefined;
let pendingLock:
  | { id: string; participants: Set<string>; ready: Set<string>; failed?: string }
  | undefined;
let pageHideListenerAdded = false;
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
const verificationText = 'Margin vault key verification v1';
const exportMagic = encoder.encode('MARGIN1\n');
const MAX_PACKAGE_BYTES = 110 * 1024 * 1024;

function randomBytes(length: number) {
  return crypto.getRandomValues(new Uint8Array(length));
}
function aad(vaultId: string, store: string, key: string) {
  return encoder.encode(JSON.stringify(['margin', 1, vaultId, store, key]));
}
function requireSession(): VaultSession {
  if (!session) throw new Error('Your vault is locked. Unlock it to access your documents.');
  return session;
}
function assertSession(expected: VaultSession) {
  if (session !== expected || generation !== expected.generation)
    throw new Error('Your vault was locked. This operation was stopped.');
}
/** Bind async work to the currently unlocked identity; a lock or re-unlock invalidates the operation. */
export function createVaultGuard(): () => void {
  const current = requireSession();
  return () => assertSession(current);
}
function ensureCrypto() {
  if (!globalThis.crypto?.subtle)
    throw new Error('Secure document storage requires Web Crypto in a secure browser context.');
}
async function database() {
  if (typeof indexedDB === 'undefined')
    throw new Error(
      'This browser does not support encrypted local storage. Enable IndexedDB and try again.',
    );
  if (!connection)
    connection = openDB<VaultDatabase>(VAULT_DATABASE, 1, {
      upgrade(db) {
        db.createObjectStore('public', { keyPath: 'id' });
        db.createObjectStore('records', { keyPath: 'storageKey' }).createIndex('by-store', 'store');
      },
      blocking() {
        void connection?.then((db) => db.close());
        connection = undefined;
        clearSession(true);
      },
      terminated() {
        connection = undefined;
        clearSession(true);
      },
    }).catch((error) => {
      connection = undefined;
      throw error;
    });
  return connection;
}
function validateConfiguration(config: VaultConfiguration) {
  if (
    config.version !== 1 ||
    !/^[a-f0-9-]{36}$/.test(config.vaultId) ||
    config.iterations !== KDF_ITERATIONS ||
    config.salt?.byteLength !== 32 ||
    !Number.isSafeInteger(config.revision)
  ) {
    throw new Error(
      'This vault configuration is unsupported or damaged. Its encrypted data has not been changed.',
    );
  }
}
async function deriveKey(passphrase: string, salt: Uint8Array<ArrayBuffer>, iterations: number) {
  ensureCrypto();
  if (typeof passphrase !== 'string' || passphrase.length > 1024)
    throw new Error('Use a passphrase no longer than 1,024 characters.');
  const material = await crypto.subtle.importKey(
    'raw',
    encoder.encode(passphrase),
    'PBKDF2',
    false,
    ['deriveKey'],
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}
async function encrypt(
  key: CryptoKey,
  bytes: Uint8Array<ArrayBuffer>,
  additionalData: Uint8Array<ArrayBuffer>,
): Promise<Ciphertext> {
  const iv = randomBytes(12);
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData, tagLength: 128 },
    key,
    bytes,
  );
  return { iv, bytes: new Uint8Array(ciphertext) };
}
async function decrypt(
  key: CryptoKey,
  encrypted: Ciphertext,
  additionalData: Uint8Array<ArrayBuffer>,
): Promise<Uint8Array<ArrayBuffer>> {
  if (
    !(encrypted.iv instanceof Uint8Array) ||
    encrypted.iv.byteLength !== 12 ||
    !(encrypted.bytes instanceof Uint8Array) ||
    encrypted.bytes.byteLength < 16
  )
    throw new Error('The encrypted record is malformed.');
  return new Uint8Array(
    await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: encrypted.iv, additionalData, tagLength: 128 },
      key,
      encrypted.bytes,
    ),
  );
}
function announce(status: VaultStatus, error?: string) {
  if (typeof window !== 'undefined')
    window.dispatchEvent(new CustomEvent(VAULT_CHANGE_EVENT, { detail: { status, error } }));
}
function announceLocking(locking: boolean) {
  if (typeof window !== 'undefined')
    window.dispatchEvent(
      new CustomEvent('margin-vault-locking', { detail: { active: locking, locking } }),
    );
}
function releaseIncomingLock(id: string) {
  const timer = incomingLockTimers.get(id);
  if (timer) clearTimeout(timer);
  incomingLockTimers.delete(id);
  incomingLocks.delete(id);
  preparedLocks.delete(id);
}
function listenForLocks() {
  if (typeof window === 'undefined' || typeof BroadcastChannel === 'undefined' || lockChannel)
    return;
  lockChannel = new BroadcastChannel('margin-vault-lock-v1');
  lockChannel.onmessage = (event) => {
    const message = event.data;
    if (
      !message ||
      typeof message !== 'object' ||
      !/^[a-f0-9-]{36}$/.test(message.sender ?? '') ||
      ![
        'hello',
        'hello-ack',
        'closed',
        'locked',
        'prepare-lock',
        'commit-lock',
        'abort-lock',
        'lock-present',
        'lock-ready',
        'lock-failed',
      ].includes(message.type)
    )
      return;
    if (
      message.type.includes('lock') &&
      message.type !== 'locked' &&
      !/^[a-f0-9-]{36}$/.test(message.requestId ?? '')
    )
      return;
    if (message?.vaultId !== session?.config.vaultId || message?.sender === tabId) return;
    if (message.type === 'hello' || message.type === 'hello-ack') {
      peers.add(message.sender);
      if (message.type === 'hello')
        lockChannel?.postMessage({
          type: 'hello-ack',
          vaultId: session?.config.vaultId,
          sender: tabId,
        });
    } else if (message.type === 'closed') {
      peers.delete(message.sender);
      pendingLock?.participants.delete(message.sender);
      for (const [id, sender] of incomingLocks)
        if (sender === message.sender) releaseIncomingLock(id);
      if (!incomingLocks.size && !pendingLock) announceLocking(false);
    } else if (message.type === 'locked') clearSession(false);
    else if (message.type === 'prepare-lock') {
      if (incomingLocks.has(message.requestId)) return;
      incomingLocks.set(message.requestId, message.sender);
      incomingLockTimers.set(
        message.requestId,
        setTimeout(() => {
          releaseIncomingLock(message.requestId);
          if (!incomingLocks.size && !pendingLock) announceLocking(false);
          announce(
            'unlocked',
            'The lock request from another tab expired. Your workspace remains unlocked so your edits are preserved.',
          );
          lockChannel?.postMessage({
            type: 'lock-failed',
            vaultId: session?.config.vaultId,
            sender: tabId,
            requestId: message.requestId,
          });
        }, 15_000),
      );
      announceLocking(true);
      lockChannel?.postMessage({
        type: 'lock-present',
        vaultId: session?.config.vaultId,
        sender: tabId,
        requestId: message.requestId,
      });
      void flushBeforeLock().then(
        () => {
          if (!incomingLocks.has(message.requestId)) return;
          preparedLocks.add(message.requestId);
          lockChannel?.postMessage({
            type: 'lock-ready',
            vaultId: session?.config.vaultId,
            sender: tabId,
            requestId: message.requestId,
          });
        },
        () => {
          releaseIncomingLock(message.requestId);
          const error = "Couldn't save latest edits. Retry saving before locking.";
          announceLocking(false);
          announce('unlocked', error);
          lockChannel?.postMessage({
            type: 'lock-failed',
            vaultId: session?.config.vaultId,
            sender: tabId,
            requestId: message.requestId,
            error,
          });
        },
      );
    } else if (message.type === 'commit-lock' && preparedLocks.has(message.requestId))
      clearSession(false);
    else if (message.type === 'abort-lock') {
      releaseIncomingLock(message.requestId);
      if (!incomingLocks.size && !pendingLock) announceLocking(false);
    } else if (pendingLock && pendingLock.id === message.requestId) {
      const pending = pendingLock;
      if (message.type === 'lock-present') pending.participants.add(message.sender);
      if (message.type === 'lock-ready') {
        pending.participants.add(message.sender);
        pending.ready.add(message.sender);
      }
      if (message.type === 'lock-failed')
        pending.failed = 'Another tab could not save its latest edits.';
    }
  };
  lockChannel.postMessage({ type: 'hello', vaultId: session?.config.vaultId, sender: tabId });
  if (!pageHideListenerAdded) {
    pageHideListenerAdded = true;
    window.addEventListener('pagehide', () => clearSession(false));
  }
}
function clearSession(broadcast: boolean) {
  const vaultId = session?.config.vaultId;
  if (broadcast && vaultId) lockChannel?.postMessage({ type: 'locked', vaultId, sender: tabId });
  if (vaultId) lockChannel?.postMessage({ type: 'closed', vaultId, sender: tabId });
  session = undefined;
  generation++;
  for (const transaction of activeWrites) {
    try {
      transaction.abort();
    } catch {
      /* The transaction may already have committed. */
    }
  }
  for (const handle of lockHandlers) {
    try {
      handle();
    } catch {
      /* Key removal must still finish. */
    }
  }
  lockChannel?.close();
  lockChannel = undefined;
  peers.clear();
  preparedLocks.clear();
  incomingLocks.clear();
  for (const timer of incomingLockTimers.values()) clearTimeout(timer);
  incomingLockTimers.clear();
  announceLocking(false);
  announce('locked');
}
export function onVaultLock(handle: () => void): () => void {
  lockHandlers.add(handle);
  return () => lockHandlers.delete(handle);
}
export function onBeforeVaultLock(handle: () => Promise<void>): () => void {
  beforeLockHandlers.add(handle);
  return () => beforeLockHandlers.delete(handle);
}
async function flushBeforeLock() {
  await Promise.all([...beforeLockHandlers].map((handle) => handle()));
  await writeQueue;
}
export function lockVault(): Promise<void> {
  if (locking) return locking;
  if (!session) {
    clearSession(false);
    return Promise.resolve();
  }
  const current = session;
  announceLocking(true);
  const requestId = crypto.randomUUID();
  pendingLock = { id: requestId, participants: new Set(peers), ready: new Set() };
  lockChannel?.postMessage({
    type: 'prepare-lock',
    vaultId: current.config.vaultId,
    sender: tabId,
    requestId,
  });
  locking = (async () => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        flushBeforeLock(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('Save timed out.')), 10_000);
        }),
      ]);
      if (timer) clearTimeout(timer);
      // Give currently open tabs a chance to announce themselves before committing the lock.
      if (lockChannel) await new Promise((resolve) => setTimeout(resolve, 180));
      const deadline = Date.now() + 10_000;
      while (
        pendingLock &&
        [...pendingLock.participants].some((peer) => !pendingLock?.ready.has(peer))
      ) {
        if (pendingLock.failed || Date.now() > deadline)
          throw new Error(pendingLock.failed || 'Another tab did not confirm its save.');
        await new Promise((resolve) => setTimeout(resolve, 40));
      }
      if (pendingLock?.failed) throw new Error(pendingLock.failed);
      assertSession(current);
      lockChannel?.postMessage({
        type: 'commit-lock',
        vaultId: current.config.vaultId,
        sender: tabId,
        requestId,
      });
      clearSession(false);
    } catch {
      lockChannel?.postMessage({
        type: 'abort-lock',
        vaultId: current.config.vaultId,
        sender: tabId,
        requestId,
      });
      announceLocking(false);
      throw new Error(
        "Couldn't save latest edits. Retry saving before locking. If another tab is open, check that tab too.",
      );
    } finally {
      if (timer) clearTimeout(timer);
      pendingLock = undefined;
      locking = undefined;
    }
  })();
  return locking;
}
export async function vaultStatus(): Promise<VaultStatus> {
  const config = await (await database()).get('public', 'vault');
  if (!config) return 'new';
  validateConfiguration(config);
  return session?.config.vaultId === config.vaultId ? 'unlocked' : 'locked';
}
export async function createVault(passphrase: string): Promise<void> {
  ensureCrypto();
  if (passphrase.length < 12 || !passphrase.trim())
    throw new Error('Use a strong passphrase with at least 12 characters.');
  if (await (await database()).get('public', 'vault'))
    throw new Error('A vault already exists on this browser. Unlock it with its passphrase.');
  const salt = randomBytes(32);
  const vaultId = crypto.randomUUID();
  const key = await deriveKey(passphrase, salt, KDF_ITERATIONS);
  const verifier = await encrypt(
    key,
    encoder.encode(verificationText),
    aad(vaultId, 'configuration', 'verifier'),
  );
  const config: VaultConfiguration = {
    id: 'vault',
    version: 1,
    vaultId,
    salt,
    iterations: KDF_ITERATIONS,
    verifier,
    revision: 0,
  };
  const db = await database();
  const tx = db.transaction('public', 'readwrite');
  if (await tx.store.get('vault')) {
    await tx.done;
    throw new Error('A vault was created in another tab. Unlock that vault instead.');
  }
  await tx.store.add(config);
  await tx.done;
  session = { key, config, generation: ++generation };
  listenForLocks();
  announce('unlocked');
}
export async function unlockVault(passphrase: string): Promise<void> {
  const config = await (await database()).get('public', 'vault');
  if (!config) throw new Error('Create a vault before unlocking it.');
  validateConfiguration(config);
  const expectedGeneration = generation;
  const key = await deriveKey(passphrase, config.salt, config.iterations);
  try {
    const plaintext = await decrypt(
      key,
      config.verifier,
      aad(config.vaultId, 'configuration', 'verifier'),
    );
    if (decoder.decode(plaintext) !== verificationText) throw new Error('Invalid verifier.');
  } catch {
    throw new Error('The passphrase is incorrect, or the vault verification record is damaged.');
  }
  if (expectedGeneration !== generation)
    throw new Error('The unlock operation was interrupted. Please try again.');
  session = { key, config, generation: ++generation };
  listenForLocks();
  announce('unlocked');
}
export async function hasLegacyWorkspace(): Promise<boolean> {
  if (!indexedDB.databases) return false;
  return (await indexedDB.databases()).some((item) => item.name === 'margin-workspace');
}

async function storageKey(current: VaultSession, store: VaultStore, key: string) {
  const hash = await crypto.subtle.digest(
    'SHA-256',
    encoder.encode(JSON.stringify([current.config.vaultId, store, key])),
  );
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, '0')).join('');
}
async function pack(key: string, value: unknown): Promise<Uint8Array<ArrayBuffer>> {
  const isBlob = value instanceof Blob;
  const metadata = encoder.encode(
    JSON.stringify(isBlob ? { key, blob: true, mimeType: value.type } : { key, value }),
  );
  const data = isBlob ? new Uint8Array(await value.arrayBuffer()) : new Uint8Array();
  const result = new Uint8Array(4 + metadata.byteLength + data.byteLength);
  new DataView(result.buffer).setUint32(0, metadata.byteLength);
  result.set(metadata, 4);
  result.set(data, 4 + metadata.byteLength);
  return result;
}
function unpack<T>(bytes: Uint8Array<ArrayBuffer>): { key: string; value: T } {
  if (bytes.byteLength < 4) throw new Error('The encrypted record is damaged.');
  const length = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0);
  if (length > bytes.byteLength - 4) throw new Error('The encrypted record is damaged.');
  const metadata = JSON.parse(decoder.decode(bytes.subarray(4, length + 4))) as {
    key: string;
    value?: T;
    blob?: boolean;
    mimeType?: string;
  };
  if (typeof metadata.key !== 'string') throw new Error('The encrypted record has an invalid key.');
  return {
    key: metadata.key,
    value: (metadata.blob
      ? new Blob([bytes.slice(length + 4)], { type: metadata.mimeType })
      : metadata.value) as T,
  };
}
async function decodeRecord<T>(
  current: VaultSession,
  record: EncryptedRecord,
): Promise<{ key: string; value: T }> {
  if (record.vaultId !== current.config.vaultId)
    throw new Error('This encrypted record belongs to a different vault.');
  let bytes: Uint8Array<ArrayBuffer>;
  try {
    bytes = await decrypt(
      current.key,
      record.ciphertext,
      aad(record.vaultId, record.store, record.storageKey),
    );
  } catch {
    throw new Error('A stored record could not be authenticated. It may be damaged or modified.');
  }
  assertSession(current);
  return unpack<T>(bytes);
}
async function readRecord<T>(
  current: VaultSession,
  store: VaultStore,
  key: string,
): Promise<T | undefined> {
  const address = await storageKey(current, store, key);
  const record = await (await database()).get('records', address);
  if (!record) {
    assertSession(current);
    return undefined;
  }
  if (record.store !== store)
    throw new Error('The encrypted record type does not match its address.');
  const decoded = await decodeRecord<T>(current, record);
  if (decoded.key !== key) throw new Error('The encrypted record key does not match its address.');
  return decoded.value;
}
export async function readVaultRecord<T>(store: VaultStore, key: string): Promise<T | undefined> {
  return readRecord<T>(requireSession(), store, key);
}
export async function listVaultRecords<T>(store: VaultStore): Promise<{ key: string; value: T }[]> {
  const current = requireSession();
  const records = await (await database()).getAllFromIndex('records', 'by-store', store);
  const decoded = await Promise.all(records.map((record) => decodeRecord<T>(current, record)));
  assertSession(current);
  return decoded;
}
export interface VaultTransaction {
  get<T>(store: VaultStore, key: string): Promise<T | undefined>;
  list<T>(store: VaultStore): Promise<{ key: string; value: T }[]>;
  put(store: VaultStore, key: string, value: unknown): void;
  delete(store: VaultStore, key: string): void;
}
/** Encrypt before opening IDB write transactions. A revision comparison retries conflicting cross-tab writes. */
export function vaultTransaction<T>(
  body: (transaction: VaultTransaction) => Promise<T>,
): Promise<T> {
  const requestedSession = requireSession();
  const run = async () => {
    for (let attempt = 0; attempt < 8; attempt++) {
      assertSession(requestedSession);
      const db = await database();
      const snapshot = await db.get('public', 'vault');
      if (!snapshot || snapshot.vaultId !== requestedSession.config.vaultId)
        throw new Error('The vault identity changed. Unlock it again before saving.');
      const writes = new Map<
        string,
        { store: VaultStore; key: string; value?: unknown; deleted: boolean }
      >();
      const cacheKey = (store: VaultStore, key: string) => JSON.stringify([store, key]);
      const transaction: VaultTransaction = {
        async get<Value>(store: VaultStore, key: string) {
          const pending = writes.get(cacheKey(store, key));
          return pending
            ? pending.deleted
              ? undefined
              : (pending.value as Value)
            : readRecord<Value>(requestedSession, store, key);
        },
        async list<Value>(store: VaultStore) {
          const rows = await listVaultRecords<Value>(store);
          const combined = new Map(rows.map((row) => [row.key, row.value]));
          for (const write of writes.values())
            if (write.store === store) {
              if (write.deleted) combined.delete(write.key);
              else combined.set(write.key, write.value as Value);
            }
          return [...combined].map(([key, value]) => ({ key, value }));
        },
        put(store, key, value) {
          writes.set(cacheKey(store, key), { store, key, value, deleted: false });
        },
        delete(store, key) {
          writes.set(cacheKey(store, key), { store, key, deleted: true });
        },
      };
      const result = await body(transaction);
      const prepared: { storageKey: string; record?: EncryptedRecord }[] = [];
      for (const write of writes.values()) {
        const address = await storageKey(requestedSession, write.store, write.key);
        if (write.deleted) {
          prepared.push({ storageKey: address });
          continue;
        }
        const ciphertext = await encrypt(
          requestedSession.key,
          await pack(write.key, write.value),
          aad(snapshot.vaultId, write.store, address),
        );
        prepared.push({
          storageKey: address,
          record: {
            storageKey: address,
            store: write.store,
            vaultId: snapshot.vaultId,
            ciphertext,
          },
        });
      }
      assertSession(requestedSession);
      const tx = db.transaction(['public', 'records'], 'readwrite');
      activeWrites.add(tx);
      try {
        const latest = await tx.objectStore('public').get('vault');
        if (!latest || latest.vaultId !== snapshot.vaultId)
          throw new Error('The vault identity changed while saving.');
        if (latest.revision !== snapshot.revision) {
          await tx.done;
          continue;
        }
        assertSession(requestedSession);
        for (const change of prepared) {
          if (change.record) await tx.objectStore('records').put(change.record);
          else await tx.objectStore('records').delete(change.storageKey);
        }
        if (prepared.length)
          await tx.objectStore('public').put({ ...latest, revision: latest.revision + 1 });
        await tx.done;
        assertSession(requestedSession);
        return result;
      } catch (error) {
        try {
          tx.abort();
        } catch {
          /* Already completed or aborted. */
        }
        await tx.done.catch(() => undefined);
        throw error;
      } finally {
        activeWrites.delete(tx);
      }
    }
    throw new Error('Another tab is making changes. Please retry your save.');
  };
  const result = writeQueue.then(run, run);
  writeQueue = result.catch(() => undefined);
  return result;
}

interface ExportHeader {
  version: 1;
  vaultId: string;
  exportId: string;
  kdf: 'PBKDF2-SHA256';
  iterations: number;
  salt: string;
  contentIv: string;
  metadataIv: string;
  metadata: string;
}
function exportAad(
  header: Pick<ExportHeader, 'version' | 'vaultId' | 'exportId' | 'kdf' | 'iterations' | 'salt'>,
  purpose: string,
) {
  return encoder.encode(
    JSON.stringify([
      'margin-export',
      header.version,
      header.vaultId,
      header.exportId,
      header.kdf,
      header.iterations,
      header.salt,
      purpose,
    ]),
  );
}
function base64(bytes: Uint8Array) {
  return btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(''));
}
function unbase64(value: string, max: number) {
  if (typeof value !== 'string' || value.length > max * 2 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value))
    throw new Error('The encrypted package header is malformed.');
  const bytes = Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
  if (bytes.byteLength > max) throw new Error('The encrypted package header is too large.');
  return bytes;
}
export async function encryptExport(
  blob: Blob,
  metadata: { name: string; mimeType: string },
): Promise<Blob> {
  const current = requireSession();
  if (blob.size > 100 * 1024 * 1024) throw new Error('Encrypted export is limited to 100 MB.');
  if (metadata.name.length > 1000 || metadata.mimeType.length > 200)
    throw new Error('The export metadata is too long.');
  const exportId = crypto.randomUUID();
  const parameters = {
    version: 1 as const,
    vaultId: current.config.vaultId,
    exportId,
    kdf: 'PBKDF2-SHA256' as const,
    iterations: current.config.iterations,
    salt: base64(current.config.salt),
  };
  const encryptedMetadata = await encrypt(
    current.key,
    encoder.encode(JSON.stringify(metadata)),
    exportAad(parameters, 'metadata'),
  );
  const content = await encrypt(
    current.key,
    new Uint8Array(await blob.arrayBuffer()),
    exportAad(parameters, 'content'),
  );
  assertSession(current);
  const header: ExportHeader = {
    ...parameters,
    contentIv: base64(content.iv),
    metadataIv: base64(encryptedMetadata.iv),
    metadata: base64(encryptedMetadata.bytes),
  };
  const encoded = encoder.encode(JSON.stringify(header));
  const size = new Uint8Array(4);
  new DataView(size.buffer).setUint32(0, encoded.byteLength);
  return new Blob([exportMagic, size, encoded, content.bytes], {
    type: 'application/vnd.margin.encrypted',
  });
}
export async function decryptExport(
  blob: Blob,
  passphrase?: string,
): Promise<{ blob: Blob; name: string; mimeType: string }> {
  const guard = createVaultGuard();
  if (blob.size < 28 || blob.size > MAX_PACKAGE_BYTES)
    throw new Error(
      'This encrypted package is empty, incomplete, or exceeds the 110 MB package limit.',
    );
  const prefix = new Uint8Array(await blob.slice(0, 12).arrayBuffer());
  if (!exportMagic.every((byte, index) => byte === prefix[index]))
    throw new Error('This is not a supported Margin encrypted document.');
  const headerLength = new DataView(prefix.buffer).getUint32(8);
  if (headerLength < 1 || headerLength > 16_384 || 12 + headerLength + 16 > blob.size)
    throw new Error('The encrypted package header is invalid.');
  let header: ExportHeader;
  try {
    header = JSON.parse(
      decoder.decode(await blob.slice(12, 12 + headerLength).arrayBuffer()),
    ) as ExportHeader;
  } catch {
    throw new Error('The encrypted package header could not be read.');
  }
  if (
    header.version !== 1 ||
    header.kdf !== 'PBKDF2-SHA256' ||
    header.iterations !== KDF_ITERATIONS ||
    !/^[a-f0-9-]{36}$/.test(header.vaultId) ||
    !/^[a-f0-9-]{36}$/.test(header.exportId)
  )
    throw new Error('This encrypted package uses an unsupported or unsafe format.');
  const salt = unbase64(header.salt, 32);
  const contentIv = unbase64(header.contentIv, 12);
  const metadataIv = unbase64(header.metadataIv, 12);
  if (salt.byteLength !== 32 || contentIv.byteLength !== 12 || metadataIv.byteLength !== 12)
    throw new Error('The encrypted package parameters are invalid.');
  const current =
    session?.config.vaultId === header.vaultId && !passphrase ? requireSession() : undefined;
  if (!current && !passphrase)
    throw new Error(
      'This encrypted document belongs to another vault. Enter the passphrase used when it was exported.',
    );
  const key = current?.key ?? (await deriveKey(passphrase!, salt, header.iterations));
  guard();
  try {
    const metadataBytes = await decrypt(
      key,
      { iv: metadataIv, bytes: unbase64(header.metadata, 8192) },
      exportAad(header, 'metadata'),
    );
    const metadata = JSON.parse(decoder.decode(metadataBytes)) as {
      name: string;
      mimeType: string;
    };
    if (
      typeof metadata.name !== 'string' ||
      metadata.name.length > 1000 ||
      typeof metadata.mimeType !== 'string' ||
      metadata.mimeType.length > 200
    )
      throw new Error('Invalid encrypted metadata.');
    const content = await decrypt(
      key,
      { iv: contentIv, bytes: new Uint8Array(await blob.slice(12 + headerLength).arrayBuffer()) },
      exportAad(header, 'content'),
    );
    guard();
    return {
      blob: new Blob([content], { type: metadata.mimeType }),
      name: metadata.name,
      mimeType: metadata.mimeType,
    };
  } catch {
    throw new Error(
      'The encrypted document could not be authenticated. Check its passphrase; the file may also be damaged or modified.',
    );
  }
}
