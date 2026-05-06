// Open ring binder schematic — implies authored docs that aren't here yet.
export default function NoDocuments({
  size = 140,
  className,
}: {
  size?: number;
  className?: string;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 140 140"
      fill="none"
      stroke="currentColor"
      strokeWidth="1"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden
    >
      {/* Left cover */}
      <rect x="20" y="36" width="48" height="76" rx="2" />
      {/* Right cover */}
      <rect x="72" y="36" width="48" height="76" rx="2" />
      {/* Spine */}
      <line x1="70" y1="36" x2="70" y2="112" />
      {/* Page lines, left */}
      <line x1="28" y1="50" x2="60" y2="50" />
      <line x1="28" y1="58" x2="56" y2="58" />
      <line x1="28" y1="66" x2="60" y2="66" />
      <line x1="28" y1="74" x2="52" y2="74" />
      {/* Page lines, right */}
      <line x1="80" y1="50" x2="112" y2="50" />
      <line x1="80" y1="58" x2="108" y2="58" />
      <line x1="80" y1="66" x2="112" y2="66" />
      <line x1="80" y1="74" x2="104" y2="74" />
      {/* Ring binders */}
      <circle cx="70" cy="52" r="2" />
      <circle cx="70" cy="74" r="2" />
      <circle cx="70" cy="96" r="2" />
    </svg>
  );
}
