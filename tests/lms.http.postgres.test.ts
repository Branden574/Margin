import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createServer, request as httpsRequest, type Server } from 'node:https';
import { request as httpRequest, createServer as createHttpServer } from 'node:http';
import { Pool } from 'pg';
import * as oidc from 'openid-client';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { hostedCanvasEndpoints, LTI_CLAIM, type LaunchAttempt } from '../packages/lms/src/index';
import {
  createLmsHandler,
  createLmsService,
  lmsLookupDigest,
  PostgresLmsRepository,
} from '../apps/api/src/lms/index';
import { IdentityService } from '../apps/api/src/identity/service';
import { createIdentityHandler } from '../apps/api/src/identity/http';
import { PostgresIdentityRepository } from '../apps/api/src/identity/postgres';
import { createApi } from '../apps/api/src/server';
import { withTableOwnerMembership } from './helpers/owner-role';
import { withAssignmentProvisionerMembership } from './helpers/provisioner-role';
import { stopDisposablePostgres } from './helpers/postgres';

const available = ['initdb', 'pg_ctl', 'psql'].every((tool) => {
  try {
    execFileSync(tool, ['--version'], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
});
if (process.env.MARGIN_REQUIRE_POSTGRES_TESTS === '1' && !available)
  throw new Error('Required LMS PostgreSQL test binaries are unavailable.');
const installA = randomUUID(),
  installB = randomUUID(),
  orgA = randomUUID(),
  orgB = randomUUID(),
  userA = randomUUID(),
  userB = randomUUID(),
  courseA = randomUUID(),
  courseB = randomUUID();
const lookupKey = Buffer.alloc(32, 37),
  platform = hostedCanvasEndpoints('test'),
  institution = 'https://school.test.instructure.com';
let directory: string,
  socket: string,
  origin: string,
  started = false,
  admin: Pool,
  runtime: Pool,
  provisioner: Pool,
  repository: PostgresLmsRepository,
  identityRepository: PostgresIdentityRepository,
  identity: IdentityService,
  server: Server;
let tls: { key: Buffer; cert: Buffer },
  privateKey: CryptoKey,
  keys: ReturnType<typeof createLocalJWKSet>;
let service: ReturnType<typeof createLmsService>;
let handler: ReturnType<typeof createLmsHandler>,
  identityHandler: ReturnType<typeof createIdentityHandler>;
const base = (id = installA) => `/api/lms/canvas/${id}`;
const digest = (s: string) => createHash('sha256').update(s).digest('hex');
const cookieHeader = (values: readonly string[]) => values.map((v) => v.split(';')[0]).join('; ');
interface Reply {
  status: number;
  headers: import('node:http').IncomingHttpHeaders;
  body: string;
}
function request(
  path: string,
  options: { method?: string; body?: string; headers?: Record<string, string> } = {},
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = httpsRequest(
      path.startsWith('https://') ? path : origin + path,
      {
        method: options.method ?? 'GET',
        ca: tls.cert,
        rejectUnauthorized: true,
        headers: {
          ...(options.body !== undefined
            ? {
                'content-type': 'application/x-www-form-urlencoded',
                'content-length': String(Buffer.byteLength(options.body)),
              }
            : {}),
          ...options.headers,
        },
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body }));
      },
    );
    req.on('error', reject);
    req.end(options.body);
  });
}
async function begin(id = installA, extra: Record<string, string> = {}) {
  const params = new URLSearchParams({
    iss: platform.issuer,
    login_hint: 'opaque-platform-hint',
    client_id: 'client-test',
    deployment_id: id === installA ? 'deployment-a' : 'deployment-b',
    target_link_uri: origin + base(id) + '/launch',
    ...extra,
  });
  const response = await request(base(id) + '/login?' + params);
  expect(response.status, response.body).toBe(302);
  const authorization = new URL(response.headers.location!);
  return {
    state: authorization.searchParams.get('state')!,
    nonce: authorization.searchParams.get('nonce')!,
    cookies: response.headers['set-cookie']!,
    authorization,
  };
}
async function signed(
  flow: Awaited<ReturnType<typeof begin>>,
  patch: Record<string, unknown> = {},
) {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({
    iss: platform.issuer,
    aud: 'client-test',
    sub: 'canvas-user-a',
    iat: now,
    exp: now + 240,
    nonce: flow.nonce,
    [LTI_CLAIM + 'version']: '1.3.0',
    [LTI_CLAIM + 'deployment_id']: 'deployment-a',
    [LTI_CLAIM + 'message_type']: 'LtiResourceLinkRequest',
    [LTI_CLAIM + 'target_link_uri']: origin + base() + '/launch',
    [LTI_CLAIM + 'roles']: ['http://purl.imsglobal.org/vocab/lis/v2/membership#Learner'],
    [LTI_CLAIM + 'resource_link']: { id: 'assignment-a' },
    [LTI_CLAIM + 'context']: { id: 'course-a' },
    ...patch,
  })
    .setProtectedHeader({ alg: 'RS256', kid: 'fixture-key' })
    .sign(privateKey);
}
async function launch(
  flow: Awaited<ReturnType<typeof begin>>,
  patch: Record<string, unknown> = {},
  headers: Record<string, string> = {},
) {
  return request(base() + '/launch', {
    method: 'POST',
    body: new URLSearchParams({
      state: flow.state,
      id_token: await signed(flow, patch),
    }).toString(),
    headers: { cookie: cookieHeader(flow.cookies), ...headers },
  });
}
async function successfulSession() {
  const flow = await begin();
  const result = await launch(flow);
  expect(result.status, result.body).toBe(303);
  const cookies = result.headers['set-cookie']!;
  const auth = await request('/api/auth/session', { headers: { cookie: cookieHeader(cookies) } });
  expect(auth.status, auth.body).toBe(200);
  return { cookies, principal: JSON.parse(auth.body) };
}
async function seedInstallation(id: string, org: string, dep: string) {
  await provisioner.query(
    'INSERT INTO margin_lms.installations(id,organization_id,issuer,client_id,deployment_id,version,enabled,configuration) VALUES($1,$2,$3,$4,$5,1,true,$6)',
    [
      id,
      org,
      platform.issuer,
      'client-test',
      dep,
      {
        authorizationEndpoint: platform.authorizationEndpoint,
        jwksUri: platform.jwksUri,
        targets: [
          { uri: origin + base(id) + '/launch', messageType: 'LtiResourceLinkRequest' },
          { uri: origin + base(id) + '/deep-link', messageType: 'LtiDeepLinkingRequest' },
        ],
        serviceOrigins: [institution],
        frameOrigins: [institution],
        allowedServiceScopes: [],
      },
    ],
  );
}

