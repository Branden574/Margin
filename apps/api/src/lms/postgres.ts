import { createHmac } from 'node:crypto';
import { Pool, type PoolClient, type PoolConfig } from 'pg';
import type {
  InstallationRepository,
  LaunchAttempt,
  LaunchReplayRepository,
  LMSLaunchContext,
} from '@margin/lms';
import type {
  CanvasHttpInstallation,
  LmsEnrollmentRepository,
  LmsSessionBindingRepository,
  LmsSessionPrincipal,
  VerifiedLmsEnrollment,
} from './types.js';

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const context = (client: PoolClient, name: string, value: string) =>
  client.query('SELECT set_config($1,$2,true)', [`margin_lms.${name}`, value]);
export function lmsLookupDigest(
  key: Uint8Array,
  kind: 'subject' | 'course',
  installationId: string,
  value: string,
): string {
  if (key.byteLength !== 32 || !uuid.test(installationId) || !value || value.length > 2048)
    throw new Error('Invalid LMS lookup configuration.');
  return createHmac('sha256', key)
    .update(JSON.stringify(['margin-lms-v1', kind, installationId, value]))
    .digest('hex');
}
interface AttemptRow {
  state_digest: string;
  nonce_digest: string;
  browser_binding_digest: string;
  installation_id: string;
  registration_version: number;
  target_uri: string;
  message_type: LaunchAttempt['messageType'];
  created_at: Date;
  expires_at: Date;
  consumed_at: Date | null;
}
const attempt = (row: AttemptRow): LaunchAttempt => ({
  stateDigest: row.state_digest,
  nonceDigest: row.nonce_digest,
  browserBindingDigest: row.browser_binding_digest,
  installationId: row.installation_id,
  registrationVersion: row.registration_version,
  targetUri: row.target_uri,
  messageType: row.message_type,
  createdAt: row.created_at.getTime(),
  expiresAt: row.expires_at.getTime(),
});
const sameAttempt = (a: LaunchAttempt, b: LaunchAttempt) =>
  Object.keys(a).every((k) => a[k as keyof LaunchAttempt] === b[k as keyof LaunchAttempt]);
interface BindingRow {
  session_id: string;
  installation_id: string;
  registration_version: number;
  organization_id: string;
  user_id: string;
  course_id: string;
  subject_digest: string;
  course_digest: string;
  role: VerifiedLmsEnrollment['role'];
}
function binding(row: BindingRow): VerifiedLmsEnrollment {
  return {
    installationId: row.installation_id,
    registrationVersion: row.registration_version,
    organizationId: row.organization_id,
    userId: row.user_id,
    courseId: row.course_id,
    subjectDigest: row.subject_digest,
    courseDigest: row.course_digest,
    role: row.role,
  };
}

