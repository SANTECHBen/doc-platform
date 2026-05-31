'use client';

// Design system reference — a single-page index of every primitive, token,
// and pattern used across FieldSupport. New contributors land here before
// rolling their own component; existing authors check here when looking
// for the right class/component.
//
// Live examples (left) + copy-pasteable code (right) for each primitive.
// Auth-gated only — no platform-admin check. Reachable from the sidebar
// footer.

import { useState, type ReactNode } from 'react';
import {
  AlertTriangle,
  Box,
  CheckCircle2,
  ChevronRight,
  Copy,
  FileText,
  Inbox,
  Info,
  Plus,
  Search,
  ShieldAlert,
  Sparkles,
  Wrench,
  X,
} from 'lucide-react';
import { PageHeader, PageShell, Pill } from '@/components/page-shell';
import {
  EmptyState,
  ErrorBanner,
  SegmentCard,
  Skeleton,
} from '@platform/ui';

export default function DesignSystemPage() {
  return (
    <PageShell crumbs={[{ label: 'Design system' }]}>
      <PageHeader
        title="Design system"
        description="Tokens, primitives, and patterns used across the FieldSupport admin and PWA. Copy any code block as a starting point."
      />

      <TableOfContents />

      <Section id="tokens-color" title="Color tokens" description="Semantic surfaces and signal colors used throughout both apps. Raw values live as CSS custom properties in globals.css and adapt to light/dark theme automatically.">
        <SubSection title="Surface">
          <TokenSwatchRow tokens={[
            { name: 'surface-base', cssVar: '--surface-base', usage: 'Page background.' },
            { name: 'surface-raised', cssVar: '--surface-raised', usage: 'Cards, modals, table rows.' },
            { name: 'surface-elevated', cssVar: '--surface-elevated', usage: 'Hover state of raised surfaces.' },
            { name: 'surface-inset', cssVar: '--surface-inset', usage: 'Inputs, code blocks, well-style insets.' },
            { name: 'surface-sidebar', cssVar: '--surface-sidebar', usage: 'Always-dark left rail.' },
          ]} />
        </SubSection>

        <SubSection title="Ink (text)">
          <TokenSwatchRow tokens={[
            { name: 'ink-primary', cssVar: '--ink-primary', usage: 'Headings and primary body copy.' },
            { name: 'ink-secondary', cssVar: '--ink-secondary', usage: 'Supporting copy, descriptions.' },
            { name: 'ink-tertiary', cssVar: '--ink-tertiary', usage: 'Metadata, hints, disabled-ish text.' },
            { name: 'ink-brand', cssVar: '--ink-brand', usage: 'Brand-tinted text (avoid for body copy).' },
            { name: 'ink-inverse', cssVar: '--ink-inverse', usage: 'Text on filled brand/dark surfaces.' },
          ]} />
        </SubSection>

        <SubSection title="Brand">
          <TokenSwatchRow tokens={[
            { name: 'brand', cssVar: '--brand', usage: 'Primary brand fill — buttons, active states.' },
            { name: 'brand-strong', cssVar: '--brand-strong', usage: 'Hover/pressed state of brand fills.' },
            { name: 'brand-ink', cssVar: '--brand-ink', usage: 'Text laid on top of a brand fill.' },
          ]} />
        </SubSection>

        <SubSection title="Signal (OSHA-aligned)">
          <TokenSwatchRow tokens={[
            { name: 'signal-ok', cssVar: '--signal-ok', usage: 'Healthy state, resolved, success.' },
            { name: 'signal-warn', cssVar: '--signal-warn', usage: 'Needs attention now, overdue.' },
            { name: 'signal-fault', cssVar: '--signal-fault', usage: 'Active alarm, blocking error, critical.' },
            { name: 'signal-info', cssVar: '--signal-info', usage: 'Neutral status, informational.' },
            { name: 'signal-safety', cssVar: '--signal-safety', usage: 'Safety callout (LOTO, PPE).' },
          ]} />
        </SubSection>

        <SubSection title="Line (borders)">
          <TokenSwatchRow tokens={[
            { name: 'line-subtle', cssVar: '--line-subtle', usage: 'Quietest hairline — row dividers.' },
            { name: 'line', cssVar: '--line', usage: 'Default border — cards, inputs.' },
            { name: 'line-strong', cssVar: '--line-strong', usage: 'Hover-state borders, table headers.' },
          ]} />
        </SubSection>
      </Section>

      <Section id="tokens-typography" title="Typography" description="Industrial scale — tight line heights, precise steps. Pair IBM Plex Sans for prose with IBM Plex Mono for any value that reads as machine data (PN, serials, ref codes, measurements).">
        <SubSection title="Scale">
          <div className="flex flex-col gap-3">
            {[
              { cls: 'text-3xl', label: 'text-3xl' },
              { cls: 'text-2xl', label: 'text-2xl' },
              { cls: 'text-xl', label: 'text-xl' },
              { cls: 'text-lg', label: 'text-lg' },
              { cls: 'text-base', label: 'text-base' },
              { cls: 'text-sm', label: 'text-sm' },
              { cls: 'text-xs', label: 'text-xs' },
            ].map((t) => (
              <div key={t.cls} className="flex items-baseline gap-4">
                <code className="w-24 shrink-0 font-mono text-xs text-ink-tertiary">{t.label}</code>
                <span className={`${t.cls} text-ink-primary`}>The quick brown fox</span>
              </div>
            ))}
          </div>
        </SubSection>

        <SubSection title="Captions" description="Two distinct primitives. .caption / .cap is sentence-case sans-serif (prose). .cap-mono is mono + uppercase tracked (SCADA data labels). Common mistake: putting ALL-CAPS source text on .caption expecting a SCADA look — the result is literal CAPS in sans-serif. Switch to .cap-mono and let the CSS handle the uppercase work.">
          <div className="flex flex-col gap-4">
            <Pair
              left={<span className="caption">Open work orders</span>}
              right={`<span className="caption">Open work orders</span>`}
            />
            <Pair
              left={<span className="cap-mono">SERIAL NUMBER</span>}
              right={`<span className="cap-mono">Serial number</span>`}
              note="Source text can be sentence-case; CSS handles the uppercase."
            />
          </div>
        </SubSection>
      </Section>

      <Section id="buttons" title="Buttons" description="The .btn family. Three sizes (btn-sm 30px, btn 36px, btn-lg 44px). Five variants. Compose with Lucide icons inline; aria-label any icon-only button.">
        <SubSection title="Variants">
          <div className="flex flex-wrap gap-3">
            <button className="btn btn-primary">Primary</button>
            <button className="btn btn-secondary">Secondary</button>
            <button className="btn btn-ghost">Ghost</button>
            <button className="btn btn-outline">Outline</button>
            <button className="btn btn-danger">Danger</button>
          </div>
          <CodeBlock>{`<button className="btn btn-primary">Primary</button>
<button className="btn btn-secondary">Secondary</button>
<button className="btn btn-ghost">Ghost</button>
<button className="btn btn-outline">Outline</button>
<button className="btn btn-danger">Danger</button>`}</CodeBlock>
        </SubSection>

        <SubSection title="Sizes">
          <div className="flex flex-wrap items-end gap-3">
            <button className="btn btn-primary btn-sm">btn-sm</button>
            <button className="btn btn-primary">btn (default)</button>
            <button className="btn btn-primary btn-lg">btn-lg</button>
          </div>
        </SubSection>

        <SubSection title="With icon">
          <div className="flex flex-wrap gap-3">
            <button className="btn btn-primary">
              <Plus size={14} strokeWidth={2} /> New item
            </button>
            <button className="btn btn-secondary">
              <FileText size={14} strokeWidth={2} /> Open doc
            </button>
          </div>
          <CodeBlock>{`<button className="btn btn-primary">
  <Plus size={14} strokeWidth={2} /> New item
</button>`}</CodeBlock>
        </SubSection>

        <SubSection title="States">
          <div className="flex flex-wrap gap-3">
            <button className="btn btn-primary" disabled>Disabled</button>
            <button className="btn btn-primary btn-loading">Loading</button>
          </div>
          <CodeBlock>{`<button className="btn btn-primary" disabled>Disabled</button>
<button className="btn btn-primary btn-loading">Loading</button>`}</CodeBlock>
        </SubSection>
      </Section>

      <Section id="pills" title="Pills" description="Compact status tags. Mono uppercase, six tones. Use for org type, work-order severity, training status.">
        <div className="flex flex-wrap gap-2">
          <Pill tone="default">default</Pill>
          <Pill tone="success">success</Pill>
          <Pill tone="warning">warning</Pill>
          <Pill tone="danger">danger</Pill>
          <Pill tone="info">info</Pill>
        </div>
        <CodeBlock>{`import { Pill } from '@/components/page-shell';

<Pill tone="success">resolved</Pill>
<Pill tone="warning">overdue</Pill>
<Pill tone="danger">critical</Pill>`}</CodeBlock>
      </Section>

      <Section id="leds" title="LEDs" description="Status dots with optional pulse. 8px disc with a glow halo. Pair with .pill or a short status label.">
        <div className="flex flex-wrap items-center gap-6">
          <LedSample className="led" label="info (pulse)" />
          <LedSample className="led led-ok" label="ok" />
          <LedSample className="led led-warn" label="warn" />
          <LedSample className="led led-fault" label="fault" />
          <LedSample className="led led-idle" label="idle" />
        </div>
        <CodeBlock>{`<span className="led" />            {/* info, pulses */}
<span className="led led-ok" />     {/* green */}
<span className="led led-warn" />   {/* amber */}
<span className="led led-fault" />  {/* red */}
<span className="led led-idle" />   {/* gray, no pulse */}`}</CodeBlock>
      </Section>

      <Section id="icon-chips" title="Icon chips" description="Tinted-background squares for leading icons. Use as the visual anchor of a list row, empty state, or feature callout. Four sizes — sm 24px, default 32px, md 40px, lg 56px.">
        <SubSection title="Tones">
          <div className="flex flex-wrap items-center gap-3">
            {[
              { cls: '', icon: Info, label: 'brand' },
              { cls: 'icon-chip-ok', icon: CheckCircle2, label: 'ok' },
              { cls: 'icon-chip-warn', icon: AlertTriangle, label: 'warn' },
              { cls: 'icon-chip-fault', icon: X, label: 'fault' },
              { cls: 'icon-chip-info', icon: Info, label: 'info' },
              { cls: 'icon-chip-safety', icon: ShieldAlert, label: 'safety' },
              { cls: 'icon-chip-neutral', icon: Box, label: 'neutral' },
            ].map((t) => {
              const Icon = t.icon;
              return (
                <div key={t.label} className="flex flex-col items-center gap-1">
                  <div className={`icon-chip ${t.cls}`}>
                    <Icon size={16} strokeWidth={1.75} />
                  </div>
                  <span className="font-mono text-[10px] text-ink-tertiary">{t.label}</span>
                </div>
              );
            })}
          </div>
        </SubSection>

        <SubSection title="Sizes">
          <div className="flex items-end gap-3">
            {[
              { cls: 'icon-chip-sm', size: 12 },
              { cls: '', size: 16 },
              { cls: 'icon-chip-md', size: 18 },
              { cls: 'icon-chip-lg', size: 22 },
            ].map((s) => (
              <div key={s.cls || 'default'} className={`icon-chip ${s.cls}`}>
                <Wrench size={s.size} strokeWidth={1.75} />
              </div>
            ))}
          </div>
        </SubSection>

        <CodeBlock>{`<div className="icon-chip icon-chip-lg icon-chip-ok">
  <CheckCircle2 size={22} strokeWidth={1.75} />
</div>`}</CodeBlock>
      </Section>

      <Section id="form" title="Form inputs" description="Use the Field / TextInput / Select / Textarea wrappers from components/form so labels, hints, and error states stay consistent. All inputs respect aria-invalid for the red focus ring.">
        <div className="grid gap-4 lg:grid-cols-2">
          <label className="flex flex-col gap-1.5">
            <span className="form-label">Default input</span>
            <input className="form-input" placeholder="Type something…" />
            <span className="form-hint">Helper text appears below.</span>
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="form-label form-label-required">Required</span>
            <input className="form-input" defaultValue="Memphis DC" />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="form-label">Disabled</span>
            <input className="form-input" defaultValue="Read-only" disabled />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="form-label">Invalid</span>
            <input className="form-input" aria-invalid="true" defaultValue="abc" />
            <span className="form-error">Must be a number.</span>
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="form-label">Select</span>
            <select className="form-select">
              <option>Open</option>
              <option>Acknowledged</option>
              <option>Resolved</option>
            </select>
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="form-label">Textarea</span>
            <textarea className="form-textarea" placeholder="Describe what happened…" rows={3} />
          </label>
        </div>
        <CodeBlock>{`import { Field, TextInput, Select, Textarea } from '@/components/form';

<Field label="Name" required>
  <TextInput value={name} onChange={(e) => setName(e.target.value)} />
</Field>

<Field label="Status" hint="Visible to the customer.">
  <Select value={status} onChange={...}>
    <option>Open</option>
  </Select>
</Field>`}</CodeBlock>
      </Section>

      <Section id="data-table" title="Data table" description="The .data-table class produces the standard admin table — surface-raised background, surface-inset header, hover state on rows, monospace columns via .cell-mono.">
        <div className="overflow-hidden rounded-md border border-line-subtle">
          <table className="data-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Code</th>
                <th>Status</th>
                <th>Updated</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td className="cell-primary">Acme Material Handling</td>
                <td className="cell-mono">ACME</td>
                <td><Pill tone="success">active</Pill></td>
                <td className="cell-mono">2026-05-30</td>
              </tr>
              <tr>
                <td className="cell-primary">FedEx Memphis</td>
                <td className="cell-mono">FEDEX-MEM</td>
                <td><Pill tone="warning">setup</Pill></td>
                <td className="cell-mono">2026-05-28</td>
              </tr>
            </tbody>
          </table>
        </div>
        <CodeBlock>{`<table className="data-table">
  <thead>
    <tr><th>Name</th><th>Code</th><th>Status</th></tr>
  </thead>
  <tbody>
    <tr>
      <td className="cell-primary">Acme</td>
      <td className="cell-mono">ACME</td>
      <td><Pill tone="success">active</Pill></td>
    </tr>
  </tbody>
</table>`}</CodeBlock>
      </Section>

      <Section id="shared-ui" title="Shared @platform/ui" description="Cross-app primitives that live in the shared package. Import directly via @platform/ui or via the back-compat re-exports at @/components/empty-state and @/components/skeleton.">
        <SubSection title="EmptyState">
          <EmptyState
            icon={Inbox}
            title="No work orders yet"
            description="When a tech reports an issue from the PWA, it shows up here."
            action={<button className="btn btn-secondary btn-sm">Refresh</button>}
          />
          <CodeBlock>{`import { EmptyState } from '@platform/ui';

<EmptyState
  icon={Inbox}
  tone="ok"
  title="No work orders yet"
  description="When a tech reports an issue, it shows up here."
  action={<button className="btn btn-secondary btn-sm">Refresh</button>}
/>`}</CodeBlock>
        </SubSection>

        <SubSection title="EmptyState tones">
          <div className="grid gap-3 lg:grid-cols-2">
            {(['info', 'ok', 'warn', 'fault', 'safety', 'neutral'] as const).map((tone) => (
              <EmptyState
                key={tone}
                icon={Sparkles}
                tone={tone}
                title={`tone="${tone}"`}
                description="Drives the icon-chip tint."
              />
            ))}
          </div>
        </SubSection>

        <SubSection title="ErrorBanner">
          <ErrorBanner error="API 500: upstream timeout while loading work orders." />
          <CodeBlock>{`import { ErrorBanner } from '@platform/ui';

<ErrorBanner error={error} />
<ErrorBanner error={error} className="mb-4" />  {/* opt-in spacing */}`}</CodeBlock>
        </SubSection>

        <SubSection title="SegmentCard">
          <SegmentCardDemo />
          <CodeBlock>{`import { SegmentCard } from '@platform/ui';

<SegmentCard
  icon={FileText}
  label="Documents"
  active={section === 'documents'}
  onClick={() => setSection('documents')}
/>`}</CodeBlock>
        </SubSection>
      </Section>

      <Section id="skeletons" title="Skeletons" description="Loading placeholders. The base Skeleton ships in @platform/ui; domain-specific variants (TableSkeleton, TilesSkeleton, DetailSkeleton, DocListSkeleton, RowListSkeleton) live in each app.">
        <SubSection title="Base">
          <div className="flex flex-col gap-2">
            <Skeleton className="h-4 w-32" />
            <Skeleton className="h-3 w-48" />
            <Skeleton className="h-3 w-24" />
          </div>
          <CodeBlock>{`import { Skeleton } from '@platform/ui';

<Skeleton className="h-4 w-32" />
<Skeleton className="h-3 w-48" />`}</CodeBlock>
        </SubSection>
      </Section>

      <Section id="patterns" title="Patterns" description="Composite patterns that pull primitives together.">
        <SubSection title="List row" description="Generic card-list item. Used for setup checklists and non-tabular lists.">
          <div className="flex flex-col gap-1.5">
            <div className="list-row">
              <div className="icon-chip"><Wrench size={16} strokeWidth={1.75} /></div>
              <div className="list-row-body">
                <span className="list-row-title">Replace bearing assembly</span>
                <span className="list-row-desc">Every 90 days. Last performed 2026-03-12.</span>
              </div>
              <div className="list-row-aside">
                <Pill tone="warning">due</Pill>
                <ChevronRight size={16} className="text-ink-tertiary" />
              </div>
            </div>
            <div className="list-row">
              <div className="icon-chip icon-chip-ok"><CheckCircle2 size={16} strokeWidth={1.75} /></div>
              <div className="list-row-body">
                <span className="list-row-title">Daily lubrication walk</span>
                <span className="list-row-desc">Completed 4 hours ago by L. Martinez.</span>
              </div>
            </div>
          </div>
        </SubSection>

        <SubSection title="Metric tile" description="Dashboard hero. Big mono number with a label and optional sub-line.">
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <MetricTileSample label="Open WOs" value="12" sub="↑ 3 since yesterday" />
            <MetricTileSample label="PM compliance" value="94%" sub="last 30 days" tone="ok" />
            <MetricTileSample label="Overdue" value="3" sub="2 critical" tone="warn" />
            <MetricTileSample label="Procedures" value="47" sub="22 published" />
          </div>
        </SubSection>

        <SubSection title="Scope chip" description="Indicates whether the current page renders a cross-org rollup or one organization's workspace. Rendered automatically by TopBar — admins shouldn't have to render this manually.">
          <div className="flex flex-wrap items-center gap-3">
            <span
              className="inline-flex h-6 items-center gap-1.5 rounded border px-2.5 font-mono text-[11px] font-medium uppercase tracking-[0.04em]"
              style={{
                background: 'rgba(var(--brand-soft-v), var(--brand-soft-a))',
                color: 'rgb(var(--ink-brand))',
                borderColor: 'rgb(var(--brand) / 0.35)',
              }}
            >
              <span
                className="inline-block h-1.5 w-1.5 rounded-full"
                style={{
                  background: 'rgb(var(--brand))',
                  boxShadow: '0 0 6px rgb(var(--brand) / 0.45)',
                }}
                aria-hidden
              />
              Acme MH
            </span>
            <span
              className="inline-flex h-6 items-center gap-1.5 rounded border border-line bg-surface-raised px-2.5 font-mono text-[11px] font-medium uppercase tracking-[0.04em] text-ink-secondary"
            >
              <Box size={11} strokeWidth={2.25} aria-hidden />
              All organizations
            </span>
          </div>
        </SubSection>
      </Section>

      <Section id="brand" title="Brand mark" description="The FS monogram. Use brand-mark-square for any compact placeholder where the OEM logo isn't authored.">
        <div className="flex items-center gap-4">
          <div className="brand-mark-square">FS</div>
          <code className="font-mono text-xs text-ink-tertiary">{`<div className="brand-mark-square">FS</div>`}</code>
        </div>
      </Section>

      <PageFooter />
    </PageShell>
  );
}

