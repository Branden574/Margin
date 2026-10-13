import { Pool, type PoolClient, type PoolConfig } from 'pg';
import type { SessionPrincipal } from '../../identity/types.js';
import { AssignmentError } from '../types.js';
import { feedbackId } from './validation.js';
export const unavailable = () =>
  new AssignmentError(
    404,
    'feedback_unavailable',
    'Open this submission through its current assignment launch.',
  );
export const check = (signal?: AbortSignal) => {
  if (signal?.aborted)
    throw new AssignmentError(
      409,
      'feedback_cancelled',
      'The feedback request was interrupted. Check the same request before retrying.',
    );
};
export class FeedbackPool {
  private readonly pool: Pool;
  constructor(config: PoolConfig) {
    const socket =
      process.env.NODE_ENV === 'test' && config.host?.startsWith('/') && !config.connectionString;
    if (
      process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0' ||
      (!socket &&
        (!config.ssl ||
          (typeof config.ssl === 'object' && config.ssl.rejectUnauthorized === false))) ||
      (config.connectionString &&
        [...new URL(config.connectionString).searchParams.keys()].some((k) => k.startsWith('ssl')))
    )
      throw Error('Feedback requires separately configured verified PostgreSQL TLS.');
    this.pool = new Pool({
      ...config,
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
    if (p.authenticationMethod !== 'lti' || !['teacher', 'student'].includes(p.role))
      throw unavailable();
    for (const id of [p.organizationId, p.userId, p.sessionId]) feedbackId(id);
    const c = await this.pool.connect();
    let discard = false;
    try {
      await c.query('BEGIN ISOLATION LEVEL READ COMMITTED');
      await c.query("SET LOCAL synchronous_commit='on'");
      await c.query("SET LOCAL lock_timeout='2s'");
      const guard = (
        await c.query<{ unsafe: boolean }>(
          `SELECT (current_setting('fsync')<>'on' OR current_setting('full_page_writes')<>'on' OR r.rolsuper OR r.rolbypassrls OR r.rolcreatedb OR r.rolcreaterole OR NOT pg_has_role(current_user,'margin_feedback_runtime','MEMBER') OR EXISTS(SELECT 1 FROM pg_roles p WHERE p.rolname LIKE 'margin\\_%' ESCAPE '\\' AND p.rolname<>'margin_feedback_runtime' AND p.oid<>current_user::regrole AND pg_has_role(current_user,p.oid,'MEMBER')) OR EXISTS(SELECT 1 FROM pg_class t JOIN pg_namespace n ON n.oid=t.relnamespace WHERE n.nspname LIKE 'margin\\_%' ESCAPE '\\' AND pg_has_role(current_user,t.relowner,'MEMBER'))) AS unsafe FROM pg_roles r WHERE r.rolname=current_user`,
        )
      ).rows[0];
      if (!guard || guard.unsafe)
        throw Error(
          'Feedback requires dedicated least-privilege credentials and durable PostgreSQL settings.',
        );
      for (const ns of ['margin_feedback', 'margin_review', 'margin_work']) {
        for (const [k, v] of [
          ['session_id', p.sessionId],
          ['user_id', p.userId],
          ['organization_id', p.organizationId],
          ['role', p.role],
        ])
          await c.query('SELECT set_config($1,$2,true)', [ns + '.' + k, v]);
      }
      const active = async () => {
        check(signal);
        const q =
          p.role === 'teacher' ? 'margin_review.request_active()' : 'margin_work.request_active()';
        if (!(await c.query<{ active: boolean }>('SELECT ' + q + ' AS active')).rows[0]?.active)
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
