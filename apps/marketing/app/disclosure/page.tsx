import type { Metadata } from 'next';
import { PolicyPage } from '../../components/PolicyPage';
export const metadata: Metadata = { title: 'Responsible disclosure status' };
export default function Page() {
  return (
    <PolicyPage eyebrow="HANDLE FINDINGS CAREFULLY" title="Responsible disclosure.">
      <p>
        A public security reporting channel and coordinated disclosure policy have not yet been
        established.
      </p>
      <h2>If you are evaluating the project</h2>
      <p>
        Contact the maintainer through an existing private project channel. Do not post vault
        passphrases, API tokens, real documents, exploit details affecting others, or personal
        information in public issues.
      </p>
      <p>
        Use synthetic data in local environments you are authorized to test. This statement does not
        create a bug bounty program or grant authorization to test third-party systems.
      </p>
    </PolicyPage>
  );
}
