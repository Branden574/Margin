import { Pool, type PoolConfig, type PoolClient } from 'pg';
import type { SessionPrincipal } from '../identity/types.js';
import { identifier } from './validation.js';
import { SyncError } from './types.js';
export class SyncPool {
  private readonly pool: Pool;
  constructor(
    options: PoolConfig,
    private readonly mode: 'runtime' | 'provisioner',
  ) {
    const socket =
      process.env.NODE_ENV === 'test' && options.host?.startsWith('/') && !options.connectionString;
    if (
      process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0' ||
      (!socket &&
        (!options.ssl ||
          (typeof options.ssl === 'object' && options.ssl.rejectUnauthorized === false)))
    )
      throw new Error('Document sync requires certificate-verified PostgreSQL TLS.');
    if (
      options.connectionString &&
      [...new URL(options.connectionString).searchParams.keys()].some((key) =>
        key.startsWith('ssl'),
      )
    )
      throw new Error('Use explicit verified PostgreSQL ssl configuration.');
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
    principal: SessionPrincipal | undefined,
    run: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    const client = await this.pool.connect();
    let discard = false;
    try {
      await client.query('BEGIN');
      await client.query("SET LOCAL statement_timeout='5s'");
      await client.query("SET LOCAL synchronous_commit='on'");
      await client.query("SET LOCAL lock_timeout='2s'");
      await client.query("SET LOCAL idle_in_transaction_session_timeout='5s'");
      const role = await client.query<{
        unsafe: boolean;
        allowed: boolean;
        provisioner: boolean;
        identity_admin: boolean;
        identity_runtime: boolean;
        runtime: boolean;
      }>(
        "SELECT (current_setting('fsync')<>'on' OR current_setting('full_page_writes')<>'on' OR r.rolsuper OR r.rolbypassrls OR r.rolcreaterole OR r.rolcreatedb OR EXISTS(SELECT 1 FROM pg_roles p WHERE p.rolname='margin_assignment_provisioner' AND pg_has_role(current_user,p.oid,'MEMBER')) OR EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname IN ('margin_sync','margin_identity','margin_work') AND pg_has_role(current_user,c.relowner,'MEMBER'))) AS unsafe,pg_has_role(current_user,$1,'MEMBER') AS allowed,pg_has_role(current_user,'margin_sync_provisioner','MEMBER') AS provisioner,pg_has_role(current_user,'margin_identity_provisioner','MEMBER') AS identity_admin,pg_has_role(current_user,'margin_identity_runtime','MEMBER') AS identity_runtime,pg_has_role(current_user,'margin_sync_runtime','MEMBER') AS runtime FROM pg_roles r WHERE r.rolname=current_user",
        [this.mode === 'runtime' ? 'margin_sync_runtime' : 'margin_sync_provisioner'],
      );
      const row = role.rows[0];
      if (
        !row ||
        row.unsafe ||
        !row.allowed ||
        row.identity_runtime ||
        (this.mode === 'runtime' && (row.provisioner || row.identity_admin)) ||
        (this.mode === 'provisioner' && row.runtime)
      )
        throw new Error(
          'Document sync requires its dedicated restricted database role and durable PostgreSQL settings.',
        );
      if (principal)
        for (const [name, value] of [
          ['user_id', principal.userId],
          ['organization_id', principal.organizationId],
          ['session_id', principal.sessionId],
        ])
          await client.query('SELECT set_config($1,$2,true)', [
            `margin_sync.${name}`,
            identifier(value),
          ]);
      if (principal) {
        const method = principal.authenticationMethod ?? 'oidc';
        if (method !== 'oidc' && method !== 'lti')
          throw new Error('Invalid session authentication method.');
        await client.query("SELECT set_config('margin_sync.authentication_method',$1,true)", [
          method,
        ]);
      }
      const result = await run(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch {
        discard = true;
      }
      const code = (error as { code?: string }).code;
      if (code === '55P03' || code === '57014')
        throw new SyncError(
          503,
          'sync_busy',
          'Synchronization is busy. Keep this edit locally and retry with the same operation identifier.',
        );
      throw error;
    } finally {
      client.release(discard);
    }
  }
}