// ---------------------------------------------------------------------
// Section primitives
// ---------------------------------------------------------------------

function TableOfContents() {
  const items = [
    { id: 'tokens-color', label: 'Color tokens' },
    { id: 'tokens-typography', label: 'Typography' },
    { id: 'buttons', label: 'Buttons' },
    { id: 'pills', label: 'Pills' },
    { id: 'leds', label: 'LEDs' },
    { id: 'icon-chips', label: 'Icon chips' },
    { id: 'form', label: 'Form inputs' },
    { id: 'data-table', label: 'Data table' },
    { id: 'shared-ui', label: 'Shared @platform/ui' },
    { id: 'skeletons', label: 'Skeletons' },
    { id: 'patterns', label: 'Patterns' },
    { id: 'brand', label: 'Brand mark' },
  ];
  return (
    <nav
      aria-label="Contents"
      className="mb-8 flex flex-wrap gap-2 rounded-md border border-line-subtle bg-surface-raised p-3"
    >
      {items.map((it) => (
        <a
          key={it.id}
          href={`#${it.id}`}
          className="rounded px-2.5 py-1 text-xs font-medium text-ink-secondary transition hover:bg-surface-elevated hover:text-ink-primary"
        >
          {it.label}
        </a>
      ))}
    </nav>
  );
}

