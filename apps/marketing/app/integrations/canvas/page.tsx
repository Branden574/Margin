import type { Metadata } from 'next';
import Link from 'next/link';
import { ArrowRight, ShieldCheck } from 'lucide-react';
import { CanvasStory } from '../../../components/CanvasStory';
import { AccessButton, WebAppLink } from '../../../components/Actions';
import { Reveal } from '../../../components/Motion';
export const metadata: Metadata = {
  title: 'Canvas integration — planned',
  description:
    'Explore Margin’s planned Canvas workflow for student documents, teacher review, secure submission, grade passback, and offline recovery. Not yet a production integration.',
};
const faqs = [
  [
    'Can I connect my Canvas institution today?',
    'There is no production-ready Canvas connection offered from this website. Integration foundations are in development. A real institution workflow, deployment review, and appropriate administrator authorization are required before use with students.',
  ],
  [
    'Will students need to download and upload PDFs?',
    'The intended flow opens a personal working document from a Canvas assignment and submits it through the integration. That complete workflow has not yet been verified against a real Canvas test installation.',
  ],
  [
    'Does saved mean submitted?',
    'No. Local save, server synchronization, assignment submission, and grade synchronization are different states. The planned interface must show successful submission only after Canvas confirms it.',
  ],
  [
    'Will grades go into the Canvas gradebook?',
    'Grade passback is planned through LTI Advantage Assignment and Grade Services where the installation supports it. It needs confirmed, idempotent requests and safe retry handling. No live grade is sent by this preview.',
  ],
  [
    'What happens when school Wi-Fi drops?',
    'The existing local editor supports device-local recovery after app assets have loaded. Canvas-linked offline editing, queued submission, identity expiry, reconnection, and recovery still require integration testing. A passphrase is needed to unlock the local vault after reload.',
  ],
  [
    'Can teachers control student tools?',
    'Assignment-specific tools, restricted assessment settings, and server-enforced policies are planned. Browser restrictions cannot guarantee academic integrity, and this will not be marketed as cheat-proof.',
  ],
  [
    'Are Canvas rubrics synchronized?',
    'Rubric interoperability is not established. Any internal rubric will need to be clearly distinguished from a Canvas-native rubric until supported synchronization is implemented and tested.',
  ],
  [
    'Is the integration certified or approved by Canvas?',
    'No certification, endorsement, partnership, or completed institutional security review is claimed. Canvas is a product of Instructure; this is Margin’s independent integration plan.',
  ],
];
export default function CanvasPage() {
  return (
    <>
      <header className="policy-header">
        <Link href="/#main" className="wordmark">
          margin<span>.</span>
        </Link>
        <Link href="/#main">← Back to the story</Link>
      </header>
      <div className="canvas-plan-banner">
        Planned integration · no institution is connected through this page
      </div>
      <main id="main">
        <section className="canvas-page-hero">
          <Reveal>
            <span className="eyebrow">MARGIN + CANVAS / IN DEVELOPMENT</span>
            <h1>
              Your document workspace.
              <br />
              <em>A clearer Canvas workflow.</em>
            </h1>
            <p>
              The direction: open assignments, annotate, save, submit, review, and return feedback
              with less file juggling. The full school workflow is still being built and tested.
            </p>
            <div className="button-row">
              <a href="#setup" className="button primary">
                Explore Canvas setup <ArrowRight size={16} />
              </a>
              <AccessButton kind="district" className="button secondary">
                Request district demo
              </AccessButton>
            </div>
          </Reveal>
        </section>
        <nav className="canvas-section-nav" aria-label="Canvas page sections">
          {[
            ['How it works', 'workflow'],
            ['Students', 'students'],
            ['Teachers', 'teachers'],
            ['IT', 'setup'],
            ['Security', 'security'],
            ['Grade passback', 'grades'],
            ['Offline recovery', 'offline'],
            ['FAQ', 'faq'],
          ].map(([label, id]) => (
            <a key={id} href={`#${id}`}>
              {label}
            </a>
          ))}
        </nav>
        <section className="section-wrap" id="workflow">
          <div className="section-heading">
            <span className="eyebrow">HOW IT’S INTENDED TO WORK</span>
            <h2>
              Canvas in.
              <br />
              <em>Clearer steps between.</em>
            </h2>
            <p>A clickable concept, not a connected assignment. Try each step below.</p>
          </div>
          <CanvasStory compact />
        </section>
        <section className="soft-section" id="students">
          <div className="section-wrap">
            <div className="split-heading">
              <div>
                <span className="eyebrow">FOR STUDENTS / PLANNED</span>
                <h2>
                  Open the assignment.
                  <br />
                  Find your thinking space.
                </h2>
              </div>
              <p>
                The intended workspace shows the assignment, instructions, allowed tools, due date,
                save state, and submission state. A personal working copy keeps your work separate
                from the teacher’s original.
              </p>
            </div>
            <div className="canvas-diagram">
              <span>Canvas assignment</span>
              <ArrowRight size={17} />
              <span>Your working copy</span>
              <ArrowRight size={17} />
              <span>Confirmed submission</span>
            </div>
            <div className="editorial-columns">
              <div>
                <h3>One clear next step.</h3>
                <p>
                  No unnecessary extra sign-in after a valid institution launch. Identity,
                  installation, course, assignment, and document permissions must be checked on the
                  server.
                </p>
              </div>
              <div>
                <h3>Your work, your copy.</h3>
                <p>
                  Source documents should be immutable where appropriate, with isolated student
                  annotations. This student provisioning workflow is planned and still requires real
                  integration testing.
                </p>
              </div>
            </div>
          </div>
        </section>
        <section className="section-wrap" id="teachers">
          <div className="split-heading">
            <div>
              <span className="eyebrow">FOR TEACHERS / PLANNED</span>
              <h2>
                From a worksheet
                <br />
                <em>to the next good question.</em>
              </h2>
            </div>
            <p>
              Create an external-tool assignment, choose a document, set appropriate tools, and
              review each student’s work without losing the course context.
            </p>
          </div>
          <ol className="canvas-workflow-list">
            <li>
              <h3>Choose the starting point.</h3>
              <p>
                Deep Linking is intended to offer an existing document, a new assignment, or a
                template. Drive and Canvas file import remain planned.
              </p>
            </li>
            <li>
              <h3>Set the assignment.</h3>
              <p>
                Configure instructions, points, course-aware dates, available tools, and submission
                rules. Settings that affect security require server enforcement.
              </p>
            </li>
            <li>
              <h3>Review in context.</h3>
              <p>
                See student work, add feedback on a separate layer, and move between students.
                Rubrics, scores, attempt history, and review navigation require the completed
                integration.
              </p>
            </li>
            <li>
              <h3>Return useful feedback.</h3>
              <p>
                Preserve feedback and grade state before external synchronization. Never silently
                overwrite previous submission attempts or mark an unconfirmed grade as synced.
              </p>
            </li>
          </ol>
        </section>
        <section className="ink-section" id="security">
          <div className="section-wrap security-layout">
            <div className="security-copy">
              <ShieldCheck size={36} strokeWidth={1} />
              <h2>
                School context.
                <br />
                Clear boundaries.
              </h2>
              <p>
                The intended integration uses server-validated LTI launches and the minimum
                permissions needed for a documented feature.
              </p>
              <ul className="plain-checks">
                <li>✓ Validate issuer, audience, signature, state, and nonce</li>
                <li>✓ Check deployment, role, course, and tenant access</li>
                <li>✓ Keep provider credentials off the browser</li>
                <li>✓ Encrypt documents and derived artifacts</li>
              </ul>
              <p className="fine-print">
                These are integration requirements, not a claim that the entire Canvas deployment is
                operational, audited, or certified.
              </p>
              <Link className="text-button" href="/security#main">
                Read current security boundaries <ArrowRight size={16} />
              </Link>
            </div>
            <div>
              <span className="eyebrow">A SCOPED CONNECTION — INTENDED MODEL</span>
              <div className="security-flow">
                <div className="security-node">
                  <strong>Organization → installation</strong>
                </div>
                <div className="canvas-line-arrow">↓</div>
                <div className="security-node">
                  <strong>Course → role → assignment</strong>
                </div>
                <div className="canvas-line-arrow">↓</div>
                <div className="security-node">
                  <strong>Personal document → permitted action</strong>
                </div>
              </div>
              <p className="fine-print" style={{ marginTop: 25 }}>
                A Canvas ID by itself is never authorization. Tenant isolation, replay protection,
                token rotation, auditing, retention, and fail-closed behavior need tested services
                and operating procedures.
              </p>
            </div>
          </div>
        </section>
        <section className="section-wrap" id="grades">
          <div className="split-heading">
            <div>
              <span className="eyebrow">GRADE PASSBACK / PLANNED</span>
              <h2>
                A grade saved.
                <br />
                <em>A grade confirmed.</em>
              </h2>
            </div>
            <p>
              Those are different moments. The intended flow saves the grade, requests passback, and
              waits for Canvas to confirm it.
            </p>
          </div>
          <div className="canvas-diagram">
            <span>Example score: 18 / 20</span>
            <ArrowRight size={17} />
            <span>Pending passback</span>
            <ArrowRight size={17} />
            <span>Canvas confirmation</span>
          </div>
          <div className="editorial-columns">
            <div>
              <h3>Safe to retry.</h3>
              <p>
                Idempotency, bounded retries, and clear failures are required. An unavailable Canvas
                service must not erase a grade or create a duplicate submission.
              </p>
            </div>
            <div>
              <h3>Respect the course.</h3>
              <p>
                Attempts, late status, due dates, and course timezones must come from appropriate
                Canvas context. Rubric synchronization must not be implied where unsupported.
              </p>
            </div>
          </div>
        </section>
        <section className="soft-section" id="offline">
          <div className="section-wrap">
            <div className="split-heading">
              <div>
                <span className="eyebrow">OFFLINE RECOVERY / INTEGRATION WORK AHEAD</span>
                <h2>
                  Wi-Fi can stop.
                  <br />
                  The thought can continue.
                </h2>
              </div>
              <p>
                Local editing and encrypted recovery already form part of Margin’s local foundation.
                The intended Canvas workflow builds on it, with an explicit distinction between work
                saved and assignment submitted.
              </p>
            </div>
            <div className="editorial-columns">
              <div>
                <h3>Saved work stays visible.</h3>
                <p>
                  Offline edits need an honest local-save state. Reconnection should reconcile
                  confirmed work before submission, with expiry and permission changes respected.
                </p>
              </div>
              <div>
                <h3>“Try again” should mean something.</h3>
                <p>
                  A failed Canvas request must leave work intact and explain what is still pending.
                  Offline submission and grade recovery are not yet verified in a real Canvas
                  environment.
                </p>
              </div>
            </div>
          </div>
        </section>
        <section className="section-wrap" id="setup">
          <div className="split-heading">
            <div>
              <span className="eyebrow">FOR IT / SETUP READINESS</span>
              <h2>
                A connection
                <br />
                <em>you can understand.</em>
              </h2>
            </div>
            <p>
              No “Connected” badge without a tested connection. This website does not accept
              institution settings, credentials, or deployment secrets.
            </p>
          </div>
          <div className="editorial-columns">
            <div>
              <h3>Prepare the institution context.</h3>
              <ul className="canvas-requirements">
                <li>Authorized Canvas test institution and administrator</li>
                <li>Reviewed LTI client, issuer, deployment, keys, and redirect configuration</li>
                <li>Documented Deep Linking, AGS, and roster permissions</li>
                <li>Test users, courses, assignments, and isolation cases</li>
              </ul>
            </div>
            <div>
              <h3>Define what “ready” means.</h3>
              <ul className="canvas-requirements">
                <li>Real teacher → student → review → grade workflow</li>
                <li>Outage, retry, replay, revoked access, and tenant tests</li>
                <li>Retention, support, audit, and incident procedures</li>
                <li>Institutional privacy and security approval</li>
              </ul>
            </div>
          </div>
          <div className="button-row" style={{ marginTop: 30 }}>
            <AccessButton kind="district">Prepare an evaluation brief</AccessButton>
            <WebAppLink>Explore the local editor</WebAppLink>
          </div>
        </section>
        <section className="soft-section" id="faq">
          <div className="section-wrap">
            <div className="section-heading">
              <span className="eyebrow">A FEW CLEAR ANSWERS</span>
              <h2>Before the first assignment.</h2>
            </div>
            <div className="canvas-faq">
              {faqs.map(([question, answer]) => (
                <details key={question}>
                  <summary>{question}</summary>
                  <p>{answer}</p>
                </details>
              ))}
            </div>
          </div>
        </section>
        <section className="pricing-section section-wrap">
          <span className="eyebrow">BUILT FOR A MORE THOUGHTFUL WORKFLOW</span>
          <h2>
            Less file juggling.
            <br />
            <em>More room to learn.</em>
          </h2>
          <p>
            Explore the local editor today. Evaluate the Canvas direction with a clear view of what
            remains to be built and verified.
          </p>
          <div className="button-row">
            <WebAppLink />
            <AccessButton kind="district" className="button secondary">
              Prepare a district brief
            </AccessButton>
          </div>
        </section>
      </main>
      <footer className="site-footer">
        <Link href="/#main" className="wordmark">
          margin<span>.</span>
        </Link>
        <p>A little more room for what matters.</p>
        <nav aria-label="Footer">
          <Link href="/security#main">Security</Link>
          <Link href="/privacy#main">Privacy</Link>
          <Link href="/#compare">Comparison</Link>
          <Link href="/methodology#main">Methodology</Link>
        </nav>
        <span>
          Canvas is a trademark of Instructure. No affiliation, certification, or endorsement is
          implied.
        </span>
      </footer>
    </>
  );
}
