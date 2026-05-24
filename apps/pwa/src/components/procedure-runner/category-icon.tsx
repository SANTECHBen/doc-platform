'use client';

// Resolve a Lucide icon name (from the API's curated allowlist) to a
// concrete React component. Mirrors the admin side's category-icon
// helper. Unknown names render nothing — safe fallback if the allowlist
// drifts across deploys.

import type { ComponentType, SVGProps } from 'react';
import {
  Camera,
  Cog,
  CircleCheck,
  ClipboardCheck,
  Droplet,
  Eye,
  Flame,
  Gauge,
  Hammer,
  Lock,
  Package,
  Ruler,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  Thermometer,
  Wrench,
  Zap,
} from 'lucide-react';

const ICON_MAP = new Map<
  string,
  ComponentType<SVGProps<SVGSVGElement> & { size?: number; strokeWidth?: number }>
>([
  ['shield-alert', ShieldAlert],
  ['shield-check', ShieldCheck],
  ['circle-check', CircleCheck],
  ['clipboard-check', ClipboardCheck],
  ['wrench', Wrench],
  ['cog', Cog],
  ['hammer', Hammer],
  ['lock', Lock],
  ['flame', Flame],
  ['zap', Zap],
  ['droplet', Droplet],
  ['ruler', Ruler],
  ['camera', Camera],
  ['eye', Eye],
  ['thermometer', Thermometer],
  ['gauge', Gauge],
  ['package', Package],
  ['sparkles', Sparkles],
]);

export function CategoryIcon({
  name,
  size = 12,
  strokeWidth = 2,
  className,
}: {
  name: string | null | undefined;
  size?: number;
  strokeWidth?: number;
  className?: string;
}) {
  if (!name) return null;
  const Icon = ICON_MAP.get(name);
  if (!Icon) return null;
  return <Icon size={size} strokeWidth={strokeWidth} className={className} />;
}