function Section({
  id,
  title,
  description,
  children,
}: {
  id: string;
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <section id={id} className="mb-12 scroll-mt-24">
      <header className="mb-4 border-b border-line-subtle pb-3">
        <h2 className="text-2xl font-semibold tracking-tight text-ink-primary">{title}</h2>
        {description && <p className="mt-1.5 max-w-3xl text-sm text-ink-secondary">{description}</p>}
      </header>
      <div className="flex flex-col gap-6">{children}</div>
    </section>
  );
}

function SubSection({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <div>
      <h3 className="caption mb-2">{title}</h3>
      {description && (
        <p className="mb-3 max-w-3xl text-xs text-ink-secondary">{description}</p>
      )}
      <div className="flex flex-col gap-3">{children}</div>
    </div>
  );
}

function CodeBlock({ children }: { children: string }) {
  const [copied, setCopied] = useState(false);
  function copy() {
    void navigator.clipboard.writeText(children).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    });
  }
  return (
    <div className="relative">
      <pre className="overflow-x-auto rounded-md border border-line-subtle bg-surface-inset p-3 font-mono text-xs leading-relaxed text-ink-primary">
        <code>{children}</code>
      </pre>
      <button
        type="button"
        onClick={copy}
        aria-label="Copy code"
        className="absolute right-2 top-2 inline-flex items-center gap-1 rounded border border-line bg-surface-raised px-2 py-1 text-[11px] text-ink-secondary transition hover:border-line-strong hover:text-ink-primary"
      >
        <Copy size={11} strokeWidth={2} />
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  );
}

