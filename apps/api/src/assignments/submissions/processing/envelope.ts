import type { KeyManagementProvider } from '../../../encryption.js';
import { canonical } from '../../../sync/validation.js';
import { decrypt, unwrapKey } from '../../../sync/encryption.js';
import { decodeManifest, type Decoded } from '../../work/manifest.js';
import { fail, type Snapshot } from './authority.js';
export async function authenticate(
  kms: KeyManagementProvider,
  s: Snapshot,
): Promise<{ decoded: Decoded; bytes: number; frozenAt: string }> {
  const decoded = await decodeManifest(kms, s.assignment, s.work, s.receipt);
  if (!decoded.completion || canonical(s.pages) !== canonical(decoded.completion.pages))
    throw fail('submission_integrity');
  const r = s.request,
    a = s.attempt,
    context = canonical([
      'margin-submission-request-v1',
      r.organization_id,
      r.work_id,
      r.request_id,
      Number(r.expected_cursor),
    ]);
  let key: Buffer | undefined, plain: Buffer | undefined;
  try {
    key = await unwrapKey(kms, r.wrapped_key, context);
    plain = decrypt(key, r, context, 262144);
    const data = JSON.parse(plain.toString('utf8'));
    const pin = {
      organizationId: s.work.organization_id,
      workId: s.work.id,
      assignmentId: s.work.assignment_id,
      documentId: s.work.document_id,
      versionId: s.work.version_id,
      source: decoded.source,
      completion: decoded.completion,
      wrappedAnnotationKey: s.wrappedKey,
    };
    const request = data.request,
      status = request?.submission,
      prefix = data.prefix;
    if (
      Object.keys(data).sort().join(',') !== 'pin,prefix,request,schema' ||
      data.schema !== 1 ||
      canonical(data.pin) !== canonical(pin) ||
      Object.keys(prefix ?? {})
        .sort()
        .join(',') !== 'bytes,cursor' ||
      prefix.cursor !== Number(a.frozen_cursor) ||
      !Number.isSafeInteger(prefix.bytes) ||
      prefix.bytes < 0 ||
      prefix.bytes > 134217728 ||
      Object.keys(request ?? {})
        .sort()
        .join(',') !== 'expectedCursor,requestId,state,submission' ||
      request.state !== 'captured' ||
      request.requestId !== a.request_id ||
      request.expectedCursor !== Number(a.frozen_cursor) ||
      Object.keys(status ?? {})
        .sort()
        .join(',') !==
        'attempt,confirmedAt,errorCode,frozenAt,frozenCursor,id,phase,requestId,retryAllowed,revision' ||
      status.id !== a.id ||
      status.requestId !== a.request_id ||
      status.attempt !== 1 ||
      status.frozenCursor !== Number(a.frozen_cursor) ||
      status.revision !== 1 ||
      status.phase !== 'processing' ||
      status.confirmedAt !== null ||
      status.retryAllowed !== false ||
      status.errorCode !== null ||
      !Number.isFinite(Date.parse(status.frozenAt)) ||
      new Date(status.frozenAt).toISOString() !== status.frozenAt ||
      decoded.source.artifactId !== a.source_artifact_id ||
      decoded.source.scanReceiptId !== a.scan_receipt_id
    )
      throw fail('submission_integrity');
    return { decoded, bytes: prefix.bytes, frozenAt: status.frozenAt };
  } catch {
    throw fail('submission_integrity');
  } finally {
    key?.fill(0);
    plain?.fill(0);
  }
}
