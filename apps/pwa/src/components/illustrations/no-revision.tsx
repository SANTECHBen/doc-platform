// Blueprint sheet with empty title block — implies no content pack version
// has been pinned to this asset yet.
export default function NoRevision({
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
      {/* Sheet */}
      <path d="M22 18 H106 L118 30 V122 H22 Z" />
      {/* Corner fold */}
      <path d="M106 18 V30 H118" />
      {/* Inner drafting border */}
      <rect x="30" y="26" width="80" height="84" strokeDasharray="2 3" opacity="0.5" />
      {/* Dimension extension + arrows */}
      <line x1="42" y1="48" x2="86" y2="48" />
      <line x1="42" y1="44" x2="42" y2="52" />
      <line x1="86" y1="44" x2="86" y2="52" />
      {/* Title block (REV slot empty) */}
      <rect x="74" y="92" width="32" height="18" />
      <line x1="74" y1="100" x2="106" y2="100" />
      <line x1="90" y1="92" x2="90" y2="110" />
      {/* Em-dash in REV cell to hint "no revision" */}
      <line x1="80" y1="105" x2="86" y2="105" strokeWidth="1.25" />
    </svg>
  );
}
