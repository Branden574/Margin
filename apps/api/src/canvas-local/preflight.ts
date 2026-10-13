import { readFile } from 'node:fs/promises';
import { Pool, type PoolClient, type PoolConfig } from 'pg';
import { CANVAS_DATABASE_ROLES, CANVAS_MIGRATIONS, migrationManifest } from './bootstrap.js';
import { CANVAS_DATABASE_PURPOSES, type CanvasDatabasePurpose } from './config.js';

export type CanvasDatabases = Record<CanvasDatabasePurpose, PoolConfig>;
export type CanvasReadinessPurpose = CanvasDatabasePurpose | 'inspector' | 'feedback';
type Check =
  | 'configuration'
  | 'connection'
  | 'transport'
  | 'durability'
  | 'role'
  | 'installation'
  | 'schema'
  | 'cancelled'
  | 'deadline';
export class CanvasDatabasePreflightError extends Error {
  readonly code = 'canvas_database_not_ready';
  constructor(
    readonly purpose: CanvasReadinessPurpose,
    readonly check: Check,
  ) {
    super(
      `Canvas database ${purpose} failed its ${check} readiness check. Check the dedicated local installation and configuration.`,
    );
    this.name = 'CanvasDatabasePreflightError';
  }
}
const schemas = [
  'margin_identity',
  'margin_sync',
  'margin_lms',
  'margin_assignments',
  'margin_ingestion',
  'margin_work',
  'margin_submissions',
  'margin_review',
];
const allSchemas = [...schemas, 'margin_feedback', 'margin_local'];
const groups = [
  ...Object.values(CANVAS_DATABASE_ROLES),
  'margin_identity_provisioner',
  'margin_sync_runtime',
  'margin_sync_provisioner',
  'margin_lms_provisioner',
  'margin_ingestion_inspector',
  'margin_submission_retention_guard',
];
const identifiers = /^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/;
const permittedOptions = new Set([
  'host',
  'port',
  'database',
  'user',
  'password',
  'ssl',
  'sslnegotiation',
  'options',
  'client_encoding',
  'application_name',
  'connectionTimeoutMillis',
]);
function configuration<P extends CanvasReadinessPurpose>(
  input: Record<P, PoolConfig>,
  purposes: readonly P[],
): Record<P, PoolConfig> {
  const result = {} as Record<P, PoolConfig>;
  let endpoint: string | undefined;
  const users = new Set<string>();
  for (const purpose of purposes) {
    const c = input?.[purpose],
      ssl = c?.ssl;
    if (
      process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0' ||
      process.env.PGREPLICATION ||
      process.env.PGBINARY ||
      !c ||
      Object.keys(c).some((k) => !permittedOptions.has(k)) ||
      typeof c.host !== 'string' ||
      !c.host ||
      c.host.startsWith('/') ||
      /[\s\u0000]/.test(c.host) ||
      !Number.isInteger(c.port) ||
      c.port! < 1 ||
      c.port! > 65535 ||
      typeof c.user !== 'string' ||
      !identifiers.test(c.user) ||
      typeof c.database !== 'string' ||
      !identifiers.test(c.database) ||
      typeof c.password !== 'string' ||
      !c.password ||
      c.password.length > 1024 ||
      !ssl ||
      typeof ssl !== 'object' ||
      ssl.rejectUnauthorized !== true ||
      Object.keys(ssl).some((k) => k !== 'ca' && k !== 'rejectUnauthorized') ||
      !(typeof ssl.ca === 'string' || Buffer.isBuffer(ssl.ca)) ||
      !ssl.ca.length ||
      ssl.ca.length > 262144 ||
      (c.options !== undefined && c.options !== '-c search_path=pg_catalog') ||
      (c.client_encoding !== undefined && c.client_encoding !== 'UTF8') ||
      (c.sslnegotiation !== undefined && c.sslnegotiation !== 'postgres')
    )
      throw new CanvasDatabasePreflightError(purpose, 'configuration');
    const target = JSON.stringify([c.host, c.port, c.database]);
    if ((endpoint && endpoint !== target) || users.has(c.user))
      throw new CanvasDatabasePreflightError(purpose, 'configuration');
    endpoint = target;
    users.add(c.user);
    // Snapshot all inputs before the first await; no custom pg clients, streams, parsers,
    // connection strings, TLS callbacks or environment-dependent credential fallbacks.
    result[purpose] = {
      host: c.host,
      port: c.port,
      user: c.user,
      password: c.password,
      database: c.database,
      ssl: {
        ca: typeof ssl.ca === 'string' ? ssl.ca : Buffer.from(ssl.ca),
        rejectUnauthorized: true,
      },
      sslnegotiation: 'postgres',
      options: '-c search_path=pg_catalog',
      client_encoding: 'UTF8',
      application_name: 'margin-canvas-preflight',
      max: 1,
      connectionTimeoutMillis: 5000,
      query_timeout: 6000,
      statement_timeout: 5000,
      idle_in_transaction_session_timeout: 5000,
    };
  }
  return result;
}