describe.skipIf(!available)(
  'Canvas HTTPS launch and durable PostgreSQL enrollment boundary',
  () => {
    beforeAll(async () => {
      directory = mkdtempSync(join(tmpdir(), 'margin-lms-pg-'));
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
          `-k ${socket} -h '' -p 55491`,
          '-w',
          'start',
        ],
        { stdio: 'pipe' },
      );
      started = true;
      admin = new Pool({ host: socket, port: 55491, user: 'postgres', database: 'postgres' });
      await admin.query(
        readFileSync(new URL('../infra/migrations/001-identity.sql', import.meta.url), 'utf8'),
      );
      await admin.query(
        readFileSync(
          new URL('../infra/migrations/003-lms-installations.sql', import.meta.url),
          'utf8',
        ),
      );
      await admin.query(
        'CREATE ROLE lms_runtime_test LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS; GRANT margin_lms_runtime TO lms_runtime_test; CREATE ROLE lms_identity_runtime_test LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS; GRANT margin_identity_runtime TO lms_identity_runtime_test; CREATE ROLE lms_provision_test LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS; GRANT margin_lms_provisioner,margin_identity_provisioner TO lms_provision_test',
      );
      const config = { host: socket, port: 55491, user: 'lms_runtime_test', database: 'postgres' };
      runtime = new Pool(config);
      repository = new PostgresLmsRepository(config, lookupKey);
      identityRepository = new PostgresIdentityRepository({
        ...config,
        user: 'lms_identity_runtime_test',
      });
      provisioner = new Pool({ ...config, user: 'lms_provision_test' });
      await provisioner.query(
        'INSERT INTO margin_identity.users(id,identity_key) VALUES($1,$2),($3,$4)',
        [userA, digest('user-a'), userB, digest('user-b')],
      );
      await provisioner.query('INSERT INTO margin_identity.organizations(id) VALUES($1),($2)', [
        orgA,
        orgB,
      ]);
      await provisioner.query(
        "INSERT INTO margin_identity.memberships(organization_id,user_id,role) VALUES($1,$2,'student'),($3,$4,'student')",
        [orgA, userA, orgB, userB],
      );
      const helper = new URL('../scripts/local-tls.mjs', import.meta.url);
      const { ensureLocalTls } = await import(helper.href);
      const pair = ensureLocalTls(join(directory, 'tls'));
      tls = { key: readFileSync(pair.keyPath), cert: readFileSync(pair.certPath) };
      const cryptoKeys = await generateKeyPair('RS256');
      privateKey = cryptoKeys.privateKey;
      keys = createLocalJWKSet({
        keys: [
          {
            ...(await exportJWK(cryptoKeys.publicKey)),
            kid: 'fixture-key',
            alg: 'RS256',
            use: 'sig',
          },
        ],
      });
      server = createServer(tls, async (req, res) => {
        if (await handler(req, res)) return;
        if (await identityHandler(req, res)) return;
        res.writeHead(404);
        res.end();
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      origin = `https://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`;
      identity = new IdentityService(
        {
          issuerUrl: 'https://identity.fixture.test',
          clientId: 'fixture-bff',
          clientSecret: 'fixture-secret-is-not-a-real-credential',
          applicationOrigin: origin,
          redirectUri: origin + '/api/auth/callback',
          sessionSecret: Buffer.alloc(32, 11),
          identityHmacKey: Buffer.alloc(32, 12),
        },
        identityRepository,
        new oidc.Configuration({ issuer: 'https://identity.fixture.test' }, 'fixture-bff'),
        { authorizeLmsSession: (principal) => repository.authorizeSession(principal) },
      );
      service = createLmsService({
        applicationOrigin: origin,
        repository,
        issueSession: (enrollment, req) => identity.issueLmsSession(enrollment, req),
        authenticateSession: (req) => identity.authenticateRequest(req),
        resolveKey: () => keys,
      });
      handler = createLmsHandler(service);
      identityHandler = createIdentityHandler(identity);
      await seedInstallation(installA, orgA, 'deployment-a');
      await seedInstallation(installB, orgB, 'deployment-b');
      for (const [id, org, user, course, subject, external] of [
        [installA, orgA, userA, courseA, 'canvas-user-a', 'course-a'],
        [installB, orgB, userB, courseB, 'canvas-user-b', 'course-b'],
      ]) {
        await provisioner.query(
          'INSERT INTO margin_lms.user_links(installation_id,organization_id,subject_digest,user_id) VALUES($1,$2,$3,$4)',
          [id, org, lmsLookupDigest(lookupKey, 'subject', id, subject), user],
        );
        await provisioner.query(
          'INSERT INTO margin_lms.courses(installation_id,organization_id,external_digest,course_id) VALUES($1,$2,$3,$4)',
          [id, org, lmsLookupDigest(lookupKey, 'course', id, external), course],
        );
        await provisioner.query(
          "INSERT INTO margin_lms.enrollments(installation_id,organization_id,course_id,user_id,role) VALUES($1,$2,$3,$4,'student')",
          [id, org, course, user],
        );
      }
    }, 30000);
    beforeEach(() => {
      handler = createLmsHandler(service);
    });
    afterAll(async () => {
      await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
      await Promise.all([
        repository?.close(),
        identityRepository?.close(),
        runtime?.end(),
        provisioner?.end(),
        admin?.end(),
      ]);
      if (started) await stopDisposablePostgres(join(directory, 'data'));
      if (directory) rmSync(directory, { recursive: true, force: true });
    });
    it('performs a certificate-verified HTTPS form_post launch, creates a bound session and retains Lax application cookies', async () => {
      const flow = await begin();
      expect(flow.cookies[0]).toContain('Secure; HttpOnly; SameSite=None');
      expect(flow.cookies[0]).toMatch(/^__Host-margin-lti-/);
      expect(flow.authorization.href).not.toContain(flow.cookies[0].split('=')[1].split(';')[0]);
      const response = await launch(flow);
      expect(response.status, response.body).toBe(303);
      expect(response.headers.location).toBe(origin + '/');
      expect(response.headers['cache-control']).toBe('no-store');
      const sessionCookie = response.headers['set-cookie']!.find((v) =>
        v.startsWith('__Host-margin-session='),
      )!;
      expect(sessionCookie).toContain('Secure; HttpOnly; SameSite=Lax');
      const authenticated = await request('/api/auth/session', {
        headers: { cookie: cookieHeader(response.headers['set-cookie']!) },
      });
      expect(authenticated.status, authenticated.body).toBe(200);
      expect(JSON.parse(authenticated.body)).toMatchObject({
        userId: userA,
        organizationId: orgA,
        role: 'student',
        authenticationMethod: 'lti',
        mfa: false,
      });
      const stored = await admin.query(
        'SELECT * FROM margin_lms.session_bindings WHERE session_id=$1',
        [JSON.parse(authenticated.body).sessionId],
      );
      expect(stored.rows[0]).toMatchObject({
        installation_id: installA,
        course_id: courseA,
        user_id: userA,
      });
    });
    it('retains independent cookies for concurrent launches and consumes each launch at most once', async () => {
      const first = await begin(),
        second = await begin();
      expect(first.cookies[0].split('=')[0]).not.toBe(second.cookies[0].split('=')[0]);
      const body = new URLSearchParams({
        state: first.state,
        id_token: await signed(first),
      }).toString();
      const responses = await Promise.all([
        request(base() + '/launch', {
          method: 'POST',
          body,
          headers: { cookie: cookieHeader([...first.cookies, ...second.cookies]) },
        }),
        request(base() + '/launch', {
          method: 'POST',
          body,
          headers: { cookie: cookieHeader(first.cookies) },
        }),
      ]);
      expect(responses.map((v) => v.status).sort()).toEqual([303, 403]);
      expect((await launch(second)).status).toBe(303);
    });
    it('fails closed for missing, duplicated and substituted binding cookies without issuing a session', async () => {
      for (const cookie of ['', 'wrong=value']) {
        const flow = await begin();
        const result = await launch(flow, {}, { cookie });
        expect(result.status).toBe(403);
        expect(result.body).toContain('top-level');
      }
      const first = await begin(),
        second = await begin();
      expect(
        (await launch(first, {}, { cookie: cookieHeader([...first.cookies, ...first.cookies]) }))
          .status,
      ).toBe(403);
      expect((await launch(first, {}, { cookie: cookieHeader(second.cookies) })).status).toBe(403);
    });
    it('requires trusted account, course and explicit matching enrollment instead of email or token roles', async () => {
      for (const patch of [
        { sub: 'unlinked', email: 'student@example.test' },
        { [LTI_CLAIM + 'context']: { id: 'unregistered-course' } },
        { [LTI_CLAIM + 'roles']: ['http://purl.imsglobal.org/vocab/lis/v2/membership#Instructor'] },
        {
          [LTI_CLAIM + 'roles']: [
            'http://purl.imsglobal.org/vocab/lis/v2/membership#Administrator',
          ],
        },
      ]) {
        const result = await launch(await begin(), patch);
        expect(result.status, result.body).toBe(403);
        expect(result.body).toContain('enrollment_required');
      }
      expect((await runtime.query('SELECT * FROM margin_lms.user_links')).rowCount).toBe(0);
    });
    it('does not permit an installation or course from another tenant to replace the signed registered mapping', async () => {
      const flow = await begin();
      expect((await launch(flow, { [LTI_CLAIM + 'deployment_id']: 'deployment-b' })).status).toBe(
        403,
      );
      const other = await begin(installB);
      const token = await signed(other, {
        [LTI_CLAIM + 'deployment_id']: 'deployment-b',
        [LTI_CLAIM + 'target_link_uri']: origin + base(installB) + '/launch',
      });
      const result = await request(base(installB) + '/launch', {
        method: 'POST',
        body: new URLSearchParams({ state: other.state, id_token: token }).toString(),
        headers: { cookie: cookieHeader(other.cookies) },
      });
      expect(result.status).toBe(403);
      expect(result.body).toContain('enrollment_required');
    });
    it('invalidates active sessions when enrollment, user link, course, membership or institution is disabled', async () => {
      for (const [table, key, value] of [
        ['margin_lms.enrollments', 'user_id', userA],
        ['margin_lms.user_links', 'user_id', userA],
        ['margin_lms.courses', 'course_id', courseA],
        ['margin_identity.users', 'id', userA],
        ['margin_identity.organizations', 'id', orgA],
      ]) {
        const { cookies } = await successfulSession();
        await admin.query(`UPDATE ${table} SET disabled_at=now() WHERE ${key}=$1`, [value]);
        try {
          const response = await request('/api/auth/session', {
            headers: { cookie: cookieHeader(cookies) },
          });
          expect([401, 403]).toContain(response.status);
        } finally {
          await admin.query(`UPDATE ${table} SET disabled_at=NULL WHERE ${key}=$1`, [value]);
        }
      }
      const { cookies } = await successfulSession();
      await admin.query(
        'UPDATE margin_identity.memberships SET revoked_at=now() WHERE user_id=$1',
        [userA],
      );
      try {
        expect(
          (await request('/api/auth/session', { headers: { cookie: cookieHeader(cookies) } }))
            .status,
        ).toBe(401);
      } finally {
        await admin.query(
          'UPDATE margin_identity.memberships SET revoked_at=NULL WHERE user_id=$1',
          [userA],
        );
      }
    });
    it('denies privilege promotion and rechecks installation version after launch', async () => {
      const { cookies } = await successfulSession();
      await admin.query("UPDATE margin_identity.memberships SET role='teacher' WHERE user_id=$1", [
        userA,
      ]);
      try {
        expect(
          (await request('/api/auth/session', { headers: { cookie: cookieHeader(cookies) } }))
            .status,
        ).toBe(403);
      } finally {
        await admin.query(
          "UPDATE margin_identity.memberships SET role='student' WHERE user_id=$1",
          [userA],
        );
      }
      const next = await successfulSession();
      await provisioner.query('UPDATE margin_lms.installations SET version=version+1 WHERE id=$1', [
        installA,
      ]);
      expect(
        (await request('/api/auth/session', { headers: { cookie: cookieHeader(next.cookies) } }))
          .status,
      ).toBe(403);
    });
    it('rejects a login that was pending before a registration change or revocation', async () => {
      const flow = await begin();
      await provisioner.query(
        'UPDATE margin_lms.installations SET version=version+1,enabled=false WHERE id=$1',
        [installA],
      );
      try {
        expect((await launch(flow)).status).toBe(404);
      } finally {
        await provisioner.query(
          'UPDATE margin_lms.installations SET version=version+1,enabled=true WHERE id=$1',
          [installA],
        );
      }
      expect((await launch(flow)).status).toBe(403);
    });
    it('offers a registered-origin, escaped top-level continuation instead of weakening browser binding in an iframe', async () => {
      const params = new URLSearchParams({
        iss: platform.issuer,
        login_hint: '"><script>alert(1)</script>',
        target_link_uri: origin + base() + '/launch',
      });
      const response = await request(base() + '/login?' + params, {
        headers: { 'sec-fetch-dest': 'iframe' },
      });
      expect(response.status).toBe(200);
      expect(response.headers['content-security-policy']).toContain(
        `frame-ancestors ${institution}`,
      );
      expect(response.headers['set-cookie']).toBeUndefined();
      expect(response.headers['x-frame-options']).toBeUndefined();
      expect(response.body).toContain('target="_top"');
      expect(response.body).not.toContain('<script>');
      expect(response.body).toContain('&lt;script&gt;');
      const direct = await launch(await begin(), {}, { 'sec-fetch-dest': 'iframe' });
      expect(direct.status).toBe(403);
      expect(direct.headers['x-frame-options']).toBe('DENY');
    });
    it('rejects duplicate/unknown/oversized/form-mixed parameters and preserves no-store frame denial on errors', async () => {
      const requests = [
        request(base() + '/login?iss=a&iss=b'),
        request(base() + '/login?unexpected=value'),
        request(base() + '/launch', { method: 'GET' }),
        request(base() + '/launch?state=x', { method: 'POST', body: '' }),
        request(base() + '/launch', {
          method: 'POST',
          body: '{}',
          headers: { 'content-type': 'application/json' },
        }),
        request(base() + '/launch', { method: 'POST', body: 'id_token=' + 'x'.repeat(100000) }),
      ];
      const responses = await Promise.all(requests);
      expect(responses.map((v) => v.status)).toEqual([400, 400, 405, 400, 415, 413]);
      for (const result of responses) {
        expect(result.headers['cache-control']).toBe('no-store');
        expect(result.headers['x-frame-options']).toBe('DENY');
      }
    });
    it('persists only digests, enforces all-field replay comparison, survives repository restart and reserves nonce once', async () => {
      const now = Date.now(),
        value: LaunchAttempt = {
          stateDigest: digest(randomUUID()),
          nonceDigest: digest(randomUUID()),
          browserBindingDigest: digest(randomUUID()),
          installationId: installA,
          registrationVersion: 1,
          targetUri: origin + base() + '/launch',
          messageType: 'LtiResourceLinkRequest',
          createdAt: now,
          expiresAt: now + 300000,
        };
      expect(await repository.create(value)).toBe(true);
      expect(await repository.create(value)).toBe(false);
      const second = new PostgresLmsRepository(
        { host: socket, port: 55491, user: 'lms_runtime_test', database: 'postgres' },
        lookupKey,
      );
      try {
        expect(await second.find(value.stateDigest)).toEqual(value);
        expect(
          await second.consume({ ...value, targetUri: origin + '/wrong' }, now, now + 240000),
        ).toBe(false);
        const results = await Promise.all([
          repository.consume(value, now, now + 240000),
          second.consume(value, now, now + 240000),
        ]);
        expect(results.filter(Boolean)).toHaveLength(1);
        expect(await second.find(value.stateDigest)).toBeNull();
        const repeated = { ...value, stateDigest: digest(randomUUID()) };
        await second.create(repeated);
        expect(await second.consume(repeated, now, now + 240000)).toBe(false);
      } finally {
        await second.close();
      }
      const rows = await admin.query(
        "SELECT column_name FROM information_schema.columns WHERE table_schema='margin_lms'",
      );
      expect(rows.rows.map((v) => v.column_name)).not.toContain('id_token');
      expect(rows.rows.map((v) => v.column_name)).not.toContain('browser_binding');
    });
    it('enforces RLS and provisioning grants and rejects tenant relinking or unversioned updates', async () => {
      for (const table of [
        'installations',
        'launch_attempts',
        'nonce_receipts',
        'user_links',
        'courses',
        'enrollments',
        'session_bindings',
      ])
        expect((await runtime.query(`SELECT * FROM margin_lms.${table}`)).rowCount).toBe(0);
      await expect(
        runtime.query('UPDATE margin_lms.installations SET enabled=false'),
      ).rejects.toMatchObject({ code: '42501' });
      await expect(
        provisioner.query('UPDATE margin_lms.installations SET enabled=false WHERE id=$1', [
          installA,
        ]),
      ).rejects.toThrow('increment version');
      await expect(
        provisioner.query('UPDATE margin_lms.user_links SET user_id=$1', [userB]),
      ).rejects.toMatchObject({ code: '42501' });
      await expect(
        provisioner.query(
          'INSERT INTO margin_lms.user_links(installation_id,organization_id,subject_digest,user_id) VALUES($1,$2,$3,$4)',
          [installA, orgB, digest('foreign'), userB],
        ),
      ).rejects.toMatchObject({ code: '23503' });
      expect(await repository.findById(installA)).toMatchObject({
        id: installA,
        organizationId: orgA,
      });
    });
    it('denies a valid identity LTI session without its LMS binding and never permits forged principal substitution', async () => {
      const issued = await identity.issueLmsSession(
        { userId: userA, organizationId: orgA, role: 'student' },
        { headers: {} },
      );
      expect(
        (await request('/api/auth/session', { headers: { cookie: cookieHeader(issued.cookies) } }))
          .status,
      ).toBe(403);
      const active = await successfulSession();
      expect(await repository.authorizeSession({ ...active.principal, userId: userB })).toBe(false);
      expect(
        await repository.authorizeSession({ ...active.principal, authenticationMethod: 'oidc' }),
      ).toBe(false);
      expect(await repository.authorizeSession({ ...active.principal, organizationId: orgB })).toBe(
        false,
      );
    });
    it('requires verified database TLS and least-privilege runtime credentials', async () => {
      expect(() => new PostgresLmsRepository({ host: 'db.test', ssl: false }, lookupKey)).toThrow(
        'TLS',
      );
      expect(
        () =>
          new PostgresLmsRepository(
            { host: 'db.test', ssl: { rejectUnauthorized: false } },
            lookupKey,
          ),
      ).toThrow('TLS');
      const tlsSetting = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
      process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
      try {
        expect(() => new PostgresLmsRepository({ host: 'db.test', ssl: true }, lookupKey)).toThrow(
          'TLS',
        );
      } finally {
        if (tlsSetting === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
        else process.env.NODE_TLS_REJECT_UNAUTHORIZED = tlsSetting;
      }
      const unsafe = new PostgresLmsRepository(
        { host: socket, port: 55491, user: 'postgres', database: 'postgres' },
        lookupKey,
      );
      try {
        await expect(unsafe.findById(installA)).rejects.toThrow('must not');
      } finally {
        await unsafe.close();
      }
      const forbidden = new PostgresLmsRepository(
        { host: socket, port: 55491, user: 'lms_provision_test', database: 'postgres' },
        lookupKey,
      );
      try {
        await expect(forbidden.findById(installA)).rejects.toThrow('must not');
      } finally {
        await forbidden.close();
      }
    });
    it.each([true, false])(
      'rejects assignment-provisioner membership with inheritance=%s',
      async (inherit) => {
        await withAssignmentProvisionerMembership(
          admin,
          { host: socket, port: 55491, database: 'postgres' },
          'margin_lms_runtime',
          inherit,
          async (config) => {
            const unsafe = new PostgresLmsRepository(config, lookupKey);
            try {
              await expect(unsafe.findById(installA)).rejects.toThrow('must not');
            } finally {
              await unsafe.close();
            }
          },
        );
        expect((await repository.findById(installA))?.id).toBe(installA);
      },
    );
    it.each([true, false])(
      'rejects table-owner membership with inheritance=%s',
      async (inherit) => {
        await withTableOwnerMembership(
          admin,
          { host: socket, port: 55491, database: 'postgres' },
          'margin_lms.installations',
          'margin_lms_runtime',
          inherit,
          async (config) => {
            const unsafe = new PostgresLmsRepository(config, lookupKey);
            try {
              await expect(unsafe.findById(installA)).rejects.toThrow('must not');
            } finally {
              await unsafe.close();
            }
          },
        );
        expect((await repository.findById(installA))?.id).toBe(installA);
      },
    );
    it('exposes only current minimal course context and denies unauthenticated or malformed context access', async () => {
      const { cookies } = await successfulSession();
      const response = await request('/api/lms/context', {
        headers: { cookie: cookieHeader(cookies) },
      });
      expect(response.status, response.body).toBe(200);
      expect(JSON.parse(response.body)).toEqual({
        provider: 'canvas',
        installationId: installA,
        courseId: courseA,
        role: 'student',
        capabilities: ['launch-context'],
      });
      expect((await request('/api/lms/context')).status).toBe(401);
      expect(
        (
          await request('/api/lms/context?courseId=' + courseB, {
            headers: { cookie: cookieHeader(cookies) },
          })
        ).status,
      ).toBe(400);
      expect(
        (
          await request('/api/lms/context', {
            headers: {
              cookie: cookieHeader(cookies),
              origin: institution,
              'sec-fetch-site': 'cross-site',
            },
          })
        ).status,
      ).toBe(403);
    });
    it('composes with the real API router for cross-site form_post and blocks generic LTI document access', async () => {
      const api = await createApi({
        dataDirectory: join(directory, 'composed-api'),
        identityService: identity,
        lmsService: service,
        keyEncryptionKey: Buffer.alloc(32, 41),
        tls,
        allowedOrigins: [origin],
      });
      await new Promise<void>((resolve) => api.listen(0, '127.0.0.1', resolve));
      const apiOrigin = `https://127.0.0.1:${(api.address() as import('node:net').AddressInfo).port}`;
      try {
        const flow = await begin();
        const result = await request(apiOrigin + base() + '/launch', {
          method: 'POST',
          body: new URLSearchParams({ state: flow.state, id_token: await signed(flow) }).toString(),
          headers: {
            cookie: cookieHeader(flow.cookies),
            origin: institution,
            'sec-fetch-site': 'cross-site',
            'sec-fetch-dest': 'document',
          },
        });
        expect(result.status, result.body).toBe(303);
        const cookies = cookieHeader(result.headers['set-cookie']!);
        const context = await request(apiOrigin + '/api/lms/context', {
          headers: { cookie: cookies, origin },
        });
        expect(context.status, context.body).toBe(200);
        expect(JSON.parse(context.body).courseId).toBe(courseA);
        const documents = await request(apiOrigin + '/api/documents', {
          headers: { cookie: cookies, origin },
        });
        expect(documents.status, documents.body).toBe(403);
        expect(documents.body).toContain('lms');
      } finally {
        await new Promise<void>((resolve) => api.close(() => resolve()));
      }
    });
    it('allows explicitly provisioned teacher and viewer roles without granting token-supplied promotions', async () => {
      for (const [role, protocol] of [
        ['teacher', 'Instructor'],
        ['viewer', 'Learner'],
      ]) {
        await admin.query('UPDATE margin_identity.memberships SET role=$2 WHERE user_id=$1', [
          userA,
          role,
        ]);
        await provisioner.query('UPDATE margin_lms.enrollments SET role=$2 WHERE user_id=$1', [
          userA,
          role,
        ]);
        try {
          const result = await launch(await begin(), {
            [LTI_CLAIM + 'roles']: [
              `http://purl.imsglobal.org/vocab/lis/v2/membership#${protocol}`,
            ],
          });
          expect(result.status, result.body).toBe(303);
          const session = await request('/api/auth/session', {
            headers: { cookie: cookieHeader(result.headers['set-cookie']!) },
          });
          expect(JSON.parse(session.body).role).toBe(role);
        } finally {
          await admin.query(
            "UPDATE margin_identity.memberships SET role='student' WHERE user_id=$1",
            [userA],
          );
          await provisioner.query(
            "UPDATE margin_lms.enrollments SET role='student' WHERE user_id=$1",
            [userA],
          );
        }
      }
    });
    it('runs the trusted launch hook only after verification and restricts its redirect to exact permitted paths', async () => {
      let calls = 0;
      const hooked = createLmsService({
        applicationOrigin: origin,
        repository,
        issueSession: (enrollment, req) => identity.issueLmsSession(enrollment, req),
        resolveKey: () => keys,
        launchReturnPaths: ['/', '/canvas/author'],
        onVerifiedLaunch: async ({ principal, launch }) => {
          calls++;
          expect(principal.authenticationMethod).toBe('lti');
          expect(launch.installationId).toBe(installA);
          return { redirectPath: '/canvas/author' };
        },
      });
      let flow = await begin();
      const bad = new URLSearchParams({ state: flow.state, id_token: (await signed(flow)) + 'x' });
      await expect(
        hooked.completeLaunch(installA, base() + '/launch', bad, {
          headers: { cookie: cookieHeader(flow.cookies) },
        }),
      ).rejects.toBeTruthy();
      expect(calls).toBe(0);
      flow = await begin();
      const result = await hooked.completeLaunch(
        installA,
        base() + '/launch',
        new URLSearchParams({ state: flow.state, id_token: await signed(flow) }),
        { headers: { cookie: cookieHeader(flow.cookies) } },
      );
      expect(result.location).toBe(origin + '/canvas/author');
      expect(calls).toBe(1);
      const unsafe = createLmsService({
        applicationOrigin: origin,
        repository,
        issueSession: (enrollment, req) => identity.issueLmsSession(enrollment, req),
        resolveKey: () => keys,
        onVerifiedLaunch: async () => ({ redirectPath: '//unapproved.test' }),
      });
      flow = await begin();
      await expect(
        unsafe.completeLaunch(
          installA,
          base() + '/launch',
          new URLSearchParams({ state: flow.state, id_token: await signed(flow) }),
          { headers: { cookie: cookieHeader(flow.cookies) } },
        ),
      ).rejects.toThrow('unregistered destination');
      expect(() =>
        createLmsService({
          applicationOrigin: origin,
          repository,
          issueSession: (enrollment, req) => identity.issueLmsSession(enrollment, req),
          launchReturnPaths: ['https://unapproved.test/'],
        }),
      ).toThrow('same-origin');
    });
    it('refuses plaintext HTTP even on a loopback socket', async () => {
      const plain = createHttpServer(async (req, res) => {
        await handler(req, res);
      });
      await new Promise<void>((resolve) => plain.listen(0, '127.0.0.1', resolve));
      try {
        const port = (plain.address() as import('node:net').AddressInfo).port;
        const status = await new Promise<number>((resolve, reject) => {
          const req = httpRequest({ host: '127.0.0.1', port, path: base() + '/login' }, (res) => {
            res.resume();
            res.on('end', () => resolve(res.statusCode!));
          });
          req.on('error', reject);
          req.end();
        });
        expect(status).toBe(400);
      } finally {
        await new Promise<void>((resolve) => plain.close(() => resolve()));
      }
    });
  },
);
