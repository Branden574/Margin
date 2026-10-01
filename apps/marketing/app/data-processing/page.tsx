import type { Metadata } from 'next';
import { PolicyPage } from '../../components/PolicyPage';
export const metadata: Metadata = { title: 'Data processing status' };
export default function Page() {
  return (
    <PolicyPage
      eyebrow="STATUS, NOT A CONTRACT"
      title="A school deployment needs more than a page."
    >
      <p>
        No data processing agreement is offered by this local development edition. This page is a
        readiness statement, not a DPA.
      </p>
      <h2>Before real school deployment</h2>
      <ul>
        <li>Identify the controller, processor, subprocessors, and hosting regions.</li>
        <li>Agree on retention, deletion, access, export, and incident-response obligations.</li>
        <li>Complete identity, authorization, malware-processing, recovery, and audit controls.</li>
        <li>
          Review applicable privacy obligations with qualified counsel and the deploying school.
        </li>
      </ul>
      <p>
        Keep evaluations limited to synthetic or appropriately authorized material until those
        requirements are satisfied.
      </p>
    </PolicyPage>
  );
}