/** Durable repository; runtime credentials cannot create installations, user links, courses or grants. */
export class PostgresLmsRepository
  implements
    InstallationRepository,
    LaunchReplayRepository,
    LmsEnrollmentRepository,
    LmsSessionBindingRepository
{
  private readonly pool: Pool;
  private readonly lookupKey: Buffer;
  constructor(options: PoolConfig, lookupKey: Uint8Array) {
    if (lookupKey.byteLength !== 32)
      throw new Error('LMS lookup HMAC key must contain 32 random bytes.');
    this.lookupKey = Buffer.from(lookupKey);
    const testSocket =
      process.env.NODE_ENV === 'test' && options.host?.startsWith('/') && !options.connectionString;
    if (
      process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0' ||
      (!testSocket &&
        (!options.ssl ||
          (typeof options.ssl === 'object' && options.ssl.rejectUnauthorized === false)))
    )
      throw new Error('LMS PostgreSQL requires certificate-verified TLS.');
    if (
      options.connectionString &&
      [...new URL(options.connectionString).searchParams.keys()].some((k) => k.startsWith('ssl'))
    )
      throw new Error(
        'Configure verified LMS PostgreSQL TLS separately, not through URL overrides.',
      );
    this.pool = new Pool({
      ...options,
      max: 8,
      connectionTimeoutMillis: 5000,
      idleTimeoutMillis: 30000,
      query_timeout: 6000,
      statement_timeout: 5000,
      idle_in_transaction_session_timeout: 5000,
    });
  }
  async close() {
    await this.pool.end();
    this.lookupKey.fill(0);
  }
  private async transaction<T>(run: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    let discard = false;
    try {
      await client.query('BEGIN');
      await client.query("SET LOCAL statement_timeout='5s'");
      await client.query("SET LOCAL synchronous_commit='on'");
      await client.query("SET LOCAL lock_timeout='1s'");
      await client.query("SET LOCAL idle_in_transaction_session_timeout='5s'");
      const result = await client.query<{ unsafe: boolean }>(
        "SELECT (current_setting('fsync')<>'on' OR current_setting('full_page_writes')<>'on' OR r.rolsuper OR r.rolbypassrls OR r.rolcreaterole OR r.rolcreatedb OR NOT pg_has_role(current_user,'margin_lms_runtime','MEMBER') OR pg_has_role(current_user,'margin_identity_runtime','MEMBER') OR pg_has_role(current_user,'margin_lms_provisioner','MEMBER') OR pg_has_role(current_user,'margin_identity_provisioner','MEMBER') OR EXISTS(SELECT 1 FROM pg_roles p WHERE p.rolname IN ('margin_assignment_provisioner','margin_assignment_work_runtime') AND pg_has_role(current_user,p.oid,'MEMBER')) OR EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname IN ('margin_lms','margin_identity','margin_work') AND pg_has_role(current_user,c.relowner,'MEMBER'))) AS unsafe FROM pg_roles r WHERE r.rolname=current_user",
      );
      if (!result.rows[0] || result.rows[0].unsafe)
        throw new Error(
          'LMS runtime must not be a superuser, BYPASSRLS, provisioning/identity/work role or table owner; durable PostgreSQL settings are required.',
        );
      const value = await run(client);
      await client.query('COMMIT');
      return value;
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch {
        discard = true;
      }
      throw error;
    } finally {
      client.release(discard);
    }
  }
  private async installation(
    client: PoolClient,
    id: string,
  ): Promise<CanvasHttpInstallation | null> {
    if (!uuid.test(id)) return null;
    await context(client, 'installation_id', id);
    const result = await client.query('SELECT * FROM margin_lms.installations WHERE id=$1', [id]);
    const row = result.rows[0];
    if (!row) return null;
    return {
      ...row.configuration,
      id: row.id,
      organizationId: row.organization_id,
      issuer: row.issuer,
      clientId: row.client_id,
      deploymentId: row.deployment_id,
      version: row.version,
      enabled: row.enabled,
    };
  }
  findById(id: string) {
    return this.transaction((client) => this.installation(client, id));
  }
  async create(value: LaunchAttempt): Promise<boolean> {
    return this.transaction(async (client) => {
      await context(client, 'installation_id', value.installationId);
      await context(client, 'state_digest', value.stateDigest);
      const result = await client.query(
        'INSERT INTO margin_lms.launch_attempts(state_digest,nonce_digest,browser_binding_digest,installation_id,registration_version,target_uri,message_type,created_at,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT DO NOTHING RETURNING state_digest',
        [
          value.stateDigest,
          value.nonceDigest,
          value.browserBindingDigest,
          value.installationId,
          value.registrationVersion,
          value.targetUri,
          value.messageType,
          new Date(value.createdAt),
          new Date(value.expiresAt),
        ],
      );
      return result.rowCount === 1;
    });
  }
  async find(stateDigest: string): Promise<LaunchAttempt | null> {
    return this.transaction(async (client) => {
      await context(client, 'state_digest', stateDigest);
      const result = await client.query<AttemptRow>(
        'SELECT * FROM margin_lms.launch_attempts WHERE state_digest=$1 AND consumed_at IS NULL',
        [stateDigest],
      );
      return result.rows[0] ? attempt(result.rows[0]) : null;
    });
  }
  async consume(value: LaunchAttempt, now: number, retainNonceUntil: number): Promise<boolean> {
    if (
      !Number.isSafeInteger(retainNonceUntil) ||
      retainNonceUntil <= now ||
      retainNonceUntil > now + 660000
    )
      return false;
    return this.transaction(async (client) => {
      await context(client, 'state_digest', value.stateDigest);
      await context(client, 'installation_id', value.installationId);
      await context(client, 'nonce_digest', value.nonceDigest);
      const result = await client.query<AttemptRow>(
        'SELECT * FROM margin_lms.launch_attempts WHERE state_digest=$1 FOR UPDATE',
        [value.stateDigest],
      );
      const row = result.rows[0];
      if (
        !row ||
        row.consumed_at ||
        !sameAttempt(attempt(row), value) ||
        row.expires_at.getTime() <= now
      )
        return false;
      const inserted = await client.query(
        'INSERT INTO margin_lms.nonce_receipts(installation_id,nonce_digest,expires_at) VALUES($1,$2,$3) ON CONFLICT DO NOTHING RETURNING nonce_digest',
        [value.installationId, value.nonceDigest, new Date(retainNonceUntil)],
      );
      if (inserted.rowCount !== 1) return false;
      await client.query(
        'UPDATE margin_lms.launch_attempts SET consumed_at=$2 WHERE state_digest=$1',
        [value.stateDigest, new Date(now)],
      );
      return true;
    });
  }
  private async mapped(
    client: PoolClient,
    input: {
      installationId: string;
      registrationVersion: number;
      organizationId: string;
      subjectDigest: string;
      courseDigest: string;
    },
  ): Promise<VerifiedLmsEnrollment | null> {
    const registration = await this.installation(client, input.installationId);
    if (
      !registration?.enabled ||
      registration.version !== input.registrationVersion ||
      registration.organizationId !== input.organizationId
    )
      return null;
    await context(client, 'subject_digest', input.subjectDigest);
    await context(client, 'course_digest', input.courseDigest);
    await context(client, 'organization_id', input.organizationId);
    const links = await client.query<{ user_id: string }>(
      'SELECT user_id FROM margin_lms.user_links WHERE installation_id=$1 AND organization_id=$2 AND subject_digest=$3 AND disabled_at IS NULL',
      [input.installationId, input.organizationId, input.subjectDigest],
    );
    const courses = await client.query<{ course_id: string }>(
      'SELECT course_id FROM margin_lms.courses WHERE installation_id=$1 AND organization_id=$2 AND external_digest=$3 AND disabled_at IS NULL',
      [input.installationId, input.organizationId, input.courseDigest],
    );
    const userId = links.rows[0]?.user_id,
      courseId = courses.rows[0]?.course_id;
    if (!userId || !courseId) return null;
    await context(client, 'user_id', userId);
    await context(client, 'course_id', courseId);
    const roles = await client.query<{ role: VerifiedLmsEnrollment['role'] }>(
      'SELECT e.role FROM margin_lms.enrollments e JOIN margin_identity.memberships m ON m.organization_id=e.organization_id AND m.user_id=e.user_id JOIN margin_identity.users u ON u.id=e.user_id JOIN margin_identity.organizations o ON o.id=e.organization_id WHERE e.installation_id=$1 AND e.organization_id=$2 AND e.course_id=$3 AND e.user_id=$4 AND e.disabled_at IS NULL AND m.revoked_at IS NULL AND m.role=e.role AND u.disabled_at IS NULL AND o.disabled_at IS NULL',
      [input.installationId, input.organizationId, courseId, userId],
    );
    const role = roles.rows[0]?.role;
    if (!role) return null;
    return { ...input, userId, courseId, role };
  }
  async resolveEnrollment(launch: LMSLaunchContext): Promise<VerifiedLmsEnrollment | null> {
    if (!launch.course || launch.user.roleHints.includes('administrator')) return null;
    const subjectDigest = lmsLookupDigest(
      this.lookupKey,
      'subject',
      launch.installationId,
      launch.user.reference.externalId,
    );
    const courseDigest = lmsLookupDigest(
      this.lookupKey,
      'course',
      launch.installationId,
      launch.course.reference.externalId,
    );
    return this.transaction(async (client) => {
      const registration = await this.installation(client, launch.installationId);
      if (
        !registration ||
        registration.issuer !== launch.issuer ||
        registration.clientId !== launch.clientId ||
        registration.deploymentId !== launch.deploymentId
      )
        return null;
      const value = await this.mapped(client, {
        installationId: launch.installationId,
        registrationVersion: launch.registrationVersion,
        organizationId: launch.organizationId,
        subjectDigest,
        courseDigest,
      });
      if (!value) return null;
      const required = value.role === 'teacher' ? 'instructor' : 'learner';
      if (!launch.user.roleHints.includes(required)) return null;
      return Object.freeze(value);
    });
  }
  async recordSessionBinding(
    enrollment: VerifiedLmsEnrollment,
    principal: LmsSessionPrincipal,
  ): Promise<void> {
    if (
      principal.authenticationMethod !== 'lti' ||
      principal.userId !== enrollment.userId ||
      principal.organizationId !== enrollment.organizationId ||
      principal.role !== enrollment.role
    )
      throw new Error('LMS session identity does not match enrollment.');
    await this.transaction(async (client) => {
      const current = await this.mapped(client, enrollment);
      if (
        !current ||
        Object.keys(current).some(
          (k) =>
            current[k as keyof VerifiedLmsEnrollment] !==
            enrollment[k as keyof VerifiedLmsEnrollment],
        )
      )
        throw new Error('LMS enrollment changed during launch.');
      await context(client, 'session_id', principal.sessionId);
      const session = await client.query(
        "SELECT id FROM margin_identity.sessions WHERE id=$1 AND user_id=$2 AND organization_id=$3 AND authentication_method='lti' AND revoked_at IS NULL AND expires_at>now() AND idle_expires_at>now()",
        [principal.sessionId, principal.userId, principal.organizationId],
      );
      if (session.rowCount !== 1) throw new Error('LMS session is unavailable.');
      await client.query(
        'INSERT INTO margin_lms.session_bindings(session_id,installation_id,registration_version,organization_id,user_id,course_id,subject_digest,course_digest,role) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',
        [
          principal.sessionId,
          enrollment.installationId,
          enrollment.registrationVersion,
          enrollment.organizationId,
          enrollment.userId,
          enrollment.courseId,
          enrollment.subjectDigest,
          enrollment.courseDigest,
          enrollment.role,
        ],
      );
    });
  }
  async getSessionEnrollment(principal: {
    sessionId: string;
    userId: string;
    organizationId: string;
    role: string;
    authenticationMethod?: string;
  }): Promise<VerifiedLmsEnrollment | null> {
    if (principal.authenticationMethod !== 'lti' || !uuid.test(principal.sessionId)) return null;
    return this.transaction(async (client) => {
      await context(client, 'session_id', principal.sessionId);
      const result = await client.query<BindingRow>(
        'SELECT * FROM margin_lms.session_bindings WHERE session_id=$1',
        [principal.sessionId],
      );
      const row = result.rows[0];
      if (
        !row ||
        row.user_id !== principal.userId ||
        row.organization_id !== principal.organizationId ||
        row.role !== principal.role
      )
        return null;
      const saved = binding(row),
        current = await this.mapped(client, saved);
      if (
        !current ||
        Object.keys(current).some(
          (k) =>
            current[k as keyof VerifiedLmsEnrollment] !== saved[k as keyof VerifiedLmsEnrollment],
        )
      )
        return null;
      const session = await client.query(
        "SELECT id FROM margin_identity.sessions WHERE id=$1 AND user_id=$2 AND organization_id=$3 AND authentication_method='lti' AND revoked_at IS NULL AND expires_at>now() AND idle_expires_at>now()",
        [principal.sessionId, principal.userId, principal.organizationId],
      );
      return session.rowCount === 1 ? Object.freeze(current) : null;
    });
  }
  async authorizeSession(principal: LmsSessionPrincipal): Promise<boolean> {
    return (await this.getSessionEnrollment(principal)) !== null;
  }
}
