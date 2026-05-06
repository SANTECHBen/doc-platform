// Exploded-view assembly outline — geometric primitives with lead lines.
export default function NoParts({
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
      {/* Centerline cross */}
      <line x1="70" y1="22" x2="70" y2="118" strokeDasharray="2 4" opacity="0.4" />
      <line x1="22" y1="70" x2="118" y2="70" strokeDasharray="2 4" opacity="0.4" />
      {/* Center cube (isometric front face) */}
      <path d="M58 62 L82 62 L82 86 L58 86 Z" />
      <path d="M58 62 L66 56 L90 56 L82 62" />
      <path d="M82 86 L90 80 L90 56" />
      {/* Top cylinder (washer) */}
      <ellipse cx="70" cy="34" rx="12" ry="3" />
      <ellipse cx="70" cy="38" rx="12" ry="3" />
      <line x1="58" y1="34" x2="58" y2="38" />
      <line x1="82" y1="34" x2="82" y2="38" />
      {/* Bottom small disc */}
      <circle cx="70" cy="106" r="6" />
      <circle cx="70" cy="106" r="2" />
      {/* Lead lines */}
      <line x1="70" y1="42" x2="70" y2="56" strokeDasharray="2 2" opacity="0.6" />
      <line x1="70" y1="86" x2="70" y2="100" strokeDasharray="2 2" opacity="0.6" />
    </svg>
  );
}
