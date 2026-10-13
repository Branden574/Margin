import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { Client } from 'pg';
import { upgradeObjects } from './upgrade-contract.js';

const REVIEWED_014_SHA256 = '8b8e01f5a2ccc8f9c9adce51c52107bcecb86d8f52901a5f3cfe8d3f184254b2';
export const FEEDBACK_GROUP = 'margin_feedback_runtime';
export const FEEDBACK_LOGIN = 'margin_canvas_feedback';
export async function reviewedMigration014() {
  const name = '014-submission-feedback.sql';
  const bytes = await readFile(new URL('../../../../infra/migrations/' + name, import.meta.url));
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const sql = bytes.toString('utf8');
  if (
    bytes.length > 262144 ||
    sha256 !== REVIEWED_014_SHA256 ||
    (sql.match(/^BEGIN;\s*$/gm) || []).length !== 1 ||
    (sql.match(/^COMMIT;\s*$/gm) || []).length !== 1
  )
    throw new Error('The reviewed migration 014 content differs.');
  return {
    position: 14,
    name,
    sha256,
    sql: sql.replace(/^BEGIN;\s*$/m, '').replace(/^COMMIT;\s*$/m, ''),
  };
}
export function assertFeedbackObjects(
  before: Awaited<ReturnType<typeof upgradeObjects>>,
  after: Awaited<ReturnType<typeof upgradeObjects>>,
) {
  const expected = {
    functions: ['margin_feedback.ctx', 'margin_feedback.protect_draft', 'margin_feedback.visible'],
    triggers: ['margin_feedback.drafts:protect_feedback_draft'],
    tables: ['margin_feedback.commands', 'margin_feedback.drafts', 'margin_feedback.releases'],
  };
  for (const kind of ['functions', 'triggers', 'tables'] as const) {
    const old = new Map(before[kind].map((row) => [row.key, row.definition]));
    const current = new Map(after[kind].map((row) => [row.key, row.definition]));
    if (
      before[kind].some((row) => current.get(row.key) !== row.definition) ||
      JSON.stringify(
        after[kind]
          .filter((row) => !old.has(row.key))
          .map((row) => row.key)
          .sort(),
      ) !== JSON.stringify(expected[kind])
    )
      throw new Error('Migration 014 changed objects outside its additive contract.');
  }
}
const structural = [
  'margin_identity.users',
  'margin_identity.organizations',
  'margin_identity.memberships',
  'margin_identity.sessions',
  'margin_lms.installations',
  'margin_lms.session_bindings',
  'margin_lms.user_links',
  'margin_lms.courses',
  'margin_lms.enrollments',
  'margin_assignments.assignments',
  'margin_assignments.launch_bindings',
  'margin_assignments.resource_links',
  'margin_assignments.student_work',
  'margin_assignments.provisioning_outbox',
  'margin_work.receipts',
  'margin_sync.documents',
  'margin_sync.versions',
  'margin_sync.grants',
  'margin_sync.pages',
  'margin_sync.document_keys',
  'margin_ingestion.artifacts',
  'margin_ingestion.storage_receipts',
  'margin_ingestion.inspection_jobs',
  'margin_ingestion.inspection_receipts',
  'margin_ingestion.page_geometry',
  'margin_submissions.attempts',
  'margin_submissions.requests',
  'margin_submissions.outbox',
  'margin_submissions.materialization_receipts',
  'margin_submissions.materialization_chunks',
];
type Policy = {
  table_name: string;
  name: string;
  roles: string[];
  command: string;
  permissive: boolean;
  using_expression: string | null;
  check_expression: string | null;
};
export async function feedbackPolicyAdditions(client: Client) {
  const clones = (
    await client.query<{ table_name: string; name: string; permissive: boolean }>(
      `SELECT n.nspname||'.'||c.relname AS table_name,'feedback_'||source.actor||'_'||p.oid AS name,p.polpermissive AS permissive
    FROM pg_policy p JOIN pg_class c ON c.oid=p.polrelid JOIN pg_namespace n ON n.oid=c.relnamespace
    JOIN (VALUES ('margin_submission_reviewer'::regrole,'teacher'),('margin_submission_runtime'::regrole,'student')) source(role_oid,actor) ON source.role_oid=ANY(p.polroles)
    WHERE p.polcmd='r' AND n.nspname||'.'||c.relname=ANY($1)`,
      [structural],
    )
  ).rows;
  const expected = clones.map((row) => ({ ...row, command: 'r' }));
  const add = (table_name: string, name: string, command: string, permissive = true) =>
    expected.push({ table_name, name, command, permissive });
  for (const table of structural.filter(
    (t) =>
      ![
        'margin_submissions.outbox',
        'margin_submissions.materialization_receipts',
        'margin_submissions.materialization_chunks',
      ].includes(t),
  ))
    add(table, 'feedback_lock_only', 'w');
  add('margin_submissions.attempts', 'feedback_exact_attempt', 'r', false);
  add('margin_submissions.materialization_receipts', 'feedback_student_receipt', 'r');
  add('margin_submissions.materialization_chunks', 'feedback_student_chunk', 'r');
  for (const table of ['drafts', 'releases', 'commands']) {
    add('margin_feedback.' + table, 'feedback_teacher_read', 'r');
    add('margin_feedback.' + table, 'feedback_teacher_insert', 'a');
  }
  add('margin_feedback.drafts', 'feedback_draft_update', 'w');
  add('margin_feedback.releases', 'feedback_student_release', 'r');
  add('margin_feedback.releases', 'feedback_release_saved_revision', 'a', false);
  return expected;
}
export function assertFeedbackPolicies(
  before: Policy[],
  after: Policy[],
  expected: Awaited<ReturnType<typeof feedbackPolicyAdditions>>,
) {
  const key = (row: { table_name: string; name: string }) => row.table_name + ':' + row.name;
  const old = new Map(before.map((row) => [key(row), JSON.stringify(row)]));
  const current = new Map(after.map((row) => [key(row), JSON.stringify(row)]));
  const added = after.filter((row) => !old.has(key(row)));
  if (
    before.some((row) => current.get(key(row)) !== JSON.stringify(row)) ||
    added.length !== expected.length ||
    expected.some(
      (e) =>
        !added.some(
          (p) =>
            key(p) === key(e) &&
            p.command === e.command &&
            p.permissive === e.permissive &&
            JSON.stringify(p.roles) === JSON.stringify([FEEDBACK_GROUP]),
        ),
    ) ||
    added.some((p) => p.name === 'feedback_lock_only' && p.check_expression !== 'false')
  )
    throw new Error('Migration 014 changed policies outside its reviewed additive contract.');
}
