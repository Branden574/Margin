import { createHash, randomUUID } from 'node:crypto';
import { Pool, type PoolClient, type PoolConfig } from 'pg';
import type { SessionPrincipal } from '../identity/types.js';
import type { VerifiedLmsEnrollment } from '../lms/types.js';
import type { KeyManagementProvider, WrappedDataKey } from '../encryption.js';
import { decrypt, encrypt, newWrappedKey, unwrapKey, type Ciphertext } from '../sync/encryption.js';
import { canonical } from '../sync/validation.js';
import {
  AssignmentError,
  type AssignmentInput,
  type AssignmentRecord,
  type AssignmentRepository,
  type DeepLinkSelection,
  type ReadyAssignmentSource,
  type StudentWorkReservation,
} from './types.js';
import { assignmentId } from './policy.js';

interface Envelope extends Ciphertext {
  wrapped_key: WrappedDataKey;
}
interface AssignmentRow extends Envelope {
  id: string;
  organization_id: string;
  installation_id: string;
  course_id: string;
  created_by: string;
  source_document_id: string;
  source_version_id: string;
  created_at: Date;
  selected_at: Date | null;
}
interface SelectionRow extends Envelope {
  id: string;
  organization_id: string;
  installation_id: string;
  course_id: string;
  user_id: string;
  session_id: string;
  expires_at: Date;
  consumed_at: Date | null;
}
const context = (client: PoolClient, name: string, value: string) =>
  client.query('SELECT set_config($1,$2,true)', [`margin_assignments.${name}`, value]);
const keyContext = (kind: string, org: string, id: string) =>
  `margin-assignment-${kind}-key-v1:${org}:${id}`;
const aad = (
  kind: string,
  row: { id: string; organization_id: string; installation_id: string; course_id: string },
) =>
  canonical([
    'margin-assignment-envelope-v1',
    kind,
    row.id,
    row.organization_id,
    row.installation_id,
    row.course_id,
  ]);
