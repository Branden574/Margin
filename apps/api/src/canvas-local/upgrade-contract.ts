import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { Client } from 'pg';

const REVIEWED_013_SHA256 = '90caa53504152965ebd1072d5f684aace0950537475c7228c24d29bc49180b6e';
export const UPGRADE_013_POLICIES = Object.freeze([
  'margin_sync.documents:ingestion_upload_document_insert',
  'margin_sync.versions:ingestion_upload_version_insert',
  'margin_sync.grants:ingestion_upload_grant_insert',
  'margin_ingestion.upload_reservations:upload_reservation_read',
  'margin_ingestion.upload_reservations:upload_reservation_insert',
]);
const FUNCTIONS = Object.freeze([
  'margin_ingestion.protect_upload_capacity',
  'margin_ingestion.enforce_upload_accounting',
]);
const TRIGGERS = Object.freeze([
  'margin_ingestion.upload_reservations:protect_upload_capacity',
  'margin_sync.documents:enforce_upload_accounting',
]);
const TABLE = 'margin_ingestion.upload_reservations';
export async function reviewedMigration013() {
  const name = '013-teacher-source-intake.sql';
  const bytes = await readFile(new URL('../../../../infra/migrations/' + name, import.meta.url));
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  if (bytes.length > 262144 || sha256 !== REVIEWED_013_SHA256)
    throw new Error('The reviewed migration 013 content differs.');
  const sql = bytes.toString('utf8');
  if (
    (sql.match(/^BEGIN;\s*$/gm) || []).length !== 1 ||
    (sql.match(/^COMMIT;\s*$/gm) || []).length !== 1
  )
    throw new Error('Unsupported migration framing.');
  return {
    position: 13,
    name,
    sha256,
    sql: sql.replace(/^BEGIN;\s*$/m, '').replace(/^COMMIT;\s*$/m, ''),
  };
}
type ObjectRecord = { key: string; definition: string };
export async function upgradeObjects(client: Client) {
  const functions = (
    await client.query<ObjectRecord>(
      "SELECT n.nspname||'.'||p.proname AS key,pg_get_functiondef(p.oid) AS definition FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname LIKE 'margin\\_%' ESCAPE '\\' AND n.nspname<>'margin_local' ORDER BY key",
    )
  ).rows;
  const triggers = (
    await client.query<ObjectRecord>(
      "SELECT n.nspname||'.'||c.relname||':'||t.tgname AS key,pg_get_triggerdef(t.oid,false) AS definition FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname LIKE 'margin\\_%' ESCAPE '\\' AND n.nspname<>'margin_local' AND NOT t.tgisinternal ORDER BY key",
    )
  ).rows;
  const tables = (
    await client.query<ObjectRecord>(
      "SELECT n.nspname||'.'||c.relname AS key,c.relrowsecurity::text||':'||c.relforcerowsecurity::text||':'||c.relpersistence::text AS definition FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname LIKE 'margin\\_%' ESCAPE '\\' AND n.nspname<>'margin_local' AND c.relkind='r' ORDER BY key",
    )
  ).rows;
  return { functions, triggers, tables };
}
function additions(before: ObjectRecord[], after: ObjectRecord[], expected: readonly string[]) {
  const old = new Map(before.map((entry) => [entry.key, entry.definition]));
  const current = new Map(after.map((entry) => [entry.key, entry.definition]));
  if (
    before.some((entry) => current.get(entry.key) !== entry.definition) ||
    JSON.stringify(
      after
        .filter((entry) => !old.has(entry.key))
        .map((entry) => entry.key)
        .sort(),
    ) !== JSON.stringify([...expected].sort())
  )
    throw new Error('Migration 013 changed objects outside its reviewed additive contract.');
}
export function assertUpgradeObjects(
  before: Awaited<ReturnType<typeof upgradeObjects>>,
  after: Awaited<ReturnType<typeof upgradeObjects>>,
) {
  additions(before.functions, after.functions, FUNCTIONS);
  additions(before.triggers, after.triggers, TRIGGERS);
  additions(before.tables, after.tables, [TABLE]);
}
export function assertUpgradePolicies(
  before: Array<Record<string, unknown>>,
  after: Array<Record<string, unknown>>,
) {
  const key = (row: Record<string, unknown>) => row.table_name + ':' + row.name;
  const previous = new Map(before.map((row) => [key(row), JSON.stringify(row)]));
  const current = new Map(after.map((row) => [key(row), JSON.stringify(row)]));
  const added = after.filter((row) => !previous.has(key(row)));
  if (
    before.some((row) => current.get(key(row)) !== JSON.stringify(row)) ||
    JSON.stringify(added.map(key).sort()) !== JSON.stringify([...UPGRADE_013_POLICIES].sort()) ||
    added.some(
      (row) =>
        JSON.stringify(row.roles) !== JSON.stringify(['margin_ingestion_runtime']) ||
        row.permissive !== true ||
        row.command !== (row.name === 'upload_reservation_read' ? 'r' : 'a'),
    )
  )
    throw new Error('Migration 013 changed row policies outside its reviewed additive contract.');
}
