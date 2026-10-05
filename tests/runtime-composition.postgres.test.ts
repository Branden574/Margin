import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, request as httpsRequest, type Server } from 'node:https';
import type { RequestListener } from 'node:http';
import { Pool } from 'pg';
import { PDFDocument } from 'pdf-lib';
import {
  createLocalJWKSet,
  exportJWK,
  exportPKCS8,
  generateKeyPair,
  jwtVerify,
  SignJWT,
} from 'jose';
import { hostedCanvasEndpoints, LTI_CLAIM } from '../packages/lms/src';
import {
  createCanvasRuntime,
  type CanvasRuntime,
  type CanvasRuntimeConfig,
} from '../apps/api/src/runtime-composition';
import { createApi } from '../apps/api/src/server';
import { LocalKeyProvider } from '../apps/api/src/encryption';
import {
  AssignmentDeepLinkSigner,
  PostgresAssignmentRepository,
} from '../apps/api/src/assignments';
import { PostgresAssignmentWorkService } from '../apps/api/src/assignments/work';
import { PostgresIdentityRepository, type SessionPrincipal } from '../apps/api/src/identity';
import { createCookieCrypto } from '../apps/api/src/identity/crypto';
import { PostgresLmsRepository, lmsLookupDigest } from '../apps/api/src/lms';
import {
  IngestionAssignmentSourceGateway,
  PostgresIngestionRepository,
  SourceInspectionWorker,
  type SourceScanner,
} from '../apps/api/src/ingestion';
import {
  PostgresStudentWorkProvisioner,
  StudentWorkProvisioningWorker,
} from '../apps/api/src/assignments/provisioning';
import { runtimeFixtureArtifacts } from './helpers/runtime-artifacts';
import { stopDisposablePostgres } from './helpers/postgres';

