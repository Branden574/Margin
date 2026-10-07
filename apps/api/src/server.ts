import {
  createServer as createHttpServer,
  type IncomingMessage,
  type RequestListener,
} from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdir, readdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { EncryptedStore, LocalKeyProvider, type KeyManagementProvider } from './encryption.js';
import { createIdentityHandler } from './identity/http.js';
import type { AuthenticatedRequest, IdentityService } from './identity/service.js';
import { IdentityError } from './identity/types.js';
import type { SessionPrincipal } from './identity/types.js';
import { handleDocumentSync, type DocumentSyncService } from './sync-routes.js';
import { SyncError } from './sync/index.js';
import { createLmsHandler, type LmsService } from './lms/index.js';
import {
  handleCanvasAssignments,
  handleCanvasWork,
  type CanvasAssignmentService,
} from './assignment-routes.js';
import type { AssignmentWorkService } from './assignments/work/types.js';
import { AssignmentError } from './assignments/types.js';
import { handleCanvasAssignmentReturn, isCanvasAssignmentReturnPath } from './assignment-return.js';
import { handleSubmissions, isSubmissionPath } from './submission-http.js';
import type { AssignmentSubmissionService } from './assignments/submissions/types.js';

const MIB = 1024 * 1024;
export interface LocalIdentity {
  token: string;
  tenantId: string;
  userId: string;
  expiresAt?: number;
  revoked?: boolean;
}
export interface InspectionContext {
  mimeType: string;
  size: number;
  totalChunks: number;
  readChunk: (index: number) => Promise<Buffer>;
  signal: AbortSignal;
}
export interface InspectionResult {
  decision: 'clean' | 'quarantined';
  reason: string;
}
export interface ApiOptions {
  dataDirectory: string;
  identities?: LocalIdentity[];
  /** OIDC sessions replace development bearer tokens; the two modes cannot be combined. */
  identityService?: IdentityService;
  syncService?: DocumentSyncService;
  lmsService?: LmsService;
  assignmentService?: CanvasAssignmentService;
  /** Optional current-launch student adapter; never configured by the default local entry point. */
  assignmentWorkService?: AssignmentWorkService;
  /** Explicit opt-in; capture alone does not confirm delivery to Canvas. */
  assignmentSubmissionService?: AssignmentSubmissionService;
  keyEncryptionKey?: Buffer;
  keyManagementProvider?: KeyManagementProvider;
  tls?: { key: Buffer; cert: Buffer };
  /** Explicitly available only under NODE_ENV=test for synthetic integration fixtures. */
  allowInsecureTestTransport?: boolean;
  allowedOrigins?: string[];
  maxFileBytes?: number;
  requestsPerMinute?: number;
  maxConcurrentRequests?: number;
  maxUploadsPerUser?: number;
  maxStoredBytesPerUser?: number;
  uploadLifetimeMs?: number;
  documentRetentionMs?: number;
  /** Must be a trusted adapter to isolated structural validation + malware scan workers. None is configured by the local entry point. */
  inspectDocument?: (context: InspectionContext) => Promise<InspectionResult>;
  logger?: (entry: Record<string, unknown>) => void;
}
interface UploadSession {
  id: string;
  filename: string;
  mimeType: string;
  totalSize: number;
  chunkSize: number;
  totalChunks: number;
  checksums: Record<string, string>;
  status: 'uploading' | 'complete';
  ownerId: string;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
  correlationId: string;
  documentId?: string;
  checksum?: string;
  securityState?: 'ready' | 'quarantined';
}
interface StoredDocument {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  checksum: string;
  createdAt: number;
  expiresAt: number;
  ownerId: string;
  securityState: 'ready' | 'quarantined';
  inspectionReason: string;
  partChecksums: string[];
  partSizes: number[];
}
class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}
const digest = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
const idPattern = /^[a-z0-9_-]{1,80}$/i;
const supportedTypes = new Set(['application/pdf', 'image/png', 'image/jpeg', 'image/webp']);
const extensions: Record<string, RegExp> = {
  'application/pdf': /\.pdf$/i,
  'image/png': /\.png$/i,
  'image/jpeg': /\.jpe?g$/i,
  'image/webp': /\.webp$/i,
};
const isDigest = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value);
const equalToken = (a: string, b: string) =>
  timingSafeEqual(Buffer.from(digest(a)), Buffer.from(digest(b)));
