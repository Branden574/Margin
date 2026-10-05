import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { Pool, type PoolClient, type PoolConfig } from 'pg';
import type { KeyManagementProvider, WrappedDataKey } from '../../encryption.js';
import { bounded } from '../../cloud/limits.js';
import {
  decrypt,
  encrypt,
  keyContext,
  newWrappedKey,
  unwrapKey,
  type Ciphertext,
} from '../../sync/encryption.js';
import { canonical } from '../../sync/validation.js';
import { PostgresIngestionRepository, recheckReadyManifest } from '../../ingestion/postgres.js';
import type { ArtifactReader, SourcePageGeometry } from '../../ingestion/types.js';
import { geometry } from '../../ingestion/validation.js';
import { assignmentId, verifyReadySource } from '../policy.js';
import type { ReadyAssignmentSource } from '../types.js';
import {
  StudentWorkError,
  type StudentWorkClaim,
  type StudentWorkCompletion,
  type PreparedStudentWork,
} from './types.js';
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
  selected_at: Date | null;
  disabled_at: Date | null;
}
interface WorkRow {
  id: string;
  assignment_id: string;
  organization_id: string;
  installation_id: string;
  course_id: string;
  user_id: string;
  document_id: string;
  version_id: string;
  status: 'pending' | 'provisioned';
  registration_version: number | null;
  subject_digest: string | null;
  course_digest: string | null;
  resource_digest: string | null;
}
interface JobRow {
  work_id: string;
  state: 'pending' | 'completed';
  attempt: number;
  claim_id: string | null;
  token_digest: string | null;
  lease_expires_at: Date | null;
}
interface Prepared {
  claim: StudentWorkClaim;
  work: WorkRow;
  assignmentState: string;
  source: ReadyAssignmentSource;
  manifestState: string;
  pages: Array<SourcePageGeometry & { id: string }>;
  documentKey: WrappedDataKey;
  envelope: Envelope;
  expiresAt: number;
}
const hash = (v: string | Buffer) => createHash('sha256').update(v).digest('hex');
const fail = (code: string) =>
  new StudentWorkError(code, 'Student work cannot be provisioned from this claim or source.');
const assignmentState = (row: AssignmentRow) =>
  hash(
    canonical({
      id: row.id,
      organizationId: row.organization_id,
      installationId: row.installation_id,
      courseId: row.course_id,
      ownerId: row.created_by,
      documentId: row.source_document_id,
      versionId: row.source_version_id,
      selectedAt: row.selected_at?.toISOString(),
      disabledAt: row.disabled_at?.toISOString(),
      ciphertext: row.ciphertext.toString('base64'),
      nonce: row.nonce.toString('base64'),
      tag: row.tag.toString('base64'),
      wrappedKey: row.wrapped_key,
    }),
  );
const receiptContext = (work: WorkRow, claim: StudentWorkClaim) =>
  canonical([
    'margin-assignment-work-v1',
    work.id,
    work.organization_id,
    work.installation_id,
    work.course_id,
    work.assignment_id,
    work.user_id,
    work.document_id,
    work.version_id,
    claim.claimId,
    claim.attempt,
  ]);