const available = ['initdb', 'pg_ctl'].every((tool) => {
  try {
    execFileSync(tool, ['--version'], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
});
if (!available && process.env.MARGIN_REQUIRE_POSTGRES_TESTS === '1')
  throw new Error('Required composition PostgreSQL binaries are unavailable.');
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const platform = hostedCanvasEndpoints('test');
const institution = 'https://synthetic-school.test.instructure.com';
const issuer = 'https://identity.composition.test';
const lookupKey = randomBytes(32),
  resourceKey = randomBytes(32),
  sessionKey = randomBytes(32),
  identityKey = randomBytes(32);
const keys = new LocalKeyProvider(randomBytes(32), 'synthetic-composition-key');
const artifacts = runtimeFixtureArtifacts(keys);
let directory: string,
  socket: string,
  origin: string,
  started = false,
  admin: Pool,
  server: Server;
let delegate: RequestListener | undefined;
let tls: { key: Buffer; cert: Buffer };
let runtime: CanvasRuntime,
  ingest: PostgresIngestionRepository,
  reader: PostgresIngestionRepository,
  inspector: PostgresIngestionRepository,
  workerRepository: PostgresStudentWorkProvisioner;
let sources: IngestionAssignmentSourceGateway,
  scanner: SourceInspectionWorker,
  worker: StudentWorkProvisioningWorker;
let signer: AssignmentDeepLinkSigner,
  platformPrivate: CryptoKey,
  platformKeys: ReturnType<typeof createLocalJWKSet>,
  body: Buffer;
const database = (user: string) => ({
  host: socket,
  port: 55503,
  database: 'postgres',
  user,
  application_name: 'composition-' + user,
});
const config = (): CanvasRuntimeConfig => ({
  identity: {
    issuerUrl: issuer,
    clientId: 'synthetic-confidential-client',
    clientSecret: 'synthetic-client-secret-no-real-provider',
    applicationOrigin: origin,
    redirectUri: origin + '/api/auth/callback',
    sessionSecret: Buffer.from(sessionKey),
    identityHmacKey: Buffer.from(identityKey),
  },
  databases: {
    identity: database('compose_identity'),
    lms: database('compose_lms'),
    assignments: database('compose_assignments'),
    work: database('compose_work'),
  },
  lmsLookupKey: Buffer.from(lookupKey),
  resourceHmacKey: Buffer.from(resourceKey),
});
const discovery = async (input: string | URL) => {
  if (String(input) !== issuer + '/.well-known/openid-configuration')
    throw new Error('Unexpected synthetic identity request.');
  return new Response(
    JSON.stringify({
      issuer,
      authorization_endpoint: issuer + '/authorize',
      token_endpoint: issuer + '/token',
      jwks_uri: issuer + '/jwks',
      response_types_supported: ['code'],
      subject_types_supported: ['public'],
      id_token_signing_alg_values_supported: ['RS256'],
      code_challenge_methods_supported: ['S256'],
    }),
    { headers: { 'content-type': 'application/json' } },
  );
};
const dependencies = () => ({
  keys,
  artifacts: artifacts.repository,
  sources,
  signer,
  oidcTests: { testFetch: discovery },
  resolveLmsKey: () => platformKeys,
});
interface Reply {
  status: number;
  headers: import('node:http').IncomingHttpHeaders;
  bytes: Buffer;
  text: string;
  json: any;
}
function request(
  path: string,
  options: { method?: string; body?: string; headers?: Record<string, string> } = {},
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = httpsRequest(
      origin + path,
      {
        method: options.method ?? 'GET',
        ca: tls.cert,
        rejectUnauthorized: true,
        headers: {
          ...(options.body === undefined
            ? {}
            : { 'content-length': String(Buffer.byteLength(options.body)) }),
          ...options.headers,
        },
      },
      (res) => {
        const parts: Buffer[] = [];
        res.on('data', (part: Buffer) => parts.push(part));
        res.on('end', () => {
          const bytes = Buffer.concat(parts),
            text = bytes.toString();
          let json: unknown;
          try {
            json = JSON.parse(text);
          } catch {
            /* HTML and PDF are intentional. */
          }
          resolve({ status: res.statusCode!, headers: res.headers, bytes, text, json });
        });
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    req.end(options.body);
  });
}
const cookies = (values: string[] = []) => values.map((value) => value.split(';')[0]).join('; ');
interface Session {
  cookie: string;
  csrf: string;
  principal: SessionPrincipal;
}
async function session(reply: Reply): Promise<Session> {
  expect(reply.status, reply.text).toBe(303);
  const cookie = cookies(reply.headers['set-cookie']);
  const value = await request('/api/auth/session', { headers: { cookie } });
  expect(value.status, value.text).toBe(200);
  return { cookie, csrf: value.json.csrfToken, principal: value.json };
}
function json(path: string, who: Session, value: unknown) {
  return request(path, {
    method: 'POST',
    body: JSON.stringify(value),
    headers: {
      cookie: who.cookie,
      origin,
      'x-csrf-token': who.csrf,
      'content-type': 'application/json',
    },
  });
}
async function seed() {
  const f = {
    org: randomUUID(),
    installation: randomUUID(),
    course: randomUUID(),
    teacher: randomUUID(),
    student: randomUUID(),
    documentId: randomUUID(),
    versionId: randomUUID(),
    externalCourse: randomUUID(),
    teacherSubject: randomUUID(),
    studentSubject: randomUUID(),
  };
  await admin.query('INSERT INTO margin_identity.organizations(id) VALUES($1)', [f.org]);
  const base = '/api/lms/canvas/' + f.installation;
  await admin.query(
    'INSERT INTO margin_lms.installations(id,organization_id,issuer,client_id,deployment_id,version,enabled,configuration) VALUES($1,$2,$3,$4,$5,1,true,$6)',
    [
      f.installation,
      f.org,
      platform.issuer,
      'synthetic-client',
      f.installation,
      {
        authorizationEndpoint: platform.authorizationEndpoint,
        jwksUri: platform.jwksUri,
        targets: [
          { uri: origin + base + '/launch', messageType: 'LtiResourceLinkRequest' },
          { uri: origin + base + '/deep-link', messageType: 'LtiDeepLinkingRequest' },
        ],
        serviceOrigins: [institution],
        frameOrigins: [institution],
        allowedServiceScopes: [],
      },
    ],
  );
  await admin.query(
    'INSERT INTO margin_lms.courses(installation_id,organization_id,external_digest,course_id) VALUES($1,$2,$3,$4)',
    [
      f.installation,
      f.org,
      lmsLookupDigest(lookupKey, 'course', f.installation, f.externalCourse),
      f.course,
    ],
  );
  for (const [user, role, subject] of [
    [f.teacher, 'teacher', f.teacherSubject],
    [f.student, 'student', f.studentSubject],
  ]) {
    await admin.query('INSERT INTO margin_identity.users(id,identity_key) VALUES($1,$2)', [
      user,
      hash(user),
    ]);
    await admin.query(
      'INSERT INTO margin_identity.memberships(organization_id,user_id,role) VALUES($1,$2,$3)',
      [f.org, user, role],
    );
    await admin.query(
      'INSERT INTO margin_lms.user_links(installation_id,organization_id,subject_digest,user_id) VALUES($1,$2,$3,$4)',
      [f.installation, f.org, lmsLookupDigest(lookupKey, 'subject', f.installation, subject), user],
    );
    await admin.query(
      'INSERT INTO margin_lms.enrollments(installation_id,organization_id,course_id,user_id,role) VALUES($1,$2,$3,$4,$5)',
      [f.installation, f.org, f.course, user, role],
    );
  }
  const client = await admin.connect();
  try {
    await client.query('BEGIN');
    // Fixture administration supplies the currently absent teacher intake bridge; no fake upload API.
    await client.query(
      "INSERT INTO margin_sync.documents(organization_id,id,owner_id,current_version_id,audience) VALUES($1,$2,$3,$4,'teachers')",
      [f.org, f.documentId, f.teacher, f.versionId],
    );
    await client.query(
      'INSERT INTO margin_sync.versions(organization_id,document_id,id) VALUES($1,$2,$3)',
      [f.org, f.documentId, f.versionId],
    );
    await client.query(
      "INSERT INTO margin_sync.grants(organization_id,document_id,user_id,permission) VALUES($1,$2,$3,'owner')",
      [f.org, f.documentId, f.teacher],
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
  return f;
}
type Fixture = Awaited<ReturnType<typeof seed>>;
async function begin(f: Fixture, teacher = false) {
  const base = '/api/lms/canvas/' + f.installation;
  const target = base + (teacher ? '/deep-link' : '/launch');
  const params = new URLSearchParams({
    iss: platform.issuer,
    login_hint: 'synthetic-hint',
    client_id: 'synthetic-client',
    deployment_id: f.installation,
    target_link_uri: origin + target,
  });
  const reply = await request(base + '/login?' + params);
  expect(reply.status, reply.text).toBe(302);
  const url = new URL(reply.headers.location!);
  return {
    target,
    state: url.searchParams.get('state')!,
    nonce: url.searchParams.get('nonce')!,
    cookie: cookies(reply.headers['set-cookie']),
  };
}
async function complete(
  f: Fixture,
  flow: Awaited<ReturnType<typeof begin>>,
  assignmentId?: string,
  patch: Record<string, unknown> = {},
  signingKey = platformPrivate,
) {
  const teacher = flow.target.endsWith('/deep-link'),
    now = Math.floor(Date.now() / 1000);
  const jwt = await new SignJWT({
    iss: platform.issuer,
    aud: 'synthetic-client',
    sub: teacher ? f.teacherSubject : f.studentSubject,
    iat: now,
    exp: now + 240,
    nonce: flow.nonce,
    [LTI_CLAIM + 'version']: '1.3.0',
    [LTI_CLAIM + 'deployment_id']: f.installation,
    [LTI_CLAIM + 'target_link_uri']: origin + flow.target,
    [LTI_CLAIM + 'message_type']: teacher ? 'LtiDeepLinkingRequest' : 'LtiResourceLinkRequest',
    [LTI_CLAIM + 'roles']: [
      'http://purl.imsglobal.org/vocab/lis/v2/membership#' + (teacher ? 'Instructor' : 'Learner'),
    ],
    [LTI_CLAIM + 'context']: { id: f.externalCourse },
    ...(teacher
      ? {
          'https://purl.imsglobal.org/spec/lti-dl/claim/deep_linking_settings': {
            deep_link_return_url: institution + '/return',
            accept_types: ['ltiResourceLink'],
            accept_presentation_document_targets: ['iframe'],
            data: 'synthetic-opaque-data',
          },
        }
      : {
          [LTI_CLAIM + 'resource_link']: { id: 'resource-' + assignmentId },
          [LTI_CLAIM + 'custom']: { margin_assignment_id: assignmentId },
        }),
    ...patch,
  })
    .setProtectedHeader({ alg: 'RS256', kid: 'synthetic-platform-key' })
    .sign(signingKey);
  return request(flow.target, {
    method: 'POST',
    body: new URLSearchParams({ state: flow.state, id_token: jwt }).toString(),
    headers: { cookie: flow.cookie, 'content-type': 'application/x-www-form-urlencoded' },
  });
}
async function teacherSource(f: Fixture, inspect = true) {
  const teacher = await session(await complete(f, await begin(f, true)));
  const metadata = { name: 'Synthetic private source.pdf', mimeType: 'application/pdf' as const };
  const reserved = await ingest.reserve(teacher.principal, {
    requestId: randomUUID(),
    documentId: f.documentId,
    versionId: f.versionId,
    metadata,
    plaintextBytes: body.length,
    plaintextSha256: hash(body),
  });
  const receipt = await artifacts.repository.put(reserved.identity, body, metadata, body.length);
  await ingest.stageConfirmed(teacher.principal, reserved.identity.artifactId, receipt);
  if (inspect) expect(await scanner.runOne()).toMatchObject({ status: 'ready' });
  return { teacher, reserved };
}
const assignmentInput = (f: Fixture) => ({
  requestId: randomUUID(),
  documentId: f.documentId,
  versionId: f.versionId,
  title: 'Synthetic composition assignment',
  instructions: 'Write one sentence.',
  policy: {
    allowedTools: ['text', 'pen', 'eraser'],
    allowExport: true,
    allowCopyPaste: true,
    allowReadAloud: true,
    assessment: false,
  },
});
async function selected(f: Fixture) {
  const { teacher, reserved } = await teacherSource(f);
  const created = await json('/api/assignments', teacher, assignmentInput(f));
  expect(created.status, created.text).toBe(201);
  const selection = await request('/api/assignments/selection', {
    headers: { cookie: teacher.cookie },
  });
  expect(selection.status, selection.text).toBe(200);
  const linked = await json(
    '/api/assignments/selections/' + selection.json.selection.id + '/complete',
    teacher,
    { assignmentId: created.json.assignment.id },
  );
  expect(linked.status, linked.text).toBe(200);
  const jwt = /name="JWT" value="([^"]+)"/.exec(linked.text)?.[1];
  expect(jwt).toBeTruthy();
  const verified = await jwtVerify(jwt!, createLocalJWKSet(runtime.publicJwks()), {
    issuer: 'synthetic-client',
    audience: platform.issuer,
  });
  const items = verified.payload[
    'https://purl.imsglobal.org/spec/lti-dl/claim/content_items'
  ] as Array<{ custom: { margin_assignment_id: string } }>;
  expect(items[0].custom.margin_assignment_id).toBe(created.json.assignment.id);
  expect(verified.payload['https://purl.imsglobal.org/spec/lti-dl/claim/data']).toBe(
    'synthetic-opaque-data',
  );
  return { teacher, reserved, assignmentId: items[0].custom.margin_assignment_id };
}
async function provisioned() {
  const f = await seed(),
    selectedWork = await selected(f);
  const student = await session(await complete(f, await begin(f), selectedWork.assignmentId));
  const reserved = await json('/api/assignments/work', student, {});
  expect(reserved.status, reserved.text).toBe(202);
  expect(
    (await request('/api/assignments/work', { headers: { cookie: student.cookie } })).json.work
      .status,
  ).toBe('pending');
  const pending = await request('/api/assignments/work/source', {
    headers: { cookie: student.cookie },
  });
  expect(pending.status).toBe(409);
  expect(await worker.runOne()).toMatchObject({ documentId: reserved.json.work.documentId });
  const manifest = await request('/api/assignments/work', { headers: { cookie: student.cookie } });
  expect(manifest.status, manifest.text).toBe(200);
  expect(manifest.json.work.status).toBe('provisioned');
  return { f, ...selectedWork, student, reservation: reserved.json.work, manifest: manifest.json };
}

// This scenario includes two signed launches, inspection, provisioning and many HTTPS transactions.
// Its aggregate budget does not change any production SQL, object, KMS or HTTP deadlines.
describe.skipIf(!available)(
  'Explicit Canvas composition through certificate-verified HTTPS',
  { timeout: 30_000 },
  () => {
    beforeAll(async () => {
      directory = mkdtempSync(join(tmpdir(), 'margin-compose-pg-'));
      socket = join(directory, 'socket');
      mkdirSync(socket, { mode: 0o700 });
      execFileSync(
        'initdb',
        [
          '-D',
          join(directory, 'data'),
          '-U',
          'postgres',
          '--auth-local=trust',
          '--auth-host=reject',
          '--no-locale',
          '-E',
          'UTF8',
        ],
        { stdio: 'pipe' },
      );
      execFileSync(
        'pg_ctl',
        [
          '-D',
          join(directory, 'data'),
          '-l',
          join(directory, 'postgres.log'),
          '-o',
          `-k ${socket} -h '' -p 55503`,
          '-w',
          'start',
        ],
        { stdio: 'pipe' },
      );
      started = true;
      admin = new Pool(database('postgres'));
      for (const migration of [
        '001-identity.sql',
        '002-document-sync.sql',
        '003-lms-installations.sql',
        '004-assignments.sql',
        '005-ingestion.sql',
        '006-assignment-work.sql',
        '007-assignment-work-runtime.sql',
        '008-authorization-plan-cache.sql',
      ])
        await admin.query(
          readFileSync(new URL('../infra/migrations/' + migration, import.meta.url), 'utf8'),
        );
      for (const [login, role] of [
        ['compose_identity', 'margin_identity_runtime'],
        ['compose_lms', 'margin_lms_runtime'],
        ['compose_assignments', 'margin_assignments_runtime'],
        ['compose_work', 'margin_assignment_work_runtime'],
        ['compose_ingest', 'margin_ingestion_runtime'],
        ['compose_reader', 'margin_ingestion_reader'],
        ['compose_inspector', 'margin_ingestion_inspector'],
        ['compose_worker', 'margin_assignment_provisioner'],
      ])
        await admin.query(
          `CREATE ROLE ${login} LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS; GRANT ${role} TO ${login}`,
        );
      ingest = new PostgresIngestionRepository(database('compose_ingest'), keys, 'runtime');
      reader = new PostgresIngestionRepository(database('compose_reader'), keys, 'reader');
      inspector = new PostgresIngestionRepository(database('compose_inspector'), keys, 'inspector');
      workerRepository = new PostgresStudentWorkProvisioner(database('compose_worker'), keys);
      sources = new IngestionAssignmentSourceGateway(ingest, reader, artifacts.repository);
      worker = new StudentWorkProvisioningWorker(workerRepository, reader, artifacts.repository);
      const pdf = await PDFDocument.create();
      pdf.addPage([612, 792]).drawText('Synthetic composition worksheet');
      body = Buffer.from(await pdf.save());
      const fixtureScanner: SourceScanner = {
        async inspect(bytes) {
          if (!Buffer.from(bytes).equals(body))
            throw new Error('The synthetic scanner accepts only the known fixture.');
          return {
            verdict: 'ready',
            engine: 'synthetic-fixture-only',
            engineVersion: '1',
            definitionsVersion: 'not-malware-scanning',
            pageCount: 1,
            pageGeometry: [{ index: 0, width: 612, height: 792 }],
            reason: 'clean',
          };
        },
      };
      scanner = new SourceInspectionWorker(inspector, artifacts.repository, fixtureScanner);
      const toolKeys = await generateKeyPair('RS256', { extractable: true });
      signer = new AssignmentDeepLinkSigner(
        'synthetic-tool-key',
        await exportPKCS8(toolKeys.privateKey),
      );
      const platformPair = await generateKeyPair('RS256');
      platformPrivate = platformPair.privateKey;
      platformKeys = createLocalJWKSet({
        keys: [
          {
            ...(await exportJWK(platformPair.publicKey)),
            kid: 'synthetic-platform-key',
            alg: 'RS256',
            use: 'sig',
          },
        ],
      });
      const helper = new URL('../scripts/local-tls.mjs', import.meta.url);
      const { ensureLocalTls } = await import(helper.href);
      const pair = ensureLocalTls(join(directory, 'tls'));
      tls = { key: readFileSync(pair.keyPath), cert: readFileSync(pair.certPath) };
      server = createServer(tls, (req, res) => {
        if (delegate) delegate(req, res);
        else {
          res.writeHead(503);
          res.end();
        }
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      origin = `https://127.0.0.1:${(server.address() as { port: number }).port}`;
      runtime = await createCanvasRuntime(config(), dependencies());
      const api = createApi({
        ...runtime.apiServices,
        dataDirectory: join(directory, 'filestore'),
        keyManagementProvider: keys,
        tls,
        requestsPerMinute: 5000,
        logger: () => {},
      });
      delegate = api.listeners('request')[0] as RequestListener;
    }, 30_000);
    afterEach(async () => {
      vi.restoreAllMocks();
      artifacts.setUnavailable(false);
      await admin?.query(
        'UPDATE margin_identity.organizations SET disabled_at=clock_timestamp() WHERE disabled_at IS NULL',
      );
    });
    afterAll(async () => {
      const errors: unknown[] = [];
      if (server)
        await new Promise<void>((resolve) =>
          server.close((error) => {
            if (error) errors.push(error);
            resolve();
          }),
        );
      const results = await Promise.allSettled([
        runtime?.close(),
        ingest?.close(),
        reader?.close(),
        inspector?.close(),
        workerRepository?.close(),
        admin?.end(),
      ]);
      for (const result of results) if (result.status === 'rejected') errors.push(result.reason);
      artifacts.repository.close();
      let stopped = !started;
      try {
        if (started) await stopDisposablePostgres(join(directory, 'data'));
        stopped = true;
      } catch (error) {
        errors.push(error);
      }
      if (stopped && directory) rmSync(directory, { recursive: true, force: true });
      for (const key of [lookupKey, resourceKey, sessionKey, identityKey, tls?.key]) key?.fill(0);
      body?.fill(0);
      if (errors.length) throw new AggregateError(errors, 'Composition fixture cleanup failed.');
    });
    it('connects signed teacher selection to student provisioning, source, durable operations and a fresh launch', async () => {
      const f = await provisioned(),
        document = f.manifest.work.document;
      const source = await request('/api/assignments/work/source', {
        headers: { cookie: f.student.cookie },
      });
      expect(source.status, source.text).toBe(200);
      expect(source.bytes).toEqual(body);
      expect(source.headers['cache-control']).toBe('no-store');
      for (const privateId of [f.f.teacher, f.f.documentId, f.reserved.identity.artifactId])
        expect(JSON.stringify(f.manifest)).not.toContain(privateId);
      for (const cipher of artifacts.ciphertexts()) {
        expect(cipher.includes(body)).toBe(false);
        cipher.fill(0);
      }
      const operation = {
        documentId: document.documentId,
        versionId: document.versionId,
        pageId: document.pages[0].id,
        annotationId: randomUUID(),
        operationId: randomUUID(),
        baseRevision: 0,
        kind: 'put',
        annotation: {
          type: 'text',
          x: 10,
          y: 20,
          width: 100,
          height: 24,
          text: 'Synthetic student response',
          color: '#123456',
          strokeWidth: 2,
          opacity: 1,
          rotation: 0,
        },
      };
      const first = await json('/api/assignments/work/operations', f.student, operation);
      expect(first.status, first.text).toBe(200);
      expect(first.json.receipt).toMatchObject({ cursor: 1, duplicate: false });
      expect(
        (await json('/api/assignments/work/operations', f.student, operation)).json.receipt
          .duplicate,
      ).toBe(true);
      const fresh = await session(await complete(f.f, await begin(f.f), f.assignmentId));
      expect(fresh.principal.sessionId).not.toBe(f.student.principal.sessionId);
      const view = await request('/api/assignments/work', { headers: { cookie: fresh.cookie } });
      expect(view.json.work.document.documentId).toBe(document.documentId);
      const catchup = await request('/api/assignments/work/operations?afterCursor=0&limit=10', {
        headers: { cookie: fresh.cookie },
      });
      expect(catchup.status, catchup.text).toBe(200);
      expect(catchup.json.operations).toHaveLength(1);
      expect(catchup.json.operations[0].annotation.text).toBe(operation.annotation.text);
      const generic = await request('/api/sync/documents/' + document.documentId, {
        headers: { cookie: fresh.cookie },
      });
      expect(generic.status).toBe(403);
      expect(generic.json.error.code).toBe('lms_resource_scope_required');
      const health = await request('/api/health');
      expect(health.json).toMatchObject({
        assignmentsConfigured: true,
        assignmentWorkConfigured: true,
      });
    });
    it('rejects tampered signatures, launch replay and unprovisioned subject mappings', async () => {
      const f = await seed();
      const foreign = await generateKeyPair('RS256');
      const tampered = await complete(f, await begin(f, true), undefined, {}, foreign.privateKey);
      expect(tampered.status).toBeGreaterThanOrEqual(400);
      expect(tampered.headers['set-cookie']?.join('') ?? '').not.toContain(
        '__Host-margin-session=',
      );
      const flow = await begin(f, true);
      const good = await complete(f, flow);
      expect(good.status, good.text).toBe(303);
      expect((await complete(f, flow)).status).toBeGreaterThanOrEqual(400);
      const unmapped = await complete(f, await begin(f, true), undefined, {
        sub: 'not-provisioned',
      });
      expect(unmapped.status).toBe(403);
      expect(
        (
          await admin.query(
            'SELECT count(*)::int AS n FROM margin_identity.sessions WHERE organization_id=$1',
            [f.org],
          )
        ).rows[0].n,
      ).toBe(1);
    });
    it('keeps uninspected sources unavailable and rejects missing CSRF before assignment creation', async () => {
      const f = await seed(),
        { teacher } = await teacherSource(f, false);
      const denied = await request('/api/assignments', {
        method: 'POST',
        body: JSON.stringify(assignmentInput(f)),
        headers: { cookie: teacher.cookie, origin, 'content-type': 'application/json' },
      });
      expect(denied.status).toBe(403);
      expect(denied.json.error.code).toBe('csrf_rejected');
      const pending = await json('/api/assignments', teacher, assignmentInput(f));
      expect(pending.status).toBe(409);
      expect(
        (
          await admin.query(
            'SELECT count(*)::int AS n FROM margin_assignments.assignments WHERE organization_id=$1',
            [f.org],
          )
        ).rows[0].n,
      ).toBe(0);
    });
    it('rechecks current LMS authority for existing cookies and blocks revoked source content', async () => {
      const f = await provisioned();
      await admin.query(
        'UPDATE margin_sync.grants SET revoked_at=clock_timestamp() WHERE organization_id=$1 AND document_id=$2',
        [f.f.org, f.f.documentId],
      );
      const revokedSource = await request('/api/assignments/work/source', {
        headers: { cookie: f.student.cookie },
      });
      expect(revokedSource.status).toBe(404);
      await admin.query(
        'UPDATE margin_lms.enrollments SET disabled_at=clock_timestamp() WHERE installation_id=$1 AND user_id=$2',
        [f.f.installation, f.f.student],
      );
      const revoked = await request('/api/auth/session', { headers: { cookie: f.student.cookie } });
      expect(revoked.status).toBe(403);
      expect(
        (await request('/api/assignments/work', { headers: { cookie: f.student.cookie } })).status,
      ).toBe(403);
    });
    it('never treats an object outage as available content', async () => {
      const f = await provisioned();
      artifacts.setUnavailable(true);
      const unavailable = await request('/api/assignments/work/source', {
        headers: { cookie: f.student.cookie },
      });
      expect(unavailable.status).toBeGreaterThanOrEqual(400);
      expect(unavailable.headers['content-type']).not.toBe('application/pdf');
      artifacts.setUnavailable(false);
      expect(
        (await request('/api/assignments/work/source', { headers: { cookie: f.student.cookie } }))
          .bytes,
      ).toEqual(body);
    });
    it('snapshots caller-owned keys and public JWKS while retaining caller-owned providers', async () => {
      const input = config(),
        original = Buffer.from(input.identity.sessionSecret);
      const pending = createCanvasRuntime(input, dependencies());
      for (const key of [
        input.identity.sessionSecret,
        input.identity.identityHmacKey,
        input.lmsLookupKey,
        input.resourceHmacKey,
      ])
        key.fill(0);
      const own = await pending;
      try {
        const jwks = own.publicJwks();
        expect(jwks.keys[0]).toMatchObject({ kid: 'synthetic-tool-key', alg: 'RS256' });
        expect(jwks.keys[0]).not.toHaveProperty('d');
        jwks.keys[0].kid = 'mutated';
        expect(own.publicJwks().keys[0].kid).toBe('synthetic-tool-key');
        const loginCookie = (await own.apiServices.identityService.startLogin()).cookies[0]
          .split(';')[0]
          .slice('__Host-margin-login='.length);
        expect(createCookieCrypto(original, origin).open(loginCookie).returnTo).toBe('/');
        expect(original.equals(sessionKey)).toBe(true);
        const closeA = own.close(),
          closeB = own.close();
        expect(closeA).toBe(closeB);
        await closeA;
        expect(() => own.publicJwks()).toThrow('closed');
        expect(artifacts.destroyed).toBe(false);
        expect(signer.jwks().keys[0].kid).toBe('synthetic-tool-key');
      } finally {
        await own.close();
        original.fill(0);
      }
    });
    it('closes all owned resources on failed discovery without modifying caller key material', async () => {
      const spies = [
        vi.spyOn(PostgresLmsRepository.prototype, 'close'),
        vi.spyOn(PostgresIdentityRepository.prototype, 'close'),
        vi.spyOn(PostgresAssignmentRepository.prototype, 'close'),
        vi.spyOn(PostgresAssignmentWorkService.prototype, 'close'),
      ];
      const input = config();
      await expect(
        createCanvasRuntime(input, {
          ...dependencies(),
          oidcTests: {
            testFetch: async () => {
              throw new Error('synthetic issuer unavailable');
            },
          },
        }),
      ).rejects.toBeInstanceOf(Error);
      for (const spy of spies) expect(spy).toHaveBeenCalledTimes(1);
      expect(Buffer.from(input.identity.sessionSecret)).toEqual(sessionKey);
      expect(artifacts.destroyed).toBe(false);
    });
    it('rejects shared configuration keys before constructing repositories or making discovery requests', async () => {
      const input = config();
      input.resourceHmacKey = input.lmsLookupKey;
      const fetch = vi.fn(discovery),
        close = vi.spyOn(PostgresLmsRepository.prototype, 'close');
      await expect(
        createCanvasRuntime(input, { ...dependencies(), oidcTests: { testFetch: fetch } }),
      ).rejects.toThrow('independent');
      expect(fetch).not.toHaveBeenCalled();
      expect(close).not.toHaveBeenCalled();
      expect(Buffer.from(input.lmsLookupKey)).toEqual(lookupKey);
    });
    it('cleans already constructed repositories when a later constructor refuses unsafe transport', async () => {
      const closes = [
        vi.spyOn(PostgresLmsRepository.prototype, 'close'),
        vi.spyOn(PostgresIdentityRepository.prototype, 'close'),
        vi.spyOn(PostgresAssignmentRepository.prototype, 'close'),
      ];
      const fetch = vi.fn(discovery),
        input = config();
      input.databases.work = { host: 'synthetic-invalid.test', ssl: false };
      await expect(
        createCanvasRuntime(input, { ...dependencies(), oidcTests: { testFetch: fetch } }),
      ).rejects.toThrow('TLS');
      for (const close of closes) expect(close).toHaveBeenCalledTimes(1);
      expect(fetch).not.toHaveBeenCalled();
      expect(artifacts.destroyed).toBe(false);
    });
    it('continues cleanup after one owned resource reports a failure and retains that failure', async () => {
      const own = await createCanvasRuntime(config(), dependencies());
      const originalClose = own.apiServices.assignmentWorkService.close.bind(
        own.apiServices.assignmentWorkService,
      );
      vi.spyOn(own.apiServices.assignmentWorkService, 'close').mockImplementation(async () => {
        await originalClose();
        throw new Error('synthetic cleanup failure');
      });
      const closes = [
        vi.spyOn(PostgresLmsRepository.prototype, 'close'),
        vi.spyOn(PostgresIdentityRepository.prototype, 'close'),
        vi.spyOn(PostgresAssignmentRepository.prototype, 'close'),
      ];
      const result = own.close();
      await expect(result).rejects.toMatchObject({
        errors: [expect.objectContaining({ message: 'synthetic cleanup failure' })],
      });
      expect(own.close()).toBe(result);
      for (const close of closes) expect(close).toHaveBeenCalledTimes(1);
      expect(() => own.publicJwks()).toThrow('closed');
      expect(artifacts.destroyed).toBe(false);
    });
  },
);