function Pair({ left, right, note }: { left: ReactNode; right: string; note?: string }) {
  return (
    <div className="grid items-center gap-3 lg:grid-cols-[200px_1fr]">
      <div className="flex items-center">{left}</div>
      <div className="flex flex-col gap-1">
        <code className="rounded bg-surface-inset px-2 py-1 font-mono text-xs text-ink-primary">{right}</code>
        {note && <span className="text-xs text-ink-tertiary">{note}</span>}
      </div>
    </div>
  );
}

function TokenSwatchRow({
  tokens,
}: {
  tokens: Array<{ name: string; cssVar: string; usage: string }>;
}) {
  return (
    <div className="grid gap-3 lg:grid-cols-2 xl:grid-cols-3">
      {tokens.map((t) => (
        <div
          key={t.name}
          className="flex items-start gap-3 rounded-md border border-line-subtle bg-surface-raised p-3"
        >
          <div
            className="h-12 w-12 shrink-0 rounded border border-line-subtle"
            style={{ background: `rgb(var(${t.cssVar}))` }}
            aria-hidden
          />
          <div className="min-w-0 flex-1">
            <div className="flex items-baseline justify-between gap-2">
              <code className="font-mono text-xs font-semibold text-ink-primary">{t.name}</code>
              <code className="truncate font-mono text-[10px] text-ink-tertiary">{t.cssVar}</code>
            </div>
            <p className="mt-1 text-xs text-ink-secondary">{t.usage}</p>
          </div>
        </div>
      ))}
    </div>
  );
}

