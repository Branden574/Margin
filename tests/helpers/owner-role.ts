import { randomUUID } from 'node:crypto';
import { Pool, type PoolConfig } from 'pg';
import { expect } from 'vitest';

/** Real ownership escalation fixture, confined to the caller's disposable PostgreSQL cluster. */
export async function withTableOwnerMembership(
  admin: Pool,
  config: PoolConfig,
  table: string,
  runtimeGroup: string,
  inherit: boolean,
  check: (unsafe: PoolConfig) => Promise<void>,
) {
  if (!/^margin_[a-z_]+\.[a-z_]+$/.test(table) || !/^margin_[a-z_]+$/.test(runtimeGroup))
    throw new Error('Use a fixed application table and runtime role in this fixture.');
  const suffix = randomUUID().replaceAll('-', '');
  const owner = `test_owner_${suffix}`;
  const login = `test_login_${suffix}`;
  const previous = (
    await admin.query<{ owner: string }>(
      'SELECT pg_get_userbyid(relowner) AS owner FROM pg_class WHERE oid=$1::regclass',
      [table],
    )
  ).rows[0].owner;
  const quote = (value: string) => '"' + value.replaceAll('"', '""') + '"';
  await admin.query(`CREATE ROLE ${owner} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
    CREATE ROLE ${login} LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
    GRANT ${runtimeGroup} TO ${login} WITH INHERIT TRUE;
    GRANT ${owner} TO ${login} WITH INHERIT ${inherit ? 'TRUE' : 'FALSE'}, SET TRUE;
    ALTER TABLE ${table} OWNER TO ${owner}`);
  const unsafe = { ...config, user: login };
  const probe = new Pool(unsafe);
  try {
    const privileges = (
      await probe.query<{ member: boolean; inherited: boolean; can_set: boolean }>(
        "SELECT pg_has_role(current_user,$1,'MEMBER') AS member, pg_has_role(current_user,$1,'USAGE') AS inherited, pg_has_role(current_user,$1,'SET') AS can_set",
        [owner],
      )
    ).rows[0];
    expect(privileges).toEqual({ member: true, inherited: inherit, can_set: true });
    const client = await probe.connect();
    try {
      await client.query(`SET ROLE ${owner}`);
      expect((await client.query<{ current_user: string }>('SELECT current_user')).rows[0]).toEqual(
        { current_user: owner },
      );
      await client.query('RESET ROLE');
    } finally {
      client.release();
    }
    await check(unsafe);
  } finally {
    await probe.end();
    await admin.query(`ALTER TABLE ${table} OWNER TO ${quote(previous)};
      DROP ROLE ${login}; DROP ROLE ${owner}`);
  }
}
