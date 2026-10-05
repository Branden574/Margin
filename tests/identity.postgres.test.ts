import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import {
  PostgresIdentityRepository,
  identityLookupKey,
  type NewSession,
} from '../apps/api/src/identity/index';
import { tokenHash } from '../apps/api/src/identity/crypto';
import { withTableOwnerMembership } from './helpers/owner-role';
import { withAssignmentProvisionerMembership } from './helpers/provisioner-role';
import { stopDisposablePostgres } from './helpers/postgres';

// Actual SQL/RLS integration in a disposable Unix-socket-only cluster. Never touches a running DB.
const available = ['initdb', 'pg_ctl', 'psql'].every((tool) => {
  try {
    execFileSync(tool, ['--version'], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
});
if (process.env.MARGIN_REQUIRE_POSTGRES_TESTS === '1' && !available)
  throw new Error(
    'PostgreSQL identity integration tests are required, but initdb, pg_ctl or psql is unavailable.',
  );
let directory: string;
let admin: Pool;
let runtime: Pool;
let provisioner: Pool;
let repository: PostgresIdentityRepository;
let started = false;
const userA = randomUUID(),
  userB = randomUUID(),
  orgA = randomUUID(),
  orgB = randomUUID();
const lookupKey = Buffer.alloc(32, 19);
const identityA = identityLookupKey(lookupKey, 'https://synthetic-idp.test', 'synthetic-student-a');
const identityB = identityLookupKey(lookupKey, 'https://synthetic-idp.test', 'synthetic-student-b');
function session(
  userId = userA,
  organizationId = orgA,
  overrides: Partial<NewSession> = {},
): NewSession {
  const now = Date.now();
  return {
    sessionId: randomUUID(),
    sessionHash: tokenHash(randomUUID()),
    userId,
    organizationId,
    role: 'student',
    mfa: false,
    createdAt: now,
    expiresAt: now + 3600000,
    idleExpiresAt: now + 600000,
    lastSeenAt: now,
    ...overrides,
  };
}
describe.skipIf(!available)('identity PostgreSQL repository and enforced RLS', () => {
  beforeAll(async () => {
    directory = mkdtempSync(join(tmpdir(), 'margin-identity-pg-'));
    const socket = join(directory, 'socket');
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
        join(directory, 'postgres.log'),
        '-o',
        `-F -k ${socket} -h '' -p 55489`,
        '-w',
        'start',
      ],
      { stdio: 'pipe' },
    );
    started = true;
    admin = new Pool({ host: socket, port: 55489, user: 'postgres', database: 'postgres' });
    await admin.query(
      readFileSync(new URL('../infra/migrations/001-identity.sql', import.meta.url), 'utf8'),
    );
    await admin.query(
      'CREATE ROLE margin_identity_test LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS; GRANT margin_identity_runtime TO margin_identity_test',
    );
    await admin.query(
      'CREATE ROLE margin_identity_provision_test LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS; GRANT margin_identity_provisioner TO margin_identity_provision_test',
    );
    provisioner = new Pool({
      host: socket,
      port: 55489,
      user: 'margin_identity_provision_test',
      database: 'postgres',
    });
    await provisioner.query(
      'INSERT INTO margin_identity.users(id,identity_key) VALUES($1,$2),($3,$4)',
      [userA, identityA, userB, identityB],
    );
    await provisioner.query('INSERT INTO margin_identity.organizations(id) VALUES($1),($2)', [
      orgA,
      orgB,
    ]);
    await provisioner.query(
      "INSERT INTO margin_identity.memberships(organization_id,user_id,role) VALUES($1,$2,'student'),($3,$4,'student')",
      [orgA, userA, orgB, userB],
    );
    const config = {
      host: socket,
      port: 55489,
      user: 'margin_identity_test',
      database: 'postgres',
    };
    runtime = new Pool(config);
    repository = new PostgresIdentityRepository(config);
  }, 30000);
  afterAll(async () => {
    await Promise.all([repository?.close(), runtime?.end(), provisioner?.end(), admin?.end()]);
    if (started) await stopDisposablePostgres(join(directory, 'data'));
    if (directory) rmSync(directory, { recursive: true, force: true });
  });
  it('resolves only a provisioned identity and denies missing context, cross-user reads and role escalation', async () => {
    expect(await repository.findIdentity(identityA)).toEqual({
      userId: userA,
      memberships: [{ organizationId: orgA, role: 'student' }],
    });
    expect(await repository.findIdentity(tokenHash('unknown'))).toBeNull();
    expect((await runtime.query('SELECT * FROM margin_identity.users')).rowCount).toBe(0);
    const client = await runtime.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('margin_identity.user_id',$1,true)", [userA]);
      expect((await client.query('SELECT id FROM margin_identity.users')).rows).toEqual([
        { id: userA },
      ]);
      expect((await client.query('SELECT id FROM margin_identity.organizations')).rows).toEqual([
        { id: orgA },
      ]);
      expect(
        (await client.query('SELECT * FROM margin_identity.memberships WHERE user_id=$1', [userB]))
          .rowCount,
      ).toBe(0);
      await expect(
        client.query("UPDATE margin_identity.memberships SET role='owner' WHERE user_id=$1", [
          userA,
        ]),
      ).rejects.toMatchObject({ code: '42501' });
      await client.query('ROLLBACK');
      expect((await client.query('SELECT * FROM margin_identity.users')).rowCount).toBe(0);
    } finally {
      client.release();
    }
  });
  it('consumes login receipts once even with concurrent callbacks and never persists PKCE or OAuth tokens', async () => {
    const hash = tokenHash(randomUUID());
    await repository.reserveLogin(hash, Date.now() + 60000);
    const results = await Promise.all([
      repository.consumeLogin(hash, Date.now()),
      repository.consumeLogin(hash, Date.now()),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await repository.consumeLogin(tokenHash('missing'), Date.now())).toBe(false);
    const columns = (
      await admin.query(
        "SELECT column_name FROM information_schema.columns WHERE table_schema='margin_identity' AND table_name IN ('login_attempts','sessions')",
      )
    ).rows.map((r) => r.column_name);
    expect(columns).not.toContain('refresh_token');
    expect(columns).not.toContain('access_token');
    expect(columns).not.toContain('code_verifier');
  });
  it('rechecks current membership, organization status, role changes and session revocation on every authentication', async () => {
    const s = session();
    await repository.createSession(s);
    expect((await repository.authenticate(s.sessionHash, Date.now(), 600000))?.role).toBe(
      'student',
    );
    await admin.query("UPDATE margin_identity.memberships SET role='teacher' WHERE user_id=$1", [
      userA,
    ]);
    expect((await repository.authenticate(s.sessionHash, Date.now(), 600000))?.role).toBe(
      'teacher',
    );
    await admin.query('UPDATE margin_identity.memberships SET revoked_at=now() WHERE user_id=$1', [
      userA,
    ]);
    expect(await repository.authenticate(s.sessionHash, Date.now(), 600000)).toBeNull();
    await admin.query(
      "UPDATE margin_identity.memberships SET revoked_at=NULL,role='student' WHERE user_id=$1",
      [userA],
    );
    await admin.query('UPDATE margin_identity.organizations SET disabled_at=now() WHERE id=$1', [
      orgA,
    ]);
    expect(await repository.authenticate(s.sessionHash, Date.now(), 600000)).toBeNull();
    await admin.query('UPDATE margin_identity.organizations SET disabled_at=NULL WHERE id=$1', [
      orgA,
    ]);
    await admin.query('UPDATE margin_identity.users SET disabled_at=now() WHERE id=$1', [userA]);
    expect(await repository.authenticate(s.sessionHash, Date.now(), 600000)).toBeNull();
    await admin.query('UPDATE margin_identity.users SET disabled_at=NULL WHERE id=$1', [userA]);
    await repository.revokeSession(s.sessionHash, Date.now());
    expect(await repository.authenticate(s.sessionHash, Date.now(), 600000)).toBeNull();
  });
  it('isolates session listings and revocation and does not permit changing session identity fields', async () => {
    const a = session(),
      b = session(userB, orgB);
    await repository.createSession(a);
    await repository.createSession(b);
    expect(
      (await repository.listSessions(a.sessionHash, Date.now())).every(
        (row) => row.organizationId === orgA,
      ),
    ).toBe(true);
    expect(await repository.revokeOwnedSession(a.sessionHash, b.sessionId, Date.now())).toBe(false);
    expect(await repository.authenticate(b.sessionHash, Date.now(), 600000)).not.toBeNull();
    await expect(
      runtime.query('UPDATE margin_identity.sessions SET user_id=$1 WHERE id=$2', [
        userA,
        b.sessionId,
      ]),
    ).rejects.toMatchObject({ code: '42501' });
    expect(await repository.revokeOwnedSession(a.sessionHash, a.sessionId, Date.now())).toBe(true);
    expect(await repository.authenticate(a.sessionHash, Date.now(), 600000)).toBeNull();
  });
  it('rotates sessions atomically, fails closed on expiry, and recovers the pool after a rejected transaction', async () => {
    const previous = session();
    await repository.createSession(previous);
    await expect(
      repository.createSession(session(userA, orgA, { role: 'owner' }), previous.sessionHash),
    ).rejects.toThrow('changed');
    expect(await repository.authenticate(previous.sessionHash, Date.now(), 600000)).not.toBeNull();
    const next = session();
    await repository.createSession(next, previous.sessionHash);
    expect(await repository.authenticate(previous.sessionHash, Date.now(), 600000)).toBeNull();
    expect(await repository.authenticate(next.sessionHash, next.expiresAt + 1, 600000)).toBeNull();
    expect((await repository.findIdentity(identityB))?.userId).toBe(userB);
    const row = (
      await admin.query('SELECT session_hash FROM margin_identity.sessions WHERE id=$1', [
        next.sessionId,
      ])
    ).rows[0];
    expect(row.session_hash).toBe(next.sessionHash);
  });
  it('rejects privileged runtime connections and disables insecure production transport', async () => {
    const provisioningRuntime = new PostgresIdentityRepository({
      host: join(directory, 'socket'),
      port: 55489,
      user: 'margin_identity_provision_test',
      database: 'postgres',
    });
    try {
      await expect(provisioningRuntime.findIdentity(identityA)).rejects.toThrow('must not be');
    } finally {
      await provisioningRuntime.close();
    }
    await expect(
      provisioner.query('SELECT session_hash FROM margin_identity.sessions'),
    ).rejects.toMatchObject({ code: '42501' });
    const unsafe = new PostgresIdentityRepository({
      host: join(directory, 'socket'),
      port: 55489,
      user: 'postgres',
      database: 'postgres',
    });
    try {
      await expect(unsafe.findIdentity(identityA)).rejects.toThrow('must not be a superuser');
    } finally {
      await unsafe.close();
    }
    expect(() => new PostgresIdentityRepository({ host: '127.0.0.1', ssl: false })).toThrow('TLS');
    expect(
      () =>
        new PostgresIdentityRepository({ host: 'db.example', ssl: { rejectUnauthorized: false } }),
    ).toThrow('TLS');
  });
  it.each([true, false])(
    'rejects assignment-provisioner membership with inheritance=%s',
    async (inherit) => {
      await withAssignmentProvisionerMembership(
        admin,
        { host: join(directory, 'socket'), port: 55489, database: 'postgres' },
        'margin_identity_runtime',
        inherit,
        async (config) => {
          const unsafe = new PostgresIdentityRepository(config);
          try {
            await expect(unsafe.findIdentity(identityA)).rejects.toThrow('provisioning role');
          } finally {
            await unsafe.close();
          }
        },
      );
      expect((await repository.findIdentity(identityA))?.userId).toBe(userA);
    },
  );
  it.each([true, false])('rejects table-owner membership with inheritance=%s', async (inherit) => {
    await withTableOwnerMembership(
      admin,
      { host: join(directory, 'socket'), port: 55489, database: 'postgres' },
      'margin_identity.login_attempts',
      'margin_identity_runtime',
      inherit,
      async (config) => {
        const unsafe = new PostgresIdentityRepository(config);
        try {
          await expect(unsafe.findIdentity(identityA)).rejects.toThrow('table owner');
        } finally {
          await unsafe.close();
        }
      },
    );
    expect((await repository.findIdentity(identityA))?.userId).toBe(userA);
  });
  it('cancels a slow database statement and leaves the pool usable after rollback', async () => {
    await admin.query(`CREATE FUNCTION margin_identity.synthetic_slow_login() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(6); RETURN NEW; END $$;
      CREATE TRIGGER synthetic_slow_login BEFORE INSERT ON margin_identity.login_attempts FOR EACH ROW EXECUTE FUNCTION margin_identity.synthetic_slow_login()`);
    try {
      await expect(
        repository.reserveLogin(tokenHash(randomUUID()), Date.now() + 60000),
      ).rejects.toMatchObject({ code: '57014' });
    } finally {
      await admin.query(
        'DROP TRIGGER synthetic_slow_login ON margin_identity.login_attempts; DROP FUNCTION margin_identity.synthetic_slow_login()',
      );
    }
    expect((await repository.findIdentity(identityA))?.userId).toBe(userA);
  }, 10000);
});
