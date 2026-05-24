'use client';

// Resolve a Lucide icon name (from the API's curated allowlist) to a
// concrete React component. Unknown names render nothing — never throw,
// since the allowlist is allowed to drift across deploys. Kept in its
// own file so both the admin picker and any other consumer can reuse
// the same mapping.

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

export const CATEGORY_ICON_OPTIONS: ReadonlyArray<{
  value: string;
  label: string;
  Icon: ComponentType<SVGProps<SVGSVGElement> & { size?: number; strokeWidth?: number }>;
}> = [
  { value: 'shield-alert', label: 'Safety', Icon: ShieldAlert },
  { value: 'shield-check', label: 'Safe', Icon: ShieldCheck },
  { value: 'circle-check', label: 'Verify', Icon: CircleCheck },
  { value: 'clipboard-check', label: 'Checklist', Icon: ClipboardCheck },
  { value: 'wrench', label: 'Wrench', Icon: Wrench },
  { value: 'cog', label: 'Cog', Icon: Cog },
  { value: 'hammer', label: 'Hammer', Icon: Hammer },
  { value: 'lock', label: 'Lockout', Icon: Lock },
  { value: 'flame', label: 'Hazard', Icon: Flame },
  { value: 'zap', label: 'Electrical', Icon: Zap },
  { value: 'droplet', label: 'Fluid', Icon: Droplet },
  { value: 'ruler', label: 'Measure', Icon: Ruler },
  { value: 'camera', label: 'Camera', Icon: Camera },
  { value: 'eye', label: 'Inspect', Icon: Eye },
  { value: 'thermometer', label: 'Temp', Icon: Thermometer },
  { value: 'gauge', label: 'Gauge', Icon: Gauge },
  { value: 'package', label: 'Parts', Icon: Package },
  { value: 'sparkles', label: 'Cleanup', Icon: Sparkles },
];

const ICON_MAP = new Map(CATEGORY_ICON_OPTIONS.map((o) => [o.value, o.Icon]));

/**
 * Render a category icon by Lucide name. Returns null for unknown names
 * (safe fallback — the consumer gets back nothing and renders without an
 * icon, never an error).
 */
export function CategoryIcon({
  name,
  size = 14,
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