async function body(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
  if (Number(req.headers['content-length'] ?? 0) > maxBytes)
    throw new ApiError(413, 'body_too_large', 'This request exceeds its size limit.');
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > maxBytes)
      throw new ApiError(413, 'body_too_large', 'This request exceeds its size limit.');
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}
async function jsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  if (!req.headers['content-type']?.startsWith('application/json'))
    throw new ApiError(415, 'json_required', 'Send JSON with Content-Type: application/json.');
  let value: unknown;
  try {
    value = JSON.parse((await body(req, 16 * 1024)).toString('utf8'));
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(400, 'invalid_json', 'The request contains invalid JSON.');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new ApiError(400, 'invalid_json', 'Send a JSON object.');
  return value as Record<string, unknown>;
}
function sniffMime(bytes: Buffer): string | null {
  if (/^%PDF-\d\.\d/.test(bytes.subarray(0, 8).toString('ascii'))) return 'application/pdf';
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
    return 'image/png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (
    bytes.subarray(0, 4).toString('ascii') === 'RIFF' &&
    bytes.subarray(8, 12).toString('ascii') === 'WEBP'
  )
    return 'image/webp';
  return null;
}
function publicSession(session: UploadSession) {
  const { checksums, ownerId: _owner, ...rest } = session;
  return {
    ...rest,
    uploadedChunks: Object.keys(checksums)
      .map(Number)
      .sort((a, b) => a - b),
  };
}
async function entries(path: string): Promise<string[]> {
  try {
    return await readdir(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

/** Encrypted local service. Production still requires OIDC, KMS, isolated scanning and a durable audit sink. */
export function createApi(options: ApiOptions) {
  if (
    (options.assignmentService ||
      options.assignmentWorkService ||
      options.assignmentSubmissionService) &&
    (!options.identityService || !options.lmsService)
  )
    throw new Error('Canvas assignments require authenticated identity and LMS launch services.');
  if (
    options.lmsService &&
    (!options.identityService ||
      options.lmsService.applicationOrigin !== options.identityService.applicationOrigin)
  )
    throw new Error('LMS and identity must use the same authenticated application origin.');
  if (options.syncService && !options.identityService)
    throw new Error('Document synchronization requires authenticated organization sessions.');
  const insecureTest =
    options.allowInsecureTestTransport === true && process.env.NODE_ENV === 'test';
  if (!options.tls && !insecureTest)
    throw new Error(
      'HTTPS is mandatory. Supply a TLS certificate and key; plaintext application transport is disabled.',
    );
  const identities = options.identities ?? [];
  if (options.identityService && identities.length)
    throw new Error('Choose OIDC sessions or local bearer identities, never both.');
  if (
    !options.identityService &&
    (!identities.length ||
      identities.some(({ token, tenantId, userId }) => token.length < 32 || !tenantId || !userId))
  )
    throw new Error(
      'Configure authenticated identities with a user, tenant and token of at least 32 characters.',
    );
  const provider =
    options.keyManagementProvider ??
    (options.keyEncryptionKey ? new LocalKeyProvider(options.keyEncryptionKey) : undefined);
  if (!provider)
    throw new Error(
      'An encryption key-management provider is required. Plaintext storage is disabled.',
    );
  const dataRoot = resolve(options.dataDirectory);
  const store = new EncryptedStore(dataRoot, provider);
  const startedAt = Date.now();
  const maxFileBytes = options.maxFileBytes ?? 128 * MIB;
  const uploadLifetime = options.uploadLifetimeMs ?? 24 * 60 * 60 * 1000;
  const retention = options.documentRetentionMs ?? 30 * 24 * 60 * 60 * 1000;
  const origins = new Set(
    options.allowedOrigins ??
      (options.identityService
        ? [options.identityService.applicationOrigin]
        : ['https://localhost:5173', 'https://127.0.0.1:5173']),
  );
  if (
    options.identityService &&
    (origins.size !== 1 || !origins.has(options.identityService.applicationOrigin))
  )
    throw new Error('Cookie-authenticated API access must use its exact application origin.');
  const handleIdentity = options.identityService
    ? createIdentityHandler(options.identityService)
    : undefined;
  const handleLms = options.lmsService ? createLmsHandler(options.lmsService) : undefined;
  if (!insecureTest && [...origins].some((origin) => new URL(origin).protocol !== 'https:'))
    throw new Error('Every browser origin must use HTTPS.');
  const locks = new Map<string, Promise<unknown>>();
  const rateWindows = new Map<string, { starts: number; count: number }>();
  let concurrentRequests = 0;
  const logger = options.logger ?? ((entry) => process.stdout.write(`${JSON.stringify(entry)}\n`));
  const ownerPath = (tenantId: string, userId: string) =>
    join(dataRoot, 'tenants', digest(tenantId), 'users', digest(userId));
  async function locked<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = locks.get(key) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(task);
    locks.set(key, next);
    try {
      return await next;
    } finally {
      if (locks.get(key) === next) locks.delete(key);
    }
  }
  function limit(key: string, maximum: number) {
    const now = Date.now();
    let rate = rateWindows.get(key);
    if (!rate || now - rate.starts > 60_000) {
      rate = { starts: now, count: 0 };
      rateWindows.set(key, rate);
    }
    if (++rate.count > maximum)
      throw new ApiError(
        429,
        'rate_limited',
        'Too many requests. Your confirmed encrypted chunks remain stored; retry shortly.',
      );
    if (rateWindows.size > 1000)
      for (const [key, value] of rateWindows)
        if (now - value.starts > 60_000) rateWindows.delete(key);
  }
  async function sessionFor(root: string, id: string, ownerId: string): Promise<UploadSession> {
    if (!idPattern.test(id))
      throw new ApiError(404, 'upload_not_found', 'This upload is unavailable to your account.');
    let session: UploadSession;
    try {
      session = await store.readJson(join(root, 'uploads', id, 'session.enc'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT')
        throw new ApiError(404, 'upload_not_found', 'This upload is unavailable to your account.');
      throw error;
    }
    if (session.ownerId !== ownerId)
      throw new ApiError(404, 'upload_not_found', 'This upload is unavailable to your account.');
    if (session.expiresAt <= Date.now())
      throw new ApiError(410, 'upload_expired', 'This upload session expired. Start a new upload.');
    return session;
  }
  async function removeUpload(root: string, id: string) {
    for (const name of await entries(join(root, 'uploads', id)))
      if (name.endsWith('.enc')) await store.delete(join(root, 'uploads', id, name));
    await rm(join(root, 'uploads', id), { recursive: true, force: true });
  }
  async function documentFor(root: string, id: string, ownerId: string, allowExpired = false) {
    let document: StoredDocument;
    try {
      document = await store.readJson(join(root, 'documents', `${id}.metadata.enc`));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT')
        throw new ApiError(
          404,
          'document_not_found',
          'This document is unavailable to your account.',
        );
      throw error;
    }
    if (document.ownerId !== ownerId)
      throw new ApiError(
        404,
        'document_not_found',
        'This document is unavailable to your account.',
      );
    if (!allowExpired && document.expiresAt <= Date.now())
      throw new ApiError(
        410,
        'document_expired',
        'This encrypted document has reached its retention limit.',
      );
    return document;
  }
  const handler: RequestListener = async (req, res) => {
    const correlationId = randomUUID();
    const started = Date.now();
    let tenantHash: string | undefined;
    let userHash: string | undefined;
    let uploadId: string | undefined;
    let admitted = false;
    let routeName = 'unmatched';
    res.setHeader('X-Correlation-ID', correlationId);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'; sandbox");
    res.setHeader('Referrer-Policy', 'no-referrer');
    const send = (status: number, value: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(value));
    };
    res.on('finish', () =>
      logger({
        event: 'api_request',
        correlationId,
        method: req.method,
        route: routeName,
        status: res.statusCode,
        elapsedMs: Date.now() - started,
        tenantHash,
        userHash,
        uploadId,
      }),
    );
    try {
      limit(`ip:${req.socket.remoteAddress ?? 'unknown'}`, (options.requestsPerMinute ?? 1200) * 2);
      if (concurrentRequests >= (options.maxConcurrentRequests ?? 8)) {
        res.setHeader('Retry-After', '2');
        throw new ApiError(
          429,
          'service_busy',
          'The local service is busy. Retry shortly; confirmed encrypted chunks are safe.',
        );
      }
      concurrentRequests++;
      admitted = true;
      // LTI form_post is cross-site by design. Its isolated handler validates the
      // registered installation, signed token and independent browser binding.
      // Ordinary API origins, cookies and framing protections stay unchanged.
      if (handleLms && req.url?.startsWith('/api/lms/')) {
        routeName = '/api/lms/:action';
        if (await handleLms(req, res)) return;
      }
      const origin = req.headers.origin;
      if (origin && !origins.has(origin))
        throw new ApiError(
          403,
          'origin_not_allowed',
          'This browser origin is not allowed by the secure local service.',
        );
      if (origin) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Vary', 'Origin');
        res.setHeader('Access-Control-Expose-Headers', 'X-Correlation-ID');
      }
      if (req.method === 'OPTIONS') {
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
        res.setHeader(
          'Access-Control-Allow-Headers',
          'Authorization, Content-Type, X-Chunk-SHA256, Idempotency-Key, X-CSRF-Token',
        );
        res.setHeader('Access-Control-Max-Age', '600');
        res.writeHead(204);
        res.end();
        return;
      }
      const path = new URL(req.url ?? '/', 'https://localhost').pathname;
      if (handleIdentity && path.startsWith('/api/auth/')) {
        routeName = '/api/auth/:action';
        if (await handleIdentity(req, res)) return;
      }
      routeName = ['/api/health', '/api/uploads', '/api/documents'].includes(path)
        ? path
        : /^\/api\/uploads\//.test(path)
          ? '/api/uploads/:id'
          : /^\/api\/documents\//.test(path)
            ? '/api/documents/:id'
            : 'unmatched';
      if (req.method === 'GET' && path === '/api/health') {
        send(200, {
          status: 'ok',
          mode: 'encrypted-local',
          authentication: options.identityService ? 'oidc-session' : 'local-bearer',
          transport: insecureTest ? 'synthetic-test' : 'tls',
          scanningConfigured: Boolean(options.inspectDocument),
          synchronizationConfigured: Boolean(options.syncService),
          canvasConfigured: Boolean(options.lmsService),
          assignmentsConfigured: Boolean(options.assignmentService),
          assignmentWorkConfigured: Boolean(options.assignmentWorkService),
          assignmentSubmissionsConfigured: Boolean(options.assignmentSubmissionService),
        });
        return;
      }
      let identity: { tenantId: string; userId: string };
      let principal: SessionPrincipal | undefined;
      let authenticated: AuthenticatedRequest | undefined;
      const assignmentReturn = isCanvasAssignmentReturnPath(path);
      if (options.identityService) {
        authenticated = await options.identityService.authenticateRequest(req);
        principal = authenticated.principal;
        if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method ?? '')) {
          if (!assignmentReturn) options.identityService.verifyCsrf(req, authenticated);
          if (['viewer', 'support'].includes(authenticated.principal.role))
            throw new ApiError(
              403,
              'write_not_allowed',
              'This workspace role cannot modify documents.',
            );
        }
        identity = {
          tenantId: authenticated.principal.organizationId,
          userId: authenticated.principal.userId,
        };
      } else {
        const token = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1] ?? '';
        const localIdentity = identities.find((item) => equalToken(item.token, token));
        if (
          !localIdentity ||
          localIdentity.revoked ||
          (localIdentity.expiresAt ?? startedAt + 60 * 60 * 1000) <= Date.now()
        )
          throw new ApiError(
            401,
            'authentication_required',
            'Your local session is missing, expired or revoked. Reconnect with a current access token.',
          );
        identity = localIdentity;
      }
      tenantHash = digest(identity.tenantId).slice(0, 12);
      userHash = digest(identity.userId).slice(0, 12);
      limit(`tenant:${identity.tenantId}`, options.requestsPerMinute ?? 1200);
      limit(`user:${identity.tenantId}:${identity.userId}`, options.requestsPerMinute ?? 1200);
      if (path === '/api/assignments' || path.startsWith('/api/assignments/')) {
        routeName = '/api/assignments/:action';
        if (isSubmissionPath(path)) {
          await handleSubmissions(
            req,
            res,
            options.assignmentSubmissionService,
            principal,
            async () => {
              const fresh = await options.identityService!.authenticateRequest(req);
              options.identityService!.verifyCsrf(req, fresh);
              return fresh.principal;
            },
          );
          return;
        }
        if (
          assignmentReturn &&
          options.assignmentService &&
          options.identityService &&
          authenticated
        ) {
          await handleCanvasAssignmentReturn(
            req,
            res,
            options.assignmentService,
            options.identityService,
            authenticated,
          );
          return;
        }
        if (
          options.assignmentWorkService &&
          principal &&
          (await handleCanvasWork(req, res, options.assignmentWorkService, principal))
        )
          return;
        if (!options.assignmentService || !principal)
          throw new ApiError(
            503,
            'assignments_unavailable',
            'Canvas assignment authoring is not configured.',
          );
        await handleCanvasAssignments(req, res, options.assignmentService, principal);
        return;
      }
      if (principal?.authenticationMethod === 'lti')
        throw new ApiError(
          403,
          'lms_resource_scope_required',
          'Open the permitted assignment through its Canvas workspace. General document access is not available through an LMS session.',
        );
      if (path.startsWith('/api/sync/')) {
        routeName = '/api/sync/documents/:id';
        if (!options.syncService || !principal)
          throw new ApiError(
            503,
            'sync_unavailable',
            'Organization document synchronization is not configured. Your local work is unchanged.',
          );
        if (await handleDocumentSync(req, res, options.syncService, principal)) return;
        throw new ApiError(404, 'not_found', 'This synchronization route does not exist.');
      }
      const root = ownerPath(identity.tenantId, identity.userId);
      const now = Date.now();
      if (req.method === 'POST' && path === '/api/uploads') {
        const input = await jsonBody(req);
        const { filename, mimeType, totalSize } = input;
        const chunkSize = input.chunkSize ?? MIB;
        if (
          Object.keys(input).some(
            (key) => !['filename', 'mimeType', 'totalSize', 'chunkSize'].includes(key),
          )
        )
          throw new ApiError(
            400,
            'unexpected_field',
            'This upload request contains unsupported fields. Ownership comes from your authenticated session.',
          );
        if (
          typeof filename !== 'string' ||
          !filename.trim() ||
          filename.length > 200 ||
          /[\x00-\x1f\x7f]/.test(filename)
        )
          throw new ApiError(
            400,
            'invalid_filename',
            'Choose a filename of 1–200 characters without control characters.',
          );
        if (
          typeof mimeType !== 'string' ||
          !supportedTypes.has(mimeType) ||
          !extensions[mimeType].test(filename)
        )
          throw new ApiError(
            415,
            'unsupported_file',
            'Use a matching PDF, PNG, JPEG or WebP filename and media type.',
          );
        if (
          !Number.isSafeInteger(totalSize) ||
          Number(totalSize) < 1 ||
          Number(totalSize) > maxFileBytes
        )
          throw new ApiError(
            413,
            'invalid_file_size',
            `Files must be between 1 byte and ${maxFileBytes / MIB} MB.`,
          );
        if (
          !Number.isSafeInteger(chunkSize) ||
          Number(chunkSize) < 256 * 1024 ||
          Number(chunkSize) > 4 * MIB
        )
          throw new ApiError(
            400,
            'invalid_chunk_size',
            'Chunk sizes must be between 256 KB and 4 MB.',
          );
        const key = req.headers['idempotency-key'];
        if (key !== undefined && (typeof key !== 'string' || key.length > 200 || !key.trim()))
          throw new ApiError(
            400,
            'invalid_idempotency_key',
            'Use an idempotency key of 1–200 characters.',
          );
        const id = key ? `u_${digest(key).slice(0, 40)}` : `u_${randomUUID()}`;
        uploadId = id;
        await locked(`${root}/quota`, async () => {
          await locked(`${root}/${id}`, async () => {
            if (key) {
              try {
                const previous = await sessionFor(root, id, identity.userId);
                if (
                  previous.filename !== filename ||
                  previous.mimeType !== mimeType ||
                  previous.totalSize !== totalSize ||
                  previous.chunkSize !== chunkSize
                )
                  throw new ApiError(
                    409,
                    'idempotency_conflict',
                    'This upload key already belongs to a different file.',
                  );
                send(200, publicSession(previous));
                return;
              } catch (error) {
                if (error instanceof ApiError && error.status === 410) await removeUpload(root, id);
                else if (!(error instanceof ApiError && error.status === 404)) throw error;
              }
            }
            let reservedBytes = 0;
            let activeCount = 0;
            for (const existing of await entries(join(root, 'uploads'))) {
              if (!idPattern.test(existing)) continue;
              const receipt = await store.readJson<UploadSession>(
                join(root, 'uploads', existing, 'session.enc'),
              );
              if (receipt.expiresAt <= now) {
                await locked(`${root}/${existing}`, () => removeUpload(root, existing));
                continue;
              }
              if (receipt.status === 'uploading') {
                reservedBytes += receipt.totalSize;
                activeCount++;
              }
            }
            const documentFiles = (await entries(join(root, 'documents'))).filter((name) =>
              name.endsWith('.metadata.enc'),
            );
            if (documentFiles.length >= 250)
              throw new ApiError(
                429,
                'document_limit',
                'This local account reached its encrypted document limit. Delete unneeded server copies first.',
              );
            for (const file of documentFiles) {
              const existing = await store.readJson<StoredDocument>(join(root, 'documents', file));
              reservedBytes += existing.size;
            }
            if (
              activeCount >= (options.maxUploadsPerUser ?? 25) ||
              reservedBytes + Number(totalSize) > (options.maxStoredBytesPerUser ?? 512 * MIB)
            )
              throw new ApiError(
                429,
                'storage_quota',
                'This account reached its encrypted upload storage quota. Cancel unfinished uploads or delete server copies.',
              );
            const session: UploadSession = {
              id,
              filename,
              mimeType,
              totalSize: Number(totalSize),
              chunkSize: Number(chunkSize),
              totalChunks: Math.ceil(Number(totalSize) / Number(chunkSize)),
              checksums: {},
              status: 'uploading',
              ownerId: identity.userId,
              createdAt: now,
              updatedAt: now,
              expiresAt: now + uploadLifetime,
              correlationId,
            };
            await mkdir(join(root, 'uploads', id), { recursive: true, mode: 0o700 });
            await store.writeJson(join(root, 'uploads', id, 'session.enc'), session);
            send(201, publicSession(session));
          });
        });
        return;
      }
      const uploadMatch = /^\/api\/uploads\/([^/]+)(?:\/(chunks\/([0-9]+)|finalize))?$/.exec(path);
      if (uploadMatch) {
        const id = uploadMatch[1];
        if (!idPattern.test(id))
          throw new ApiError(
            404,
            'upload_not_found',
            'This upload is unavailable to your account.',
          );
        uploadId = id;
        await locked(`${root}/${id}`, async () => {
          const session = await sessionFor(root, id, identity.userId);
          const uploadRoot = join(root, 'uploads', id);
          if (req.method === 'GET' && !uploadMatch[2]) {
            send(200, publicSession(session));
            return;
          }
          if (req.method === 'DELETE' && !uploadMatch[2]) {
            if (session.status === 'complete')
              throw new ApiError(
                409,
                'upload_complete',
                'This encrypted document is already finalized.',
              );
            await removeUpload(root, id);
            send(200, { canceled: true });
            return;
          }
          if (req.method === 'PUT' && uploadMatch[3] !== undefined) {
            const index = Number(uploadMatch[3]);
            if (!Number.isSafeInteger(index) || index >= session.totalChunks)
              throw new ApiError(
                400,
                'invalid_chunk_index',
                'This chunk index is outside the upload.',
              );
            const checksum = req.headers['x-chunk-sha256'];
            if (!isDigest(checksum))
              throw new ApiError(
                400,
                'checksum_required',
                'Include this chunk’s SHA-256 checksum in X-Chunk-SHA256.',
              );
            const expectedSize = Math.min(
              session.chunkSize,
              session.totalSize - index * session.chunkSize,
            );
            const bytes = await body(req, expectedSize);
            try {
              if (bytes.length !== expectedSize)
                throw new ApiError(
                  400,
                  'chunk_size_mismatch',
                  `Chunk ${index} must contain exactly ${expectedSize} bytes.`,
                );
              if (digest(bytes) !== checksum.toLowerCase())
                throw new ApiError(
                  422,
                  'checksum_mismatch',
                  'The chunk did not pass integrity verification. Retry this chunk.',
                );
              if (session.checksums[String(index)]) {
                if (session.checksums[String(index)] !== checksum.toLowerCase())
                  throw new ApiError(
                    409,
                    'chunk_conflict',
                    'A different chunk is already stored at this position.',
                  );
                send(200, { index, checksum: checksum.toLowerCase(), duplicate: true });
                return;
              }
              if (session.status === 'complete')
                throw new ApiError(
                  409,
                  'upload_complete',
                  'This encrypted document is already finalized.',
                );
              await store.write(join(uploadRoot, `${index}.chunk.enc`), bytes);
              session.checksums[String(index)] = checksum.toLowerCase();
              session.updatedAt = Date.now();
              await store.writeJson(join(uploadRoot, 'session.enc'), session);
              send(200, { index, checksum: checksum.toLowerCase(), duplicate: false });
              return;
            } finally {
              bytes.fill(0);
            }
          }
          if (req.method === 'POST' && uploadMatch[2] === 'finalize') {
            const input = await jsonBody(req);
            if (Object.keys(input).some((key) => key !== 'checksum'))
              throw new ApiError(
                400,
                'unexpected_field',
                'Only checksum is accepted when finalizing.',
              );
            if (input.checksum !== undefined && !isDigest(input.checksum))
              throw new ApiError(
                400,
                'invalid_checksum',
                'Provide a hexadecimal SHA-256 checksum.',
              );
            const result = () => ({
              documentId: session.documentId,
              checksum: session.checksum,
              mimeType: session.mimeType,
              size: session.totalSize,
              securityState: session.securityState,
            });
            if (session.status === 'complete') {
              if (input.checksum && input.checksum.toLowerCase() !== session.checksum)
                throw new ApiError(
                  422,
                  'checksum_mismatch',
                  'The final document checksum does not match.',
                );
              send(200, result());
              return;
            }
            if (Object.keys(session.checksums).length !== session.totalChunks)
              throw new ApiError(
                409,
                'upload_incomplete',
                'Some chunks are still missing. Resume before finalizing.',
              );
            const readChunk = async (index: number) => {
              if (!Number.isInteger(index) || index < 0 || index >= session.totalChunks)
                throw new Error('Inspection chunk out of bounds.');
              const bytes = await store.read(join(uploadRoot, `${index}.chunk.enc`));
              if (digest(bytes) !== session.checksums[String(index)]) {
                bytes.fill(0);
                throw new ApiError(
                  422,
                  'stored_chunk_corrupt',
                  'A stored chunk failed verification. Cancel and upload the file again.',
                );
              }
              return bytes;
            };
            const hash = createHash('sha256');
            let actualMime: string | null = null;
            let totalBytes = 0;
            for (let i = 0; i < session.totalChunks; i++) {
              const bytes = await readChunk(i);
              if (i === 0) actualMime = sniffMime(bytes);
              hash.update(bytes);
              totalBytes += bytes.length;
              bytes.fill(0);
            }
            const checksum = hash.digest('hex');
            if (actualMime !== session.mimeType)
              throw new ApiError(
                415,
                'file_signature_mismatch',
                'The contents do not match the selected format. Export a valid PDF or image.',
              );
            if (
              totalBytes !== session.totalSize ||
              (input.checksum && input.checksum.toLowerCase() !== checksum)
            )
              throw new ApiError(
                422,
                'checksum_mismatch',
                'The final document failed integrity verification.',
              );
            let inspection: InspectionResult = {
              decision: 'quarantined',
              reason: 'Structural validation and malware scanning are not configured.',
            };
            if (options.inspectDocument) {
              const signal = AbortSignal.timeout(15_000);
              try {
                inspection = await Promise.race([
                  options.inspectDocument({
                    mimeType: actualMime,
                    size: totalBytes,
                    totalChunks: session.totalChunks,
                    readChunk,
                    signal,
                  }),
                  new Promise<never>((_, reject) =>
                    signal.addEventListener(
                      'abort',
                      () => reject(new Error('Inspection timed out.')),
                      { once: true },
                    ),
                  ),
                ]);
              } catch {
                inspection = {
                  decision: 'quarantined',
                  reason: 'Inspection failed or exceeded its time limit.',
                };
              }
              if (
                !inspection ||
                !['clean', 'quarantined'].includes(inspection.decision) ||
                typeof inspection.reason !== 'string'
              )
                inspection = {
                  decision: 'quarantined',
                  reason: 'The inspection provider returned an invalid decision.',
                };
            }
            const documentId = `d_${id.slice(2)}`;
            const documentsRoot = join(root, 'documents');
            const partSizes: number[] = [];
            for (let i = 0; i < session.totalChunks; i++) {
              const bytes = await readChunk(i);
              try {
                partSizes.push(bytes.length);
                await store.write(join(documentsRoot, `${documentId}.${i}.part.enc`), bytes);
              } finally {
                bytes.fill(0);
              }
            }
            const document: StoredDocument = {
              id: documentId,
              name: session.filename,
              mimeType: actualMime,
              size: totalBytes,
              checksum,
              createdAt: session.createdAt,
              expiresAt: now + retention,
              ownerId: identity.userId,
              securityState: inspection.decision === 'clean' ? 'ready' : 'quarantined',
              inspectionReason: inspection.reason.slice(0, 300),
              partChecksums: Array.from(
                { length: session.totalChunks },
                (_, i) => session.checksums[String(i)],
              ),
              partSizes,
            };
            await store.writeJson(join(documentsRoot, `${documentId}.metadata.enc`), document);
            session.status = 'complete';
            session.documentId = documentId;
            session.checksum = checksum;
            session.securityState = document.securityState;
            session.updatedAt = Date.now();
            await store.writeJson(join(uploadRoot, 'session.enc'), session);
            for (let i = 0; i < session.totalChunks; i++)
              await store.delete(join(uploadRoot, `${i}.chunk.enc`));
            logger({
              event: 'document_finalized',
              correlationId,
              tenantHash,
              userHash,
              uploadId,
              securityState: document.securityState,
            });
            send(200, result());
            return;
          }
          throw new ApiError(
            405,
            'method_not_allowed',
            'This action is not available for the upload.',
          );
        });
        return;
      }
      if (req.method === 'GET' && path === '/api/documents') {
        const documents: Record<string, unknown>[] = [];
        for (const file of (await entries(join(root, 'documents'))).filter((name) =>
          name.endsWith('.metadata.enc'),
        )) {
          const document = await store.readJson<StoredDocument>(join(root, 'documents', file));
          if (document.ownerId === identity.userId && document.expiresAt > now) {
            const {
              partChecksums: _checksums,
              partSizes: _sizes,
              ownerId: _owner,
              ...visible
            } = document;
            documents.push(visible);
          }
        }
        send(200, { documents });
        return;
      }
      const contentMatch = /^\/api\/documents\/([a-z0-9_-]{1,80})(\/content)?$/i.exec(path);
      if (contentMatch && req.method === 'DELETE' && !contentMatch[2]) {
        await locked(`${root}/${contentMatch[1]}`, async () => {
          const document = await documentFor(root, contentMatch[1], identity.userId, true);
          await store.delete(join(root, 'documents', `${document.id}.metadata.enc`));
          for (let i = 0; i < document.partSizes.length; i++)
            await store.delete(join(root, 'documents', `${document.id}.${i}.part.enc`));
          logger({ event: 'document_deleted', correlationId, tenantHash, userHash });
          send(200, { deleted: true });
        });
        return;
      }
      if (contentMatch && req.method === 'GET' && contentMatch[2]) {
        const document = await documentFor(root, contentMatch[1], identity.userId);
        if (document.securityState !== 'ready')
          throw new ApiError(
            423,
            'document_quarantined',
            'This encrypted document is quarantined. Download is blocked until isolated structural validation and malware scanning approve it.',
          );
        const readPart = async (index: number) => {
          const bytes = await store.read(
            join(root, 'documents', `${document.id}.${index}.part.enc`),
          );
          if (
            bytes.length !== document.partSizes[index] ||
            digest(bytes) !== document.partChecksums[index]
          ) {
            bytes.fill(0);
            throw new Error('Stored document integrity failed.');
          }
          return bytes;
        };
        // Authenticate every encrypted part and the complete digest before opening a download response.
        const hash = createHash('sha256');
        for (let i = 0; i < document.partSizes.length; i++) {
          const bytes = await readPart(i);
          hash.update(bytes);
          bytes.fill(0);
        }
        if (hash.digest('hex') !== document.checksum)
          throw new Error('Stored document integrity failed.');
        res.writeHead(200, {
          'Content-Type': document.mimeType,
          'Content-Length': document.size,
          'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(document.name)}`,
        });
        async function* parts() {
          for (let i = 0; i < document.partSizes.length; i++) yield await readPart(i);
        }
        await pipeline(Readable.from(parts()), res);
        logger({ event: 'document_downloaded', correlationId, tenantHash, userHash });
        return;
      }
      throw new ApiError(404, 'not_found', 'This API route does not exist.');
    } catch (error) {
      const expected =
        error instanceof ApiError ||
        error instanceof IdentityError ||
        error instanceof SyncError ||
        error instanceof AssignmentError;
      if (!expected)
        logger({ event: 'api_error', correlationId, code: 'integrity_or_service_failure' });
      if (expected && error.status === 429) res.setHeader('Retry-After', '60');
      if (!res.headersSent)
        send(expected ? error.status : 500, {
          error: {
            code: expected ? error.code : 'integrity_or_service_failure',
            message: expected
              ? error.message
              : 'The secure service could not verify or complete this request. No unverified document content was released. Check the correlation ID with the service operator.',
            ...(error instanceof SyncError && error.details ? { details: error.details } : {}),
          },
          correlationId,
        });
      else res.destroy();
    } finally {
      if (admitted) concurrentRequests--;
    }
  };
  const server = options.tls
    ? createHttpsServer({ ...options.tls, minVersion: 'TLSv1.2' }, handler)
    : createHttpServer(handler);
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  server.maxHeadersCount = 40;
  return server;
}
export const createLocalToken = () => randomBytes(32).toString('base64url');
