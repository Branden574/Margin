import Link from 'next/link';
export function PolicyPage({
  title,
  eyebrow,
  children,
}: {
  title: string;
  eyebrow: string;
  children: React.ReactNode;
}) {
  return (
    <>
      <header className="policy-header">
        <Link href="/#main" className="wordmark">
          margin<span>.</span>
        </Link>
        <Link href="/#main">← Back to the story</Link>
      </header>
      <main id="main" className="policy-page">
        <span className="eyebrow">{eyebrow}</span>
        <h1>{title}</h1>
        {children}
        <hr />
        <p className="fine-print">
          Current local development edition · October 1, 2026. This page describes current
          boundaries, not a certification or contractual guarantee.
        </p>
      </main>
    </>
  );
}