interface FunctionContract {
  name: string;
  body: string;
  language: string;
  stable: string;
  definer: boolean;
  config: string[];
  args: string[];
  defaults: string[];
}
interface TriggerContract {
  table: string;
  name: string;
  function: string;
  type: number;
  constraint: boolean;
  deferrable: boolean;
  initiallyDeferred: boolean;
}
interface PolicyContract {
  table: string;
  name: string;
  roles: string[];
  command: string;
  permissive: boolean;
}
async function schemaContract(through: 13 | 14) {
  const tables = new Set<string>(),
    functions = new Map<string, FunctionContract>(),
    triggers: TriggerContract[] = [],
    policies: PolicyContract[] = [];
  for (const name of CANVAS_MIGRATIONS.slice(0, through)) {
    const sql = await readFile(
      new URL('../../../../infra/migrations/' + name, import.meta.url),
      'utf8',
    );
    for (const match of sql.matchAll(/^CREATE TABLE (margin_\w+\.\w+)\s*\(/gm))
      tables.add(match[1]);
    // These are the fixed migration files, not a general SQL parser. Replacement functions
    // deliberately overwrite earlier versions, including 008's plan-cache authorization fix.
    for (const match of sql.matchAll(
      /^CREATE(?: OR REPLACE)? FUNCTION (margin_\w+\.\w+)\(([^)]*)\) RETURNS ([\s\S]*?) AS \$\$([\s\S]*?)\$\$/gm,
    )) {
      const [, name, parameters, header, body] = match,
        args = parameters ? parameters.split(',') : [];
      functions.set(name, {
        name,
        body,
        language: /LANGUAGE (\w+)/.exec(header)![1],
        stable: /\bSTABLE\b/.test(header) ? 's' : /\bIMMUTABLE\b/.test(header) ? 'i' : 'v',
        definer: /SECURITY DEFINER/.test(header),
        config: Array.from(
          header.matchAll(/\bSET (\w+)\s*=\s*('(?:[^']|'')*'|\w+)/g),
          (setting) => `${setting[1]}=${setting[2].replace(/^'|'$/g, '').replaceAll("''", "'")}`,
        ),
        args: args
          .map((a) => a.trim().split(/\s+/)[1])
          .map((t) => ({ boolean: 'bool', integer: 'int4' })[t] ?? t),
        defaults: args
          .filter((a) => /\bDEFAULT\b/.test(a))
          .map((a) =>
            a
              .split(/\bDEFAULT\s+/)[1]
              .trim()
              .toLowerCase(),
          ),
      });
    }
    for (const match of sql.matchAll(
      /^CREATE (CONSTRAINT )?TRIGGER (\w+) (BEFORE|AFTER) ([A-Z ]+) ON (margin_\w+\.\w+) (DEFERRABLE INITIALLY DEFERRED )?FOR EACH ROW EXECUTE FUNCTION (margin_\w+\.\w+)\(\)/gm,
    ))
      triggers.push({
        name: match[2],
        table: match[5],
        function: match[7],
        constraint: Boolean(match[1]),
        deferrable: Boolean(match[6]),
        initiallyDeferred: Boolean(match[6]),
        type:
          1 |
          (match[3] === 'BEFORE' ? 2 : 0) |
          (match[4].includes('INSERT') ? 4 : 0) |
          (match[4].includes('DELETE') ? 8 : 0) |
          (match[4].includes('UPDATE') ? 16 : 0),
      });
    for (const match of sql.matchAll(
      /^CREATE POLICY (\w+) ON (margin_\w+\.\w+)(?: AS (RESTRICTIVE|PERMISSIVE))? FOR (SELECT|INSERT|UPDATE|DELETE|ALL) TO (margin_\w+(?:\s*,\s*margin_\w+)*)/gm,
    ))
      policies.push({
        name: match[1],
        table: match[2],
        roles: match[5].split(/\s*,\s*/).sort(),
        permissive: match[3] !== 'RESTRICTIVE',
        command: (
          { SELECT: 'r', INSERT: 'a', UPDATE: 'w', DELETE: 'd', ALL: '*' } as Record<string, string>
        )[match[4]],
      });
  }
  if (
    tables.size !== (through === 14 ? 42 : 39) ||
    functions.size !== (through === 14 ? 39 : 36) ||
    triggers.length !== (through === 14 ? 11 : 10) ||
    policies.length !== (through === 14 ? 188 : 182)
  )
    throw Error('Incomplete fixed migration contract');
  return { tables, functions, triggers, policies, through };
}

