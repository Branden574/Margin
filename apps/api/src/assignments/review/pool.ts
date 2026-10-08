import { Pool, type PoolClient, type PoolConfig } from 'pg';
import type { SessionPrincipal } from '../../identity/types.js';
import { AssignmentError } from '../types.js';
import { assignmentId } from '../policy.js';
import { fingerprint } from '../submissions/processing/authority.js';
import type { AssignmentRow } from '../work/manifest.js';
export const unavailable = () =>
  new AssignmentError(
    404,
    'review_unavailable',
    'Open this assignment through its current author teacher launch.',
  );
export const interrupted = () =>
  new AssignmentError(409, 'review_cancelled', 'The review request was cancelled.');
export const check = (signal?: AbortSignal) => {
  if (signal?.aborted) throw interrupted();
};
export interface ReviewAuthority {
  assignment: AssignmentRow;
  launch: {
    session_id: string;
    installation_id: string;
    resource_digest: string;
    assignment_id: string;
    user_id: string;
  };
  binding: {
    session_id: string;
    installation_id: string;
    registration_version: number;
    organization_id: string;
    user_id: string;
    course_id: string;
    role: string;
    subject_digest: string;
    course_digest: string;
  };
}
export async function authority(c: PoolClient): Promise<ReviewAuthority> {
  const assignment = (
    await c.query<AssignmentRow>('SELECT * FROM margin_assignments.assignments LIMIT 2')
  ).rows;
  const launch = (
    await c.query<ReviewAuthority['launch']>('SELECT * FROM margin_assignments.launch_bindings')
  ).rows;
  const binding = (
    await c.query<ReviewAuthority['binding']>('SELECT * FROM margin_lms.session_bindings')
  ).rows;
  if (
    assignment.length !== 1 ||
    launch.length !== 1 ||
    binding.length !== 1 ||
    launch[0].assignment_id !== assignment[0].id ||
    binding[0].role !== 'teacher'
  )
    throw unavailable();
  return { assignment: assignment[0], launch: launch[0], binding: binding[0] };
}
export async function lockCurrent(c: PoolClient, expected: ReviewAuthority) {
  const b = expected.binding,
    a = expected.assignment;
  const locks: Array<[string, unknown[]]> = [
    ['SELECT id FROM margin_identity.organizations WHERE id=$1 FOR SHARE', [b.organization_id]],
    ['SELECT id FROM margin_identity.users WHERE id=$1 FOR SHARE', [b.user_id]],
    [
      'SELECT user_id FROM margin_identity.memberships WHERE organization_id=$1 AND user_id=$2 FOR SHARE',
      [b.organization_id, b.user_id],
    ],
    ['SELECT id FROM margin_identity.sessions WHERE id=$1 FOR SHARE', [b.session_id]],
    [
      'SELECT session_id FROM margin_lms.session_bindings WHERE session_id=$1 FOR SHARE',
      [b.session_id],
    ],
    ['SELECT id FROM margin_lms.installations WHERE id=$1 FOR SHARE', [b.installation_id]],
    [
      'SELECT course_id FROM margin_lms.courses WHERE installation_id=$1 AND course_id=$2 FOR SHARE',
      [b.installation_id, b.course_id],
    ],
    [
      'SELECT user_id FROM margin_lms.user_links WHERE installation_id=$1 AND user_id=$2 FOR SHARE',
      [b.installation_id, b.user_id],
    ],
    [
      'SELECT user_id FROM margin_lms.enrollments WHERE installation_id=$1 AND course_id=$2 AND user_id=$3 FOR SHARE',
      [b.installation_id, b.course_id, b.user_id],
    ],
    ['SELECT id FROM margin_assignments.assignments WHERE id=$1 FOR SHARE', [a.id]],
    [
      'SELECT session_id FROM margin_assignments.launch_bindings WHERE session_id=$1 FOR SHARE',
      [b.session_id],
    ],
    [
      'SELECT resource_digest FROM margin_assignments.resource_links WHERE installation_id=$1 AND resource_digest=$2 FOR SHARE',
      [b.installation_id, expected.launch.resource_digest],
    ],
  ];
  for (const [sql, values] of locks)
    if (!(await c.query(sql, values)).rowCount) throw unavailable();
  if (fingerprint(await authority(c)) !== fingerprint(expected)) throw unavailable();
}
export class ReviewPool {
  private readonly pool: Pool;
  constructor(options: PoolConfig) {
    const socket =
      process.env.NODE_ENV === 'test' && options.host?.startsWith('/') && !options.connectionString;
    if (
      process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0' ||
      (!socket &&
        (!options.ssl ||
          (typeof options.ssl === 'object' && options.ssl.rejectUnauthorized === false)))
    )
      throw Error('Submission review requires verified PostgreSQL TLS.');
    if (
      options.connectionString &&
      [...new URL(options.connectionString).searchParams.keys()].some((k) => k.startsWith('ssl'))
    )
      throw Error('Configure verified PostgreSQL TLS separately.');
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
  async transaction<T>(
    p: SessionPrincipal,
    fn: (c: PoolClient) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    check(signal);
    if (p.authenticationMethod !== 'lti' || p.role !== 'teacher') throw unavailable();
    for (const id of [p.sessionId, p.userId, p.organizationId]) assignmentId(id);
    const c = await this.pool.connect();
    let discard = false;
    try {
      await c.query('BEGIN ISOLATION LEVEL READ COMMITTED');
      await c.query("SET LOCAL lock_timeout='2s'");
      const guard = (
        await c.query<{ unsafe: boolean }>(
          `SELECT (r.rolsuper OR r.rolbypassrls OR r.rolcreatedb OR r.rolcreaterole OR NOT pg_has_role(current_user,'margin_submission_reviewer','MEMBER') OR EXISTS(SELECT 1 FROM pg_roles p WHERE p.rolname IN ('margin_identity_runtime','margin_identity_provisioner','margin_sync_runtime','margin_sync_provisioner','margin_lms_runtime','margin_lms_provisioner','margin_assignments_runtime','margin_assignment_work_runtime','margin_assignment_provisioner','margin_submission_runtime','margin_submission_retention_guard','margin_submission_processor','margin_ingestion_runtime','margin_ingestion_inspector','margin_ingestion_reader') AND pg_has_role(current_user,p.oid,'MEMBER')) OR EXISTS(SELECT 1 FROM pg_class t JOIN pg_namespace n ON n.oid=t.relnamespace WHERE n.nspname IN ('margin_identity','margin_lms','margin_sync','margin_ingestion','margin_assignments','margin_work','margin_submissions','margin_review') AND pg_has_role(current_user,t.relowner,'MEMBER'))) AS unsafe FROM pg_roles r WHERE r.rolname=current_user`,
        )
      ).rows[0];
      if (!guard || guard.unsafe)
        throw Error('Submission review requires dedicated least-privilege credentials.');
      for (const [k, v] of [
        ['session_id', p.sessionId],
        ['user_id', p.userId],
        ['organization_id', p.organizationId],
      ])
        await c.query('SELECT set_config($1,$2,true)', ['margin_review.' + k, v]);
      const active = async () => {
        check(signal);
        if (
          !(await c.query<{ active: boolean }>('SELECT margin_review.request_active() AS active'))
            .rows[0]?.active
        )
          throw unavailable();
      };
      await active();
      const result = await fn(c);
      await active();
      await c.query('COMMIT');
      check(signal);
      return result;
    } catch (error) {
      try {
        await c.query('ROLLBACK');
      } catch {
        discard = true;
      }
      throw error;
    } finally {
      c.release(discard);
    }
  }
}
