import Link from 'next/link';
import { ArrowDown, ArrowRight, Check, Chrome, Feather, Monitor, ShieldCheck } from 'lucide-react';
import { Navbar } from '../components/Navbar';
import { AccessButton, WebAppLink } from '../components/Actions';
import { Reveal, ScrollProgress } from '../components/Motion';
import { HeroDemo } from '../components/HeroDemo';
import { UploadStory } from '../components/UploadStory';
import { AnnotationDemo } from '../components/AnnotationDemo';
import { Architecture, SecurityVisualization } from '../components/Architecture';
import { LazyDemo } from '../components/LazyDemo';
import { ComparisonTable } from '../components/ComparisonTable';
import { CanvasStory } from '../components/CanvasStory';
import { FinalOrbit } from '../components/FinalOrbit';

export default function Home() {
  return (
    <>
      <ScrollProgress />
      <Navbar />
      <main id="main">
        <section className="hero" id="product">
          <div className="hero-grain" aria-hidden="true" />
          <div className="hero-copy">
            <Reveal>
              <p className="eyebrow">
                <span className="accent-dash" />A LITTLE MORE ROOM FOR YOUR IDEAS
              </p>
              <h1>
                Your documents.
                <br />
                <span>
                  Finally, <em>Margin.</em>
                </span>
              </h1>
              <p className="hero-description">
                A calmer place to read, write, and think. Meet the document workspace that puts your
                ideas first.
              </p>
              <div className="button-row hero-actions">
                <AccessButton />
                <a href="#watch-demo" className="button secondary">
                  See it in action <ArrowDown size={16} />
                </a>
              </div>
              <p className="hero-footnote">
                PDFs, notes, and a little peace of mind. <span>Local edition · in development</span>
              </p>
            </Reveal>
          </div>
          <HeroDemo />
          <div className="integrations-line">
            <span>YOUR CLASSROOM CONNECTIONS, NEXT</span>
            <div>
              Google Drive <i />
              Classroom <i />
              OneDrive <i />
              <Link href="/integrations/canvas#main">Canvas ↗</Link>
              <i />
              Schoology
            </div>
            <small>All integrations listed above are coming soon.</small>
          </div>
        </section>

        <section className="ink-section speed-section" id="speed">
          <div className="section-wrap">
            <Reveal>
              <span className="eyebrow">01 / GIVE YOUR BROWSER SOME BREATHING ROOM</span>
              <h2>
                Your document shouldn’t
                <br />
                freeze your browser.
              </h2>
              <p className="section-intro">
                A page at a time. Work in the background.
                <br />
                Built thoughtfully from the beginning.
              </p>
            </Reveal>
            <Architecture />
            <div className="feature-line">
              <span>Progressive rendering</span>
              <span>Background processing</span>
              <span>Resumable uploads</span>
              <span>Local autosave</span>
              <span>Smart caching</span>
            </div>
            <p className="fine-print">
              Engineering choices, not benchmark claims.{' '}
              <Link href="/methodology#main">See what still needs measuring ↗</Link>
            </p>
          </div>
        </section>
        <UploadStory />

        <section className="section-wrap annotation-section" id="annotations">
          <Reveal>
            <div className="section-heading">
              <span className="eyebrow">03 / THINK RIGHT ON THE PAGE</span>
              <h2>
                Everything you reach for.
                <br />
                <em>Nothing in your way.</em>
              </h2>
              <p>Follow a thought. Circle a possibility. Leave a better question.</p>
            </div>
          </Reveal>
          <AnnotationDemo />
        </section>

        <section className="ink-section large-document-section" id="large-documents">
          <div className="section-wrap">
            <Reveal>
              <div className="split-heading">
                <div>
                  <span className="eyebrow">04 / MORE PAGES. LESS WEIGHT.</span>
                  <h2>
                    347 pages shouldn’t
                    <br />
                    feel like 347 pages.
                  </h2>
                </div>
                <p>
                  Keep the page you need close. Let the rest wait their turn. Try the scrubber to
                  explore the idea.
                </p>
              </div>
            </Reveal>
            <LazyDemo name="pages" label="A page scrubber with three lightweight page previews" />
          </div>
        </section>

        <section className="section-wrap recovery-section" id="offline">
          <Reveal>
            <div className="split-heading">
              <div>
                <span className="eyebrow">05 / A THOUGHT WORTH KEEPING</span>
                <h2>
                  Your work should survive
                  <br />
                  <em>the unexpected.</em>
                </h2>
              </div>
              <p>
                School Wi-Fi happens. Your next idea shouldn’t depend on it. Local saving and a
                clear recovery path come first.
              </p>
            </div>
          </Reveal>
          <LazyDemo name="recovery" label="Write, save, close, and restore an illustrative note" />
          <div className="editorial-columns">
            <div>
              <h3>School Wi-Fi happens.</h3>
              <p>
                The local app can edit offline after its application assets have loaded. Your
                encrypted vault stays on the device.
              </p>
            </div>
            <div>
              <h3>Know where your work stands.</h3>
              <p>
                Save status and errors are visible. Refresh recovery requires your passphrase. Cloud
                annotation synchronization and durable version history remain planned.
              </p>
            </div>
          </div>
        </section>

        <section className="soft-section" id="collaboration">
          <div className="section-wrap">
            <div className="split-heading">
              <div>
                <span className="eyebrow">06 / BETTER TOGETHER — COMING SOON</span>
                <h2>
                  Good ideas
                  <br />
                  make conversation.
                </h2>
              </div>
              <p>
                Live presence, shared annotations, and thoughtful replies are part of the direction.
                This is a concept, not a connected collaboration service.
              </p>
            </div>
            <LazyDemo
              name="collaboration"
              label="An illustrative teacher and student conversation"
            />
          </div>
        </section>

        <section className="section-wrap" id="scans">
          <Reveal>
            <div className="section-heading">
              <span className="eyebrow">07 / WHAT’S NEXT FOR PAPER</span>
              <h2>
                Turn scans into
                <br />
                <em>something useful.</em>
              </h2>
              <p>
                Searchable text. A sentence you can select. A page you can listen to.
                <br />
                Recognize printed English locally, one page at a time. Copy, search, highlight, or
                listen with local voices. Recognized text is stored encrypted beside your PDF.
              </p>
            </div>
          </Reveal>
          <LazyDemo name="ocr" label="An illustrative OCR preview with a prepared translation" />
        </section>

        <section className="soft-section" id="students">
          <div className="section-wrap">
            <div className="split-heading">
              <div>
                <span className="eyebrow">08 / MAKE ROOM FOR DIFFERENT MINDS</span>
                <h2>
                  Accessibility belongs
                  <br />
                  in the workspace.
                </h2>
              </div>
              <p>
                Start with contrast, comfortable reading, and keyboard access. Keep building toward
                more ways to understand a page.
              </p>
            </div>
            <LazyDemo
              name="accessibility"
              label="Contrast, spacing, and planned reading-support illustrations"
            />
          </div>
        </section>

        <section className="section-wrap" id="teachers">
          <Reveal>
            <div className="section-heading">
              <span className="eyebrow">09 / FOR THE MOMENTS THAT MATTER</span>
              <h2>
                From worksheet to feedback.
                <br />
                <em>One thoughtful workflow.</em>
              </h2>
              <p>Less time finding the file. More time asking the next good question.</p>
            </div>
          </Reveal>
          <LazyDemo name="teacher" label="A fictional local assignment and feedback workflow" />
        </section>

        <section className="ink-section" id="schools">
          <div className="section-wrap">
            <div className="split-heading">
              <div>
                <span className="eyebrow">10 / A DIRECTION FOR SCHOOLS</span>
                <h2>
                  Teachers get flexibility.
                  <br />
                  IT keeps a clear view.
                </h2>
              </div>
              <p>
                District, school, and class policies are coming soon. Explore the intended controls,
                then prepare an evaluation brief.
              </p>
            </div>
            <LazyDemo
              name="admin"
              label="An illustrative district policy panel; no real policies are applied"
            />
            <div className="school-followup">
              <span>
                School identity, SSO, audit trails, retention policies, and managed deployment
                require production services.
              </span>
              <AccessButton kind="district" className="button light">
                Request a district demo <ArrowRight size={15} />
              </AccessButton>
            </div>
          </div>
        </section>

        <section className="section-wrap" id="canvas">
          <Reveal>
            <div className="section-heading">
              <span className="eyebrow">CANVAS / THE NEXT CHAPTER — PLANNED</span>
              <h2>
                Less file juggling.
                <br />
                <em>More room for the work.</em>
              </h2>
              <p>
                Built to make the space between Canvas assignments and Canvas submissions simpler.
                Explore the intended workflow, with each state kept honest.
              </p>
            </div>
          </Reveal>
          <CanvasStory />
          <div className="canvas-route-link">
            <Link href="/integrations/canvas#main" className="text-button">
              Explore the Canvas integration plan <ArrowRight size={16} />
            </Link>
          </div>
        </section>

        <section className="ink-section security-section" id="security">
          <div className="section-wrap security-layout">
            <div className="security-copy">
              <span className="eyebrow">11 / BUILT AROUND YOUR TRUST</span>
              <h2>
                Your documents
                <br />
                are <em>yours.</em>
              </h2>
              <p>
                Security deserves specifics. Here are the controls in the local foundation, and the
                work still ahead.
              </p>
              <ul className="plain-checks">
                <li>
                  <Check size={16} />
                  Passphrase-protected encrypted local vault
                </li>
                <li>
                  <Check size={16} />
                  HTTPS transport and encrypted API artifacts
                </li>
                <li>
                  <Check size={16} />
                  Owner and tenant checks in the local API
                </li>
                <li>
                  <Check size={16} />
                  Minimal extension permissions
                </li>
              </ul>
              <p className="fine-print">
                The local API uses expiring development tokens and quarantines uploads. Production
                role-based identity, independently reviewed cloud deployment, malware scanning, and
                compliance operations are not established.
              </p>
              <Link href="/security#main" className="text-button">
                Read the security boundary <ArrowRight size={16} />
              </Link>
            </div>
            <SecurityVisualization />
          </div>
        </section>

        <section className="section-wrap comparison-section" id="compare">
          <Reveal>
            <div className="section-heading">
              <span className="eyebrow">12 / A CLEARER CHOICE STARTS WITH THE FACTS</span>
              <h2>
                A modern alternative.
                <br />
                <em>An honest comparison.</em>
              </h2>
              <p>
                Kami already offers substantial classroom, collaboration, and accessibility tools.
                <br />
                Margin is a local foundation with a different product direction.
              </p>
            </div>
          </Reveal>
          <ComparisonTable />
        </section>

        <section className="benchmark-section section-wrap" id="benchmarks">
          <div>
            <span className="eyebrow">MEASURE THE EXPERIENCE</span>
            <h2>
              Don’t take
              <br />
              our word for it.
            </h2>
            <p>
              Reproducible performance results belong here.
              <br />
              Until then, we’ll leave the numbers out.
            </p>
            <Link href="/methodology#main" className="button secondary">
              View methodology <ArrowRight size={15} />
            </Link>
          </div>
          <div className="benchmark-ledger">
            <span className="status-stamp">BENCHMARKING IN PROGRESS</span>
            {[
              '100 MB upload',
              '300-page PDF opening',
              '1,000 annotations',
              'Interrupted upload recovery',
              'Memory and time to first page',
              'Interaction latency on Chromebooks',
            ].map((name) => (
              <div key={name}>
                <span>{name}</span>
                <span>Pending</span>
              </div>
            ))}
          </div>
        </section>

        <section className="soft-section hardware-section">
          <div className="section-wrap">
            <span className="eyebrow">DESIGNED WITH CLASSROOM HARDWARE IN MIND</span>
            <h2>
              Good tools shouldn’t
              <br />
              need extraordinary computers.
            </h2>
            <div
              className="hardware-illustration"
              aria-label="Original illustration of a classroom laptop"
            >
              <div className="laptop-display">
                <span className="wordmark">
                  margin<span>.</span>
                </span>
                <div className="laptop-paper">
                  <span />
                  <span />
                  <span />
                  <i />
                </div>
              </div>
              <div className="laptop-base" />
            </div>
            <div className="hardware-notes">
              <span>
                <Feather size={18} />
                Lightweight launcher
              </span>
              <span>
                <Monitor size={18} />
                Bounded rendering
              </span>
              <span>
                <ShieldCheck size={18} />
                Background processing
              </span>
            </div>
            <p>
              Low-memory Chromebook and managed-device testing is still pending.
              <br />
              No claim of equivalent performance across hardware.
            </p>
          </div>
        </section>

        <section className="section-wrap command-section" id="commands">
          <div className="split-heading">
            <div>
              <span className="eyebrow">13 / FIND YOUR NEXT MOVE</span>
              <h2>
                More possibility.
                <br />
                <em>Fewer buttons.</em>
              </h2>
            </div>
            <p>
              A command palette makes space on the page. Local document navigation is available;
              advanced commands shown here are examples or planned tools.
            </p>
          </div>
          <LazyDemo name="command" label="A keyboard-accessible command palette illustration" />
        </section>

        <section className="section-wrap">
          <div className="section-heading">
            <span className="eyebrow">MAKE A LITTLE ROOM</span>
            <h2>A clearer way through.</h2>
            <p>Move the slider. See what a little less clutter can do.</p>
          </div>
          <LazyDemo
            name="comparison"
            label="Compare two original document-workflow illustrations"
          />
        </section>

        <section className="trust-section section-wrap">
          <div className="trust-statement">
            <ShieldCheck size={38} strokeWidth={1.1} />
            <h2>
              Built with student
              <br />
              privacy in mind.
            </h2>
            <p>
              Encrypted documents and private local storage are here. School permissions, SSO, full
              audit trails, admin policies, and retention operations are still work ahead.
            </p>
            <div className="inline-links">
              <Link href="/privacy#main">Privacy</Link>
              <Link href="/data-processing#main">Data processing</Link>
              <Link href="/disclosure#main">Responsible disclosure</Link>
            </div>
          </div>
          <div className="voices">
            <span className="eyebrow">THE NEXT VOICES SHOULD BE REAL</span>
            <h3>
              No borrowed trust.
              <br />
              No invented stories.
            </h3>
            <p>
              Customer testimonials will appear only with genuine experience and permission. For
              now, there are no customer quotes or certifications to display.
            </p>
            <div>
              <span>Teachers</span>
              <span>Students</span>
              <span>School IT</span>
            </div>
            <AccessButton kind="district" className="text-button">
              Help shape an evaluation <ArrowRight size={16} />
            </AccessButton>
          </div>
        </section>

        <section className="pricing-section section-wrap" id="pricing">
          <span className="eyebrow">AN HONEST START</span>
          <h2>
            Explore the local edition.
            <br />
            Pricing can wait.
          </h2>
          <p>
            No paid plans or school pricing have been announced. The current edition runs from the
            project source; it is not a hosted school service.
          </p>
          <div className="button-row">
            <WebAppLink />
            <AccessButton kind="district" className="text-button">
              Prepare a school evaluation <ArrowRight size={16} />
            </AccessButton>
          </div>
        </section>

        <section className="finale">
          <FinalOrbit />
          <Reveal>
            <div className="final-monogram">m.</div>
            <p className="eyebrow">ONE WORKSPACE. ROOM FOR EVERY DOCUMENT.</p>
            <h2>
              Documents should
              <br />
              <em>work better.</em>
            </h2>
            <p>
              Room for students to think. Room for teachers to teach.
              <br />A clear path toward the controls schools need.
            </p>
            <div className="button-row">
              <AccessButton />
              <WebAppLink />
            </div>
            <AccessButton kind="district" className="text-button">
              Request a school demo <ArrowRight size={15} />
            </AccessButton>
            <small>Start locally. Planned school services remain clearly marked.</small>
          </Reveal>
        </section>
      </main>
      <footer className="site-footer">
        <a href="#main" className="wordmark">
          margin<span>.</span>
        </a>
        <p>A little more room for what matters.</p>
        <nav aria-label="Footer">
          <Link href="/security#main">Security</Link>
          <Link href="/privacy#main">Privacy</Link>
          <Link href="/data-processing#main">Data processing</Link>
          <Link href="/disclosure#main">Responsible disclosure</Link>
          <Link href="/methodology#main">Methodology</Link>
          <Link href="/integrations/canvas#main">Canvas</Link>
        </nav>
        <span>© 2026 Margin. An independent product in development.</span>
      </footer>
    </>
  );
}
