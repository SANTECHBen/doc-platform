'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import {
  ArrowRight,
  Boxes,
  FileCheck,
  QrCode,
  Tag,
  type LucideIcon,
} from 'lucide-react';
import { getMetrics, type AdminMetrics } from '@/lib/api';

type Page = 'tenants' | 'asset-models' | 'content-packs' | 'qr-codes';

interface Hint {
  check: (m: AdminMetrics) => boolean;
  icon: LucideIcon;
  title: string;
  description: string;
  href: string;
  cta: string;
}

const HINTS: Record<Page, Hint> = {
  tenants: {
    check: (m) => m.organizations > 0 && m.assetModels === 0,
    icon: Boxes,
    title: 'Next: register an asset model',
    description:
      'An asset model is a SKU — content and serial-numbered instances hang off of it.',
    href: '/asset-models',
    cta: 'Asset models',
  },
  'asset-models': {
    check: (m) => m.assetModels > 0 && m.publishedContentPacks === 0,
    icon: FileCheck,
    title: 'Next: publish a content pack',
    description:
      'Attach documents, training, and parts to a model so field techs can view them.',
    href: '/content-packs',
    cta: 'Content packs',
  },
  'content-packs': {
    check: (m) => m.publishedContentPacks > 0 && m.assetInstances === 0,
    icon: Tag,
    title: 'Next: register an asset instance',
    description:
      'Assign a serial number to a customer site. This is what QR labels point at.',
    href: '/asset-models',
    cta: 'Asset models',
  },
  'qr-codes': {
    check: (m) => m.assetInstances > 0 && m.activeQrCodes === 0,
    icon: QrCode,
    title: 'Generate your first QR label',
    description:
      'A scannable label linked to an instance. Techs scan it on equipment to open the asset hub.',
    href: '/qr-codes',
    cta: 'Generate',
  },
};

export function NextStepHint({ page }: { page: Page }) {
  const [metrics, setMetrics] = useState<AdminMetrics | null>(null);

  useEffect(() => {
    getMetrics()
      .then(setMetrics)
      .catch(() => {
        // Silent — the hint is a nice-to-have, not critical.
      });
  }, []);

  const hint = HINTS[page];
  if (!metrics || !hint.check(metrics)) return null;
  const Icon = hint.icon;

  return (
    <section
      className="flex items-center gap-3 rounded-md border p-3 md:p-4"
      style={{
        borderColor: 'rgb(var(--brand) / 0.32)',
        background: 'rgba(var(--brand-soft-v), var(--brand-soft-a))',
      }}
    >
      <div className="icon-chip icon-chip-info">
        <Icon size={16} strokeWidth={2} />
      </div>
      <div className="min-w-0 flex-1">
        <h3 className="text-sm font-semibold text-ink-primary">{hint.title}</h3>
        <p className="mt-0.5 text-xs text-ink-secondary">{hint.description}</p>
      </div>
      <Link href={hint.href} className="btn btn-primary btn-sm shrink-0">
        {hint.cta}
        <ArrowRight size={14} strokeWidth={2} />
      </Link>
    </section>
  );
}