async function role(c: PoolClient, expected: string) {
  const r = (
    await c.query<{ valid: boolean }>(
      `SELECT
    current_user=session_user AND r.rolcanlogin AND NOT(r.rolsuper OR r.rolbypassrls OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication)
    AND pg_has_role(current_user,$1,'USAGE')
    AND NOT EXISTS(SELECT 1 FROM pg_roles p WHERE pg_has_role(current_user,p.oid,'MEMBER') AND p.rolname NOT IN (current_user,$1))
    AND NOT EXISTS(SELECT 1 FROM pg_auth_members m WHERE pg_has_role(current_user,m.member,'MEMBER') AND m.admin_option)
    AND NOT has_database_privilege(current_user,current_database(),'CREATE')
    AND NOT has_database_privilege(current_user,current_database(),'TEMP')
    AND NOT EXISTS(SELECT 1 FROM pg_namespace n WHERE n.nspname=ANY($2) AND (pg_has_role(current_user,n.nspowner,'MEMBER') OR has_schema_privilege(current_user,n.oid,'CREATE')))
    AND NOT has_schema_privilege(current_user,'public','CREATE')
    AND NOT EXISTS(SELECT 1 FROM pg_class t JOIN pg_namespace n ON n.oid=t.relnamespace WHERE n.nspname=ANY($2) AND pg_has_role(current_user,t.relowner,'MEMBER'))
    AND NOT EXISTS(SELECT 1 FROM pg_proc f JOIN pg_namespace n ON n.oid=f.pronamespace WHERE n.nspname=ANY($2) AND pg_has_role(current_user,f.proowner,'MEMBER'))
    AND NOT EXISTS(SELECT 1 FROM pg_class t JOIN pg_namespace n ON n.oid=t.relnamespace WHERE n.nspname=ANY($2) AND t.relkind='r' AND has_table_privilege(current_user,t.oid,'TRUNCATE,REFERENCES,TRIGGER'))
    AND NOT EXISTS(SELECT 1 FROM pg_class t JOIN pg_namespace n ON n.oid=t.relnamespace CROSS JOIN unnest(ARRAY['SELECT WITH GRANT OPTION','INSERT WITH GRANT OPTION','UPDATE WITH GRANT OPTION','DELETE WITH GRANT OPTION']) p WHERE n.nspname=ANY($2) AND t.relkind='r' AND has_table_privilege(current_user,t.oid,p))
    AND NOT EXISTS(SELECT 1 FROM pg_class t JOIN pg_namespace n ON n.oid=t.relnamespace JOIN pg_attribute a ON a.attrelid=t.oid CROSS JOIN unnest(ARRAY['SELECT WITH GRANT OPTION','INSERT WITH GRANT OPTION','UPDATE WITH GRANT OPTION','REFERENCES','REFERENCES WITH GRANT OPTION']) p WHERE n.nspname=ANY($2) AND t.relkind='r' AND a.attnum>0 AND NOT a.attisdropped AND has_column_privilege(current_user,t.oid,a.attnum,p))
    AND NOT EXISTS(SELECT 1 FROM pg_proc f JOIN pg_namespace n ON n.oid=f.pronamespace WHERE n.nspname=ANY($2) AND has_function_privilege(current_user,f.oid,'EXECUTE WITH GRANT OPTION'))
    AND NOT EXISTS(SELECT 1 FROM pg_class t JOIN pg_namespace n ON n.oid=t.relnamespace CROSS JOIN unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) p WHERE n.nspname=ANY($2) AND t.relkind='r' AND has_table_privilege(current_user,t.oid,p)<>has_table_privilege($1,t.oid,p))
    AND NOT EXISTS(SELECT 1 FROM pg_class t JOIN pg_namespace n ON n.oid=t.relnamespace JOIN pg_attribute a ON a.attrelid=t.oid CROSS JOIN unnest(ARRAY['SELECT','INSERT','UPDATE','REFERENCES']) p WHERE n.nspname=ANY($2) AND t.relkind='r' AND a.attnum>0 AND NOT a.attisdropped AND has_column_privilege(current_user,t.oid,a.attnum,p)<>has_column_privilege($1,t.oid,a.attnum,p))
    AND NOT EXISTS(SELECT 1 FROM pg_proc f JOIN pg_namespace n ON n.oid=f.pronamespace WHERE n.nspname=ANY($2) AND has_function_privilege(current_user,f.oid,'EXECUTE')<>has_function_privilege($1,f.oid,'EXECUTE'))
    AND NOT EXISTS(SELECT 1 FROM pg_class t JOIN pg_namespace n ON n.oid=t.relnamespace WHERE n.nspname='margin_local' AND (has_table_privilege(current_user,t.oid,'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') OR has_any_column_privilege(current_user,t.oid,'INSERT,UPDATE,REFERENCES')))
    AS valid FROM pg_roles r WHERE r.rolname=current_user`,
      [expected, allSchemas],
    )
  ).rows[0];
  if (!r?.valid) throw Error('Unsafe runtime role');
}

