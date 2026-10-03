import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTableOwnerMembership } from './helpers/owner-role';
import { stopDisposablePostgres } from './helpers/postgres';
import { execFileSync } from 'node:child_process';
import { generateKeyPairSync, randomBytes, randomUUID, createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Pool } from 'pg';
import { createLocalJWKSet, jwtVerify } from 'jose';
import { hostedCanvasEndpoints, type LMSLaunchContext, LTI_CLAIM } from '../packages/lms/src/index';
import {
  PostgresLmsRepository,
  lmsLookupDigest,
  type VerifiedLmsEnrollment,
} from '../apps/api/src/lms/index';
import { LocalKeyProvider } from '../apps/api/src/encryption';
import {
  AssignmentService,
  AssignmentDeepLinkSigner,
  PostgresAssignmentRepository,
  parseAssignmentInput,
  type AssignmentInput,
  type ReadyAssignmentSource,
  type AssignmentSourceGateway,
} from '../apps/api/src/assignments/index';
import type { SessionPrincipal } from '../apps/api/src/identity/types';
const available = ['initdb', 'pg_ctl', 'psql'].every((tool) => {
  try {
    execFileSync(tool, ['--version'], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
});
if (process.env.MARGIN_REQUIRE_POSTGRES_TESTS === '1' && !available)
  throw new Error('Required assignment PostgreSQL binaries are unavailable.');
const org = randomUUID(),
  install = randomUUID(),
  course = randomUUID(),
  otherCourse = randomUUID(),
  teacher = randomUUID(),
  student = randomUUID(),
  peer = randomUUID(),
  master = randomUUID(),
  version = randomUUID();
const lookup = Buffer.alloc(32, 67),
  platform = hostedCanvasEndpoints('test'),
  application = 'https://workspace.assignment.test',
  institution = 'https://school.test.instructure.com';
const resourceUrl = `${application}/api/lms/canvas/${install}/launch`;
let directory: string,
  socket: string,
  started = false,
  admin: Pool,
  runtime: Pool,
  lms: PostgresLmsRepository,
  repository: PostgresAssignmentRepository,
  signer: AssignmentDeepLinkSigner,
  service: AssignmentService;
let teacherSession: SessionPrincipal,
  studentSession: SessionPrincipal,
  peerSession: SessionPrincipal,
  ready = true,
  source: ReadyAssignmentSource,
  sources: AssignmentSourceGateway;
const kms = new LocalKeyProvider(randomBytes(32), 'synthetic-assignment-fixture');
const hash = (v: string) => createHash('sha256').update(v).digest('hex');
const input = (patch: Partial<AssignmentInput> = {}): AssignmentInput => ({
  requestId: randomUUID(),
  documentId: master,
  versionId: version,
  title: 'Synthetic biology homework',
  instructions: 'Private teacher instructions',
  policy: {
    allowedTools: ['text', 'pen', 'comment'],
    allowExport: false,
    allowCopyPaste: false,
    allowReadAloud: true,
    assessment: true,
  },
  ...patch,
});
async function session(
  userId: string,
  role: 'teacher' | 'student' | 'viewer',
): Promise<SessionPrincipal> {
  const now = Date.now();
  const p: SessionPrincipal = {
    sessionId: randomUUID(),
    userId,
    organizationId: org,
    role,
    authenticationMethod: 'lti',
    mfa: false,
    createdAt: now,
    expiresAt: now + 3600000,
    lastSeenAt: now,
  };
  await admin.query(
    "INSERT INTO margin_identity.sessions(id,session_hash,user_id,organization_id,mfa,authentication_method,created_at,expires_at,idle_expires_at,last_seen_at) VALUES($1,$2,$3,$4,false,'lti',$5,$6,$6,$5)",
    [p.sessionId, hash(randomUUID()), userId, org, new Date(now), new Date(p.expiresAt)],
  );
  await admin.query(
    'INSERT INTO margin_lms.session_bindings(session_id,installation_id,registration_version,organization_id,user_id,course_id,subject_digest,course_digest,role) VALUES($1,$2,1,$3,$4,$5,$6,$7,$8)',
    [
      p.sessionId,
      install,
      org,
      userId,
      course,
      lmsLookupDigest(lookup, 'subject', install, userId),
      lmsLookupDigest(lookup, 'course', install, 'course-1'),
      role,
    ],
  );
  return p;
}
function launch(
  principal: SessionPrincipal,
  deep: boolean,
  assignment?: string,
  resource = 'resource-1',
): LMSLaunchContext {
  return {
    provider: 'canvas',
    installationId: install,
    organizationId: org,
    registrationVersion: 1,
    ...{ issuer: platform.issuer },
    clientId: 'assignment-client',
    deploymentId: 'assignment-deployment',
    messageType: deep ? 'LtiDeepLinkingRequest' : 'LtiResourceLinkRequest',
    targetUri: deep ? resourceUrl.replace('/launch', '/deep-link') : resourceUrl,
    user: {
      reference: { installationId: install, externalId: principal.userId },
      roleHints: [principal.role === 'teacher' ? 'instructor' : 'learner'],
    },
    protocolRoles: [
      `http://purl.imsglobal.org/vocab/lis/v2/membership#${principal.role === 'teacher' ? 'Instructor' : 'Learner'}`,
    ],
    course: { reference: { installationId: install, externalId: 'course-1' } },
    issuedAt: Math.floor(Date.now() / 1000),
    expiresAt: Math.floor(Date.now() / 1000) + 240,
    services: {},
    ...(deep
      ? {
          deepLinking: {
            returnUrl: institution + '/deep-link/return',
            acceptTypes: ['ltiResourceLink'],
            presentationTargets: ['window'],
            data: '',
          },
        }
      : {
          resource: {
            reference: { installationId: install, externalId: resource },
            assignmentId: assignment,
          },
        }),
  };
}
async function select(assignment: string | null, actor = teacherSession) {
  await service.captureVerifiedLaunch({ principal: actor, launch: launch(actor, true) });
  const selection = await service.currentSelection(actor);
  expect(selection).not.toBeNull();
  return service.completeDeepLink(actor, selection!.id, assignment);
}
function tokenFrom(html: string) {
  const value = html.match(/name="JWT" value="([^"]+)"/)?.[1];
  expect(value).toBeTruthy();
  return value!;
}

describe.skipIf(!available)(
  'Assignment persistence and signed Deep Linking with a synthetic inspected-source gateway',
  () => {
    beforeAll(async () => {
      directory = mkdtempSync(join(tmpdir(), 'margin-assignment-pg-'));
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
          join(directory, 'pg.log'),
          '-o',
          `-k ${socket} -h '' -p 55492`,
          '-w',
          'start',
        ],
        { stdio: 'pipe' },
      );
      started = true;
      admin = new Pool({ host: socket, port: 55492, user: 'postgres', database: 'postgres' });
      for (const name of [
        '001-identity.sql',
        '002-document-sync.sql',
        '003-lms-installations.sql',
        '004-assignments.sql',
      ])
        await admin.query(
          readFileSync(new URL('../infra/migrations/' + name, import.meta.url), 'utf8'),
        );
      await admin.query(
        'CREATE ROLE assignments_test LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS; GRANT margin_assignments_runtime TO assignments_test; CREATE ROLE assignments_lms_test LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS; GRANT margin_lms_runtime TO assignments_lms_test',
      );
      const config = { host: socket, port: 55492, user: 'assignments_test', database: 'postgres' };
      runtime = new Pool(config);
      repository = new PostgresAssignmentRepository(config, kms);
      lms = new PostgresLmsRepository({ ...config, user: 'assignments_lms_test' }, lookup);
      await admin.query('INSERT INTO margin_identity.organizations(id) VALUES($1)', [org]);
      for (const [user, role] of [
        [teacher, 'teacher'],
        [student, 'student'],
        [peer, 'student'],
      ]) {
        await admin.query('INSERT INTO margin_identity.users(id,identity_key) VALUES($1,$2)', [
          user,
          hash(user),
        ]);
        await admin.query(
          'INSERT INTO margin_identity.memberships(organization_id,user_id,role) VALUES($1,$2,$3)',
          [org, user, role],
        );
      }
      await admin.query(
        'INSERT INTO margin_lms.installations(id,organization_id,issuer,client_id,deployment_id,version,enabled,configuration) VALUES($1,$2,$3,$4,$5,1,true,$6)',
        [
          install,
          org,
          platform.issuer,
          'assignment-client',
          'assignment-deployment',
          {
            authorizationEndpoint: platform.authorizationEndpoint,
            jwksUri: platform.jwksUri,
            targets: [
              { uri: resourceUrl, messageType: 'LtiResourceLinkRequest' },
              {
                uri: resourceUrl.replace('/launch', '/deep-link'),
                messageType: 'LtiDeepLinkingRequest',
              },
            ],
            serviceOrigins: [institution],
            frameOrigins: [institution],
            allowedServiceScopes: [],
          },
        ],
      );
      for (const [id, external] of [
        [course, 'course-1'],
        [otherCourse, 'course-2'],
      ])
        await admin.query(
          'INSERT INTO margin_lms.courses(installation_id,organization_id,external_digest,course_id) VALUES($1,$2,$3,$4)',
          [install, org, lmsLookupDigest(lookup, 'course', install, external), id],
        );
      for (const [user, role] of [
        [teacher, 'teacher'],
        [student, 'student'],
        [peer, 'student'],
      ]) {
        await admin.query(
          'INSERT INTO margin_lms.user_links(installation_id,organization_id,subject_digest,user_id) VALUES($1,$2,$3,$4)',
          [install, org, lmsLookupDigest(lookup, 'subject', install, user), user],
        );
        await admin.query(
          'INSERT INTO margin_lms.enrollments(installation_id,organization_id,course_id,user_id,role) VALUES($1,$2,$3,$4,$5)',
          [install, org, course, user, role],
        );
      }
      teacherSession = await session(teacher, 'teacher');
      studentSession = await session(student, 'student');
      peerSession = await session(peer, 'student');
      await admin.query('BEGIN');
      await admin.query(
        "INSERT INTO margin_sync.documents(organization_id,id,owner_id,current_version_id,audience) VALUES($1,$2,$3,$4,'teachers')",
        [org, master, teacher, version],
      );
      await admin.query(
        'INSERT INTO margin_sync.versions(organization_id,document_id,id) VALUES($1,$2,$3)',
        [org, master, version],
      );
      await admin.query('COMMIT');
      source = {
        organizationId: org,
        documentId: master,
        versionId: version,
        ownerId: teacher,
        artifactId: randomUUID(),
        artifactVersion: 'synthetic-object-version',
        sha256: hash('fixture source'),
        scanReceiptId: randomUUID(),
        inspectionStatus: 'ready',
        encrypted: true,
        pageCount: 1,
      };
      sources = {
        resolveForTeacher: async (p, ref) =>
          p.userId === teacher && ref.documentId === master && ref.versionId === version
            ? structuredClone(source)
            : null,
        stillAvailable: async () => ready,
        prepareAvailability: async (snapshot) => {
          if (!ready) return null;
          const fingerprint = JSON.stringify(snapshot);
          let used = false;
          return async (current) => {
            if (used) return false;
            used = true;
            return ready && JSON.stringify(current) === fingerprint;
          };
        },
      };
      const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
      signer = new AssignmentDeepLinkSigner(
        'fixture-signing-key',
        pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
      );
      service = new AssignmentService({
        repository,
        authorizer: lms,
        installations: lms,
        sources,
        signer,
        resourceHmacKey: Buffer.alloc(32, 71),
      });
    }, 30000);
    afterAll(async () => {
      const errors: unknown[] = [];
      try {
        service?.close();
      } catch (error) {
        errors.push(error);
      }
      const closed = await Promise.allSettled([
        repository?.close(),
        lms?.close(),
        runtime?.end(),
        admin?.end(),
      ]);
      for (const result of closed) if (result.status === 'rejected') errors.push(result.reason);
      let stopped = !started;
      try {
        if (started) await stopDisposablePostgres(join(directory, 'data'));
        stopped = true;
      } catch (error) {
        errors.push(error);
      }
      // Keep diagnostics/data if shutdown could not be confirmed; never delete a running fixture.
      if (stopped && directory) {
        try {
          rmSync(directory, { recursive: true, force: true });
        } catch (error) {
          errors.push(error);
        }
      }
      if (errors.length) throw new AggregateError(errors, 'PostgreSQL fixture cleanup failed.');
    }, 15000);
    it('creates encrypted immutable assignment metadata and deduplicates concurrent identical authoring requests', async () => {
      const request = input();
      const records = await Promise.all([
        service.create(teacherSession, request),
        service.create(teacherSession, request),
      ]);
      expect(records[0].id).toBe(records[1].id);
      expect(records[0]).toMatchObject({ title: request.title, source, policy: request.policy });
      const row = (
        await admin.query('SELECT * FROM margin_assignments.assignments WHERE id=$1', [
          records[0].id,
        ])
      ).rows[0];
      expect(row.ciphertext.toString('utf8')).not.toContain(request.title);
      expect(JSON.stringify(row)).not.toContain(request.instructions);
      expect(row.source_version_id).toBe(version);
      expect(row.request_digest).toBeUndefined();
      expect(records[0]).not.toHaveProperty('requestFingerprint');
      expect(row.selected_at).toBeNull();
      await expect(
        service.create(teacherSession, { ...request, title: 'changed' }),
      ).rejects.toMatchObject({ code: 'idempotency_conflict' });
    });
    it('denies students, forged principals, unconfigured inspection and source ownership/quarantine mismatches', async () => {
      await expect(service.create(studentSession, input())).rejects.toMatchObject({ status: 403 });
      await expect(
        service.create({ ...studentSession, role: 'teacher' }, input()),
      ).rejects.toMatchObject({ status: 403 });
      const disabled = new AssignmentService({
        repository,
        authorizer: lms,
        installations: lms,
        resourceHmacKey: Buffer.alloc(32, 72),
      });
      try {
        await expect(disabled.create(teacherSession, input())).rejects.toMatchObject({
          code: 'inspection_unconfigured',
        });
      } finally {
        disabled.close();
      }
      for (const patch of [
        { ownerId: student },
        { inspectionStatus: 'quarantined' },
        { encrypted: false },
        { versionId: randomUUID() },
      ]) {
        const original = structuredClone(source);
        Object.assign(source, patch);
        try {
          await expect(service.create(teacherSession, input())).rejects.toMatchObject({
            code: 'source_not_ready',
          });
        } finally {
          source = original;
        }
      }
    });
    it('validates strict assignment policy and rejects unsupported claims or tools', () => {
      for (const patch of [
        { role: 'teacher' },
        { policy: { ...input().policy, allowedTools: ['text', 'text'] } },
        { policy: { ...input().policy, allowedTools: ['ai'] } },
        { policy: { ...input().policy, allowExport: 'true' } },
        { title: '' },
      ])
        expect(() => parseAssignmentInput({ ...input(), ...patch })).toThrow();
    });
    it('signs the correct tool-originating response with exact empty opaque data, safe form post and no fabricated grade claim', async () => {
      const assignment = await service.create(teacherSession, input());
      const result = await select(assignment.id);
      const token = tokenFrom(result.html);
      const { payload, protectedHeader } = await jwtVerify(
        token,
        createLocalJWKSet(signer.jwks()),
        { issuer: 'assignment-client', audience: platform.issuer, algorithms: ['RS256'] },
      );
      expect(protectedHeader.kid).toBe('fixture-signing-key');
      expect(payload[LTI_CLAIM + 'message_type']).toBe('LtiDeepLinkingResponse');
      expect(payload['https://purl.imsglobal.org/spec/lti-dl/claim/data']).toBe('');
      expect(payload.sub).toBeUndefined();
      const items = payload['https://purl.imsglobal.org/spec/lti-dl/claim/content_items'] as Record<
        string,
        unknown
      >[];
      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({
        type: 'ltiResourceLink',
        url: resourceUrl,
        custom: { margin_assignment_id: assignment.id },
        'https://canvas.instructure.com/lti/preserveExistingAssignmentName': true,
      });
      expect(items[0].lineItem).toBeUndefined();
      expect(result.headers['Content-Security-Policy']).toContain(`form-action ${institution}`);
      expect(result.html).toContain('method="post"');
      expect(result.headers['Cache-Control']).toBe('no-store');
      expect(signer.jwks().keys[0].d).toBeUndefined();
    });
    it('supports cancellation with an empty item list and prevents repeated selection consumption', async () => {
      await service.captureVerifiedLaunch({
        principal: teacherSession,
        launch: launch(teacherSession, true),
      });
      const current = await service.currentSelection(teacherSession);
      const response = await service.completeDeepLink(teacherSession, current!.id, null);
      const verified = await jwtVerify(tokenFrom(response.html), createLocalJWKSet(signer.jwks()));
      expect(
        verified.payload['https://purl.imsglobal.org/spec/lti-dl/claim/content_items'],
      ).toEqual([]);
      await expect(
        service.completeDeepLink(teacherSession, current!.id, null),
      ).rejects.toMatchObject({ code: 'selection_expired' });
    });
    it('rejects unapproved return URLs, non-teacher selection, foreign launch identities and expired selections', async () => {
      const bad = launch(teacherSession, true);
      bad.deepLinking!.returnUrl = 'https://unapproved.test/return';
      await expect(
        service.captureVerifiedLaunch({ principal: teacherSession, launch: bad }),
      ).rejects.toMatchObject({ code: 'return_url_rejected' });
      await expect(
        service.captureVerifiedLaunch({
          principal: studentSession,
          launch: launch(studentSession, true),
        }),
      ).rejects.toMatchObject({ code: 'deep_link_not_allowed' });
      await expect(
        service.captureVerifiedLaunch({
          principal: teacherSession,
          launch: launch(studentSession, true),
        }),
      ).rejects.toMatchObject({ code: 'launch_scope' });
      await service.captureVerifiedLaunch({
        principal: teacherSession,
        launch: launch(teacherSession, true),
      });
      const current = await service.currentSelection(teacherSession);
      await admin.query(
        "UPDATE margin_assignments.deep_link_selections SET created_at=now()-interval '20 minutes',expires_at=now()-interval '10 minutes' WHERE id=$1",
        [current!.id],
      );
      await expect(
        service.completeDeepLink(teacherSession, current!.id, null),
      ).rejects.toMatchObject({ code: 'selection_expired' });
    });
    it('binds only a signed assignment resource and reserves one private pending copy-on-write workspace per student', async () => {
      const assignment = await service.create(teacherSession, input());
      await select(assignment.id);
      await service.captureVerifiedLaunch({
        principal: studentSession,
        launch: launch(studentSession, false, assignment.id, 'student-work-resource'),
      });
      expect((await service.currentAssignment(studentSession))?.id).toBe(assignment.id);
      const work = await Promise.all([
        service.reserveStudentWork(studentSession),
        service.reserveStudentWork(studentSession),
      ]);
      expect(work[0].id).toBe(work[1].id);
      expect(work.filter((v) => v.duplicate)).toHaveLength(1);
      expect(work[0].status).toBe('pending');
      expect(work[0].documentId).not.toBe(master);
      expect(work[0].versionId).not.toBe(version);
      expect(
        (await admin.query('SELECT * FROM margin_sync.documents WHERE id=$1', [work[0].documentId]))
          .rowCount,
      ).toBe(0);
      expect(
        (
          await admin.query(
            'SELECT * FROM margin_assignments.provisioning_outbox WHERE work_id=$1',
            [work[0].id],
          )
        ).rowCount,
      ).toBe(1);
      await service.captureVerifiedLaunch({
        principal: peerSession,
        launch: launch(peerSession, false, assignment.id, 'student-work-resource'),
      });
      const other = await service.reserveStudentWork(peerSession);
      expect(other.id).not.toBe(work[0].id);
      expect(other.documentId).not.toBe(work[0].documentId);
    });
    it('does not reserve without a bound launch or remap an existing Canvas resource/session to another assignment', async () => {
      const fresh = await session(student, 'student');
      expect(await service.currentAssignment(fresh)).toBeNull();
      await expect(service.reserveStudentWork(fresh)).rejects.toMatchObject({
        code: 'assignment_launch_required',
      });
      await expect(
        service.captureVerifiedLaunch({ principal: fresh, launch: launch(fresh, false) }),
      ).rejects.toMatchObject({ code: 'assignment_launch_required' });
      const assignment = await service.create(teacherSession, input());
      await select(assignment.id);
      await expect(
        service.captureVerifiedLaunch({
          principal: fresh,
          launch: launch(fresh, false, assignment.id, 'student-work-resource'),
        }),
      ).rejects.toMatchObject({ code: 'resource_mapping_conflict' });
    });
    it('rechecks current source inspection and revocation before content selection or student provisioning', async () => {
      ready = false;
      try {
        await expect(service.create(teacherSession, input())).rejects.toMatchObject({
          code: 'source_unavailable',
        });
        await expect(service.reserveStudentWork(studentSession)).rejects.toMatchObject({
          code: 'source_unavailable',
        });
        await expect(service.currentAssignment(studentSession)).rejects.toMatchObject({
          code: 'source_unavailable',
        });
      } finally {
        ready = true;
      }
      await admin.query('UPDATE margin_lms.enrollments SET disabled_at=now() WHERE user_id=$1', [
        student,
      ]);
      try {
        await expect(service.reserveStudentWork(studentSession)).rejects.toMatchObject({
          status: 403,
        });
        await expect(service.currentAssignment(studentSession)).rejects.toMatchObject({
          status: 403,
        });
      } finally {
        await admin.query('UPDATE margin_lms.enrollments SET disabled_at=NULL WHERE user_id=$1', [
          student,
        ]);
      }
    });
    it('enforces RLS and immutable metadata at the database, including cross-course and peer denial', async () => {
      for (const table of [
        'assignments',
        'deep_link_selections',
        'resource_links',
        'launch_bindings',
        'student_work',
        'provisioning_outbox',
      ])
        expect((await runtime.query(`SELECT * FROM margin_assignments.${table}`)).rowCount).toBe(0);
      await expect(
        runtime.query('UPDATE margin_assignments.assignments SET source_version_id=$1', [
          randomUUID(),
        ]),
      ).rejects.toMatchObject({ code: '42501' });
      await expect(
        runtime.query("UPDATE margin_assignments.student_work SET status='ready'"),
      ).rejects.toMatchObject({ code: '42501' });
      const enrollment = (await lms.getSessionEnrollment(teacherSession))!;
      await expect(
        repository.get(teacherSession, { ...enrollment, courseId: otherCourse }, randomUUID()),
      ).rejects.toMatchObject({ code: 'course_access_revoked' });
      await expect(
        repository.get({ ...teacherSession, userId: student }, enrollment, randomUUID()),
      ).rejects.toMatchObject({ status: 403 });
    });
    it('denies same-course student access to drafts and selected assignments without a signed session binding', async () => {
      const record = await service.create(teacherSession, input());
      const enrollment = (await lms.getSessionEnrollment(studentSession))!;
      expect(await repository.get(studentSession, enrollment, record.id)).toBeNull();
      await select(record.id);
      expect(await repository.get(studentSession, enrollment, record.id)).toBeNull();
      const fresh = await session(student, 'student');
      ready = false;
      try {
        await expect(
          service.captureVerifiedLaunch({
            principal: fresh,
            launch: launch(fresh, false, record.id, 'unavailable-source-resource'),
          }),
        ).rejects.toMatchObject({ code: 'source_unavailable' });
        expect(
          (
            await admin.query(
              'SELECT * FROM margin_assignments.launch_bindings WHERE session_id=$1',
              [fresh.sessionId],
            )
          ).rowCount,
        ).toBe(0);
      } finally {
        ready = true;
      }
      await service.captureVerifiedLaunch({
        principal: fresh,
        launch: launch(fresh, false, record.id, 'approved-source-resource'),
      });
      expect(
        (await repository.get(fresh, (await lms.getSessionEnrollment(fresh))!, record.id))?.id,
      ).toBe(record.id);
    });
    it('denies viewer access to a teacher draft and unlaunched selection', async () => {
      await admin.query("UPDATE margin_identity.memberships SET role='viewer' WHERE user_id=$1", [
        peer,
      ]);
      await admin.query("UPDATE margin_lms.enrollments SET role='viewer' WHERE user_id=$1", [peer]);
      try {
        const viewer = await session(peer, 'viewer');
        const enrollment = (await lms.getSessionEnrollment(viewer))!;
        const record = await service.create(teacherSession, input());
        expect(await repository.get(viewer, enrollment, record.id)).toBeNull();
        await select(record.id);
        expect(await repository.get(viewer, enrollment, record.id)).toBeNull();
      } finally {
        await admin.query(
          "UPDATE margin_identity.memberships SET role='student' WHERE user_id=$1",
          [peer],
        );
        await admin.query("UPDATE margin_lms.enrollments SET role='student' WHERE user_id=$1", [
          peer,
        ]);
      }
    });
    it('does not give another course teacher access to author-only assignments', async () => {
      await admin.query("UPDATE margin_identity.memberships SET role='teacher' WHERE user_id=$1", [
        peer,
      ]);
      await admin.query("UPDATE margin_lms.enrollments SET role='teacher' WHERE user_id=$1", [
        peer,
      ]);
      try {
        const coTeacher = await session(peer, 'teacher');
        const enrollment = (await lms.getSessionEnrollment(coTeacher))!;
        const record = await service.create(teacherSession, input());
        expect(await repository.get(coTeacher, enrollment, record.id)).toBeNull();
        await select(record.id);
        expect(await repository.get(coTeacher, enrollment, record.id)).toBeNull();
      } finally {
        await admin.query(
          "UPDATE margin_identity.memberships SET role='student' WHERE user_id=$1",
          [peer],
        );
        await admin.query("UPDATE margin_lms.enrollments SET role='student' WHERE user_id=$1", [
          peer,
        ]);
      }
    });
    it('detects encrypted metadata tampering and does not expose unauthenticated plaintext', async () => {
      const assignment = await service.create(teacherSession, input());
      const enrollment = (await lms.getSessionEnrollment(teacherSession))!;
      await admin.query(
        'UPDATE margin_assignments.assignments SET ciphertext=set_byte(ciphertext,0,get_byte(ciphertext,0)#1) WHERE id=$1',
        [assignment.id],
      );
      await expect(repository.get(teacherSession, enrollment, assignment.id)).rejects.toMatchObject(
        { code: 'assignment_unavailable' },
      );
    });
    it('rejects inherited and SET-ROLE-only membership in an assignment table owner', async () => {
      for (const inherit of [true, false])
        await withTableOwnerMembership(
          admin,
          { host: socket, port: 55492, database: 'postgres' },
          'margin_assignments.assignments',
          'margin_assignments_runtime',
          inherit,
          async (unsafeConfig) => {
            const unsafe = new PostgresAssignmentRepository(unsafeConfig, kms);
            try {
              await expect(
                unsafe.get(
                  teacherSession,
                  (await lms.getSessionEnrollment(teacherSession))!,
                  randomUUID(),
                ),
              ).rejects.toThrow('least-privilege');
            } finally {
              await unsafe.close();
            }
          },
        );
    });
    it('performs slow object verification and KMS outside the resource-binding transaction', async () => {
      const record = await service.create(teacherSession, input());
      await select(record.id);
      const fresh = await session(student, 'student'),
        enrollment = (await lms.getSessionEnrollment(fresh))!;
      let unwraps = 0,
        checks = 0;
      const active = async () =>
        Number(
          (
            await admin.query(
              "SELECT count(*) FROM pg_stat_activity WHERE application_name='assignment_prepared_boundary' AND xact_start IS NOT NULL",
            )
          ).rows[0].count,
        );
      const auditedKeys = {
        wrapKey: (key: Buffer, context: string) => kms.wrapKey(key, context),
        unwrapKey: async (envelope: Parameters<typeof kms.unwrapKey>[0], context: string) => {
          expect(await active()).toBe(0);
          unwraps++;
          return kms.unwrapKey(envelope, context);
        },
      };
      const boundedRepository = new PostgresAssignmentRepository(
        {
          host: socket,
          port: 55492,
          user: 'assignments_test',
          database: 'postgres',
          application_name: 'assignment_prepared_boundary',
        },
        auditedKeys,
      );
      try {
        await boundedRepository.bindResource(
          fresh,
          enrollment,
          record.id,
          hash('slow verified source'),
          async (source) => {
            expect(await active()).toBe(0);
            expect(source).toEqual(record.source);
            const before = unwraps;
            // Longer than the repository's five-second idle transaction timeout.
            await new Promise((resolve) => setTimeout(resolve, 5200));
            return async (candidate) => {
              checks++;
              expect(await active()).toBe(1);
              expect(unwraps).toBe(before);
              return JSON.stringify(candidate) === JSON.stringify(source);
            };
          },
        );
        expect(unwraps).toBe(1);
        expect(checks).toBe(1);
        expect(
          (
            await admin.query(
              'SELECT * FROM margin_assignments.launch_bindings WHERE session_id=$1',
              [fresh.sessionId],
            )
          ).rowCount,
        ).toBe(1);
      } finally {
        await boundedRepository.close();
      }
    }, 10000);
    it('rechecks authorization and the immutable assignment after outside-transaction verification', async () => {
      const record = await service.create(teacherSession, input());
      await select(record.id);
      const fresh = await session(student, 'student'),
        enrollment = (await lms.getSessionEnrollment(fresh))!;
      let checked = false;
      try {
        await expect(
          repository.bindResource(
            fresh,
            enrollment,
            record.id,
            hash('revocation during source I/O'),
            async () => {
              await admin.query(
                'UPDATE margin_lms.enrollments SET disabled_at=now() WHERE user_id=$1 AND course_id=$2',
                [student, course],
              );
              return async () => {
                checked = true;
                return true;
              };
            },
          ),
        ).rejects.toMatchObject({ code: 'course_access_revoked' });
      } finally {
        await admin.query(
          'UPDATE margin_lms.enrollments SET disabled_at=NULL WHERE user_id=$1 AND course_id=$2',
          [student, course],
        );
      }
      expect(checked).toBe(false);
      expect(
        (
          await admin.query(
            'SELECT * FROM margin_assignments.launch_bindings WHERE session_id=$1',
            [fresh.sessionId],
          )
        ).rowCount,
      ).toBe(0);
      await expect(
        repository.bindResource(
          fresh,
          enrollment,
          record.id,
          hash('changed assignment during source I/O'),
          async () => {
            await admin.query(
              'UPDATE margin_assignments.assignments SET ciphertext=set_byte(ciphertext,0,get_byte(ciphertext,0)#1) WHERE id=$1',
              [record.id],
            );
            return async () => true;
          },
        ),
      ).rejects.toMatchObject({ code: 'assignment_changed' });
      expect(
        (
          await admin.query(
            'SELECT * FROM margin_assignments.launch_bindings WHERE session_id=$1',
            [fresh.sessionId],
          )
        ).rowCount,
      ).toBe(0);
    });
    it('rejects unsafe credentials and database transport and leaves the pool usable after an error', async () => {
      expect(() => new PostgresAssignmentRepository({ host: 'db.test', ssl: false }, kms)).toThrow(
        'TLS',
      );
      const unsafe = new PostgresAssignmentRepository(
        { host: socket, port: 55492, user: 'postgres', database: 'postgres' },
        kms,
      );
      try {
        await expect(
          unsafe.get(
            teacherSession,
            (await lms.getSessionEnrollment(teacherSession))!,
            randomUUID(),
          ),
        ).rejects.toThrow('least-privilege');
      } finally {
        await unsafe.close();
      }
      expect(await service.create(teacherSession, input())).toMatchObject({ createdBy: teacher });
    });
  },
);