function LedSample({ className, label }: { className: string; label: string }) {
  return (
    <div className="flex items-center gap-2">
      <span className={className} />
      <span className="font-mono text-xs text-ink-secondary">{label}</span>
    </div>
  );
}

function SegmentCardDemo() {
  const [section, setSection] = useState<'documents' | 'training'>('documents');
  return (
    <div className="grid max-w-md grid-cols-2 gap-2">
      <SegmentCard
        icon={FileText}
        label="Documents"
        active={section === 'documents'}
        onClick={() => setSection('documents')}
      />
      <SegmentCard
        icon={Search}
        label="Training"
        active={section === 'training'}
        onClick={() => setSection('training')}
      />
    </div>
  );
}

function MetricTileSample({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: string;
  sub?: string;
  tone?: 'ok' | 'warn' | 'fault';
}) {
  return (
    <div className="metric-tile">
      <div className="metric-tile-top">
        <span className="caption">{label}</span>
      </div>
      <div className={`metric-value${tone ? ` ${tone}` : ''}`}>{value}</div>
      {sub && <div className="metric-sub">{sub}</div>}
    </div>
  );
}

function PageFooter() {
  return (
    <footer className="mt-12 border-t border-line-subtle pt-6 text-xs text-ink-tertiary">
      <p>
        Missing a primitive? Check the source of <code className="font-mono text-[11px]">apps/admin/src/app/globals.css</code> and
        the <code className="font-mono text-[11px]">@platform/ui</code> package before rolling your own component.
      </p>
    </footer>
  );
}
