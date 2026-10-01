import type { Metadata } from 'next';
import { PolicyPage } from '../../components/PolicyPage';
export const metadata: Metadata = { title: 'Security boundary' };
export default function Page() {
  return (
    <PolicyPage eyebrow="SPECIFICS BEFORE SLOGANS" title="Security, with the boundaries visible.">
      <h2>The local foundation</h2>
      <p>
        The document workspace uses a passphrase-protected local vault. Documents, annotations,
        metadata, and preferences are encrypted with authenticated AES-GCM before they are stored in
        IndexedDB. The local app uses HTTPS; locking drops the active vault session. Losing the
        passphrase can mean losing access to the vault.
      </p>
      <h2>The optional companion API</h2>
      <p>
        The local server requires TLS 1.2 or newer and an expiring development token. It checks
        tenant and owner scope, verifies upload checksums, encrypts chunks and sensitive metadata
        using per-artifact data keys, and keeps uploads quarantined until a scanner is connected.
        Its local master key is not a managed cloud KMS.
      </p>
      <h2>What this does not establish</h2>
      <p>
        These controls are not proof of production readiness, regulatory compliance, or an
        independent security assessment. Managed school identity, production role-based
        authorization, cloud key management, malware scanning, durable audit operations, retention
        enforcement, and recovery operations require further implementation and review.
      </p>
      <h2>Chrome extension</h2>
      <p>
        The launcher requests activeTab, contextMenus, and storage. It has no broad host permissions
        and does not receive document bytes, vault passphrases, or server tokens. It only hands off
        a user-selected ordinary HTTPS document link.
      </p>
    </PolicyPage>
  );
}
