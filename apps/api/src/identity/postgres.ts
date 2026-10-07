import { Pool, type PoolClient, type PoolConfig } from 'pg';
import type {
  IdentityRepository,
  IdentityRole,
  NewSession,
  ProvisionedIdentity,
  SessionPrincipal,
  SessionSummary,
} from './types.js';

interface SessionRow {
  id: string;
  user_id: string;
  organization_id: string;
  mfa: boolean;
  authentication_method: 'oidc' | 'lti';
  created_at: Date;
  expires_at: Date;
  last_seen_at: Date;
  idle_expires_at: Date;
}
type ContextName = 'user_id' | 'identity_key' | 'session_hash' | 'login_hash';
const context = (client: PoolClient, name: ContextName, value: string) =>
  client.query('SELECT set_config($1, $2, true)', [`margin_identity.${name}`, value]);

/** Owns a bounded TLS-only pool. Test-only Unix sockets cannot be enabled in a production process. */
export class PostgresIdentityRepository implements IdentityRepository {
  private readonly pool: Pool;
  constructor(options: PoolConfig) {
    const testSocket =
      process.env.NODE_ENV === 'test' && options.host?.startsWith('/') && !options.connectionString;
    if (
      !testSocket &&
      (!options.ssl ||
        (typeof options.ssl === 'object' && options.ssl.rejectUnauthorized === false))
    )
      throw new Error('Identity PostgreSQL connections require certificate-verified TLS.');
    if (
      options.connectionString &&
      [...new URL(options.connectionString).searchParams.keys()].some((key) =>
        key.startsWith('ssl'),
      )
    )
      throw new Error(
        'Set verified PostgreSQL TLS through ssl configuration, not connection-string overrides.',
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
  close() {
    return this.pool.end();
  }
  private async transaction<T>(run: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    let discard = false;
    try {
      await client.query('BEGIN');
      await client.query("SET LOCAL statement_timeout = '5s'");
      await client.query("SET LOCAL lock_timeout = '1s'");
      await client.query("SET LOCAL idle_in_transaction_session_timeout = '5s'");
      const privileges = await client.query<{ unsafe: boolean }>(
        "SELECT (r.rolsuper OR r.rolbypassrls OR pg_has_role(current_user,'margin_identity_provisioner','MEMBER') OR EXISTS(SELECT 1 FROM pg_roles p WHERE p.rolname IN ('margin_assignment_provisioner','margin_assignment_work_runtime','margin_submission_runtime','margin_submission_retention_guard') AND pg_has_role(current_user,p.oid,'MEMBER')) OR EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname IN ('margin_identity','margin_work','margin_submissions') AND pg_has_role(current_user,c.relowner,'MEMBER'))) AS unsafe FROM pg_roles r WHERE r.rolname=current_user",
      );
      if (!privileges.rows[0] || privileges.rows[0].unsafe)
        throw new Error(
          'Identity runtime must not be a superuser, BYPASSRLS role, provisioning role, mixed application role, or identity table owner.',
        );
      const result = await run(client);
      await client.query('COMMIT');
      return result;
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
  async reserveLogin(stateHash: string, expiresAt: number): Promise<void> {
    await this.transaction(async (client) => {
      await context(client, 'login_hash', stateHash);
      await client.query(
        'INSERT INTO margin_identity.login_attempts(state_hash, expires_at) VALUES($1, $2)',
        [stateHash, new Date(expiresAt)],
      );
    });
  }
  async consumeLogin(stateHash: string, now: number): Promise<boolean> {
    return this.transaction(async (client) => {
      await context(client, 'login_hash', stateHash);
      const result = await client.query(
        'UPDATE margin_identity.login_attempts SET consumed_at=$2 WHERE state_hash=$1 AND consumed_at IS NULL AND expires_at>$2 RETURNING state_hash',
        [stateHash, new Date(now)],
      );
      return result.rowCount === 1;
    });
  }
  async findIdentity(identityKey: string): Promise<ProvisionedIdentity | null> {
    return this.transaction(async (client) => {
      await context(client, 'identity_key', identityKey);
      const users = await client.query<{ id: string }>(
        'SELECT id FROM margin_identity.users WHERE identity_key=$1 AND disabled_at IS NULL',
        [identityKey],
      );
      const userId = users.rows[0]?.id;
      if (!userId) return null;
      await context(client, 'user_id', userId);
      const memberships = await client.query<{ organizationId: string; role: IdentityRole }>(
        'SELECT m.organization_id AS "organizationId", m.role FROM margin_identity.memberships m JOIN margin_identity.organizations o ON o.id=m.organization_id WHERE m.user_id=$1 AND m.revoked_at IS NULL AND o.disabled_at IS NULL ORDER BY m.organization_id LIMIT 101',
        [userId],
      );
      if (memberships.rows.length > 100) throw new Error('Identity membership limit exceeded.');
      return { userId, memberships: memberships.rows };
    });
  }
  private async activeMembership(
    client: PoolClient,
    userId: string,
    organizationId: string,
  ): Promise<IdentityRole | undefined> {
    const result = await client.query<{ role: IdentityRole }>(
      'SELECT m.role FROM margin_identity.memberships m JOIN margin_identity.users u ON u.id=m.user_id JOIN margin_identity.organizations o ON o.id=m.organization_id WHERE m.user_id=$1 AND m.organization_id=$2 AND m.revoked_at IS NULL AND u.disabled_at IS NULL AND o.disabled_at IS NULL',
      [userId, organizationId],
    );
    return result.rows[0]?.role;
  }
  async createSession(session: NewSession, previousSessionHash?: string): Promise<void> {
    await this.transaction(async (client) => {
      await context(client, 'user_id', session.userId);
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [session.userId]);
      if (
        (await this.activeMembership(client, session.userId, session.organizationId)) !==
        session.role
      )
        throw new Error('Workspace membership changed during sign-in.');
      if (previousSessionHash) {
        await context(client, 'session_hash', previousSessionHash);
        await client.query(
          'UPDATE margin_identity.sessions SET revoked_at=$2 WHERE session_hash=$1 AND revoked_at IS NULL',
          [previousSessionHash, new Date(session.createdAt)],
        );
      }
      await context(client, 'session_hash', session.sessionHash);
      await client.query(
        'INSERT INTO margin_identity.sessions(id, session_hash, user_id, organization_id, mfa, created_at, expires_at, idle_expires_at, last_seen_at, authentication_method) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$6,$9)',
        [
          session.sessionId,
          session.sessionHash,
          session.userId,
          session.organizationId,
          session.mfa,
          new Date(session.createdAt),
          new Date(session.expiresAt),
          new Date(session.idleExpiresAt),
          session.authenticationMethod ?? 'oidc',
        ],
      );
      // At most ten live sessions per account; old receipts remain available for the retention job.
      await client.query(
        'UPDATE margin_identity.sessions SET revoked_at=$2 WHERE id IN (SELECT id FROM margin_identity.sessions WHERE user_id=$1 AND revoked_at IS NULL AND expires_at>$2 ORDER BY created_at DESC, id DESC OFFSET 10)',
        [session.userId, new Date(session.createdAt)],
      );
    });
  }
  private async liveSession(
    client: PoolClient,
    hash: string,
    now: number,
  ): Promise<SessionRow | undefined> {
    await context(client, 'session_hash', hash);
    const result = await client.query<SessionRow>(
      'SELECT id,user_id,organization_id,mfa,authentication_method,created_at,expires_at,idle_expires_at,last_seen_at FROM margin_identity.sessions WHERE session_hash=$1 AND revoked_at IS NULL AND expires_at>$2 AND idle_expires_at>$2',
      [hash, new Date(now)],
    );
    const session = result.rows[0];
    if (session) await context(client, 'user_id', session.user_id);
    return session;
  }
  async authenticate(
    sessionHash: string,
    now: number,
    idleTimeoutMs: number,
  ): Promise<SessionPrincipal | null> {
    return this.transaction(async (client) => {
      const session = await this.liveSession(client, sessionHash, now);
      if (!session) return null;
      const role = await this.activeMembership(client, session.user_id, session.organization_id);
      if (!role) return null;
      const touched = await client.query(
        'UPDATE margin_identity.sessions SET last_seen_at=$2, idle_expires_at=LEAST(expires_at,$3) WHERE id=$1 AND revoked_at IS NULL RETURNING id',
        [session.id, new Date(now), new Date(now + idleTimeoutMs)],
      );
      if (touched.rowCount !== 1) return null;
      return {
        sessionId: session.id,
        userId: session.user_id,
        organizationId: session.organization_id,
        role,
        mfa: session.mfa,
        authenticationMethod: session.authentication_method,
        createdAt: session.created_at.getTime(),
        expiresAt: session.expires_at.getTime(),
        lastSeenAt: now,
      };
    });
  }
  async revokeSession(sessionHash: string, now: number): Promise<void> {
    await this.transaction(async (client) => {
      await context(client, 'session_hash', sessionHash);
      await client.query(
        'UPDATE margin_identity.sessions SET revoked_at=$2 WHERE session_hash=$1 AND revoked_at IS NULL',
        [sessionHash, new Date(now)],
      );
    });
  }
  async listSessions(sessionHash: string, now: number): Promise<SessionSummary[]> {
    return this.transaction(async (client) => {
      const session = await this.liveSession(client, sessionHash, now);
      if (
        !session ||
        !(await this.activeMembership(client, session.user_id, session.organization_id))
      )
        return [];
      const result = await client.query<SessionRow>(
        'SELECT id,organization_id,created_at,expires_at,last_seen_at FROM margin_identity.sessions WHERE user_id=$1 AND revoked_at IS NULL AND expires_at>$2 AND idle_expires_at>$2 ORDER BY created_at DESC LIMIT 10',
        [session.user_id, new Date(now)],
      );
      return result.rows.map((row) => ({
        sessionId: row.id,
        organizationId: row.organization_id,
        createdAt: row.created_at.getTime(),
        expiresAt: row.expires_at.getTime(),
        lastSeenAt: row.last_seen_at.getTime(),
        current: row.id === session.id,
      }));
    });
  }
  async revokeOwnedSession(
    sessionHash: string,
    targetSessionId: string,
    now: number,
  ): Promise<boolean> {
    return this.transaction(async (client) => {
      const session = await this.liveSession(client, sessionHash, now);
      if (
        !session ||
        !(await this.activeMembership(client, session.user_id, session.organization_id))
      )
        return false;
      const result = await client.query(
        'UPDATE margin_identity.sessions SET revoked_at=$3 WHERE id=$1 AND user_id=$2 AND revoked_at IS NULL RETURNING id',
        [targetSessionId, session.user_id, new Date(now)],
      );
      return result.rowCount === 1;
    });
  }
}
