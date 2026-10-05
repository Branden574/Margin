import type { WrappedDataKey, KeyManagementProvider } from '../../encryption.js';
import { decrypt, unwrapKey, type Ciphertext } from '../../sync/encryption.js';
import { canonical } from '../../sync/validation.js';
import { geometry, receipt as validateReceipt } from '../../ingestion/validation.js';
import type { ArtifactReceipt } from '../../cloud/types.js';
import { assignmentId, parseAssignmentInput, verifyReadySource } from '../policy.js';
import { AssignmentError, type ReadyAssignmentSource, type AssignmentPolicy } from '../types.js';
export interface Envelope extends Ciphertext {
  wrapped_key: WrappedDataKey;
}
export interface AssignmentRow extends Envelope {
  id: string;
  organization_id: string;
  installation_id: string;
  course_id: string;
  created_by: string;
  source_document_id: string;
  source_version_id: string;
  request_id: string;
  selected_at: Date | null;
  disabled_at: Date | null;
}
export interface WorkRow {
  id: string;
  assignment_id: string;
  organization_id: string;
  installation_id: string;
  course_id: string;
  user_id: string;
  document_id: string;
  version_id: string;
  status: 'pending' | 'provisioned';
  resource_digest: string;
  registration_version: number;
  subject_digest: string;
  course_digest: string;
}
export interface ReceiptRow extends Envelope {
  work_id: string;
  organization_id: string;
  document_id: string;
  version_id: string;
  claim_id: string;
  attempt: number;
  source_artifact_id: string;
  scan_receipt_id: string;
}
export interface Decoded {
  title: string;
  instructions: string;
  policy: AssignmentPolicy;
  source: ReadyAssignmentSource;
  completion?: {
    approval: string;
    storage: ArtifactReceipt;
    pages: Array<{ id: string; index: number; width: number; height: number }>;
  };
}
export const unavailable = () =>
  new AssignmentError(
    404,
    'work_unavailable',
    'This assignment work is not available through the current launch.',
  );
export const integrity = () =>
  new AssignmentError(
    503,
    'work_integrity',
    'The encrypted assignment work could not be authenticated. Keep any local edits and retry.',
  );
async function open(
  kms: KeyManagementProvider,
  row: Envelope,
  context: string,
  keyContext = context,
  max = 65536,
) {
  let key: Buffer | undefined, plain: Buffer | undefined;
  try {
    key = await unwrapKey(kms, row.wrapped_key, keyContext);
    plain = decrypt(key, row, context, max);
    return JSON.parse(plain.toString('utf8'));
  } finally {
    key?.fill(0);
    plain?.fill(0);
  }
}
/** Authenticates both independent envelopes; structural IDs alone never establish completion. */
export async function decodeManifest(
  kms: KeyManagementProvider,
  a: AssignmentRow,
  w: WorkRow | null,
  r: ReceiptRow | null,
): Promise<Decoded> {
  try {
    const data = await open(
      kms,
      a,
      canonical([
        'margin-assignment-envelope-v1',
        'master',
        a.id,
        a.organization_id,
        a.installation_id,
        a.course_id,
      ]),
      `margin-assignment-master-key-v1:${a.organization_id}:${a.id}`,
    );
    const parsed = parseAssignmentInput({
      requestId: a.request_id,
      documentId: a.source_document_id,
      versionId: a.source_version_id,
      title: data.title,
      instructions: data.instructions,
      policy: data.policy,
    });
    const source = verifyReadySource(data.source, {
      organizationId: a.organization_id,
      ownerId: a.created_by,
      documentId: a.source_document_id,
      versionId: a.source_version_id,
    });
    const out: Decoded = {
      title: parsed.title,
      instructions: parsed.instructions,
      policy: parsed.policy,
      source,
    };
    if (w?.status !== 'provisioned') return out;
    if (
      !r ||
      r.work_id !== w.id ||
      r.organization_id !== w.organization_id ||
      r.document_id !== w.document_id ||
      r.version_id !== w.version_id
    )
      throw integrity();
    const context = canonical([
      'margin-assignment-work-v1',
      w.id,
      w.organization_id,
      w.installation_id,
      w.course_id,
      w.assignment_id,
      w.user_id,
      w.document_id,
      w.version_id,
      r.claim_id,
      r.attempt,
    ]);
    const done = await open(kms, r, context, context, 262144);
    if (
      done.schema !== 1 ||
      done.workId !== w.id ||
      done.assignmentId !== w.assignment_id ||
      done.ownerId !== w.user_id ||
      done.documentId !== w.document_id ||
      done.versionId !== w.version_id ||
      done.claimId !== r.claim_id ||
      done.attempt !== r.attempt ||
      !/^[a-f0-9]{64}$/.test(done.approval) ||
      canonical(done.source) !== canonical(source) ||
      r.source_artifact_id !== source.artifactId ||
      r.scan_receipt_id !== source.scanReceiptId
    )
      throw integrity();
    const storage = validateReceipt(done.storageReceipt);
    if (storage.objectVersionId !== source.artifactVersion) throw integrity();
    const pages = geometry(done.pages, source.pageCount).map((page, index) => ({
      ...page,
      id: assignmentId(done.pages[index].id),
    }));
    if (new Set(pages.map((p) => p.id)).size !== pages.length) throw integrity();
    out.completion = { approval: done.approval, storage, pages };
    return out;
  } catch {
    throw integrity();
  }
}
