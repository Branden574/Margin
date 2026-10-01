import { Search, Sidebar, MoreHorizontal } from 'lucide-react';
export function ProductWindow({
  children,
  title = 'Cell structure & function',
  dark = false,
  toolbar,
}: {
  children: React.ReactNode;
  title?: string;
  dark?: boolean;
  toolbar?: React.ReactNode;
}) {
  return (
    <div className={`product-window ${dark ? 'window-dark' : ''}`}>
      <div className="window-chrome">
        <span className="window-dots" aria-hidden="true">
          <i />
          <i />
          <i />
        </span>
        <span className="window-title">
          <span className="tiny-brand">m.</span>
          {title}
        </span>
        <span className="window-tools" aria-hidden="true">
          <Search size={14} />
          <Sidebar size={14} />
          <MoreHorizontal size={17} />
        </span>
      </div>
      {toolbar}
      <div className="window-content">{children}</div>
    </div>
  );
}
export function CellIllustration() {
  return (
    <svg
      className="cell-illustration"
      viewBox="0 0 280 160"
      role="img"
      aria-label="Original illustration of a plant cell"
    >
      <path
        d="M44 24C68 4 210 6 242 32c25 23 23 80-6 104-32 22-167 21-196-1C17 113 16 49 44 24Z"
        fill="#edf0df"
        stroke="#7c8b6a"
        strokeWidth="2"
      />
      <path
        d="M49 34c34-19 153-17 184 5 21 16 21 67-3 84-31 19-157 21-184 2-21-17-22-68 3-91Z"
        fill="#f8f7e9"
        stroke="#a6ad89"
        strokeWidth="2"
      />
      <ellipse cx="151" cy="84" rx="54" ry="39" fill="#dce7dc" stroke="#9eb5a0" />
      <ellipse cx="80" cy="80" rx="24" ry="27" fill="#dfcabb" stroke="#ab8268" />
      <ellipse cx="79" cy="82" rx="9" ry="11" fill="#a77763" />
      {[
        [58, 45],
        [53, 117],
        [212, 45],
        [215, 117],
        [119, 36],
      ].map(([x, y]) => (
        <ellipse
          key={`${x}${y}`}
          cx={x}
          cy={y}
          rx="13"
          ry="7"
          transform={`rotate(-25 ${x} ${y})`}
          fill="#8ea484"
          stroke="#6e8b64"
        />
      ))}
      <path
        d="M49 57q20-13 35 0m-42 46q16-8 39 7m109-51q27-9 37 7"
        fill="none"
        stroke="#b89974"
        strokeWidth="3"
        strokeLinecap="round"
      />
    </svg>
  );
}
