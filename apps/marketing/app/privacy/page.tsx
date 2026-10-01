import type { Metadata } from 'next';
import { PolicyPage } from '../../components/PolicyPage';
export const metadata: Metadata = { title: 'Privacy in the local edition' };
export default function Page() {
  return (
    <PolicyPage eyebrow="YOUR WORK, CLOSE TO YOU" title="Privacy in the local edition.">
      <h2>This website</h2>
      <p>
        The marketing page has no analytics integration, advertising pixels, contact submission
        endpoint, or account system. Its interactive examples run in memory. Evaluation briefs are
        copied or downloaded on your device; they are not sent to Margin. A future website host may
        keep normal access logs, which must be reviewed before deployment.
      </p>
      <h2>The workspace</h2>
      <p>
        Documents stay in the local encrypted browser vault unless you explicitly choose an export
        or optional server upload. Clearing site data removes that local storage. Keep encrypted
        exports and protect the passphrase needed to reopen them.
      </p>
      <h2>Links and planned services</h2>
      <p>
        Opening external product references or the configured workspace takes you to those
        destinations. This is a development privacy summary, not a reviewed school-service privacy
        policy. School deployment and real student data require a separate legal, security, and
        operational review.
      </p>
    </PolicyPage>
  );
}
