'use client';

// SegmentCard — the etched-tile button used on both the Library page's
// Documents/Training segmented control and the Maintenance page's
// category grid (Action / Upcoming / Walkthroughs / R&R / Troubleshoot /
// History). Same chrome on both pages so the tech sees one visual
// vocabulary across the app's navigation surfaces.
//
// API:
//   * required props: icon, label, active, onClick
//   * count   — optional digit shown on the right. When undefined the
//               icon+label center in the cell (Library uses this form).
//               When set, layout switches to [icon · label · count].
//   * tone    — optional warn/fault/ok tint. Drives a translucent
//               background + count color so the Action card can read
//               yellow (warn) and escalate to red (fault) without
//               changing layout.
//
// What this component DOES NOT own:
//   * The grid container (parent decides 1-row segmented control vs
//     multi-row grid).
//   * Disabled / loading affordances (no consumer needs them yet).
//
// Why the etched-tile base: matches every other interactive surface in
// the PWA — part rows, doc cards, file tiles all share it. New buttons
// stand out less than freshly-styled ones.

import type { SVGProps, ComponentType } from 'react';

export type SegmentCardTone = 'idle' | 'ok' | 'warn' | 'fault';

interface Props {
  icon: ComponentType<SVGProps<SVGSVGElement> & { size?: number; strokeWidth?: number }>;
  label: string;
  active: boolean;
  onClick: () => void;
  /** When provided, the card renders [icon · label · count]. When
   *  omitted, the card centers icon+label (used by the Library
   *  segmented control which has no count to surface). */
  count?: number;
  /** Background + count-color tint. Defaults to 'idle' (no tint). */
  tone?: SegmentCardTone;
  /** Optional aria label override — useful when the visible label is
   *  ambiguous out of context (e.g., the active-card icon disappears
   *  for screen readers but the parent wants extra context). */
  ariaLabel?: string;
}

export function SegmentCard({
  icon: Icon,
  label,
  active,
  onClick,
  count,
  tone = 'idle',
  ariaLabel,
}: Props) {
  const hasCount = count !== undefined;
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      aria-label={ariaLabel}
      data-active={active ? 'true' : 'false'}
      data-tone={tone}
      data-has-count={hasCount ? 'true' : 'false'}
      // .segment-card is the layout + state layer; .surface-etched
      // provides the shared chrome (inset shadow + border). Order
      // doesn't matter to CSS specificity but matches the visual
      // hierarchy: layout first, chrome second.
      className="segment-card surface-etched"
    >
      <Icon className="segment-card-icon" size={15} strokeWidth={2} aria-hidden />
      <span className="segment-card-label">{label}</span>
      {hasCount && <span className="segment-card-count">{count}</span>}
    </button>
  );
}
