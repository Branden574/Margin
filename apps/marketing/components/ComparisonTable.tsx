const sources = {
  markup: ['Markup tools', 'https://help.kamiapp.com/kami-help-center/markup-tool'],
  drawing: ['Drawing tools', 'https://help.kamiapp.com/kami-help-center/drawing-tool'],
  collaboration: [
    'Collaboration and document sharing',
    'https://www.kamiapp.com/products/kami-app/features/',
  ],
  offline: [
    'Offline mode and conditions',
    'https://help.kamiapp.com/kami-help-center/offline-mode',
  ],
  speech: ['Read Aloud tool', 'https://help.kamiapp.com/kami-help-center/read-aloud-tool'],
  ocr: ['Text Recognition tool', 'https://help.kamiapp.com/kami-help-center/text-recognition-tool'],
  privacy: ['Vendor privacy policy', 'https://www.kamiapp.com/privacy-policy/'],
  canvas: [
    'Canvas installation and grade sync',
    'https://help.kamiapp.com/kami-help-center/installing-the-kami-canvas-external-tool-integration',
  ],
  assignments: [
    'Creating Canvas assignments',
    'https://help.kamiapp.com/kami-help-center/creating-kami-assignments-in-canvas',
  ],
  review: [
    'Canvas Class View and SpeedGrader',
    'https://www.kamiapp.com/lesson/kami-and-canvas-getting-started/',
  ],
} as const;
type Row = { feature: string; margin: string; kami: string; source?: keyof typeof sources };
const rows: Row[] = [
  {
    feature: 'Core PDF markup',
    margin: 'Included locally',
    kami: 'Core markup available free',
    source: 'markup',
  },
  {
    feature: 'Drawing tools',
    margin: 'Pen and shapes locally',
    kami: 'Core drawing free; advanced tools paid',
    source: 'drawing',
  },
  {
    feature: 'Real-time collaboration',
    margin: 'Coming soon',
    kami: 'Documented',
    source: 'collaboration',
  },
  {
    feature: 'Classroom / LMS integration',
    margin: 'Coming soon',
    kami: 'Canvas integration on paid plans',
    source: 'canvas',
  },
  {
    feature: 'Offline workflow',
    margin: 'Local editing after first load',
    kami: 'Available after opening online; tool and device conditions',
    source: 'offline',
  },
  {
    feature: 'Text-to-speech',
    margin: 'Browser read aloud; available voices vary',
    kami: 'Read Aloud on paid plans',
    source: 'speech',
  },
  {
    feature: 'OCR for scanned PDFs',
    margin: 'Local printed English · one page at a time',
    kami: 'Text Recognition available on all plans',
    source: 'ocr',
  },
  { feature: 'Resumable uploads', margin: 'Optional local API', kami: 'Not verified' },
  { feature: 'Upload recovery', margin: 'Verified-chunk resume', kami: 'Not verified' },
  {
    feature: 'Local edit recovery',
    margin: 'Encrypted vault; unlock required',
    kami: 'Local offline saving and resync documented',
    source: 'offline',
  },
  {
    feature: 'Progressive large-PDF rendering',
    margin: 'Bounded rendering implemented',
    kami: 'Not evaluated',
  },
  { feature: 'Page reordering', margin: 'Included locally', kami: 'Not verified' },
  { feature: 'Page insertion', margin: 'Included locally', kami: 'Not verified' },
  {
    feature: 'PDF splitting / merging',
    margin: 'Selected-page export and merge',
    kami: 'Split and Merge listed as an online tool',
    source: 'offline',
  },
  { feature: 'Format conversion', margin: 'PNG/JPEG to PDF only', kami: 'Not verified' },
  { feature: 'Customizable toolbar', margin: 'Coming soon', kami: 'Not verified' },
  { feature: 'Command palette', margin: 'Local navigation commands', kami: 'Not verified' },
  {
    feature: 'Teacher / student workflow',
    margin: 'Local assignment sequence',
    kami: 'Canvas assignment workflow documented',
    source: 'assignments',
  },
  {
    feature: 'Assignment tool controls',
    margin: 'Coming soon',
    kami: 'Feature Control documented; configuration dependent',
    source: 'assignments',
  },
  { feature: 'Per-student controls', margin: 'Coming soon', kami: 'Not verified' },
  { feature: 'Admin feature policies', margin: 'Coming soon', kami: 'Not verified' },
  {
    feature: 'Version history',
    margin: 'Session undo; durable history planned',
    kami: 'Not verified',
  },
  {
    feature: 'Accessibility tools',
    margin: 'Contrast, reading, keyboard controls',
    kami: 'Read Aloud documented; paid plan',
    source: 'speech',
  },
  {
    feature: 'Encryption in transit',
    margin: 'HTTPS; API TLS 1.2+',
    kami: 'TLS stated in vendor policy',
    source: 'privacy',
  },
  {
    feature: 'Encryption at rest',
    margin: 'Encrypted local and API records',
    kami: 'Encryption stated in vendor policy',
    source: 'privacy',
  },
  {
    feature: 'Private file storage',
    margin: 'Local vault and owner-scoped API',
    kami: 'See vendor policy; not independently evaluated',
    source: 'privacy',
  },
  {
    feature: 'Document sharing',
    margin: 'Coming soon',
    kami: 'Sharing and live feedback documented',
    source: 'collaboration',
  },
  {
    feature: 'Managed SSO',
    margin: 'Configurable service; not provisioned',
    kami: 'Not verified in this comparison',
  },
  {
    feature: 'Audit logging',
    margin: 'Limited operational API logs',
    kami: 'Not independently evaluated',
  },
  {
    feature: 'Chrome extension permissions',
    margin: 'Three permissions; no host permissions',
    kami: 'Not evaluated',
  },
];
const canvasRows: Row[] = [
  {
    feature: 'Canvas LMS integration',
    margin: 'Coming soon',
    kami: 'Paid plan; course or institution install',
    source: 'canvas',
  },
  {
    feature: 'LTI 1.3 specifically',
    margin: 'Foundation in development',
    kami: 'Not verified; no absence claimed',
  },
  {
    feature: 'Canvas assignment launch',
    margin: 'Planned; real workflow unverified',
    kami: 'Assignment and External Tool workflow documented',
    source: 'assignments',
  },
  {
    feature: 'Student-specific document provisioning',
    margin: 'Planned',
    kami: 'Not verified in reviewed sources',
  },
  {
    feature: 'Direct submission workflow',
    margin: 'Planned; requires Canvas confirmation',
    kami: 'Not verified in reviewed sources',
  },
  {
    feature: 'Grade passback',
    margin: 'Planned; real workflow unverified',
    kami: 'Grade sync documented; paid integration',
    source: 'canvas',
  },
  {
    feature: 'Teacher review workflow',
    margin: 'Planned',
    kami: 'Class View and SpeedGrader documented',
    source: 'review',
  },
  {
    feature: 'Offline Canvas assignments',
    margin: 'Integration recovery unverified',
    kami: 'General offline mode documented; Canvas-specific path not verified',
    source: 'offline',
  },
  { feature: 'Submission recovery', margin: 'Planned', kami: 'Not verified in reviewed sources' },
  {
    feature: 'Admin integration controls',
    margin: 'Foundation in development',
    kami: 'Course and institution installation documented',
    source: 'canvas',
  },
  {
    feature: 'Integration audit logs',
    margin: 'Foundation in development',
    kami: 'Not verified in reviewed sources',
  },
];
function ComparisonRow({ row }: { row: Row }) {
  return (
    <tr>
      <th scope="row">{row.feature}</th>
      <td>
        <span className={row.margin === 'Coming soon' ? 'planned-status' : 'margin-status'}>
          {row.margin === 'Coming soon' ? '◐ ' : row.margin === 'Included locally' ? '✓ ' : ''}
          {row.margin}
        </span>
      </td>
      <td>
        {row.kami}
        {row.source && (
          <a
            className="comparison-source-link"
            href={sources[row.source][1]}
            aria-label={`Kami source for ${row.feature}: ${sources[row.source][0]}`}
          >
            Source ↗
          </a>
        )}
      </td>
    </tr>
  );
}
export function ComparisonTable() {
  return (
    <div className="comparison-table-wrap">
      <p className="comparison-note">
        Different products. Different stages. Here’s the honest version.
      </p>
      <div
        className="table-scroll"
        tabIndex={0}
        role="region"
        aria-label="Feature comparison, horizontally scrollable"
      >
        <table className="comparison-table">
          <thead>
            <tr>
              <th scope="col">What matters</th>
              <th scope="col">
                <span className="wordmark">
                  margin<span>.</span>
                </span>
                <small>Current local edition</small>
              </th>
              <th scope="col">
                Kami<small>Established classroom platform</small>
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <ComparisonRow key={row.feature} row={row} />
            ))}
            <tr className="comparison-group">
              <th colSpan={3} scope="colgroup">
                Canvas workflows · Margin’s complete integration is not yet verified
              </th>
            </tr>
            {canvasRows.map((row) => (
              <ComparisonRow key={row.feature} row={row} />
            ))}
          </tbody>
        </table>
      </div>
      <div className="comparison-sources">
        <p>
          Based on publicly available product information. Features may change and depend on plan,
          platform, or deployment. “Not verified” and “Not evaluated” mean no conclusion, not a
          missing feature. Cited Kami pages checked: October 1, 2026. Vendor security statements are
          not an independent audit.
        </p>
        <p>
          {Object.entries(sources).map(([key, [label, url]]) => (
            <a key={key} href={url}>
              {label} ↗
            </a>
          ))}
        </p>
        <p className="fine-print">
          ✓ Included locally · ◐ Coming soon. Configuration limits are written in each row. No
          relative performance result, certification, or claim that Margin is more secure is
          implied.
        </p>
      </div>
    </div>
  );
}
