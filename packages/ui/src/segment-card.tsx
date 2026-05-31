'use client';

// SegmentCard — the etched-tile button used on segmented controls and
// category grids. Originally a PWA-only component; lives here so the
// admin can pick it up for filter/category controls that hand-roll the
// same shape today.
//
// API:
//   * required: icon, label, active, onClick
//   * count   — optional digit shown on the right. When undefined the
//               icon+label center in the cell. When set, layout switches
//               to [icon · label · count].
//   * tone    — optional warn/fault/ok tint. Drives a translucent
//               background + count color so the Action card can read
//               yellow (warn) and escalate to red (fault) without
//               changing layout.

import type { SVGProps, ComponentType } from 'react';

export type SegmentCardTone = 'idle' | 'ok' | 'warn' | 'fault';

export interface SegmentCardProps {
  icon: ComponentType<SVGProps<SVGSVGElement> & { size?: number; strokeWidth?: number }>;
  label: string;
  active: boolean;
  onClick: () => void;
  /** When provided, the card renders [icon · label · count]. When
   *  omitted, the card centers icon+label. */
  count?: number;
  /** Background + count-color tint. Defaults to 'idle' (no tint). */
  tone?: SegmentCardTone;
  /** Optional aria label override — useful when the visible label is
   *  ambiguous out of context. */
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
}: SegmentCardProps) {
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
      className="segment-card surface-etched"
    >
      <Icon className="segment-card-icon" size={15} strokeWidth={2} aria-hidden />
      <span className="segment-card-label">{label}</span>
      {hasCount && <span className="segment-card-count">{count}</span>}
    </button>
  );
}
