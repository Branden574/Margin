import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { Pool, type PoolClient, type PoolConfig } from 'pg';
import type { SessionPrincipal } from '../identity/types.js';
import type { ArtifactIdentity, ArtifactReceipt } from '../cloud/types.js';
import type { ReadyAssignmentSource } from '../assignments/types.js';
import type { KeyManagementProvider, WrappedDataKey } from '../encryption.js';
import { encrypt, decrypt, newWrappedKey, unwrapKey, type Ciphertext } from '../sync/encryption.js';
import { canonical } from '../sync/validation.js';
import {
  IngestionError,
  type SourceReservationInput,
  type SourceReservation,
  type InspectionClaim,
  type InspectionReport,
  type InspectionReceipt,
} from './types.js';
import { id, digest, reservation, receipt, report } from './validation.js';
type Kind = 'runtime' | 'inspector' | 'reader';
interface Envelope extends Ciphertext {
  wrapped_key: WrappedDataKey;
}
interface Row extends Envelope {
  artifact_id: string;
  organization_id: string;
  document_id: string;
  version_id: string;
  owner_id: string;
  installation_id: string;
  course_id: string;
  registration_version: number;
  request_id: string;
  revoked_at: Date | null;
}
interface Job {
  artifact_id: string;
  status: 'quarantined' | 'ready' | 'rejected';
  attempt: number;
  claim_id: string | null;
  token_digest: string | null;
  lease_expires_at: Date | null;
  scan_receipt_id: string | null;
}
interface ScanRow extends Envelope {
  id: string;
  artifact_id: string;
  claim_id: string;
  attempt: number;
  verdict: 'ready' | 'rejected';
}
interface PrivateReservation extends SourceReservationInput {
  fingerprint: string;
}
const scanBinding = (s: Pick<ScanRow, 'id' | 'claim_id' | 'attempt' | 'verdict'>) =>
  canonical([s.id, s.claim_id, s.attempt, s.verdict]);
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const ctx = (c: PoolClient, k: string, v: string) =>
  c.query('SELECT set_config($1,$2,true)', [`margin_ingestion.${k}`, id(v)]);
const identity = (r: Row): ArtifactIdentity => ({
  organizationId: r.organization_id,
  documentId: r.document_id,
  versionId: r.version_id,
  artifactId: r.artifact_id,
  kind: 'source-pdf',
});
const envelopeState = (e: Envelope) => [
  e.ciphertext.toString('base64'),
  e.nonce.toString('base64'),
  e.tag.toString('base64'),
  e.wrapped_key,
];
const stateToken = (r: Row, j: Job, stored: Envelope, scan: ScanRow) =>
  hash(
    canonical([
      binding('approval-state', r),
      envelopeState(r),
      envelopeState(stored),
      j.status,
      j.attempt,
      j.claim_id,
      j.scan_receipt_id,
      scanBinding(scan),
      envelopeState(scan),
    ]),
  );
const binding = (kind: string, r: Row, extra = '') =>
  canonical([
    'margin-ingestion-v1',
    kind,
    r.organization_id,
    r.document_id,
    r.version_id,
    r.artifact_id,
    r.owner_id,
    r.installation_id,
    r.course_id,
    r.registration_version,
    r.request_id,
    extra,
  ]);
