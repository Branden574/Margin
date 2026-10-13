import { same, type FeedbackCapture, type StudentFeedback } from './decode';

interface ReturnedFeedbackDependencies {
  source: Blob;
  readFeedback: () => Promise<StudentFeedback>;
  readBinding: () => Promise<{
    identity: { documentId: string; versionId: string };
    sourceSha256: string;
  }>;
  check: () => void;
}

/** A failed first read does not establish a capture. The first successful read must verify its source. */
export function createReturnedFeedbackReader({
  source,
  readFeedback,
  readBinding,
  check,
}: ReturnedFeedbackDependencies) {
  let verifiedCapture: FeedbackCapture | null = null;
  return async (): Promise<StudentFeedback> => {
    check();
    const data = await readFeedback();
    check();
    if (verifiedCapture) {
      if (!same(verifiedCapture, data.capture))
        throw new Error('The captured submission changed. Check feedback again.');
      return data;
    }
    const binding = await readBinding();
    check();
    const snapshot = data.capture;
    if (
      snapshot.documentId !== binding.identity.documentId ||
      snapshot.versionId !== binding.identity.versionId ||
      snapshot.source.sha256 !== binding.sourceSha256 ||
      source.size !== snapshot.source.bytes
    )
      throw new Error(
        'This feedback belongs to a different captured document. Reopen the assignment.',
      );
    const bytes = await source.arrayBuffer();
    let digest: string;
    try {
      digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
        .map((byte) => byte.toString(16).padStart(2, '0'))
        .join('');
    } finally {
      new Uint8Array(bytes).fill(0);
    }
    check();
    if (digest !== snapshot.source.sha256)
      throw new Error('The assignment source could not be verified. Reopen the assignment.');
    verifiedCapture = structuredClone(snapshot);
    return data;
  };
}