/** Dedicated runtime credentials. Source readiness is provided by authoritative ingestion, not fabricated by this repository. */
export class PostgresAssignmentRepository implements AssignmentRepository {
  private readonly pool: Pool;
  constructor(
    options: PoolConfig,
    private readonly kms: KeyManagementProvider,
  ) {
    const socket =
      process.env.NODE_ENV === 'test' && options.host?.startsWith('/') && !options.connectionString;
    if (
      process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0' ||
      (!socket &&
        (!options.ssl ||
          (typeof options.ssl === 'object' && options.ssl.rejectUnauthorized === false)))
    )
      throw new Error('Assignments require verified PostgreSQL TLS.');
    if (
      options.connectionString &&
      [...new URL(options.connectionString).searchParams.keys()].some((k) => k.startsWith('ssl'))
    )
      throw new Error('Configure verified PostgreSQL TLS separately.');
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
  close() {
    return this.pool.end();
  }
  private async transaction<T>(
    principal: SessionPrincipal,
    enrollment: VerifiedLmsEnrollment,
    run: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    if (
      principal.authenticationMethod !== 'lti' ||
      principal.userId !== enrollment.userId ||
      principal.organizationId !== enrollment.organizationId ||
      principal.role !== enrollment.role
    )
      throw new AssignmentError(
        403,
        'course_access_denied',
        'Open the assignment from an approved Canvas course.',
      );
    const client = await this.pool.connect();
    let discard = false;
    try {
      await client.query('BEGIN');
      await client.query("SET LOCAL synchronous_commit='on'");
      await client.query("SET LOCAL statement_timeout='5s'");
      await client.query("SET LOCAL lock_timeout='2s'");
      await client.query("SET LOCAL idle_in_transaction_session_timeout='5s'");
      const privileges = await client.query<{ unsafe: boolean }>(
        "SELECT (current_setting('fsync')<>'on' OR current_setting('full_page_writes')<>'on' OR r.rolsuper OR r.rolbypassrls OR r.rolcreaterole OR r.rolcreatedb OR NOT pg_has_role(current_user,'margin_assignments_runtime','MEMBER') OR pg_has_role(current_user,'margin_identity_runtime','MEMBER') OR pg_has_role(current_user,'margin_identity_provisioner','MEMBER') OR pg_has_role(current_user,'margin_sync_provisioner','MEMBER') OR pg_has_role(current_user,'margin_lms_provisioner','MEMBER') OR EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname IN ('margin_assignments','margin_lms','margin_identity','margin_sync') AND pg_has_role(current_user,c.relowner,'USAGE'))) AS unsafe FROM pg_roles r WHERE r.rolname=current_user",
      );
      if (!privileges.rows[0] || privileges.rows[0].unsafe)
        throw new Error(
          'Assignments require dedicated least-privilege credentials and durable PostgreSQL settings.',
        );
      for (const [name, value] of [
        ['session_id', principal.sessionId],
        ['user_id', principal.userId],
        ['organization_id', principal.organizationId],
        ['installation_id', enrollment.installationId],
        ['course_id', enrollment.courseId],
      ])
        await context(client, name, assignmentId(value));
      const assertRole = async () => {
        const role = (
          await client.query<{ role: string | null }>(
            'SELECT margin_assignments.active_role() AS role',
          )
        ).rows[0]?.role;
        if (role !== enrollment.role)
          throw new AssignmentError(
            403,
            'course_access_revoked',
            'This Canvas course access changed. Launch again from Canvas.',
          );
      };
      await assertRole();
      const result = await run(client);
      await assertRole();
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch {
        discard = true;
      }
      const code = (error as { code?: string }).code;
      if (code === '23505')
        throw new AssignmentError(
          409,
          'assignment_conflict',
          'This request or launch is already associated with another resource.',
        );
      if (['55P03', '57014'].includes(code ?? ''))
        throw new AssignmentError(
          503,
          'assignments_busy',
          'Assignment storage is busy. Retry with the same request identifier.',
        );
      throw error;
    } finally {
      client.release(discard);
    }
  }
  private async seal(
    kind: string,
    row: { id: string; organization_id: string; installation_id: string; course_id: string },
    value: unknown,
  ): Promise<Envelope> {
    const plaintext = Buffer.from(canonical(value));
    if (plaintext.length > 32768) {
      plaintext.fill(0);
      throw new AssignmentError(413, 'assignment_too_large', 'Assignment metadata is too large.');
    }
    const keyBinding = keyContext(kind, row.organization_id, row.id);
    let key: Buffer | undefined;
    try {
      const wrapped_key = await newWrappedKey(this.kms, keyBinding);
      key = await unwrapKey(this.kms, wrapped_key, keyBinding);
      return { ...encrypt(key, plaintext, aad(kind, row)), wrapped_key };
    } finally {
      plaintext.fill(0);
      key?.fill(0);
    }
  }
  private async open<T>(
    kind: string,
    row: Envelope & {
      id: string;
      organization_id: string;
      installation_id: string;
      course_id: string;
    },
  ): Promise<T> {
    let key: Buffer | undefined, plaintext: Buffer | undefined;
    try {
      key = await unwrapKey(
        this.kms,
        row.wrapped_key,
        keyContext(kind, row.organization_id, row.id),
      );
      plaintext = decrypt(key, row, aad(kind, row));
      return JSON.parse(plaintext.toString('utf8')) as T;
    } catch {
      throw new AssignmentError(
        503,
        'assignment_unavailable',
        'Encrypted assignment metadata could not be authenticated.',
      );
    } finally {
      key?.fill(0);
      plaintext?.fill(0);
    }
  }
  private async record(row: AssignmentRow): Promise<AssignmentRecord> {
    const { requestFingerprint: _, ...data } = await this.open<
      Pick<AssignmentRecord, 'title' | 'instructions' | 'policy' | 'source'> & {
        requestFingerprint: string;
      }
    >('master', row);
    if (
      data.source.organizationId !== row.organization_id ||
      data.source.documentId !== row.source_document_id ||
      data.source.versionId !== row.source_version_id ||
      data.source.ownerId !== row.created_by
    )
      throw new AssignmentError(
        503,
        'assignment_integrity',
        'Assignment metadata does not match its immutable source.',
      );
    return {
      id: row.id,
      organizationId: row.organization_id,
      installationId: row.installation_id,
      courseId: row.course_id,
      createdBy: row.created_by,
      createdAt: row.created_at.toISOString(),
      ...data,
    };
  }
  async create(
    principal: SessionPrincipal,
    enrollment: VerifiedLmsEnrollment,
    input: AssignmentInput,
    source: ReadyAssignmentSource,
  ): Promise<AssignmentRecord> {
    if (enrollment.role !== 'teacher')
      throw new AssignmentError(
        403,
        'teacher_required',
        'Only an approved course teacher can author assignments.',
      );
    const fingerprint = createHash('sha256').update(canonical({ input, source })).digest('hex');
    return this.transaction(principal, enrollment, async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
        canonical([principal.organizationId, principal.userId, input.requestId]),
      ]);
      const existing = (
        await client.query<AssignmentRow>(
          'SELECT * FROM margin_assignments.assignments WHERE organization_id=$1 AND created_by=$2 AND request_id=$3',
          [principal.organizationId, principal.userId, input.requestId],
        )
      ).rows[0];
      if (existing) {
        const prior = await this.open<{ requestFingerprint: string }>('master', existing);
        if (prior.requestFingerprint !== fingerprint)
          throw new AssignmentError(
            409,
            'idempotency_conflict',
            'This request identifier already belongs to a different assignment.',
          );
        return this.record(existing);
      }
      const row = {
        id: randomUUID(),
        organization_id: principal.organizationId,
        installation_id: enrollment.installationId,
        course_id: enrollment.courseId,
      };
      const sealed = await this.seal('master', row, {
        requestFingerprint: fingerprint,
        title: input.title,
        instructions: input.instructions,
        policy: input.policy,
        source,
      });
      const inserted = await client.query<AssignmentRow>(
        'INSERT INTO margin_assignments.assignments(id,organization_id,installation_id,course_id,created_by,request_id,source_document_id,source_version_id,ciphertext,nonce,tag,wrapped_key) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *',
        [
          row.id,
          row.organization_id,
          row.installation_id,
          row.course_id,
          principal.userId,
          input.requestId,
          input.documentId,
          input.versionId,
          sealed.ciphertext,
          sealed.nonce,
          sealed.tag,
          sealed.wrapped_key,
        ],
      );
      return this.record(inserted.rows[0]);
    });
  }
  async get(
    principal: SessionPrincipal,
    enrollment: VerifiedLmsEnrollment,
    id: string,
  ): Promise<AssignmentRecord | null> {
    return this.transaction(principal, enrollment, async (client) => {
      const row = (
        await client.query<AssignmentRow>(
          'SELECT * FROM margin_assignments.assignments WHERE id=$1',
          [assignmentId(id)],
        )
      ).rows[0];
      return row ? this.record(row) : null;
    });
  }
  async captureSelection(
    principal: SessionPrincipal,
    enrollment: VerifiedLmsEnrollment,
    value: DeepLinkSelection,
  ): Promise<void> {
    await this.transaction(principal, enrollment, async (client) => {
      const row = {
        id: value.id,
        organization_id: value.organizationId,
        installation_id: value.installationId,
        course_id: value.courseId,
      };
      const sealed = await this.seal('selection', row, value);
      await client.query(
        'INSERT INTO margin_assignments.deep_link_selections(id,organization_id,installation_id,course_id,user_id,session_id,ciphertext,nonce,tag,wrapped_key,created_at,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)',
        [
          value.id,
          value.organizationId,
          value.installationId,
          value.courseId,
          value.userId,
          value.sessionId,
          sealed.ciphertext,
          sealed.nonce,
          sealed.tag,
          sealed.wrapped_key,
          new Date(value.expiresAt - 600000),
          new Date(value.expiresAt),
        ],
      );
    });
  }
  async currentSelection(
    principal: SessionPrincipal,
    enrollment: VerifiedLmsEnrollment,
  ): Promise<DeepLinkSelection | null> {
    return this.transaction(principal, enrollment, async (client) => {
      const row = (
        await client.query<SelectionRow>(
          'SELECT * FROM margin_assignments.deep_link_selections WHERE session_id=$1 AND consumed_at IS NULL AND expires_at>clock_timestamp() ORDER BY created_at DESC,id DESC LIMIT 1',
          [principal.sessionId],
        )
      ).rows[0];
      return row ? this.open<DeepLinkSelection>('selection', row) : null;
    });
  }
  async getSelection(
    principal: SessionPrincipal,
    enrollment: VerifiedLmsEnrollment,
    id: string,
  ): Promise<DeepLinkSelection | null> {
    return this.transaction(principal, enrollment, async (client) => {
      const row = (
        await client.query<SelectionRow>(
          'SELECT * FROM margin_assignments.deep_link_selections WHERE id=$1 AND consumed_at IS NULL AND expires_at>clock_timestamp()',
          [assignmentId(id)],
        )
      ).rows[0];
      if (!row) return null;
      const data = await this.open<DeepLinkSelection>('selection', row);
      if (
        data.sessionId !== row.session_id ||
        data.userId !== row.user_id ||
        data.expiresAt !== row.expires_at.getTime()
      )
        throw new AssignmentError(
          503,
          'selection_integrity',
          'Selection metadata does not match its session.',
        );
      return data;
    });
  }
  async consumeSelection(
    principal: SessionPrincipal,
    enrollment: VerifiedLmsEnrollment,
    id: string,
    selected: string | null,
  ): Promise<boolean> {
    return this.transaction(principal, enrollment, async (client) => {
      const row = (
        await client.query<SelectionRow>(
          'SELECT * FROM margin_assignments.deep_link_selections WHERE id=$1 AND consumed_at IS NULL AND expires_at>clock_timestamp() FOR UPDATE',
          [assignmentId(id)],
        )
      ).rows[0];
      if (!row) return false;
      if (selected) {
        const result = await client.query(
          'UPDATE margin_assignments.assignments SET selected_at=COALESCE(selected_at,clock_timestamp()) WHERE id=$1 AND created_by=$2 RETURNING id',
          [assignmentId(selected), principal.userId],
        );
        if (result.rowCount !== 1)
          throw new AssignmentError(
            403,
            'assignment_selection_denied',
            'Select an assignment you authored in this course.',
          );
      }
      await client.query(
        'UPDATE margin_assignments.deep_link_selections SET consumed_at=clock_timestamp(),selected_assignment_id=$2 WHERE id=$1',
        [id, selected],
      );
      return true;
    });
  }
  async bindResource(
    principal: SessionPrincipal,
    enrollment: VerifiedLmsEnrollment,
    selected: string,
    resourceDigest: string,
    sourceAvailable: (source: ReadyAssignmentSource) => Promise<boolean>,
  ): Promise<void> {
    if (!/^[a-f0-9]{64}$/.test(resourceDigest))
      throw new AssignmentError(400, 'invalid_resource', 'The signed resource mapping is invalid.');
    await this.transaction(principal, enrollment, async (client) => {
      await context(client, 'resource_digest', resourceDigest);
      // Only this trusted verified-launch path gets a narrow selected-assignment lookup.
      await context(client, 'verified_assignment_id', assignmentId(selected));
      const candidate = (
        await client.query<AssignmentRow>(
          'SELECT * FROM margin_assignments.assignments WHERE id=$1 AND selected_at IS NOT NULL',
          [selected],
        )
      ).rows[0];
      if (!candidate)
        throw new AssignmentError(
          404,
          'assignment_unavailable',
          'This selected assignment is unavailable in the verified course.',
        );
      const record = await this.record(candidate);
      if (!(await sourceAvailable(record.source)))
        throw new AssignmentError(
          409,
          'source_unavailable',
          'The assignment source is unavailable or no longer approved.',
        );
      await client.query(
        'INSERT INTO margin_assignments.resource_links(installation_id,resource_digest,organization_id,course_id,assignment_id) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING',
        [
          enrollment.installationId,
          resourceDigest,
          principal.organizationId,
          enrollment.courseId,
          assignmentId(selected),
        ],
      );
      const resource = (
        await client.query<{ assignment_id: string; course_id: string }>(
          'SELECT assignment_id,course_id FROM margin_assignments.resource_links WHERE installation_id=$1 AND resource_digest=$2',
          [enrollment.installationId, resourceDigest],
        )
      ).rows[0];
      if (
        !resource ||
        resource.assignment_id !== selected ||
        resource.course_id !== enrollment.courseId
      )
        throw new AssignmentError(
          409,
          'resource_mapping_conflict',
          'This Canvas resource already belongs to a different assignment.',
        );
      await client.query(
        'INSERT INTO margin_assignments.launch_bindings(session_id,installation_id,resource_digest,assignment_id,user_id) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING',
        [
          principal.sessionId,
          enrollment.installationId,
          resourceDigest,
          selected,
          principal.userId,
        ],
      );
      const bound = (
        await client.query<{ assignment_id: string; resource_digest: string }>(
          'SELECT assignment_id,resource_digest FROM margin_assignments.launch_bindings WHERE session_id=$1',
          [principal.sessionId],
        )
      ).rows[0];
      if (!bound || bound.assignment_id !== selected || bound.resource_digest !== resourceDigest)
        throw new AssignmentError(
          409,
          'launch_mapping_conflict',
          'Launch a fresh Canvas session for another assignment.',
        );
    });
  }
  async getBoundAssignment(
    principal: SessionPrincipal,
    enrollment: VerifiedLmsEnrollment,
  ): Promise<AssignmentRecord | null> {
    return this.transaction(principal, enrollment, async (client) => {
      const row = (
        await client.query<AssignmentRow>(
          'SELECT a.* FROM margin_assignments.assignments a JOIN margin_assignments.launch_bindings b ON b.assignment_id=a.id WHERE b.session_id=$1 AND b.user_id=$2 AND a.selected_at IS NOT NULL',
          [principal.sessionId, principal.userId],
        )
      ).rows[0];
      return row ? this.record(row) : null;
    });
  }
  async reserveStudentWork(
    principal: SessionPrincipal,
    enrollment: VerifiedLmsEnrollment,
  ): Promise<StudentWorkReservation> {
    if (enrollment.role !== 'student')
      throw new AssignmentError(
        403,
        'student_required',
        'Personal assignment work requires an approved student enrollment.',
      );
    return this.transaction(principal, enrollment, async (client) => {
      const launch = (
        await client.query<{ assignment_id: string }>(
          'SELECT b.assignment_id FROM margin_assignments.launch_bindings b JOIN margin_assignments.assignments a ON a.id=b.assignment_id WHERE b.session_id=$1 AND a.selected_at IS NOT NULL',
          [principal.sessionId],
        )
      ).rows[0];
      if (!launch)
        throw new AssignmentError(
          403,
          'assignment_launch_required',
          'Open this assignment from its verified Canvas resource link.',
        );
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
        canonical([launch.assignment_id, principal.userId]),
      ]);
      const existing = (
        await client.query(
          'SELECT * FROM margin_assignments.student_work WHERE assignment_id=$1 AND user_id=$2',
          [launch.assignment_id, principal.userId],
        )
      ).rows[0];
      if (existing)
        return {
          id: existing.id,
          assignmentId: existing.assignment_id,
          userId: existing.user_id,
          documentId: existing.document_id,
          versionId: existing.version_id,
          status: 'pending',
          duplicate: true,
        };
      const id = randomUUID(),
        documentId = randomUUID(),
        versionId = randomUUID();
      await client.query(
        'INSERT INTO margin_assignments.student_work(id,assignment_id,organization_id,installation_id,course_id,user_id,document_id,version_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
        [
          id,
          launch.assignment_id,
          principal.organizationId,
          enrollment.installationId,
          enrollment.courseId,
          principal.userId,
          documentId,
          versionId,
        ],
      );
      await client.query('INSERT INTO margin_assignments.provisioning_outbox(work_id) VALUES($1)', [
        id,
      ]);
      return {
        id,
        assignmentId: launch.assignment_id,
        userId: principal.userId,
        documentId,
        versionId,
        status: 'pending',
        duplicate: false,
      };
    });
  }
}
