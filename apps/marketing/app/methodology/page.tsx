import type { Metadata } from 'next';
import { PolicyPage } from '../../components/PolicyPage';
export const metadata: Metadata = { title: 'Performance methodology' };
export default function Page() {
  return (
    <PolicyPage eyebrow="MEASURE FIRST. PUBLISH SECOND." title="Benchmarking is in progress.">
      <p>
        No comparative latency, memory, throughput, or Chromebook performance results are published
        here.
      </p>
      <h2>The test plan</h2>
      <ol>
        <li>
          Record device model, RAM, OS, browser version, build commit, power state, and test date.
        </li>
        <li>
          Use redistributable PDF fixtures with fixed hashes, byte sizes, page counts, image
          density, and annotation counts.
        </li>
        <li>
          Separate cold and warm caches. Record bandwidth, latency, offline transitions, and
          interruption timing.
        </li>
        <li>
          Measure time to first page, input latency, memory, upload bytes retried, and recovery
          correctness across repeated runs.
        </li>
        <li>
          Publish the harness, failures, sample count, distribution, and limitations. Compare
          products only under equivalent supported conditions.
        </li>
      </ol>
      <h2>Scenarios</h2>
      <p>
        100 MB uploads; 300-page and image-heavy PDFs; 1,000 annotations; interrupted uploads;
        offline edits; memory pressure; managed and entry-level Chromebooks.
      </p>
      <h2>This website’s budget</h2>
      <p>
        Targets: LCP under 2.5 seconds, INP under 200 milliseconds, CLS under 0.1; initial
        first-party JavaScript under 250 KB compressed; no video payloads, no external font
        requests, and no third-party analytics. These are targets, not measured field results.
      </p>
      <p>
        The current application has local functional tests, including a synthetic large-document
        rendering check. A passing functional test is not a performance benchmark or a
        certificate-trust compatibility test.
      </p>
    </PolicyPage>
  );
}