// These columns connect session/launch authority, immutable captures, leases and retry revisions.
const columns = {
  'margin_identity.sessions': {
    id: 'uuid',
    user_id: 'uuid',
    organization_id: 'uuid',
    authentication_method: 'text',
    expires_at: 'timestamptz',
    idle_expires_at: 'timestamptz',
    revoked_at: 'timestamptz',
  },
  'margin_lms.session_bindings': {
    session_id: 'uuid',
    installation_id: 'uuid',
    registration_version: 'int4',
    organization_id: 'uuid',
    user_id: 'uuid',
    course_id: 'uuid',
    role: 'text',
    subject_digest: 'text',
    course_digest: 'text',
  },
  'margin_assignments.launch_bindings': {
    session_id: 'uuid',
    installation_id: 'uuid',
    resource_digest: 'text',
    assignment_id: 'uuid',
    user_id: 'uuid',
  },
  'margin_assignments.student_work': {
    id: 'uuid',
    assignment_id: 'uuid',
    user_id: 'uuid',
    document_id: 'uuid',
    version_id: 'uuid',
    resource_digest: 'text',
    registration_version: 'int4',
    status: 'text',
  },
  'margin_submissions.requests': {
    work_id: 'uuid',
    request_id: 'uuid',
    expected_cursor: 'int8',
    outcome: 'text',
    ciphertext: 'bytea',
    nonce: 'bytea',
    tag: 'bytea',
    wrapped_key: 'jsonb',
  },
  'margin_submissions.attempts': {
    id: 'uuid',
    work_id: 'uuid',
    frozen_cursor: 'int8',
    source_artifact_id: 'uuid',
    scan_receipt_id: 'uuid',
  },
  'margin_submissions.outbox': {
    attempt_id: 'uuid',
    work_id: 'uuid',
    phase: 'text',
    materialization_state: 'text',
    materialization_attempt: 'int4',
    claim_id: 'uuid',
    token_digest: 'text',
    lease_expires_at: 'timestamptz',
    status_revision: 'int8',
    processing_generation: 'int4',
    published_error_code: 'text',
    failed_at: 'timestamptz',
  },
  'margin_submissions.reprocess_commands': {
    attempt_id: 'uuid',
    expected_revision: 'int8',
    accepted_revision: 'int8',
    processing_generation: 'int4',
    prior_error_code: 'text',
    state: 'text',
  },
  'margin_ingestion.upload_reservations': {
    artifact_id: 'uuid',
    organization_id: 'uuid',
    owner_id: 'uuid',
    installation_id: 'uuid',
    course_id: 'uuid',
    plaintext_bytes: 'int8',
    created_at: 'timestamptz',
  },
};
async function schema(c: PoolClient, contract: Awaited<ReturnType<typeof schemaContract>>) {
  const activeSchemas = contract.through === 14 ? [...schemas, 'margin_feedback'] : schemas;
  const namespacesExpected = [...activeSchemas, 'margin_local'];
  const activeGroups = contract.through === 14 ? [...groups, 'margin_feedback_runtime'] : groups;
  const roles = (
    await c.query<{ name: string; safe: boolean }>(
      `SELECT rolname AS name, NOT(rolsuper OR rolbypassrls OR rolcreatedb OR rolcreaterole OR rolreplication OR rolcanlogin OR rolinherit) AND NOT EXISTS(SELECT 1 FROM pg_auth_members m WHERE m.member=r.oid) AS safe FROM pg_roles r WHERE rolname=ANY($1)`,
      [activeGroups],
    )
  ).rows;
  if (roles.length !== activeGroups.length || roles.some((r) => !r.safe))
    throw Error('Unsafe application groups');
  const namespaces = (
    await c.query<{ name: string }>(
      'SELECT nspname AS name FROM pg_namespace WHERE nspname=ANY($1)',
      [namespacesExpected],
    )
  ).rows;
  if (namespaces.length !== namespacesExpected.length) throw Error('Missing schema');
  const tables = (
    await c.query<{ name: string; safe: boolean }>(
      `SELECT n.nspname||'.'||t.relname AS name, t.relkind='r' AND t.relpersistence='p' AND t.relrowsecurity AND t.relforcerowsecurity
    AND EXISTS(SELECT 1 FROM pg_constraint k WHERE k.conrelid=t.oid AND k.contype='p' AND k.convalidated)
    AND NOT EXISTS(SELECT 1 FROM pg_constraint k WHERE k.conrelid=t.oid AND NOT k.convalidated)
    AND EXISTS(SELECT 1 FROM pg_policy p WHERE p.polrelid=t.oid)
    AS safe FROM pg_class t JOIN pg_namespace n ON n.oid=t.relnamespace WHERE n.nspname=ANY($1) AND t.relkind IN ('r','p','f')`,
      [activeSchemas],
    )
  ).rows;
  if (
    tables.length !== contract.tables.size ||
    tables.some((t) => !t.safe || !contract.tables.has(t.name))
  )
    throw Error('Table/RLS drift');
  const attrs = (
    await c.query<{ table: string; column: string; type: string }>(
      `SELECT n.nspname||'.'||t.relname AS table,a.attname AS column,y.typname AS type FROM pg_class t JOIN pg_namespace n ON n.oid=t.relnamespace JOIN pg_attribute a ON a.attrelid=t.oid JOIN pg_type y ON y.oid=a.atttypid WHERE n.nspname=ANY($1) AND a.attnum>0 AND NOT a.attisdropped`,
      [activeSchemas],
    )
  ).rows;
  for (const [table, expected] of Object.entries(columns))
    for (const [column, type] of Object.entries(expected))
      if (!attrs.some((a) => a.table === table && a.column === column && a.type === type))
        throw Error('Critical column drift');
  const functions = (
    await c.query<{
      name: string;
      body: string;
      language: string;
      stable: string;
      definer: boolean;
      config: string[];
      args: string[];
      defaults: string | null;
      unsafe: boolean;
      owner: string;
    }>(
      `SELECT n.nspname||'.'||f.proname AS name,f.prosrc AS body,l.lanname AS language,f.provolatile AS stable,f.prosecdef AS definer,f.proconfig AS config,ARRAY(SELECT t.typname::text FROM unnest(f.proargtypes) WITH ORDINALITY a(oid,position) JOIN pg_type t ON t.oid=a.oid ORDER BY a.position) AS args,pg_get_expr(f.proargdefaults,0) AS defaults,f.proleakproof OR f.prokind<>'f' OR f.proparallel<>'u' AS unsafe,pg_get_userbyid(f.proowner) AS owner FROM pg_proc f JOIN pg_namespace n ON n.oid=f.pronamespace JOIN pg_language l ON l.oid=f.prolang WHERE n.nspname=ANY($1)`,
      [activeSchemas],
    )
  ).rows;
  if (functions.length !== contract.functions.size) throw Error('Function inventory drift');
  for (const f of functions) {
    const expected = contract.functions.get(f.name),
      defaults =
        f.defaults
          ?.replace(/::[a-zA-Z_]+/g, '')
          .toLowerCase()
          .split(/,\s*/) ?? [];
    if (
      !expected ||
      f.body !== expected.body ||
      f.language !== expected.language ||
      f.stable !== expected.stable ||
      f.definer !== expected.definer ||
      f.unsafe ||
      JSON.stringify(f.config) !== JSON.stringify(expected.config) ||
      JSON.stringify(f.args) !== JSON.stringify(expected.args) ||
      JSON.stringify(defaults) !== JSON.stringify(expected.defaults) ||
      (f.definer && f.owner !== 'margin_submission_retention_guard')
    )
      throw Error('Authority function drift');
  }
  const triggers = (
    await c.query<{
      table: string;
      name: string;
      function: string;
      type: number;
      enabled: string;
      conditional: boolean;
      constraint_trigger: boolean;
      deferrable: boolean;
      initially_deferred: boolean;
    }>(
      `SELECT n.nspname||'.'||t.relname AS table,g.tgname AS name,pn.nspname||'.'||p.proname AS function,g.tgtype AS type,g.tgenabled AS enabled,g.tgqual IS NOT NULL OR g.tgnargs<>0 OR cardinality(g.tgattr::smallint[])>0 AS conditional,g.tgconstraint<>0 AS constraint_trigger,g.tgdeferrable AS deferrable,g.tginitdeferred AS initially_deferred FROM pg_trigger g JOIN pg_class t ON t.oid=g.tgrelid JOIN pg_namespace n ON n.oid=t.relnamespace JOIN pg_proc p ON p.oid=g.tgfoid JOIN pg_namespace pn ON pn.oid=p.pronamespace WHERE n.nspname=ANY($1) AND NOT g.tgisinternal`,
      [activeSchemas],
    )
  ).rows;
  if (
    triggers.length !== contract.triggers.length ||
    contract.triggers.some(
      (e) =>
        !triggers.some(
          (t) =>
            t.table === e.table &&
            t.name === e.name &&
            t.function === e.function &&
            t.type === e.type &&
            t.constraint_trigger === e.constraint &&
            t.deferrable === e.deferrable &&
            t.initially_deferred === e.initiallyDeferred &&
            t.enabled === 'O' &&
            !t.conditional,
        ),
    )
  )
    throw Error('Retention/lease trigger drift');
  const policies = (
    await c.query<{
      table: string;
      name: string;
      roles: string[];
      command: string;
      permissive: boolean;
    }>(
      `SELECT n.nspname||'.'||t.relname AS table,p.polname AS name,ARRAY(SELECT r.rolname::text FROM pg_roles r WHERE r.oid=ANY(p.polroles) ORDER BY r.rolname) AS roles,p.polcmd AS command,p.polpermissive AS permissive FROM pg_policy p JOIN pg_class t ON t.oid=p.polrelid JOIN pg_namespace n ON n.oid=t.relnamespace WHERE n.nspname=ANY($1)`,
      [activeSchemas],
    )
  ).rows;
  if (
    policies.some((p) => !p.roles.length || p.roles.some((r) => !activeGroups.includes(r))) ||
    contract.policies.some(
      (e) =>
        !policies.some(
          (p) =>
            p.table === e.table &&
            p.name === e.name &&
            p.command === e.command &&
            p.permissive === e.permissive &&
            JSON.stringify(p.roles) === JSON.stringify(e.roles),
        ),
    )
  )
    throw Error('Critical policy inventory drift');
  // The operator records PostgreSQL's canonical expressions immediately after applying
  // the verified migration files. Runtime groups can read this contract but cannot edit
  // it. Compare the whole inventory so an added permissive policy or altered predicate
  // cannot pass just because the original policy names and forced-RLS flags still exist.
  const actualPolicies = (
    await c.query(
      `SELECT n.nspname||'.'||t.relname AS table_name,p.polname AS name,ARRAY(SELECT r.rolname::text FROM pg_roles r WHERE r.oid=ANY(p.polroles) ORDER BY r.rolname) AS roles,p.polcmd::text AS command,p.polpermissive AS permissive,pg_get_expr(p.polqual,p.polrelid,false) AS using_expression,pg_get_expr(p.polwithcheck,p.polrelid,false) AS check_expression FROM pg_policy p JOIN pg_class t ON t.oid=p.polrelid JOIN pg_namespace n ON n.oid=t.relnamespace WHERE n.nspname=ANY($1) ORDER BY n.nspname,t.relname,p.polname`,
      [activeSchemas],
    )
  ).rows;
  const installedPolicies = (
    await c.query(
      'SELECT table_name,name,roles,command,permissive,using_expression,check_expression FROM margin_local.policy_contract ORDER BY table_name,name',
    )
  ).rows;
  if (JSON.stringify(actualPolicies) !== JSON.stringify(installedPolicies))
    throw Error('Policy expression drift');
  const constraint = (
    await c.query<{ valid: boolean }>(
      `SELECT count(*)=4 AND bool_and(k.convalidated) AS valid FROM pg_constraint k JOIN pg_class t ON t.oid=k.conrelid JOIN pg_namespace n ON n.oid=t.relnamespace WHERE n.nspname='margin_submissions' AND ((t.relname='outbox' AND k.conname IN ('materialization_state','materialization_completion','processing_revision')) OR (t.relname='attempts' AND k.conname='submission_attempt_work'))`,
    )
  ).rows[0];
  if (!constraint?.valid) throw Error('Submission constraint drift');
}

