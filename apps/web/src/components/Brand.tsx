export function Brand({ compact = false }: { compact?: boolean }) {
  return (
    <div className="brand">
      <svg viewBox="0 0 32 34" width="29" height="31" fill="none" aria-hidden="true">
        <path d="M3 8.5 13.5 3v24L3 32V8.5Z" fill="currentColor" />
        <path d="m17 5 11 5.5v23L17 28V5Z" fill="currentColor" opacity=".72" />
        <path d="m17 1 11 5.5v3L17 4V1Z" fill="currentColor" opacity=".42" />
      </svg>
      {!compact && (
        <span>
          margin<span className="brand-period">.</span>
        </span>
      )}
    </div>
  );
}
