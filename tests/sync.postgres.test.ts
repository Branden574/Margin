import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { Pool, type PoolConfig } from 'pg';
import { LocalKeyProvider, type KeyManagementProvider } from '../apps/api/src/encryption';
import type { SessionPrincipal, IdentityRole } from '../apps/api/src/identity/types';
import {
  PostgresSyncProvisioner,
  PostgresSyncService,
  type AppendOperation,
  type ProvisionDocument,
} from '../apps/api/src/sync/index';

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
    'PostgreSQL sync integration is required, but initdb, pg_ctl or psql is unavailable.',
  );
let directory: string,
  started = false,
  admin: Pool,
  runtime: Pool,
  service: PostgresSyncService,
  provisioner: PostgresSyncProvisioner,
  config: PoolConfig,
  provisionConfig: PoolConfig;
const keys = new LocalKeyProvider(randomBytes(32), 'synthetic-sync-test-key');
const org = randomUUID(),
  otherOrg = randomUUID();
let owner: SessionPrincipal,
  peer: SessionPrincipal,
  viewer: SessionPrincipal,
  teacher: SessionPrincipal,
  outsider: SessionPrincipal;
async function identity(role: IdentityRole, organizationId = org): Promise<SessionPrincipal> {
  const now = Date.now();
  const principal: SessionPrincipal = {
    userId: randomUUID(),
    organizationId,
    sessionId: randomUUID(),
    role,
    mfa: false,
    createdAt: now,
    expiresAt: now + 3600000,
    lastSeenAt: now,
    authenticationMethod: 'oidc',
  };
  await admin.query('INSERT INTO margin_identity.users(id,identity_key) VALUES($1,$2)', [
    principal.userId,
    createHash('sha256').update(randomUUID()).digest('hex'),
  ]);
  await admin.query(
    'INSERT INTO margin_identity.memberships(organization_id,user_id,role) VALUES($1,$2,$3)',
    [organizationId, principal.userId, role],
  );
  await admin.query(
    'INSERT INTO margin_identity.sessions(id,session_hash,user_id,organization_id,mfa,created_at,expires_at,idle_expires_at,last_seen_at) VALUES($1,$2,$3,$4,false,$5,$6,$6,$5)',
    [
      principal.sessionId,
      createHash('sha256').update(randomUUID()).digest('hex'),
      principal.userId,
      organizationId,
      new Date(now),
      new Date(now + 3600000),
    ],
  );
  return principal;
}
async function document(overrides: Partial<ProvisionDocument> = {}) {
  const value: ProvisionDocument = {
    organizationId: org,
    documentId: randomUUID(),
    versionId: randomUUID(),
    ownerId: owner.userId,
    audience: 'members',
    pages: [{ id: randomUUID(), index: 0, width: 612, height: 792 }],
    ...overrides,
  };
  await provisioner.createDocument(value);
  return value;
}
function operation(
  doc: ProvisionDocument,
  overrides: Partial<AppendOperation> = {},
): AppendOperation {
  return {
    documentId: doc.documentId,
    versionId: doc.versionId,
    pageId: doc.pages[0].id,
    annotationId: randomUUID(),
    operationId: randomUUID(),
    baseRevision: 0,
    kind: 'put',
    annotation: {
      type: 'text',
      x: 80,
      y: 90,
      color: '#102030',
      strokeWidth: 2,
      opacity: 1,
      text: 'Disposable synthetic annotation — private research note',
    },
    ...overrides,
  };
}
describe.skipIf(!available)('durable encrypted PostgreSQL document sync', () => {
  beforeAll(async () => {
    directory = mkdtempSync(join(tmpdir(), 'margin-sync-pg-'));
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
        `-k ${socket} -h '' -p 55490`,
        '-w',
        'start',
      ],
      { stdio: 'pipe' },
    );
    started = true;
    admin = new Pool({ host: socket, port: 55490, user: 'postgres', database: 'postgres' });
    for (const filename of ['001-identity.sql', '002-document-sync.sql'])
      await admin.query(
        readFileSync(new URL(`../infra/migrations/${filename}`, import.meta.url), 'utf8'),
      );
    await admin.query(
      'CREATE ROLE sync_test_runtime LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS; GRANT margin_sync_runtime TO sync_test_runtime; CREATE ROLE sync_test_provisioner LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS; GRANT margin_sync_provisioner TO sync_test_provisioner',
    );
    config = { host: socket, port: 55490, user: 'sync_test_runtime', database: 'postgres' };
    provisionConfig = { ...config, user: 'sync_test_provisioner' };
    runtime = new Pool(config);
    service = new PostgresSyncService({ database: config, keyManagementProvider: keys });
    provisioner = new PostgresSyncProvisioner({
      database: provisionConfig,
      keyManagementProvider: keys,
    });
    await admin.query('INSERT INTO margin_identity.organizations(id) VALUES($1),($2)', [
      org,
      otherOrg,
    ]);
    owner = await identity('student');
    peer = await identity('student');
    viewer = await identity('viewer');
    teacher = await identity('teacher');
    outsider = await identity('student', otherOrg);
  }, 30000);
  afterAll(async () => {
    await Promise.all([service?.close(), provisioner?.close(), runtime?.end(), admin?.end()]);
    if (started)
      execFileSync('pg_ctl', ['-D', join(directory, 'data'), '-m', 'fast', '-w', 'stop'], {
        stdio: 'pipe',
      });
    if (directory) rmSync(directory, { recursive: true, force: true });
  });
  it('provisions immutable server page identities and grants, never a name or object safety claim', async () => {
    const doc = await document();
    expect(await service.describeDocument(owner, doc.documentId)).toEqual({
      documentId: doc.documentId,
      versionId: doc.versionId,
      cursor: 0,
      permission: 'owner',
      audience: 'members',
      pages: doc.pages,
    });
    const columns = (
      await admin.query(
        "SELECT column_name FROM information_schema.columns WHERE table_schema='margin_sync'",
      )
    ).rows.map((row) => row.column_name);
    expect(columns).not.toContain('name');
    expect(columns).not.toContain('annotation');
    expect(columns).not.toContain('safe');
    await expect(
      provisioner.createDocument({
        ...doc,
        documentId: randomUUID(),
        pages: [{ ...doc.pages[0], index: 2 }],
      }),
    ).rejects.toMatchObject({ code: 'invalid_pages' });
    await expect(
      provisioner.createDocument({ ...doc, documentId: randomUUID(), ownerId: outsider.userId }),
    ).rejects.toMatchObject({ code: 'invalid_grantee' });
  });
  it('commits edits, revisions and outbox atomically and recovers in a fresh service instance', async () => {
    const doc = await document(),
      edit = operation(doc);
    expect(await service.append(owner, edit)).toEqual({
      operationId: edit.operationId,
      cursor: 1,
      annotationRevision: 1,
      duplicate: false,
    });
    const fresh = new PostgresSyncService({ database: config, keyManagementProvider: keys });
    try {
      const replay = await fresh.catchUp(owner, { documentId: doc.documentId });
      expect(replay.operations).toMatchObject([
        { ...edit, actorId: owner.userId, cursor: 1, annotationRevision: 1 },
      ]);
      expect(replay).toMatchObject({ nextCursor: 1, currentCursor: 1, hasMore: false });
    } finally {
      await fresh.close();
    }
    const rows = (
      await admin.query(
        'SELECT row_to_json(o)::text AS row FROM margin_sync.operations o WHERE document_id=$1',
        [doc.documentId],
      )
    ).rows;
    expect(rows[0].row).not.toContain(edit.annotation!.text);
    expect(
      (await admin.query('SELECT * FROM margin_sync.outbox WHERE document_id=$1', [doc.documentId]))
        .rowCount,
    ).toBe(1);
    expect(
      (
        await admin.query(
          'SELECT revision,latest_cursor FROM margin_sync.annotations WHERE document_id=$1',
          [doc.documentId],
        )
      ).rows,
    ).toEqual([{ revision: 1, latest_cursor: '1' }]);
    const connection = await admin.connect();
    try {
      await connection.query('BEGIN');
      await connection.query('DELETE FROM margin_sync.outbox WHERE document_id=$1', [
        doc.documentId,
      ]);
      await connection.query('ROLLBACK');
    } finally {
      connection.release();
    }
  });
  it('orders concurrent different-annotation commits with a per-document lock and paginates without gaps', async () => {
    const doc = await document({ grants: [{ userId: peer.userId, permission: 'editor' }] }),
      other = await document();
    const inputs = Array.from({ length: 12 }, () => operation(doc));
    const receipts = await Promise.all(
      inputs.map((input, index) => service.append(index % 2 ? owner : peer, input)),
    );
    expect(receipts.map((r) => r.cursor).sort((a, b) => a - b)).toEqual(
      Array.from({ length: 12 }, (_, i) => i + 1),
    );
    expect((await service.append(owner, operation(other))).cursor).toBe(1);
    let cursor = 0;
    const observed: number[] = [];
    do {
      const page = await service.catchUp(owner, {
        documentId: doc.documentId,
        afterCursor: cursor,
        limit: 3,
      });
      observed.push(...page.operations.map((op) => op.cursor));
      cursor = page.nextCursor;
      if (!page.hasMore) break;
    } while (cursor < 100);
    expect(observed).toEqual(Array.from({ length: 12 }, (_, i) => i + 1));
    expect(
      (
        await admin.query(
          'SELECT count(*)::int AS n FROM margin_sync.outbox WHERE document_id=$1',
          [doc.documentId],
        )
      ).rows[0].n,
    ).toBe(12);
  });
  it('does not expose an allocated cursor before commit or block an unrelated document', async () => {
    const doc = await document(),
      unrelated = await document();
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const delayed: KeyManagementProvider = {
      wrapKey: keys.wrapKey.bind(keys),
      unwrapKey: async (envelope, context) => {
        entered();
        await gate;
        return keys.unwrapKey(envelope, context);
      },
    };
    const firstService = new PostgresSyncService({
      database: config,
      keyManagementProvider: delayed,
    });
    const first = firstService.append(owner, operation(doc));
    try {
      await started;
      const second = service.append(owner, operation(doc));
      // Observe a real PostgreSQL row-lock waiter, not a process-local promise queue.
      let waiting = false;
      for (let attempt = 0; attempt < 50; attempt++) {
        waiting =
          (
            await admin.query(
              "SELECT count(*)::int AS n FROM pg_stat_activity WHERE usename='sync_test_runtime' AND wait_event_type='Lock' AND query LIKE '%FOR UPDATE OF d%'",
            )
          ).rows[0].n > 0;
        if (waiting) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(waiting).toBe(true);
      expect(await service.catchUp(owner, { documentId: doc.documentId })).toMatchObject({
        operations: [],
        currentCursor: 0,
      });
      expect((await service.append(owner, operation(unrelated))).cursor).toBe(1);
      release();
      expect((await first).cursor).toBe(1);
      expect((await second).cursor).toBe(2);
      expect(
        (await service.catchUp(owner, { documentId: doc.documentId })).operations.map(
          (op) => op.cursor,
        ),
      ).toEqual([1, 2]);
    } finally {
      release();
      await first.catch(() => {});
      await firstService.close();
    }
  });
  it('deduplicates retries by actor, rejects changed retry bodies and permits the same ID for a different actor', async () => {
    const doc = await document({ grants: [{ userId: peer.userId, permission: 'editor' }] }),
      edit = operation(doc);
    const receipts = await Promise.all([service.append(owner, edit), service.append(owner, edit)]);
    expect(receipts.map((r) => r.cursor)).toEqual([1, 1]);
    expect(receipts.filter((r) => r.duplicate)).toHaveLength(1);
    await expect(
      service.append(owner, {
        ...edit,
        annotation: { ...edit.annotation, text: 'Different content' },
      }),
    ).rejects.toMatchObject({ status: 409, code: 'idempotency_conflict' });
    expect((await service.append(peer, { ...edit, annotationId: randomUUID() })).cursor).toBe(2);
    expect((await service.catchUp(owner, { documentId: doc.documentId })).operations).toHaveLength(
      2,
    );
  });
  it('returns explicit conflicts for same-annotation races, stale versions and moved annotations', async () => {
    const doc = await document(),
      initial = operation(doc);
    await service.append(owner, initial);
    const edits = [
      operation(doc, { annotationId: initial.annotationId, baseRevision: 1 }),
      operation(doc, { annotationId: initial.annotationId, baseRevision: 1 }),
    ];
    const results = await Promise.allSettled(edits.map((edit) => service.append(owner, edit)));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.find((r) => r.status === 'rejected')).toMatchObject({
      reason: {
        status: 409,
        code: 'annotation_conflict',
        details: { currentRevision: 2, currentCursor: 2 },
      },
    });
    await expect(
      service.append(owner, operation(doc, { versionId: randomUUID() })),
    ).rejects.toMatchObject({
      code: 'version_conflict',
      details: { currentVersionId: doc.versionId },
    });
    await expect(
      service.append(owner, operation(doc, { pageId: randomUUID() })),
    ).rejects.toMatchObject({ code: 'page_unavailable' });
    const deletion = operation(doc, {
      annotationId: initial.annotationId,
      baseRevision: 2,
      kind: 'delete',
    });
    delete deletion.annotation;
    expect((await service.append(owner, deletion)).annotationRevision).toBe(3);
    expect(
      (await service.catchUp(owner, { documentId: doc.documentId })).operations.at(-1)?.kind,
    ).toBe('delete');
  });
  it('denies peer and cross-organization access; read-only grants cannot write and revocation is live', async () => {
    const doc = await document();
    await service.append(owner, operation(doc));
    for (const principal of [peer, outsider]) {
      await expect(
        service.catchUp(principal, { documentId: doc.documentId }),
      ).rejects.toMatchObject({ status: 404 });
      await expect(service.append(principal, operation(doc))).rejects.toMatchObject({
        status: 404,
      });
    }
    await provisioner.setGrant(org, doc.documentId, peer.userId, 'viewer');
    expect((await service.catchUp(peer, { documentId: doc.documentId })).operations).toHaveLength(
      1,
    );
    await expect(service.append(peer, operation(doc))).rejects.toMatchObject({ status: 403 });
    await provisioner.setGrant(org, doc.documentId, peer.userId, 'editor');
    await service.append(peer, operation(doc));
    await provisioner.setGrant(org, doc.documentId, peer.userId, null);
    await expect(service.catchUp(peer, { documentId: doc.documentId })).rejects.toMatchObject({
      status: 404,
    });
    await provisioner.setGrant(org, doc.documentId, viewer.userId, 'editor');
    await expect(service.append(viewer, operation(doc))).rejects.toMatchObject({ status: 403 });
    await expect(
      provisioner.setGrant(org, doc.documentId, outsider.userId, 'viewer'),
    ).rejects.toMatchObject({ code: 'invalid_grantee' });
  });
  it('rechecks session, membership and disabled identities rather than trusting supplied role claims', async () => {
    const actor = await identity('student'),
      doc = await document({ ownerId: actor.userId });
    await expect(
      service.catchUp({ ...actor, authenticationMethod: 'lti' }, { documentId: doc.documentId }),
    ).rejects.toMatchObject({ status: 401 });
    await admin.query('UPDATE margin_identity.sessions SET revoked_at=now() WHERE id=$1', [
      actor.sessionId,
    ]);
    await expect(
      service.append({ ...actor, role: 'owner', mfa: true }, operation(doc)),
    ).rejects.toMatchObject({ status: 401 });
    await admin.query('UPDATE margin_identity.sessions SET revoked_at=NULL WHERE id=$1', [
      actor.sessionId,
    ]);
    await admin.query('UPDATE margin_identity.memberships SET revoked_at=now() WHERE user_id=$1', [
      actor.userId,
    ]);
    await expect(service.catchUp(actor, { documentId: doc.documentId })).rejects.toMatchObject({
      status: 401,
    });
    await admin.query(
      "UPDATE margin_identity.memberships SET revoked_at=NULL,role='owner' WHERE user_id=$1",
      [actor.userId],
    );
    await expect(service.append({ ...actor, mfa: true }, operation(doc))).rejects.toMatchObject({
      status: 401,
    });
    await admin.query("UPDATE margin_identity.memberships SET role='student' WHERE user_id=$1", [
      actor.userId,
    ]);
    await admin.query('UPDATE margin_identity.users SET disabled_at=now() WHERE id=$1', [
      actor.userId,
    ]);
    await expect(service.catchUp(actor, { documentId: doc.documentId })).rejects.toMatchObject({
      status: 401,
    });
  });
  it('isolates teacher-private feedback even if a student is accidentally given a grant', async () => {
    const doc = await document({ ownerId: teacher.userId, audience: 'teachers' });
    await service.append(teacher, operation(doc));
    await expect(
      provisioner.setGrant(org, doc.documentId, owner.userId, 'viewer'),
    ).rejects.toMatchObject({ code: 'invalid_grantee' });
    await admin.query(
      "INSERT INTO margin_sync.grants(organization_id,document_id,user_id,permission) VALUES($1,$2,$3,'viewer')",
      [org, doc.documentId, owner.userId],
    );
    await expect(service.catchUp(owner, { documentId: doc.documentId })).rejects.toMatchObject({
      status: 404,
    });
    expect(
      (await service.catchUp(teacher, { documentId: doc.documentId })).operations,
    ).toHaveLength(1);
  });
  it('enforces actual RLS and prevents runtime grants, metadata rewriting, ciphertext updates and key disclosure to provisioners', async () => {
    expect((await runtime.query('SELECT * FROM margin_sync.documents')).rowCount).toBe(0);
    expect((await runtime.query('SELECT * FROM margin_sync.operations')).rowCount).toBe(0);
    await expect(
      runtime.query('SELECT session_hash FROM margin_identity.sessions'),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      runtime.query(
        'INSERT INTO margin_sync.grants(organization_id,document_id,user_id,permission) VALUES($1,$2,$3,$4)',
        [org, randomUUID(), owner.userId, 'owner'],
      ),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      runtime.query('UPDATE margin_sync.documents SET current_version_id=$1', [randomUUID()]),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      runtime.query('UPDATE margin_sync.operations SET ciphertext=$1', [Buffer.from('untrusted')]),
    ).rejects.toMatchObject({ code: '42501' });
    const trusted = new Pool(provisionConfig);
    try {
      await expect(
        trusted.query('SELECT wrapped_key FROM margin_sync.document_keys'),
      ).rejects.toMatchObject({ code: '42501' });
    } finally {
      await trusted.end();
    }
    const unsafe = new PostgresSyncService({
      database: { ...config, user: 'postgres' },
      keyManagementProvider: keys,
    });
    try {
      await expect(unsafe.catchUp(owner, { documentId: randomUUID() })).rejects.toThrow(
        'dedicated',
      );
    } finally {
      await unsafe.close();
    }
    const privileged = new PostgresSyncService({
      database: provisionConfig,
      keyManagementProvider: keys,
    });
    try {
      await expect(privileged.catchUp(owner, { documentId: randomUUID() })).rejects.toThrow(
        'dedicated',
      );
    } finally {
      await privileged.close();
    }
  });
  it('rolls back the entire write if the outbox cannot commit; retry gets the first durable cursor', async () => {
    const doc = await document(),
      edit = operation(doc);
    await admin.query(
      `CREATE FUNCTION margin_sync.synthetic_outbox_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic transaction failure'; END $$; CREATE TRIGGER synthetic_outbox_failure BEFORE INSERT ON margin_sync.outbox FOR EACH ROW EXECUTE FUNCTION margin_sync.synthetic_outbox_failure()`,
    );
    try {
      await expect(service.append(owner, edit)).rejects.toThrow('synthetic transaction failure');
      expect(
        (await service.catchUp(owner, { documentId: doc.documentId })).operations,
      ).toHaveLength(0);
      expect(
        (
          await admin.query('SELECT * FROM margin_sync.annotations WHERE document_id=$1', [
            doc.documentId,
          ])
        ).rowCount,
      ).toBe(0);
    } finally {
      await admin.query(
        'DROP TRIGGER synthetic_outbox_failure ON margin_sync.outbox; DROP FUNCTION margin_sync.synthetic_outbox_failure()',
      );
    }
    expect(await service.append(owner, edit)).toMatchObject({ cursor: 1, duplicate: false });
  });
  it('fails closed on key-service failure and authenticated ciphertext corruption without returning plaintext', async () => {
    const doc = await document(),
      edit = operation(doc);
    const failing: KeyManagementProvider = {
      wrapKey: keys.wrapKey.bind(keys),
      unwrapKey: async () => {
        throw new Error('Synthetic KMS outage');
      },
    };
    const broken = new PostgresSyncService({ database: config, keyManagementProvider: failing });
    try {
      await expect(broken.append(owner, edit)).rejects.toMatchObject({
        status: 503,
        code: 'key_unavailable',
      });
    } finally {
      await broken.close();
    }
    expect((await service.describeDocument(owner, doc.documentId)).cursor).toBe(0);
    await service.append(owner, edit);
    await admin.query(
      "UPDATE margin_sync.operations SET tag=decode(repeat('00',16),'hex') WHERE document_id=$1",
      [doc.documentId],
    );
    await expect(service.catchUp(owner, { documentId: doc.documentId })).rejects.toMatchObject({
      status: 503,
      code: 'encrypted_operation_unavailable',
    });
  });
  it('rejects client-owned identity fields, oversized operations, invalid cursors and insecure database TLS', async () => {
    const doc = await document();
    await expect(
      service.append(owner, { ...operation(doc), actorId: peer.userId }),
    ).rejects.toMatchObject({ status: 400, code: 'unexpected_field' });
    await expect(
      service.append(owner, {
        ...operation(doc),
        annotation: { ...operation(doc).annotation, text: 'x'.repeat(16001) },
      }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      service.catchUp(owner, { documentId: doc.documentId, afterCursor: 1 }),
    ).rejects.toMatchObject({ status: 409, code: 'cursor_ahead' });
    await expect(
      service.catchUp(owner, { documentId: doc.documentId, limit: 101 }),
    ).rejects.toMatchObject({ status: 400 });
    expect(
      () =>
        new PostgresSyncService({
          database: { host: 'database.example', ssl: false },
          keyManagementProvider: keys,
        }),
    ).toThrow('TLS');
    expect(
      () =>
        new PostgresSyncService({
          database: { host: 'database.example', ssl: { rejectUnauthorized: false } },
          keyManagementProvider: keys,
        }),
    ).toThrow('TLS');
    expect(
      () =>
        new PostgresSyncService({
          database: {
            connectionString: 'postgresql://db.example/margin?sslmode=no-verify',
            ssl: true,
          },
          keyManagementProvider: keys,
        }),
    ).toThrow('explicit');
  });
});
