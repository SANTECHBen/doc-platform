'use client';

import Link from 'next/link';
import {
  ArrowRight,
  Boxes,
  Building2,
  Check,
  FileCheck,
  QrCode,
  Tag,
  type LucideIcon,
} from 'lucide-react';
import type { AdminMetrics } from '@/lib/api';

interface Step {
  id: string;
  icon: LucideIcon;
  title: string;
  description: string;
  href: string;
  done: boolean;
}

export function SetupChecklist({ metrics }: { metrics: AdminMetrics }) {
  const steps: Step[] = [
    {
      id: 'org',
      icon: Building2,
      title: 'Create an organization',
      description:
        'Add your first OEM, dealer, or end customer. Everything else hangs off this.',
      href: '/tenants',
      done: metrics.organizations > 0,
    },
    {
      id: 'model',
      icon: Boxes,
      title: 'Register an asset model',
      description:
        'Define a piece of equipment (a SKU). You attach content and serial-numbered instances to it.',
      href: '/asset-models',
      done: metrics.assetModels > 0,
    },
    {
      id: 'pack',
      icon: FileCheck,
      title: 'Publish a content pack',
      description:
        'Upload documents and publish a version so asset hubs can display it to field techs.',
      href: '/content-packs',
      done: metrics.publishedContentPacks > 0,
    },
    {
      id: 'instance',
      icon: Tag,
      title: 'Register an asset instance',
      description:
        'Assign a serial number to a customer site. This is what QR codes point at.',
      href: '/asset-models',
      done: metrics.assetInstances > 0,
    },
    {
      id: 'qr',
      icon: QrCode,
      title: 'Generate a QR label',
      description:
        'Create a scannable label linked to an instance. Techs scan this in the field.',
      href: '/qr-codes',
      done: metrics.activeQrCodes > 0,
    },
  ];

  const done = steps.filter((s) => s.done).length;
  const total = steps.length;
  if (done === total) return null;

  const nextId = steps.find((s) => !s.done)?.id;
  const pct = Math.round((done / total) * 100);

  return (
    <section className="rounded-md border border-line bg-surface-raised p-5 md:p-6">
      <header className="mb-5 flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
        <div>
          <h2 className="text-lg font-semibold text-ink-primary">Getting started</h2>
          <p className="mt-0.5 text-sm text-ink-secondary">
            {done === 0
              ? 'Walk through these steps to get your first asset live in the PWA.'
              : `${done} of ${total} complete. Keep going — you're ${pct}% of the way there.`}
          </p>
        </div>
        <div className="flex items-center gap-3 md:shrink-0">
          <div className="relative h-1.5 w-32 overflow-hidden rounded-full bg-surface-inset">
            <div
              className="absolute inset-y-0 left-0 bg-brand transition-[width] duration-500"
              style={{ width: `${pct}%` }}
            />
          </div>
          <span className="tnum mono text-xs text-ink-tertiary">
            {done}/{total}
          </span>
        </div>
      </header>

      <ol className="flex flex-col gap-2">
        {steps.map((step) => (
          <ChecklistRow
            key={step.id}
            step={step}
            isNext={step.id === nextId}
          />
        ))}
      </ol>
    </section>
  );
}

function ChecklistRow({ step, isNext }: { step: Step; isNext: boolean }) {
  const Icon = step.icon;
  const rowStyle =
    isNext && !step.done
      ? ({ borderColor: 'rgb(var(--brand) / 0.45)' } as const)
      : undefined;

  return (
    <li>
      <Link
        href={step.href}
        className={`list-row group ${step.done ? 'opacity-60' : ''}`}
        style={rowStyle}
      >
        <div
          className={`icon-chip ${step.done ? 'icon-chip-ok' : isNext ? '' : 'icon-chip-neutral'}`}
        >
          {step.done ? (
            <Check size={16} strokeWidth={2.5} />
          ) : (
            <Icon size={16} strokeWidth={2} />
          )}
        </div>
        <div className="list-row-body">
          <div
            className={`list-row-title ${step.done ? 'line-through decoration-ink-tertiary' : ''}`}
          >
            {step.title}
          </div>
          <div className="list-row-desc">{step.description}</div>
        </div>
        {!step.done && (
          <span className="inline-flex shrink-0 items-center gap-1.5 text-sm font-medium text-brand group-hover:gap-2 transition-all">
            {isNext ? 'Start' : 'Go'}
            <ArrowRight size={14} strokeWidth={2} />
          </span>
        )}
      </Link>
    </li>
  );
}
