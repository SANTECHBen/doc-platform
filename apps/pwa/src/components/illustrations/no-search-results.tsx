// Magnifier over a parts grid with no match — implies a search returned nothing.
export default function NoSearchResults({
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
      {/* Parts grid (3x3, lower opacity behind magnifier) */}
      <g opacity="0.45">
        <rect x="22" y="22" width="22" height="22" />
        <rect x="48" y="22" width="22" height="22" />
        <rect x="74" y="22" width="22" height="22" />
        <rect x="22" y="48" width="22" height="22" />
        <rect x="48" y="48" width="22" height="22" />
        <rect x="74" y="48" width="22" height="22" />
        <rect x="22" y="74" width="22" height="22" />
        <rect x="48" y="74" width="22" height="22" />
        <rect x="74" y="74" width="22" height="22" />
      </g>
      {/* Magnifier lens */}
      <circle cx="84" cy="84" r="22" />
      {/* Inner emptiness — diagonal "no match" slash inside the lens */}
      <line x1="74" y1="94" x2="94" y2="74" strokeWidth="1.25" />
      {/* Handle */}
      <line x1="100" y1="100" x2="118" y2="118" strokeWidth="1.5" />
    </svg>
  );
}