/** Dedicated background credentials; no scheduler, storage mutation, content route or Canvas call. */
export class PostgresStudentWorkProvisioner {
  private readonly pool: Pool;
  private readonly prepared = new WeakMap<PreparedStudentWork, Prepared>();
  private activeObjectReads = 0;
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
      throw new Error('Student work requires verified PostgreSQL TLS.');
    if (
      options.connectionString &&
      [...new URL(options.connectionString).searchParams.keys()].some((k) => k.startsWith('ssl'))
    )
      throw new Error('Configure verified PostgreSQL TLS separately.');
    this.pool = new Pool({
      ...options,
      max: 4,
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
  private async transaction<T>(run: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    let discard = false;
    try {
      await client.query('BEGIN');
      await client.query("SET LOCAL synchronous_commit='on'");
      await client.query("SET LOCAL lock_timeout='2s'");
      const check = await client.query<{ unsafe: boolean }>(
        `SELECT (current_setting('fsync')<>'on' OR current_setting('full_page_writes')<>'on' OR r.rolsuper OR r.rolbypassrls OR r.rolcreaterole OR r.rolcreatedb OR NOT pg_has_role(current_user,'margin_assignment_provisioner','MEMBER') OR EXISTS(SELECT 1 FROM pg_roles p WHERE p.rolname IN ('margin_identity_runtime','margin_identity_provisioner','margin_sync_runtime','margin_sync_provisioner','margin_lms_runtime','margin_lms_provisioner','margin_assignments_runtime','margin_assignment_work_runtime','margin_ingestion_runtime','margin_ingestion_inspector','margin_ingestion_reader') AND pg_has_role(current_user,p.oid,'MEMBER')) OR EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname IN ('margin_identity','margin_sync','margin_lms','margin_assignments','margin_ingestion','margin_work') AND pg_has_role(current_user,c.relowner,'MEMBER'))) AS unsafe FROM pg_roles r WHERE r.rolname=current_user`,
      );
      if (!check.rows[0] || check.rows[0].unsafe)
        throw new Error(
          'Student work requires dedicated least-privilege credentials and durable PostgreSQL settings.',
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
  private async context(client: PoolClient, claim: StudentWorkClaim) {
    assignmentId(claim.workId);
    assignmentId(claim.claimId);
    if (
      !/^[a-f0-9]{64}$/.test(claim.token) ||
      !Number.isInteger(claim.attempt) ||
      claim.attempt < 1 ||
      claim.attempt > 10 ||
      !Number.isFinite(claim.expiresAt)
    )
      throw fail('invalid_claim');
    for (const [key, value] of [
      ['work_id', claim.workId],
      ['claim_id', claim.claimId],
      ['token_digest', hash(claim.token)],
    ])
      await client.query('SELECT set_config($1,$2,true)', [`margin_work.${key}`, value]);
  }
  private async state(client: PoolClient, claim: StudentWorkClaim, allowCompleted = false) {
    await this.context(client, claim);
    const job = (
      await client.query<JobRow>(
        'SELECT * FROM margin_assignments.provisioning_outbox WHERE work_id=$1 FOR UPDATE',
        [claim.workId],
      )
    ).rows[0];
    const work = (
      await client.query<WorkRow>('SELECT * FROM margin_assignments.student_work WHERE id=$1', [
        claim.workId,
      ])
    ).rows[0];
    if (
      !job ||
      !work ||
      job.claim_id !== claim.claimId ||
      job.attempt !== claim.attempt ||
      job.token_digest !== hash(claim.token) ||
      (!allowCompleted &&
        (job.state !== 'pending' ||
          work.status !== 'pending' ||
          !job.lease_expires_at ||
          job.lease_expires_at.getTime() <= Date.now()))
    )
      throw fail('stale_claim');
    if (
      !(
        await client.query<{ active: boolean }>('SELECT margin_work.active($1) AS active', [
          work.id,
        ])
      ).rows[0]?.active
    )
      throw fail('work_access_revoked');
    return { job, work };
  }
  async claimNext(): Promise<StudentWorkClaim | null> {
    return this.transaction(async (client) => {
      const job = (
        await client.query<JobRow>(
          `SELECT j.* FROM margin_assignments.provisioning_outbox j JOIN margin_assignments.student_work w ON w.id=j.work_id WHERE j.state='pending' AND w.status='pending' AND j.attempt<10 AND j.next_attempt_at<=statement_timestamp() AND (j.lease_expires_at IS NULL OR j.lease_expires_at<=statement_timestamp()) AND margin_work.active(w.id) ORDER BY j.next_attempt_at,j.created_at FOR UPDATE OF j SKIP LOCKED LIMIT 1`,
        )
      ).rows[0];
      if (!job) return null;
      const claimId = randomUUID(),
        token = randomBytes(32).toString('hex');
      const updated = (
        await client.query<JobRow>(
          `UPDATE margin_assignments.provisioning_outbox SET attempt=attempt+1,claim_id=$2,token_digest=$3,lease_expires_at=statement_timestamp()+interval '120 seconds' WHERE work_id=$1 RETURNING *`,
          [job.work_id, claimId, hash(token)],
        )
      ).rows[0];
      return {
        workId: job.work_id,
        claimId,
        token,
        attempt: updated.attempt,
        expiresAt: updated.lease_expires_at!.getTime(),
      };
    });
  }
  private async source(row: AssignmentRow): Promise<ReadyAssignmentSource> {
    const context = `margin-assignment-master-key-v1:${row.organization_id}:${row.id}`;
    const key = await unwrapKey(this.kms, row.wrapped_key, context);
    let plain: Buffer | undefined;
    try {
      plain = decrypt(
        key,
        row,
        canonical([
          'margin-assignment-envelope-v1',
          'master',
          row.id,
          row.organization_id,
          row.installation_id,
          row.course_id,
        ]),
      );
      const data = JSON.parse(plain.toString('utf8')) as { source: ReadyAssignmentSource };
      return verifyReadySource(data.source, {
        organizationId: row.organization_id,
        ownerId: row.created_by,
        documentId: row.source_document_id,
        versionId: row.source_version_id,
      });
    } catch {
      throw fail('assignment_integrity');
    } finally {
      key.fill(0);
      plain?.fill(0);
    }
  }
  /** KMS, decryption and authenticated exact-version object reads finish before completion opens its transaction. */
  async prepare(
    claim: StudentWorkClaim,
    reader: PostgresIngestionRepository,
    storage: ArtifactReader,
    signal?: AbortSignal,
  ): Promise<PreparedStudentWork> {
    if (reader.purpose !== 'reader') throw fail('reader_credentials_required');
    if (signal?.aborted) throw fail('preparation_cancelled');
    const snapshot = await this.transaction(async (client) => {
      const { work } = await this.state(client, claim);
      const assignment = (
        await client.query<AssignmentRow>(
          'SELECT * FROM margin_assignments.assignments WHERE id=$1',
          [work.assignment_id],
        )
      ).rows[0];
      if (
        !assignment ||
        assignment.disabled_at ||
        !assignment.selected_at ||
        assignment.organization_id !== work.organization_id ||
        assignment.installation_id !== work.installation_id ||
        assignment.course_id !== work.course_id
      )
        throw fail('assignment_unavailable');
      return { work, assignment };
    });
    const source = await this.source(snapshot.assignment);
    const manifest = await reader.readySnapshot(source);
    if (!manifest?.pageGeometry) throw fail('authenticated_geometry_required');
    const pages = geometry(manifest.pageGeometry, source.pageCount).map((page) => ({
      ...page,
      id: randomUUID(),
    }));
    if (this.activeObjectReads >= 2) throw fail('object_reader_busy');
    this.activeObjectReads++;
    let objectStarted = false;
    let bytes: Buffer | undefined;
    try {
      const result = await bounded(
        20000,
        signal,
        async (abort) => {
          objectStarted = true;
          try {
            return await storage.get(manifest.identity, manifest.receipt, abort);
          } finally {
            this.activeObjectReads--;
          }
        },
        (late) => late.bytes.fill(0),
      );
      bytes = result.bytes;
      if (
        bytes.length < 1 ||
        bytes.length > 100 * 1024 * 1024 ||
        result.metadata.mimeType !== 'application/pdf' ||
        hash(bytes) !== source.sha256
      )
        throw fail('source_content_mismatch');
    } finally {
      if (!objectStarted) this.activeObjectReads--;
      bytes?.fill(0);
    }
    const after = await reader.readySnapshot(source);
    if (!after || canonical(after) !== canonical(manifest)) throw fail('source_access_changed');
    const documentKey = await newWrappedKey(
      this.kms,
      keyContext(snapshot.work.organization_id, snapshot.work.document_id),
    );
    const aad = receiptContext(snapshot.work, claim);
    const wrapped_key = await newWrappedKey(this.kms, aad);
    const key = await unwrapKey(this.kms, wrapped_key, aad);
    const body = Buffer.from(
      canonical({
        schema: 1,
        source,
        storageReceipt: manifest.receipt,
        approval: manifest.stateToken,
        pages,
        workId: claim.workId,
        assignmentId: snapshot.work.assignment_id,
        ownerId: snapshot.work.user_id,
        documentId: snapshot.work.document_id,
        versionId: snapshot.work.version_id,
        claimId: claim.claimId,
        attempt: claim.attempt,
      }),
    );
    let envelope: Envelope;
    try {
      if (body.length > 262144) throw fail('work_manifest_limit');
      envelope = { ...encrypt(key, body, aad), wrapped_key };
    } finally {
      key.fill(0);
      body.fill(0);
    }
    if (signal?.aborted) throw fail('preparation_cancelled');
    const ticket: PreparedStudentWork = Object.freeze({ kind: 'prepared-student-work' });
    this.prepared.set(ticket, {
      claim: structuredClone(claim),
      work: snapshot.work,
      assignmentState: assignmentState(snapshot.assignment),
      source,
      manifestState: manifest.stateToken,
      pages,
      documentKey,
      envelope,
      expiresAt: Math.min(Date.now() + 10000, claim.expiresAt),
    });
    return ticket;
  }
  /** Fixed lock ordering gives revocation a serial order relative to the complete transaction. */
  private async lockAuthority(client: PoolClient, work: WorkRow, source: ReadyAssignmentSource) {
    const actors = [work.user_id, source.ownerId].sort();
    const locks: Array<[string, unknown[]]> = [
      [
        'SELECT id FROM margin_identity.organizations WHERE id=$1 FOR SHARE',
        [work.organization_id],
      ],
      [
        'SELECT id FROM margin_identity.users WHERE id=ANY($1::uuid[]) ORDER BY id FOR SHARE',
        [actors],
      ],
      [
        'SELECT user_id FROM margin_identity.memberships WHERE organization_id=$1 AND user_id=ANY($2::uuid[]) ORDER BY user_id FOR SHARE',
        [work.organization_id, actors],
      ],
      ['SELECT id FROM margin_lms.installations WHERE id=$1 FOR SHARE', [work.installation_id]],
      [
        'SELECT course_id FROM margin_lms.courses WHERE installation_id=$1 AND course_id=$2 FOR SHARE',
        [work.installation_id, work.course_id],
      ],
      [
        'SELECT user_id FROM margin_lms.user_links WHERE installation_id=$1 AND user_id=ANY($2::uuid[]) ORDER BY user_id FOR SHARE',
        [work.installation_id, actors],
      ],
      [
        'SELECT user_id FROM margin_lms.enrollments WHERE installation_id=$1 AND course_id=$2 AND user_id=ANY($3::uuid[]) ORDER BY user_id FOR SHARE',
        [work.installation_id, work.course_id, actors],
      ],
      ['SELECT id FROM margin_assignments.assignments WHERE id=$1 FOR SHARE', [work.assignment_id]],
      [
        'SELECT resource_digest FROM margin_assignments.resource_links WHERE installation_id=$1 AND resource_digest=$2 AND assignment_id=$3 FOR SHARE',
        [work.installation_id, work.resource_digest, work.assignment_id],
      ],
      [
        'SELECT id FROM margin_sync.documents WHERE organization_id=$1 AND id=$2 FOR SHARE',
        [source.organizationId, source.documentId],
      ],
      [
        'SELECT id FROM margin_sync.versions WHERE organization_id=$1 AND document_id=$2 AND id=$3 FOR SHARE',
        [source.organizationId, source.documentId, source.versionId],
      ],
      [
        'SELECT user_id FROM margin_sync.grants WHERE organization_id=$1 AND document_id=$2 AND user_id=$3 FOR SHARE',
        [source.organizationId, source.documentId, source.ownerId],
      ],
      [
        'SELECT artifact_id FROM margin_ingestion.artifacts WHERE artifact_id=$1 AND organization_id=$2 AND installation_id=$3 AND course_id=$4 AND registration_version=$5 FOR SHARE',
        [
          source.artifactId,
          work.organization_id,
          work.installation_id,
          work.course_id,
          work.registration_version,
        ],
      ],
      [
        'SELECT artifact_id FROM margin_ingestion.storage_receipts WHERE artifact_id=$1 FOR SHARE',
        [source.artifactId],
      ],
      [
        'SELECT artifact_id FROM margin_ingestion.inspection_jobs WHERE artifact_id=$1 FOR SHARE',
        [source.artifactId],
      ],
      [
        'SELECT id FROM margin_ingestion.inspection_receipts WHERE id=$1 AND artifact_id=$2 AND has_geometry FOR SHARE',
        [source.scanReceiptId, source.artifactId],
      ],
      [
        'SELECT scan_receipt_id FROM margin_ingestion.page_geometry WHERE scan_receipt_id=$1 AND artifact_id=$2 FOR SHARE',
        [source.scanReceiptId, source.artifactId],
      ],
    ];
    for (const [sql, params] of locks)
      if (!(await client.query(sql, params)).rowCount) throw fail('source_access_changed');
  }
  /** Database-only, one-use final transaction; a timeout or unknown commit result must use receipt(). */
  async completePrepared(
    claim: StudentWorkClaim,
    ticket: PreparedStudentWork,
    signal?: AbortSignal,
  ): Promise<StudentWorkCompletion> {
    const prepared = this.prepared.get(ticket);
    this.prepared.delete(ticket);
    if (
      !prepared ||
      prepared.expiresAt <= Date.now() ||
      canonical(prepared.claim) !== canonical(claim) ||
      signal?.aborted
    )
      throw fail('invalid_preparation');
    return this.transaction(async (client) => {
      const { work } = await this.state(client, claim);
      if (canonical(work) !== canonical(prepared.work)) throw fail('work_changed');
      await this.lockAuthority(client, work, prepared.source);
      const row = (
        await client.query<AssignmentRow>(
          'SELECT * FROM margin_assignments.assignments WHERE id=$1',
          [work.assignment_id],
        )
      ).rows[0];
      if (!row || assignmentState(row) !== prepared.assignmentState)
        throw fail('assignment_changed');
      const current = async () => {
        if (
          signal?.aborted ||
          Date.now() >= prepared.expiresAt ||
          !(await recheckReadyManifest(client, prepared.source, prepared.manifestState)) ||
          !(
            await client.query<{ active: boolean }>('SELECT margin_work.active($1) AS active', [
              work.id,
            ])
          ).rows[0]?.active
        )
          throw fail('source_access_changed');
      };
      await current();
      await client.query(
        `INSERT INTO margin_sync.documents(organization_id,id,owner_id,current_version_id,audience,origin) VALUES($1,$2,$3,$4,'members','assignment')`,
        [work.organization_id, work.document_id, work.user_id, work.version_id],
      );
      await client.query(
        'INSERT INTO margin_sync.versions(organization_id,document_id,id) VALUES($1,$2,$3)',
        [work.organization_id, work.document_id, work.version_id],
      );
      await client.query(
        'INSERT INTO margin_sync.pages(organization_id,document_id,version_id,id,page_index,width,height) SELECT $1,$2,$3,p.id,p.index,p.width,p.height FROM jsonb_to_recordset($4::jsonb) AS p(id uuid,index integer,width double precision,height double precision)',
        [work.organization_id, work.document_id, work.version_id, JSON.stringify(prepared.pages)],
      );
      await client.query(
        'INSERT INTO margin_sync.document_keys(organization_id,document_id,wrapped_key) VALUES($1,$2,$3)',
        [work.organization_id, work.document_id, prepared.documentKey],
      );
      await client.query(
        "INSERT INTO margin_sync.grants(organization_id,document_id,user_id,permission) VALUES($1,$2,$3,'owner')",
        [work.organization_id, work.document_id, work.user_id],
      );
      const e = prepared.envelope;
      await client.query(
        'INSERT INTO margin_work.receipts(work_id,organization_id,document_id,version_id,claim_id,attempt,source_artifact_id,scan_receipt_id,ciphertext,nonce,tag,wrapped_key) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)',
        [
          work.id,
          work.organization_id,
          work.document_id,
          work.version_id,
          claim.claimId,
          claim.attempt,
          prepared.source.artifactId,
          prepared.source.scanReceiptId,
          e.ciphertext,
          e.nonce,
          e.tag,
          e.wrapped_key,
        ],
      );
      await client.query(
        "UPDATE margin_assignments.student_work SET status='provisioned',provisioned_at=clock_timestamp() WHERE id=$1",
        [work.id],
      );
      await client.query(
        "UPDATE margin_assignments.provisioning_outbox SET state='completed',completed_at=clock_timestamp() WHERE work_id=$1",
        [work.id],
      );
      await current();
      return {
        workId: work.id,
        documentId: work.document_id,
        versionId: work.version_id,
        status: 'provisioned',
        duplicate: false,
      };
    });
  }
  /** Authenticate recovery outside a transaction, then recheck current immutable state under authority locks. */
  async receipt(claim: StudentWorkClaim): Promise<StudentWorkCompletion | null> {
    const snapshot = await this.transaction(async (client) => {
      const { work, job } = await this.state(client, claim, true);
      if (job.state !== 'completed' || work.status !== 'provisioned') return null;
      const receipt = (
        await client.query<
          Envelope & {
            claim_id: string;
            attempt: number;
            document_id: string;
            version_id: string;
            source_artifact_id: string;
            scan_receipt_id: string;
          }
        >('SELECT * FROM margin_work.receipts WHERE work_id=$1', [work.id])
      ).rows[0];
      const assignment = (
        await client.query<AssignmentRow>(
          'SELECT * FROM margin_assignments.assignments WHERE id=$1',
          [work.assignment_id],
        )
      ).rows[0];
      if (
        !receipt ||
        !assignment ||
        receipt.claim_id !== claim.claimId ||
        receipt.attempt !== claim.attempt ||
        receipt.document_id !== work.document_id ||
        receipt.version_id !== work.version_id
      )
        throw fail('completion_integrity');
      return { work, receipt, assignment };
    });
    if (!snapshot) return null;
    const { work, receipt, assignment } = snapshot;
    const context = receiptContext(work, claim);
    let key: Buffer | undefined, plain: Buffer | undefined;
    let source: ReadyAssignmentSource,
      approval: string,
      pages: Array<SourcePageGeometry & { id: string }>;
    try {
      key = await unwrapKey(this.kms, receipt.wrapped_key, context);
      plain = decrypt(key, receipt, context, 262144);
      const data = JSON.parse(plain.toString('utf8'));
      if (
        data.schema !== 1 ||
        data.workId !== work.id ||
        data.assignmentId !== work.assignment_id ||
        data.ownerId !== work.user_id ||
        data.documentId !== work.document_id ||
        data.versionId !== work.version_id ||
        data.claimId !== claim.claimId ||
        data.attempt !== claim.attempt ||
        !/^[a-f0-9]{64}$/.test(data.approval)
      )
        throw fail('completion_integrity');
      source = verifyReadySource(data.source, {
        organizationId: assignment.organization_id,
        ownerId: assignment.created_by,
        documentId: assignment.source_document_id,
        versionId: assignment.source_version_id,
      });
      if (
        source.artifactId !== receipt.source_artifact_id ||
        source.scanReceiptId !== receipt.scan_receipt_id ||
        data.storageReceipt?.objectVersionId !== source.artifactVersion
      )
        throw fail('completion_integrity');
      pages = geometry(data.pages, source.pageCount).map((page, index) => ({
        ...page,
        id: assignmentId(data.pages[index].id),
      }));
      if (new Set(pages.map((p) => p.id)).size !== pages.length) throw fail('completion_integrity');
      approval = data.approval;
    } catch {
      throw fail('completion_integrity');
    } finally {
      key?.fill(0);
      plain?.fill(0);
    }
    return this.transaction(async (client) => {
      const current = await this.state(client, claim, true);
      if (
        current.job.state !== 'completed' ||
        current.work.status !== 'provisioned' ||
        canonical(current.work) !== canonical(work)
      )
        throw fail('completion_integrity');
      await this.lockAuthority(client, work, source);
      const target = (
        await client.query<{
          owner_id: string;
          current_version_id: string;
          origin: string;
          deleted_at: Date | null;
        }>(
          'SELECT owner_id,current_version_id,origin,deleted_at FROM margin_sync.documents WHERE organization_id=$1 AND id=$2 FOR SHARE',
          [work.organization_id, work.document_id],
        )
      ).rows[0];
      const grant = (
        await client.query<{ permission: string; revoked_at: Date | null }>(
          'SELECT permission,revoked_at FROM margin_sync.grants WHERE organization_id=$1 AND document_id=$2 AND user_id=$3 FOR SHARE',
          [work.organization_id, work.document_id, work.user_id],
        )
      ).rows[0];
      if (
        !target ||
        target.owner_id !== work.user_id ||
        target.current_version_id !== work.version_id ||
        target.origin !== 'assignment' ||
        target.deleted_at ||
        !grant ||
        grant.permission !== 'owner' ||
        grant.revoked_at
      )
        throw fail('completion_integrity');
      const fresh = (
        await client.query('SELECT * FROM margin_work.receipts WHERE work_id=$1', [work.id])
      ).rows[0];
      const master = (
        await client.query<AssignmentRow>(
          'SELECT * FROM margin_assignments.assignments WHERE id=$1',
          [work.assignment_id],
        )
      ).rows[0];
      const actual = (
        await client.query<{ id: string; index: number; width: number; height: number }>(
          'SELECT id,page_index AS index,width,height FROM margin_sync.pages WHERE organization_id=$1 AND document_id=$2 AND version_id=$3 ORDER BY page_index',
          [work.organization_id, work.document_id, work.version_id],
        )
      ).rows;
      if (
        !fresh ||
        canonical(fresh) !== canonical(receipt) ||
        !master ||
        assignmentState(master) !== assignmentState(assignment) ||
        canonical(actual) !== canonical(pages) ||
        !(await recheckReadyManifest(client, source, approval)) ||
        !(
          await client.query<{ active: boolean }>('SELECT margin_work.active($1) AS active', [
            work.id,
          ])
        ).rows[0]?.active
      )
        throw fail('completion_integrity');
      return {
        workId: work.id,
        documentId: work.document_id,
        versionId: work.version_id,
        status: 'provisioned',
        duplicate: true,
      };
    });
  }
  async retry(claim: StudentWorkClaim, delaySeconds = 30): Promise<void> {
    if (!Number.isInteger(delaySeconds) || delaySeconds < 0 || delaySeconds > 3600)
      throw fail('invalid_retry');
    await this.transaction(async (client) => {
      await this.state(client, claim);
      await client.query(
        "UPDATE margin_assignments.provisioning_outbox SET claim_id=NULL,token_digest=NULL,lease_expires_at=NULL,next_attempt_at=statement_timestamp()+($2::text||' seconds')::interval WHERE work_id=$1",
        [claim.workId, delaySeconds],
      );
    });
  }
}