interface ReadinessOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}
export interface CanvasInspectorReadinessOptions extends ReadinessOptions {
  instanceId: string;
  /** Operator-verified receipt context. This check does not require pg_control_system access.
   * Runtime identity is established by certificate-verified TLS, database/login and instanceId. */
  systemIdentifier?: string;
}

/** Read-only startup checks for the local 001–013 installation. This checks explicit critical
 * objects, not a complete schema/ACL fingerprint, live Canvas registration, or capacity readiness.
 * Every credential is verified over TLS, including tests; no account or migration is applied. */
export async function assertCanvasDatabaseReady(
  input: CanvasDatabases,
  options: ReadinessOptions = {},
): Promise<void> {
  await assertReady(input, CANVAS_DATABASE_PURPOSES, CANVAS_DATABASE_ROLES, options);
}

/** Independent restricted inspection login: no API/operator credentials or catalog-control grant. */
export async function assertCanvasInspectorReady(
  database: PoolConfig,
  options: CanvasInspectorReadinessOptions,
): Promise<void> {
  if (
    !options ||
    typeof options.instanceId !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(options.instanceId) ||
    (options.systemIdentifier !== undefined &&
      (typeof options.systemIdentifier !== 'string' ||
        !/^[0-9]{1,20}$/.test(options.systemIdentifier)))
  )
    throw new CanvasDatabasePreflightError('inspector', 'configuration');
  await assertReady(
    { inspector: database },
    ['inspector'],
    { inspector: 'margin_ingestion_inspector' },
    { signal: options.signal, timeoutMs: options.timeoutMs, instanceId: options.instanceId },
  );
}

