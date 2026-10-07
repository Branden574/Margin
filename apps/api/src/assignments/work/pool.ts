import { Pool, type PoolClient, type PoolConfig } from 'pg';
import type { SessionPrincipal } from '../../identity/types.js';
import { AssignmentError } from '../types.js';
import { assignmentId } from '../policy.js';
export class WorkPool {
  private readonly pool: Pool;
  constructor(
    options: PoolConfig,
    private readonly runtimeRole:
      | 'margin_assignment_work_runtime'
      | 'margin_submission_runtime' = 'margin_assignment_work_runtime',
  ) {
    if (!['margin_assignment_work_runtime', 'margin_submission_runtime'].includes(runtimeRole))
      throw new Error('Unknown assignment runtime role.');
    const socket =
      process.env.NODE_ENV === 'test' && options.host?.startsWith('/') && !options.connectionString;
    if (
      process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0' ||
      (!socket &&
        (!options.ssl ||
          (typeof options.ssl === 'object' && options.ssl.rejectUnauthorized === false)))
    )
      throw new Error('Assignment work requires verified PostgreSQL TLS.');
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
  async transaction<T>(
    p: SessionPrincipal,
    run: (c: PoolClient) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    if (p.authenticationMethod !== 'lti' || p.role !== 'student')
      throw new AssignmentError(
        403,
        'student_launch_required',
        'Open your work from an approved Canvas assignment.',
      );
    for (const v of [p.sessionId, p.userId, p.organizationId]) assignmentId(v);
    const c = await this.pool.connect();
    let discard = false;
    try {
      await c.query(
        this.runtimeRole === 'margin_submission_runtime'
          ? 'BEGIN ISOLATION LEVEL READ COMMITTED'
          : 'BEGIN',
      );
      await c.query("SET LOCAL synchronous_commit='on'");
      await c.query("SET LOCAL lock_timeout='2s'");
      const guard = (
        await c.query<{ unsafe: boolean }>(
          `SELECT (current_setting('fsync')<>'on' OR current_setting('full_page_writes')<>'on' OR r.rolsuper OR r.rolbypassrls OR r.rolcreaterole OR r.rolcreatedb OR NOT pg_has_role(current_user,$1,'MEMBER') OR EXISTS(SELECT 1 FROM pg_roles p WHERE p.rolname IN ('margin_identity_runtime','margin_identity_provisioner','margin_sync_runtime','margin_sync_provisioner','margin_lms_runtime','margin_lms_provisioner','margin_assignments_runtime','margin_ingestion_runtime','margin_ingestion_reader','margin_ingestion_inspector','margin_assignment_provisioner','margin_assignment_work_runtime','margin_submission_runtime','margin_submission_retention_guard') AND p.rolname<>$1 AND pg_has_role(current_user,p.oid,'MEMBER')) OR EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname IN ('margin_identity','margin_lms','margin_assignments','margin_sync','margin_ingestion','margin_work','margin_submissions') AND pg_has_role(current_user,c.relowner,'MEMBER'))) AS unsafe FROM pg_roles r WHERE r.rolname=current_user`,
          [this.runtimeRole],
        )
      ).rows[0];
      if (!guard || guard.unsafe)
        throw new Error(
          'Assignment work requires dedicated least-privilege credentials and durable PostgreSQL settings.',
        );
      for (const [k, v] of [
        ['session_id', p.sessionId],
        ['user_id', p.userId],
        ['organization_id', p.organizationId],
      ])
        await c.query('SELECT set_config($1,$2,true)', ['margin_work.' + k, v]);
      const active = async () => {
        if (signal?.aborted)
          throw new AssignmentError(
            409,
            'work_request_cancelled',
            'The work request was cancelled. Retry with the same operation identifier if its outcome is unknown.',
          );
        if (
          !(await c.query<{ active: boolean }>('SELECT margin_work.request_active() AS active'))
            .rows[0]?.active
        )
          throw new AssignmentError(
            403,
            'work_access_denied',
            'This Canvas launch no longer grants access to the work.',
          );
      };
      await active();
      const result = await run(c);
      await active();
      await c.query('COMMIT');
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