export interface ReadyManifest {
  source: ReadyAssignmentSource;
  identity: ArtifactIdentity;
  receipt: ArtifactReceipt;
  /** Opaque digest of the authenticated immutable database state; contains no plaintext metadata. */
  stateToken: string;
}
/** Separate instance and database login per purpose; never combine these groups on one credential. */
export class PostgresIngestionRepository {
  private readonly pool: Pool;
  constructor(
    options: PoolConfig,
    private readonly kms: KeyManagementProvider,
    readonly purpose: Kind,
  ) {
    const socket =
      process.env.NODE_ENV === 'test' && options.host?.startsWith('/') && !options.connectionString;
    if (
      process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0' ||
      (!socket &&
        (!options.ssl ||
          (typeof options.ssl === 'object' && options.ssl.rejectUnauthorized === false)))
    )
      throw new Error('Ingestion requires verified PostgreSQL TLS.');
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
  private require(k: Kind) {
    if (this.purpose !== k)
      throw new IngestionError(
        403,
        'ingestion_role',
        'Use the dedicated ingestion service credential.',
      );
  }
  private async tx<T>(run: (c: PoolClient) => Promise<T>): Promise<T> {
    const c = await this.pool.connect();
    let discard = false;
    try {
      await c.query('BEGIN');
      await c.query("SET LOCAL synchronous_commit='on'");
      await c.query("SET LOCAL lock_timeout='2s'");
      const group = `margin_ingestion_${this.purpose}`;
      const groups = [
        'margin_ingestion_runtime',
        'margin_ingestion_inspector',
        'margin_ingestion_reader',
        'margin_identity_runtime',
        'margin_identity_provisioner',
        'margin_sync_runtime',
        'margin_sync_provisioner',
        'margin_lms_runtime',
        'margin_lms_provisioner',
        'margin_assignments_runtime',
      ].filter((g) => g !== group);
      const safe = await c.query<{ unsafe: boolean }>(
        `SELECT (current_setting('fsync')<>'on' OR current_setting('full_page_writes')<>'on' OR r.rolsuper OR r.rolbypassrls OR r.rolcreaterole OR r.rolcreatedb OR NOT pg_has_role(current_user,$1,'MEMBER') OR EXISTS(SELECT 1 FROM pg_roles other WHERE other.rolname=ANY($2::text[]) AND pg_has_role(current_user,other.oid,'MEMBER')) OR EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname IN ('margin_ingestion','margin_identity','margin_lms','margin_sync','margin_assignments') AND pg_has_role(current_user,c.relowner,'MEMBER'))) AS unsafe FROM pg_roles r WHERE r.rolname=current_user`,
        [group, groups],
      );
      if (!safe.rows[0] || safe.rows[0].unsafe)
        throw new Error(
          'Ingestion requires separate least-privilege credentials and durable PostgreSQL settings.',
        );
      const result = await run(c);
      await c.query('COMMIT');
      return result;
    } catch (e) {
      try {
        await c.query('ROLLBACK');
      } catch {
        discard = true;
      }
      const code = (e as { code?: string }).code;
      if (code === '23505')
        throw new IngestionError(
          409,
          'ingestion_conflict',
          'This immutable source or request is already reserved.',
        );
      if (['55P03', '57014'].includes(code ?? ''))
        throw new IngestionError(
          503,
          'ingestion_busy',
          'Ingestion storage is busy. Retry with the same request identifier.',
        );
      throw e;
    } finally {
      c.release(discard);
    }
  }
  private async teacher<T>(
    p: SessionPrincipal,
    run: (
      c: PoolClient,
      b: { installation_id: string; course_id: string; registration_version: number },
    ) => Promise<T>,
  ): Promise<T> {
    this.require('runtime');
    if (p.role !== 'teacher' || p.authenticationMethod !== 'lti')
      throw new IngestionError(
        403,
        'ingestion_access',
        'Launch as a currently enrolled Canvas teacher.',
      );
    return this.tx(async (c) => {
      await ctx(c, 'session_id', p.sessionId);
      await ctx(c, 'user_id', p.userId);
      await ctx(c, 'organization_id', p.organizationId);
      const b = (
        await c.query<{ installation_id: string; course_id: string; registration_version: number }>(
          'SELECT installation_id,course_id,registration_version FROM margin_lms.session_bindings WHERE session_id=$1',
          [p.sessionId],
        )
      ).rows[0];
      if (!b)
        throw new IngestionError(
          403,
          'ingestion_access',
          'The current course session is unavailable.',
        );
      await ctx(c, 'installation_id', b.installation_id);
      await ctx(c, 'course_id', b.course_id);
      const check = async () => {
        if (
          !(await c.query<{ ok: boolean }>('SELECT margin_ingestion.active_teacher() AS ok'))
            .rows[0]?.ok
        )
          throw new IngestionError(
            403,
            'ingestion_revoked',
            'Current course access has changed. Launch again from Canvas.',
          );
      };
      await check();
      const result = await run(c, b);
      await check();
      return result;
    });
  }
  private async seal(kind: string, row: Row, value: unknown, extra = ''): Promise<Envelope> {
    const plain = Buffer.from(canonical(value));
    let key: Buffer | undefined;
    try {
      if (plain.length > 16384)
        throw new IngestionError(
          413,
          'ingestion_metadata_limit',
          'Ingestion metadata exceeds its limit.',
        );
      const bound = binding(kind, row, extra),
        wrapped_key = await newWrappedKey(this.kms, bound);
      key = await unwrapKey(this.kms, wrapped_key, bound);
      return { ...encrypt(key, plain, bound), wrapped_key };
    } finally {
      plain.fill(0);
      key?.fill(0);
    }
  }
  private async open<T>(kind: string, row: Row, value: Envelope, extra = ''): Promise<T> {
    let key: Buffer | undefined, plain: Buffer | undefined;
    try {
      const bound = binding(kind, row, extra);
      key = await unwrapKey(this.kms, value.wrapped_key, bound);
      plain = decrypt(key, value, bound);
      return JSON.parse(plain.toString('utf8')) as T;
    } catch {
      throw new IngestionError(
        503,
        'ingestion_integrity',
        'Encrypted source metadata could not be authenticated.',
      );
    } finally {
      key?.fill(0);
      plain?.fill(0);
    }
  }
  private async row(c: PoolClient, artifactId: string, lock = false) {
    return (
      await c.query<Row>(
        `SELECT * FROM margin_ingestion.artifacts WHERE artifact_id=$1${lock ? ' FOR UPDATE' : ''}`,
        [id(artifactId)],
      )
    ).rows[0];
  }
  private async status(c: PoolClient, r: Row): Promise<SourceReservation['status']> {
    return (
      (
        await c.query<Job>('SELECT * FROM margin_ingestion.inspection_jobs WHERE artifact_id=$1', [
          r.artifact_id,
        ])
      ).rows[0]?.status ?? 'pending'
    );
  }
  async reserve(p: SessionPrincipal, input: SourceReservationInput): Promise<SourceReservation> {
    const parsed = reservation(input),
      fingerprint = hash(canonical(parsed));
    return this.teacher(p, async (c, b) => {
      await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
        canonical([p.organizationId, p.userId, 'source-reservations']),
      ]);
      const existing = (
        await c.query<Row>(
          'SELECT * FROM margin_ingestion.artifacts WHERE organization_id=$1 AND owner_id=$2 AND request_id=$3',
          [p.organizationId, p.userId, parsed.requestId],
        )
      ).rows[0];
      if (existing) {
        const data = await this.open<PrivateReservation>('reservation', existing, existing);
        if (data.fingerprint !== fingerprint)
          throw new IngestionError(
            409,
            'idempotency_conflict',
            'The request identifier belongs to another source.',
          );
        return {
          identity: identity(existing),
          status: await this.status(c, existing),
          duplicate: true,
        };
      }
      const allowed = (
        await c.query<{ ok: boolean }>(
          'SELECT margin_ingestion.active_source($1,$2,$3,$4,$5,$6,$7) AS ok',
          [
            p.organizationId,
            p.userId,
            parsed.documentId,
            parsed.versionId,
            b.installation_id,
            b.course_id,
            b.registration_version,
          ],
        )
      ).rows[0]?.ok;
      if (!allowed)
        throw new IngestionError(
          403,
          'source_ownership',
          'An active owned immutable source version is required.',
        );
      const count = (
        await c.query<{ count: string }>(
          "SELECT count(*) FROM margin_ingestion.artifacts a LEFT JOIN margin_ingestion.inspection_jobs j USING(artifact_id) WHERE j.status IS NULL OR j.status='quarantined'",
        )
      ).rows[0].count;
      if (Number(count) >= 1000)
        throw new IngestionError(
          429,
          'ingestion_limit',
          'Too many sources are awaiting ingestion.',
        );
      const r = {
        artifact_id: randomUUID(),
        organization_id: p.organizationId,
        document_id: parsed.documentId,
        version_id: parsed.versionId,
        owner_id: p.userId,
        ...b,
        request_id: parsed.requestId,
      } as Row;
      const e = await this.seal('reservation', r, { ...parsed, fingerprint });
      await c.query(
        'INSERT INTO margin_ingestion.artifacts(artifact_id,organization_id,document_id,version_id,owner_id,installation_id,course_id,registration_version,request_id,ciphertext,nonce,tag,wrapped_key) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)',
        [
          r.artifact_id,
          r.organization_id,
          r.document_id,
          r.version_id,
          r.owner_id,
          r.installation_id,
          r.course_id,
          r.registration_version,
          r.request_id,
          e.ciphertext,
          e.nonce,
          e.tag,
          e.wrapped_key,
        ],
      );
      return { identity: identity(r), status: 'pending', duplicate: false };
    });
  }
  /** Trusted server call only, after authenticated storage returned a full receipt. Never mount with client receipt JSON. */
  async stageConfirmed(
    p: SessionPrincipal,
    artifactId: string,
    confirmed: ArtifactReceipt,
  ): Promise<SourceReservation> {
    const value = receipt(confirmed);
    return this.teacher(p, async (c) => {
      // Row ownership is immutable; advisory locking avoids granting runtime UPDATE privileges.
      await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [id(artifactId)]);
      const r = await this.row(c, artifactId);
      if (!r)
        throw new IngestionError(404, 'source_unavailable', 'The owned source is unavailable.');
      const existing = (
        await c.query<Envelope>(
          'SELECT * FROM margin_ingestion.storage_receipts WHERE artifact_id=$1',
          [r.artifact_id],
        )
      ).rows[0];
      if (existing) {
        if (canonical(await this.open('storage', r, existing)) !== canonical(value))
          throw new IngestionError(
            409,
            'receipt_conflict',
            'The immutable source already has another storage receipt.',
          );
        return { identity: identity(r), status: await this.status(c, r), duplicate: true };
      }
      const e = await this.seal('storage', r, value);
      await c.query(
        'INSERT INTO margin_ingestion.storage_receipts(artifact_id,ciphertext,nonce,tag,wrapped_key) VALUES($1,$2,$3,$4,$5)',
        [r.artifact_id, e.ciphertext, e.nonce, e.tag, e.wrapped_key],
      );
      await c.query('INSERT INTO margin_ingestion.inspection_jobs(artifact_id) VALUES($1)', [
        r.artifact_id,
      ]);
      return { identity: identity(r), status: 'quarantined', duplicate: false };
    });
  }
  async get(p: SessionPrincipal, artifactId: string): Promise<SourceReservation | null> {
    return this.teacher(p, async (c) => {
      const r = await this.row(c, artifactId);
      return r
        ? { identity: identity(r), status: await this.status(c, r), duplicate: false }
        : null;
    });
  }
  private async active(c: PoolClient, r: Row) {
    return (
      !r.revoked_at &&
      (
        await c.query<{ ok: boolean }>(
          'SELECT margin_ingestion.active_source($1,$2,$3,$4,$5,$6,$7) AS ok',
          [
            r.organization_id,
            r.owner_id,
            r.document_id,
            r.version_id,
            r.installation_id,
            r.course_id,
            r.registration_version,
          ],
        )
      ).rows[0]?.ok === true
    );
  }
  async claimNext(): Promise<InspectionClaim | null> {
    this.require('inspector');
    return this.tx(async (c) => {
      const j = (
        await c.query<Job>(
          `SELECT j.* FROM margin_ingestion.inspection_jobs j JOIN margin_ingestion.artifacts a USING(artifact_id) WHERE j.status='quarantined' AND j.attempt<10 AND j.next_attempt_at<=clock_timestamp() AND (j.lease_expires_at IS NULL OR j.lease_expires_at<=clock_timestamp()) AND a.revoked_at IS NULL AND margin_ingestion.active_source(a.organization_id,a.owner_id,a.document_id,a.version_id,a.installation_id,a.course_id,a.registration_version) ORDER BY j.next_attempt_at,j.created_at,j.artifact_id LIMIT 1 FOR UPDATE OF j SKIP LOCKED`,
        )
      ).rows[0];
      if (!j) return null;
      const r = (await this.row(c, j.artifact_id))!;
      const stored = (
        await c.query<Envelope>(
          'SELECT * FROM margin_ingestion.storage_receipts WHERE artifact_id=$1',
          [r.artifact_id],
        )
      ).rows[0];
      const expected = reservation(await this.open<PrivateReservation>('reservation', r, r)),
        object = receipt(await this.open<ArtifactReceipt>('storage', r, stored));
      const claimId = randomUUID(),
        token = randomBytes(32).toString('hex');
      const claimed = (
        await c.query<Job>(
          "UPDATE margin_ingestion.inspection_jobs SET attempt=attempt+1,claim_id=$2,token_digest=$3,lease_expires_at=statement_timestamp()+interval '120 seconds' WHERE artifact_id=$1 RETURNING *",
          [r.artifact_id, claimId, hash(token)],
        )
      ).rows[0];
      return {
        identity: identity(r),
        claimId,
        token,
        attempt: claimed.attempt,
        expiresAt: claimed.lease_expires_at!.getTime(),
        receipt: object,
        expected: {
          metadata: expected.metadata,
          plaintextBytes: expected.plaintextBytes,
          plaintextSha256: expected.plaintextSha256,
        },
      };
    });
  }
  private async lockedClaim(c: PoolClient, claim: InspectionClaim) {
    id(claim.claimId);
    digest(claim.token);
    const r = await this.row(c, claim.identity.artifactId);
    const j = (
      await c.query<Job>(
        'SELECT * FROM margin_ingestion.inspection_jobs WHERE artifact_id=$1 FOR UPDATE',
        [id(claim.identity.artifactId)],
      )
    ).rows[0];
    if (
      !r ||
      !j ||
      canonical(identity(r)) !== canonical(claim.identity) ||
      j.claim_id !== claim.claimId ||
      j.token_digest !== hash(claim.token) ||
      j.attempt !== claim.attempt ||
      !(await this.active(c, r))
    )
      throw new IngestionError(
        409,
        'stale_inspection',
        'This inspection claim is stale or its source is unavailable.',
      );
    return { r, j };
  }
  async complete(claim: InspectionClaim, result: InspectionReport): Promise<InspectionReceipt> {
    this.require('inspector');
    const checked = report(result),
      fingerprint = hash(canonical(checked));
    return this.tx(async (c) => {
      const { r, j } = await this.lockedClaim(c, claim);
      if (j.status !== 'quarantined') {
        const prior = (
          await c.query<ScanRow>('SELECT * FROM margin_ingestion.inspection_receipts WHERE id=$1', [
            j.scan_receipt_id,
          ])
        ).rows[0];
        const data = await this.open<{ fingerprint: string }>(
          'inspection',
          r,
          prior,
          scanBinding(prior),
        );
        if (data.fingerprint !== fingerprint)
          throw new IngestionError(
            409,
            'inspection_conflict',
            'This claim already has another inspection result.',
          );
        return { id: prior.id, status: prior.verdict, duplicate: true };
      }
      if (!j.lease_expires_at || j.lease_expires_at.getTime() <= Date.now())
        throw new IngestionError(409, 'stale_inspection', 'The inspection lease expired.');
      const expected = await this.open<PrivateReservation>('reservation', r, r);
      if (
        checked.verdict === 'ready' &&
        (checked.plaintextSha256 !== expected.plaintextSha256 ||
          checked.plaintextBytes !== expected.plaintextBytes)
      )
        throw new IngestionError(
          409,
          'inspection_content_mismatch',
          'The inspected bytes do not match the reserved source.',
        );
      const stored = (
        await c.query<Envelope>(
          'SELECT * FROM margin_ingestion.storage_receipts WHERE artifact_id=$1',
          [r.artifact_id],
        )
      ).rows[0];
      const object = receipt(await this.open<ArtifactReceipt>('storage', r, stored));
      if (
        canonical(object) !== canonical(receipt(claim.receipt)) ||
        canonical(claim.expected) !==
          canonical({
            metadata: expected.metadata,
            plaintextBytes: expected.plaintextBytes,
            plaintextSha256: expected.plaintextSha256,
          })
      )
        throw new IngestionError(
          409,
          'inspection_content_mismatch',
          'The claimed immutable source receipt changed.',
        );
      const scanId = randomUUID(),
        e = await this.seal(
          'inspection',
          r,
          { report: checked, fingerprint, receipt: object },
          scanBinding({
            id: scanId,
            claim_id: claim.claimId,
            attempt: j.attempt,
            verdict: checked.verdict,
          }),
        );
      await c.query(
        'INSERT INTO margin_ingestion.inspection_receipts(id,artifact_id,claim_id,attempt,verdict,ciphertext,nonce,tag,wrapped_key) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',
        [
          scanId,
          r.artifact_id,
          claim.claimId,
          j.attempt,
          checked.verdict,
          e.ciphertext,
          e.nonce,
          e.tag,
          e.wrapped_key,
        ],
      );
      await c.query(
        'UPDATE margin_ingestion.inspection_jobs SET status=$2,scan_receipt_id=$3,completed_at=clock_timestamp() WHERE artifact_id=$1',
        [r.artifact_id, checked.verdict, scanId],
      );
      if (!(await this.active(c, r)))
        throw new IngestionError(
          409,
          'source_revoked',
          'Source authorization changed during inspection.',
        );
      return { id: scanId, status: checked.verdict, duplicate: false };
    });
  }
  async retry(claim: InspectionClaim, delaySeconds = 30): Promise<void> {
    this.require('inspector');
    if (!Number.isSafeInteger(delaySeconds) || delaySeconds < 1 || delaySeconds > 3600)
      throw new IngestionError(
        400,
        'invalid_retry',
        'Retry delay must be between one and 3600 seconds.',
      );
    return this.tx(async (c) => {
      const { r, j } = await this.lockedClaim(c, claim);
      if (
        j.status !== 'quarantined' ||
        !j.lease_expires_at ||
        j.lease_expires_at.getTime() <= Date.now()
      )
        throw new IngestionError(
          409,
          'stale_inspection',
          'The inspection lease expired or completed.',
        );
      await c.query(
        "UPDATE margin_ingestion.inspection_jobs SET claim_id=NULL,token_digest=NULL,lease_expires_at=NULL,next_attempt_at=statement_timestamp()+$2*interval '1 second' WHERE artifact_id=$1",
        [r.artifact_id, delaySeconds],
      );
    });
  }
  /** Trusted worker/control-plane revocation; immutable decisions are never rewritten into ready. */
  async revoke(artifactId: string): Promise<void> {
    this.require('inspector');
    await this.tx(async (c) => {
      await c.query(
        'UPDATE margin_ingestion.artifacts SET revoked_at=COALESCE(revoked_at,clock_timestamp()) WHERE artifact_id=$1',
        [id(artifactId)],
      );
    });
  }
  private async ready(c: PoolClient, r: Row): Promise<ReadyManifest | null> {
    if (!(await this.active(c, r))) return null;
    const j = (
      await c.query<Job>('SELECT * FROM margin_ingestion.inspection_jobs WHERE artifact_id=$1', [
        r.artifact_id,
      ])
    ).rows[0];
    if (j?.status !== 'ready' || !j.scan_receipt_id) return null;
    const stored = (
        await c.query<Envelope>(
          'SELECT * FROM margin_ingestion.storage_receipts WHERE artifact_id=$1',
          [r.artifact_id],
        )
      ).rows[0],
      scan = (
        await c.query<ScanRow>('SELECT * FROM margin_ingestion.inspection_receipts WHERE id=$1', [
          j.scan_receipt_id,
        ])
      ).rows[0];
    if (
      !scan ||
      scan.verdict !== 'ready' ||
      scan.claim_id !== j.claim_id ||
      scan.attempt !== j.attempt
    )
      throw new IngestionError(
        503,
        'ingestion_integrity',
        'The inspection decision does not match its job.',
      );
    const expected = reservation(await this.open<PrivateReservation>('reservation', r, r)),
      object = receipt(await this.open<ArtifactReceipt>('storage', r, stored)),
      inspection = await this.open<{
        report: InspectionReport;
        receipt: ArtifactReceipt;
        fingerprint: string;
      }>('inspection', r, scan, scanBinding(scan)),
      decision = report(inspection.report);
    if (
      decision.verdict !== 'ready' ||
      decision.plaintextBytes !== expected.plaintextBytes ||
      decision.plaintextSha256 !== expected.plaintextSha256 ||
      hash(canonical(decision)) !== inspection.fingerprint ||
      canonical(object) !== canonical(inspection.receipt)
    )
      throw new IngestionError(
        503,
        'ingestion_integrity',
        'The inspection does not authenticate this immutable object version.',
      );
    return {
      identity: identity(r),
      receipt: object,
      stateToken: stateToken(r, j, stored, scan),
      source: {
        organizationId: r.organization_id,
        documentId: r.document_id,
        versionId: r.version_id,
        ownerId: r.owner_id,
        artifactId: r.artifact_id,
        artifactVersion: object.objectVersionId,
        sha256: decision.plaintextSha256,
        scanReceiptId: scan.id,
        inspectionStatus: 'ready',
        encrypted: true,
        pageCount: decision.pageCount,
      },
    };
  }
  async readyForTeacher(
    p: SessionPrincipal,
    ref: { documentId: string; versionId: string },
  ): Promise<ReadyManifest | null> {
    return this.teacher(p, async (c) => {
      const r = (
        await c.query<Row>(
          'SELECT * FROM margin_ingestion.artifacts WHERE document_id=$1 AND version_id=$2',
          [id(ref.documentId), id(ref.versionId)],
        )
      ).rows[0];
      return r ? this.ready(c, r) : null;
    });
  }
  /** Only consume a token produced by authenticated readySnapshot; no remote I/O or key operation. */
  async recheckApproval(
    source: ReadyAssignmentSource,
    expectedStateToken: string,
  ): Promise<boolean> {
    this.require('reader');
    digest(expectedStateToken);
    return this.tx(async (c) => {
      await c.query("SET LOCAL statement_timeout='750ms'");
      for (const [k, v] of [
        ['user_id', source.ownerId],
        ['organization_id', source.organizationId],
        ['document_id', source.documentId],
        ['version_id', source.versionId],
        ['artifact_id', source.artifactId],
      ])
        await ctx(c, k, v);
      const r = await this.row(c, source.artifactId);
      if (!r || !(await this.active(c, r))) return false;
      const j = (
        await c.query<Job>('SELECT * FROM margin_ingestion.inspection_jobs WHERE artifact_id=$1', [
          r.artifact_id,
        ])
      ).rows[0];
      if (j?.status !== 'ready' || j.scan_receipt_id !== source.scanReceiptId) return false;
      const stored = (
        await c.query<Envelope>(
          'SELECT * FROM margin_ingestion.storage_receipts WHERE artifact_id=$1',
          [r.artifact_id],
        )
      ).rows[0];
      const scan = (
        await c.query<ScanRow>('SELECT * FROM margin_ingestion.inspection_receipts WHERE id=$1', [
          j.scan_receipt_id,
        ])
      ).rows[0];
      return !!stored && !!scan && stateToken(r, j, stored, scan) === expectedStateToken;
    });
  }
  async readySnapshot(source: ReadyAssignmentSource): Promise<ReadyManifest | null> {
    this.require('reader');
    return this.tx(async (c) => {
      for (const [k, v] of [
        ['user_id', source.ownerId],
        ['organization_id', source.organizationId],
        ['document_id', source.documentId],
        ['version_id', source.versionId],
        ['artifact_id', source.artifactId],
      ])
        await ctx(c, k, v);
      const r = await this.row(c, source.artifactId);
      if (!r) return null;
      const value = await this.ready(c, r);
      return value && canonical(value.source) === canonical(source) ? value : null;
    });
  }
}
