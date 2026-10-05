import { randomUUID } from 'node:crypto';
import { Pool, type PoolConfig } from 'pg';
import { expect } from 'vitest';

/** Verifies actual inherited and SET ROLE capability only inside a disposable test cluster. */
export async function withAssignmentProvisionerMembership(
  admin: Pool,
  config: PoolConfig,
  runtimeGroup: string,
  inherit: boolean,
  check: (unsafe: PoolConfig) => Promise<void>,
) {
  if (!/^margin_[a-z_]+$/.test(runtimeGroup))
    throw new Error('Use a fixed application runtime role in this fixture.');
  const privileged = 'margin_assignment_provisioner';
  const login = `test_assignment_member_${randomUUID().replaceAll('-', '')}`;
  const present = (await admin.query('SELECT 1 FROM pg_roles WHERE rolname=$1', [privileged]))
    .rowCount;
  // Older identity/LMS/sync fixtures deliberately apply only their own migrations.
  // An empty role is sufficient to exercise the guard; retain the real role when 006 exists.
  if (!present)
    await admin.query(
      `CREATE ROLE ${privileged} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS`,
    );
  await admin.query(`CREATE ROLE ${login} LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
    GRANT ${runtimeGroup} TO ${login} WITH INHERIT TRUE;
    GRANT ${privileged} TO ${login} WITH INHERIT ${inherit ? 'TRUE' : 'FALSE'}, SET TRUE`);
  const unsafe = { ...config, user: login };
  const probe = new Pool(unsafe);
  try {
    expect(
      (
        await probe.query<{ member: boolean; inherited: boolean; can_set: boolean }>(
          "SELECT pg_has_role(current_user,$1,'MEMBER') AS member, pg_has_role(current_user,$1,'USAGE') AS inherited, pg_has_role(current_user,$1,'SET') AS can_set",
          [privileged],
        )
      ).rows[0],
    ).toEqual({ member: true, inherited: inherit, can_set: true });
    const client = await probe.connect();
    try {
      await client.query(`SET ROLE ${privileged}`);
      expect((await client.query<{ current_user: string }>('SELECT current_user')).rows[0]).toEqual(
        {
          current_user: privileged,
        },
      );
      await client.query('RESET ROLE');
    } finally {
      client.release();
    }
    await check(unsafe);
  } finally {
    await probe.end();
    await admin.query(`DROP ROLE ${login}`);
    if (!present) await admin.query(`DROP ROLE ${privileged}`);
  }
}