/** Optional dedicated feedback login; never reuse another API purpose's credential. */
export async function assertCanvasFeedbackReady(
  database: PoolConfig,
  options: CanvasInspectorReadinessOptions,
): Promise<void> {
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(options.instanceId))
    throw new CanvasDatabasePreflightError('feedback', 'configuration');
  await assertReady(
    { feedback: database },
    ['feedback'],
    { feedback: 'margin_feedback_runtime' },
    options,
  );
}

async function assertReady<P extends CanvasReadinessPurpose>(
  input: Record<P, PoolConfig>,
  purposes: readonly P[],
  roles: Record<P, string>,
  options: ReadinessOptions & { instanceId?: string },
): Promise<void> {
  const first = purposes[0];
  const timeoutMs = options.timeoutMs ?? 30000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000)
    throw new CanvasDatabasePreflightError(first, 'configuration');
  const deadline = Date.now() + timeoutMs;
  const active = (purpose: CanvasReadinessPurpose) => {
    if (options.signal?.aborted) throw new CanvasDatabasePreflightError(purpose, 'cancelled');
    if (Date.now() >= deadline) throw new CanvasDatabasePreflightError(purpose, 'deadline');
  };
  active(first);
  const databases = configuration(input, purposes);
  let expectedManifest: Awaited<ReturnType<typeof migrationManifest>>,
    contracts: Awaited<ReturnType<typeof schemaContract>>[];
  try {
    [expectedManifest, contracts] = await Promise.all([
      migrationManifest(14),
      Promise.all([schemaContract(13), schemaContract(14)]),
    ]);
  } catch {
    throw new CanvasDatabasePreflightError(first, 'schema');
  }
  let databaseIdentity: string | undefined;
  const logins = new Set<string>();
  for (const purpose of purposes) {
    active(purpose);
    const pool = new Pool({
      ...databases[purpose],
      connectionTimeoutMillis: Math.min(5000, Math.max(1, deadline - Date.now())),
    });
    let client: PoolClient | undefined,
      check: Check = 'connection',
      interrupted: 'cancelled' | 'deadline' | undefined,
      released = false;
    const interrupt = (reason: 'cancelled' | 'deadline') => {
      interrupted ??= reason;
      if (client && !released) {
        released = true;
        client.release(true);
      }
    };
    const abort = () => interrupt('cancelled');
    options.signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => interrupt('deadline'), Math.max(1, deadline - Date.now()));
    timer.unref();
    try {
      client = await pool.connect();
      active(purpose);
      if (interrupted) throw new CanvasDatabasePreflightError(purpose, interrupted);
      check = 'transport';
      const tls = (
        await client.query<{ ssl: boolean; version: string }>(
          'SELECT ssl,version FROM pg_stat_ssl WHERE pid=pg_backend_pid()',
        )
      ).rows[0];
      if (!tls?.ssl || !['TLSv1.2', 'TLSv1.3'].includes(tls.version))
        throw Error('Verified TLS required');
      check = 'durability';
      const settings = (
        await client.query<{ valid: boolean }>(
          `SELECT current_setting('fsync')='on' AND current_setting('full_page_writes')='on' AND current_setting('synchronous_commit')='on' AND current_setting('row_security')='on' AND current_setting('session_replication_role')='origin' AND current_setting('default_transaction_read_only')='off' AND NOT pg_is_in_recovery() AS valid`,
        )
      ).rows[0];
      if (!settings?.valid) throw Error('Durable writable server required');
      await client.query('BEGIN ISOLATION LEVEL READ COMMITTED READ ONLY');
      await client.query("SET LOCAL lock_timeout='2s'");
      check = 'role';
      await role(client, roles[purpose]);
      check = 'installation';
      const manifest = (
        await client.query(
          'SELECT position,name,sha256 FROM margin_local.migrations ORDER BY position LIMIT $1',
          [expectedManifest.length + 1],
        )
      ).rows;
      if (
        (manifest.length !== 13 && manifest.length !== 14) ||
        (purpose === 'feedback' && manifest.length !== 14) ||
        JSON.stringify(manifest) !== JSON.stringify(expectedManifest.slice(0, manifest.length))
      )
        throw Error('Migration ledger drift');
      const installation = (
        await client.query<{ id: number; instance_id: string; schema_version: number }>(
          'SELECT id,instance_id,schema_version FROM margin_local.installation LIMIT 2',
        )
      ).rows;
      if (
        installation.length !== 1 ||
        installation[0].id !== 1 ||
        installation[0].schema_version !== 1 ||
        !/^[0-9a-f-]{36}$/.test(installation[0].instance_id) ||
        (options.instanceId !== undefined && installation[0].instance_id !== options.instanceId)
      )
        throw Error('Installation identity missing');
      const identity = (
        await client.query<{
          database: string;
          oid: number;
          address: string;
          port: number;
          started: Date;
          login: string;
        }>(
          `SELECT current_database() AS database,(SELECT oid FROM pg_database WHERE datname=current_database()) AS oid,inet_server_addr()::text AS address,inet_server_port() AS port,pg_postmaster_start_time() AS started,session_user AS login`,
        )
      ).rows[0];
      const actual = JSON.stringify([
        identity.database,
        identity.oid,
        identity.address,
        identity.port,
        identity.started,
        installation[0].instance_id,
        manifest.length,
      ]);
      if (
        identity.database !== databases[purpose].database ||
        identity.login !== databases[purpose].user ||
        logins.has(identity.login) ||
        (databaseIdentity && databaseIdentity !== actual)
      )
        throw Error('Database/login identity mismatch');
      databaseIdentity = actual;
      logins.add(identity.login);
      check = 'schema';
      await schema(client, contracts[manifest.length - 13]);
      await client.query('ROLLBACK');
    } catch (error) {
      throw new CanvasDatabasePreflightError(
        purpose,
        interrupted ?? (error instanceof CanvasDatabasePreflightError ? error.check : check),
      );
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', abort);
      if (!released) client?.release(true);
      await pool.end();
    }
  }
}
