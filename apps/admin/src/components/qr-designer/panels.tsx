'use client';

// Designer control panels. Each panel is a self-contained accordion section
// in the left sidebar. They all take the current spec + an `onPatch` mutator
// so changes flow up to a single source of truth in the page.

import { useId, useRef } from 'react';
import {
  Circle,
  Image as ImageIcon,
  PaintBucket,
  Palette,
  Settings2,
  Shapes,
  Square,
  Trash2,
  Type,
  Upload,
} from 'lucide-react';
import type {
  ColorSpec,
  DotShape,
  EyeInnerShape,
  EyeOuterShape,
  QrStyleSpec,
} from '@/lib/qr-style';

// -----------------------------------------------------------------------------
// Shared bits
// -----------------------------------------------------------------------------

export function PanelSection({
  title,
  icon: Icon,
  children,
}: {
  title: string;
  icon: React.ComponentType<{ size?: number; strokeWidth?: number; className?: string }>;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-lg border border-line-subtle bg-surface-raised">
      <header className="flex items-center gap-2 border-b border-line-subtle px-3 py-2">
        <Icon size={13} strokeWidth={2} className="text-ink-tertiary" />
        <h3 className="text-[11px] font-semibold uppercase tracking-wider text-ink-tertiary">
          {title}
        </h3>
      </header>
      <div className="space-y-3 p-3">{children}</div>
    </section>
  );
}

function FieldLabel({ children, htmlFor }: { children: React.ReactNode; htmlFor?: string }) {
  return (
    <label htmlFor={htmlFor} className="text-[11px] font-medium text-ink-secondary">
      {children}
    </label>
  );
}

// -----------------------------------------------------------------------------
// Content panel — URL/text input + error correction + margin
// -----------------------------------------------------------------------------

export function ContentPanel({
  spec,
  onPatch,
}: {
  spec: QrStyleSpec;
  onPatch: (patch: Partial<QrStyleSpec>) => void;
}) {
  const id = useId();
  return (
    <PanelSection title="Content" icon={Type}>
      <div className="space-y-1">
        <FieldLabel htmlFor={`${id}-data`}>URL or text to encode</FieldLabel>
        <textarea
          id={`${id}-data`}
          value={spec.data}
          onChange={(e) => onPatch({ data: e.target.value })}
          rows={2}
          placeholder="https://example.com"
          className="w-full resize-none rounded border border-line bg-surface px-2 py-1.5 text-sm font-mono text-ink-primary placeholder:text-ink-tertiary focus:border-brand focus:outline-none"
        />
        <p className="text-[10px] leading-snug text-ink-tertiary">
          QR codes can encode URLs, plain text, phone numbers (tel:), email
          (mailto:), wifi credentials, or vCards. Longer content produces a
          denser symbol — keep URLs short for clean designs.
        </p>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <div className="space-y-1">
          <FieldLabel htmlFor={`${id}-ec`}>Error correction</FieldLabel>
          <select
            id={`${id}-ec`}
            value={spec.errorCorrection}
            onChange={(e) =>
              onPatch({ errorCorrection: e.target.value as QrStyleSpec['errorCorrection'] })
            }
            className="w-full rounded border border-line bg-surface px-2 py-1.5 text-xs"
          >
            <option value="L">L · 7%</option>
            <option value="M">M · 15%</option>
            <option value="Q">Q · 25%</option>
            <option value="H">H · 30% (logo-safe)</option>
          </select>
        </div>
        <div className="space-y-1">
          <FieldLabel htmlFor={`${id}-qz`}>Quiet zone</FieldLabel>
          <input
            id={`${id}-qz`}
            type="number"
            min={0}
            max={10}
            value={spec.quietZoneModules}
            onChange={(e) =>
              onPatch({ quietZoneModules: Math.max(0, Math.min(10, Number(e.target.value) || 0)) })
            }
            className="w-full rounded border border-line bg-surface px-2 py-1.5 text-xs"
          />
        </div>
      </div>
    </PanelSection>
  );
}

// -----------------------------------------------------------------------------
// Modules panel — dot shape
// -----------------------------------------------------------------------------

const DOT_SHAPES: Array<{ value: DotShape; label: string }> = [
  { value: 'square', label: 'Square' },
  { value: 'rounded', label: 'Rounded' },
  { value: 'dots', label: 'Dots' },
  { value: 'classy', label: 'Classy' },
  { value: 'classy-rounded', label: 'Classy R.' },
  { value: 'extra-rounded', label: 'Extra R.' },
];

export function ModulesPanel({
  spec,
  onPatch,
}: {
  spec: QrStyleSpec;
  onPatch: (patch: Partial<QrStyleSpec>) => void;
}) {
  return (
    <PanelSection title="Modules" icon={Shapes}>
      <div className="grid grid-cols-3 gap-1.5">
        {DOT_SHAPES.map((s) => (
          <button
            key={s.value}
            type="button"
            onClick={() => onPatch({ dotShape: s.value })}
            aria-pressed={spec.dotShape === s.value}
            className={`flex flex-col items-center gap-1.5 rounded-md border px-2 py-2 text-[10px] font-medium transition ${
              spec.dotShape === s.value
                ? 'border-brand bg-brand/10 text-ink-primary'
                : 'border-line bg-surface text-ink-secondary hover:bg-surface-inset'
            }`}
          >
            <DotShapeThumb shape={s.value} />
            {s.label}
          </button>
        ))}
      </div>
    </PanelSection>
  );
}

function DotShapeThumb({ shape }: { shape: DotShape }) {
  // 24×24 thumb illustrating the dot shape on a 3×3 mini-grid.
  const cells: Array<[number, number]> = [
    [0, 0], [1, 0], [2, 0],
    [0, 1],          [2, 1],
    [0, 2], [1, 2], [2, 2],
  ];
  return (
    <svg width={24} height={24} viewBox="0 0 24 24">
      {cells.map(([cx, cy]) => (
        <DotShapePath key={`${cx}-${cy}`} shape={shape} cx={cx * 8 + 4} cy={cy * 8 + 4} />
      ))}
    </svg>
  );
}

function DotShapePath({ shape, cx, cy }: { shape: DotShape; cx: number; cy: number }) {
  const s = 6.2;
  if (shape === 'dots') {
    return <circle cx={cx} cy={cy} r={s / 2} fill="currentColor" />;
  }
  if (shape === 'rounded' || shape === 'extra-rounded') {
    const r = shape === 'extra-rounded' ? 2.4 : 1.4;
    return <rect x={cx - s / 2} y={cy - s / 2} width={s} height={s} rx={r} fill="currentColor" />;
  }
  if (shape === 'classy' || shape === 'classy-rounded') {
    // Half-rounded asymmetric — top-left & bottom-right rounded, others sharp.
    const r = shape === 'classy-rounded' ? 2.6 : 1.6;
    const x = cx - s / 2;
    const y = cy - s / 2;
    return (
      <path
        d={`M${x + r} ${y} L${x + s} ${y} L${x + s} ${y + s - r} A${r} ${r} 0 0 1 ${x + s - r} ${y + s} L${x} ${y + s} L${x} ${y + r} A${r} ${r} 0 0 1 ${x + r} ${y} Z`}
        fill="currentColor"
      />
    );
  }
  return <rect x={cx - s / 2} y={cy - s / 2} width={s} height={s} fill="currentColor" />;
}

// -----------------------------------------------------------------------------
// Eyes panel — corner finder pattern shape (outer + inner)
// -----------------------------------------------------------------------------

const EYE_OUTER_SHAPES: Array<{ value: EyeOuterShape; label: string }> = [
  { value: 'square', label: 'Square' },
  { value: 'extra-rounded', label: 'Rounded' },
  { value: 'dot', label: 'Dot' },
];

const EYE_INNER_SHAPES: Array<{ value: EyeInnerShape; label: string }> = [
  { value: 'square', label: 'Square' },
  { value: 'rounded', label: 'Rounded' },
  { value: 'extra-rounded', label: 'Soft' },
  { value: 'dot', label: 'Dot' },
];

export function EyesPanel({
  spec,
  onPatch,
}: {
  spec: QrStyleSpec;
  onPatch: (patch: Partial<QrStyleSpec>) => void;
}) {
  return (
    <PanelSection title="Corner eyes" icon={Square}>
      <div className="space-y-2">
        <FieldLabel>Outer frame</FieldLabel>
        <div className="grid grid-cols-3 gap-1.5">
          {EYE_OUTER_SHAPES.map((s) => (
            <button
              key={s.value}
              type="button"
              onClick={() => onPatch({ eyeOuterShape: s.value })}
              aria-pressed={spec.eyeOuterShape === s.value}
              className={`flex flex-col items-center gap-1.5 rounded-md border px-2 py-2 text-[10px] font-medium transition ${
                spec.eyeOuterShape === s.value
                  ? 'border-brand bg-brand/10 text-ink-primary'
                  : 'border-line bg-surface text-ink-secondary hover:bg-surface-inset'
              }`}
            >
              <EyeOuterThumb shape={s.value} />
              {s.label}
            </button>
          ))}
        </div>
      </div>
      <div className="space-y-2">
        <FieldLabel>Inner pupil</FieldLabel>
        <div className="grid grid-cols-4 gap-1.5">
          {EYE_INNER_SHAPES.map((s) => (
            <button
              key={s.value}
              type="button"
              onClick={() => onPatch({ eyeInnerShape: s.value })}
              aria-pressed={spec.eyeInnerShape === s.value}
              className={`flex flex-col items-center gap-1.5 rounded-md border px-1.5 py-2 text-[10px] font-medium transition ${
                spec.eyeInnerShape === s.value
                  ? 'border-brand bg-brand/10 text-ink-primary'
                  : 'border-line bg-surface text-ink-secondary hover:bg-surface-inset'
              }`}
            >
              <EyeInnerThumb shape={s.value} />
              {s.label}
            </button>
          ))}
        </div>
      </div>
    </PanelSection>
  );
}

function EyeOuterThumb({ shape }: { shape: EyeOuterShape }) {
  const r = shape === 'extra-rounded' ? 5 : shape === 'dot' ? 11 : 1;
  return (
    <svg width={28} height={28} viewBox="0 0 28 28">
      <rect x={3} y={3} width={22} height={22} rx={r} ry={r} fill="none" stroke="currentColor" strokeWidth={3} />
    </svg>
  );
}

function EyeInnerThumb({ shape }: { shape: EyeInnerShape }) {
  if (shape === 'dot') {
    return (
      <svg width={28} height={28} viewBox="0 0 28 28">
        <circle cx={14} cy={14} r={6} fill="currentColor" />
      </svg>
    );
  }
  const r = shape === 'extra-rounded' ? 4 : shape === 'rounded' ? 2 : 1;
  return (
    <svg width={28} height={28} viewBox="0 0 28 28">
      <rect x={8} y={8} width={12} height={12} rx={r} fill="currentColor" />
    </svg>
  );
}

// -----------------------------------------------------------------------------
// Colors panel — dots, eyes, background; solid or gradient
// -----------------------------------------------------------------------------

export function ColorsPanel({
  spec,
  onPatch,
}: {
  spec: QrStyleSpec;
  onPatch: (patch: Partial<QrStyleSpec>) => void;
}) {
  return (
    <PanelSection title="Colors" icon={Palette}>
      <ColorBlock
        label="Modules"
        value={spec.dotColor}
        onChange={(dotColor) => onPatch({ dotColor })}
      />
      <ColorBlock
        label="Eye frame"
        value={spec.eyeOuterColor}
        onChange={(eyeOuterColor) => onPatch({ eyeOuterColor })}
      />
      <ColorBlock
        label="Eye pupil"
        value={spec.eyeInnerColor}
        onChange={(eyeInnerColor) => onPatch({ eyeInnerColor })}
      />
      <ColorBlock
        label="Background"
        value={spec.background}
        onChange={(background) => onPatch({ background })}
        allowTransparent
      />
    </PanelSection>
  );
}

function ColorBlock({
  label,
  value,
  onChange,
  allowTransparent = false,
}: {
  label: string;
  value: ColorSpec;
  onChange: (c: ColorSpec) => void;
  allowTransparent?: boolean;
}) {
  const id = useId();
  function setMode(mode: ColorSpec['mode']) {
    if (mode === 'solid') {
      // Keep the first stop color if coming from gradient, else default ink.
      const seed = value.mode === 'solid' ? value.color : value.stops[0]?.color ?? '#0a0c0f';
      onChange({ mode: 'solid', color: seed });
    } else {
      const seedA = value.mode === 'solid' ? value.color : value.stops[0]?.color ?? '#0B5FBF';
      const seedB = value.mode === 'solid' ? lighten(value.color, 30) : value.stops[1]?.color ?? '#0EA5E9';
      onChange({
        mode,
        rotation: value.mode === 'solid' ? 45 : value.rotation,
        stops: [
          { offset: 0, color: seedA },
          { offset: 1, color: seedB },
        ],
      });
    }
  }
  return (
    <div className="rounded-md border border-line-subtle bg-surface-inset/40 p-2.5">
      <div className="mb-2 flex items-center justify-between">
        <FieldLabel htmlFor={`${id}-mode`}>{label}</FieldLabel>
        <div className="inline-flex rounded-md border border-line bg-surface p-0.5 text-[10px]">
          {(['solid', 'linear', 'radial'] as const).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => setMode(m)}
              className={`rounded px-2 py-0.5 transition ${
                value.mode === m ? 'bg-brand text-white' : 'text-ink-secondary hover:text-ink-primary'
              }`}
            >
              {m === 'solid' ? 'Solid' : m === 'linear' ? 'Linear' : 'Radial'}
            </button>
          ))}
        </div>
      </div>

      {value.mode === 'solid' ? (
        <div className="flex items-center gap-2">
          <input
            type="color"
            value={value.color}
            onChange={(e) => onChange({ mode: 'solid', color: e.target.value })}
            className="h-7 w-10 cursor-pointer rounded border border-line"
          />
          <input
            value={value.color}
            onChange={(e) => {
              const v = e.target.value;
              if (/^#?[0-9A-Fa-f]{0,6}$/.test(v)) {
                onChange({ mode: 'solid', color: normalizeHex(v) });
              }
            }}
            className="w-24 rounded border border-line bg-surface px-2 py-1 font-mono text-xs"
          />
          {allowTransparent && (
            <button
              type="button"
              onClick={() => onChange({ mode: 'solid', color: 'transparent' })}
              className="ml-auto rounded border border-line px-2 py-1 text-[10px] text-ink-secondary hover:bg-surface"
            >
              None
            </button>
          )}
        </div>
      ) : (
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            {value.stops.map((stop, i) => (
              <input
                key={i}
                type="color"
                value={stop.color}
                onChange={(e) => {
                  const stops = value.stops.slice();
                  stops[i] = { ...stops[i]!, color: e.target.value };
                  onChange({ ...value, stops });
                }}
                className="h-7 w-10 cursor-pointer rounded border border-line"
              />
            ))}
            {value.mode === 'linear' && (
              <div className="ml-auto flex items-center gap-1.5 text-[10px] text-ink-secondary">
                <span>Angle</span>
                <input
                  type="number"
                  min={0}
                  max={360}
                  value={value.rotation}
                  onChange={(e) =>
                    onChange({
                      ...value,
                      rotation: Math.max(0, Math.min(360, Number(e.target.value) || 0)),
                    })
                  }
                  className="w-14 rounded border border-line bg-surface px-1.5 py-0.5 font-mono text-[11px]"
                />
                <span>°</span>
              </div>
            )}
          </div>
          <div
            className="h-2 w-full rounded-full"
            style={{
              background:
                value.mode === 'linear'
                  ? `linear-gradient(${value.rotation}deg, ${value.stops.map((s) => s.color).join(', ')})`
                  : `radial-gradient(circle, ${value.stops.map((s) => s.color).join(', ')})`,
            }}
          />
        </div>
      )}
    </div>
  );
}

// -----------------------------------------------------------------------------
// Logo panel — upload, scale, padding, hide-modules
// -----------------------------------------------------------------------------

export function LogoPanel({
  spec,
  onPatch,
}: {
  spec: QrStyleSpec;
  onPatch: (patch: Partial<QrStyleSpec>) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const id = useId();

  function onUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!/^image\//.test(file.type)) return;
    if (file.size > 1024 * 1024 * 4) return; // 4MB cap
    const reader = new FileReader();
    reader.onload = () => {
      onPatch({ logo: { ...spec.logo, src: reader.result as string } });
    };
    reader.readAsDataURL(file);
  }

  return (
    <PanelSection title="Logo" icon={ImageIcon}>
      <div className="flex items-center gap-3">
        <div
          className="flex h-16 w-16 shrink-0 items-center justify-center overflow-hidden rounded-md border border-line bg-[linear-gradient(45deg,#f3f4f6_25%,#fff_25%,#fff_50%,#f3f4f6_50%,#f3f4f6_75%,#fff_75%)] bg-[length:8px_8px]"
        >
          {spec.logo.src ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={spec.logo.src} alt="Logo preview" className="max-h-full max-w-full" />
          ) : (
            <ImageIcon size={20} strokeWidth={1.5} className="text-ink-tertiary" />
          )}
        </div>
        <div className="flex flex-1 flex-col gap-1.5">
          <button
            type="button"
            onClick={() => inputRef.current?.click()}
            className="inline-flex items-center justify-center gap-1.5 rounded border border-line bg-surface px-2 py-1.5 text-xs text-ink-secondary hover:bg-surface-inset"
          >
            <Upload size={11} strokeWidth={2} />
            {spec.logo.src ? 'Replace' : 'Upload'}
          </button>
          {spec.logo.src && (
            <button
              type="button"
              onClick={() => onPatch({ logo: { ...spec.logo, src: null } })}
              className="inline-flex items-center justify-center gap-1.5 rounded border border-line bg-surface px-2 py-1.5 text-[11px] text-signal-fault hover:bg-signal-fault/10"
            >
              <Trash2 size={11} strokeWidth={2} />
              Remove
            </button>
          )}
          <input
            ref={inputRef}
            type="file"
            accept="image/png,image/jpeg,image/svg+xml,image/webp"
            onChange={onUpload}
            className="hidden"
          />
        </div>
      </div>

      {spec.logo.src && (
        <>
          <div className="space-y-1">
            <FieldLabel htmlFor={`${id}-size`}>
              Size · {(spec.logo.size * 100).toFixed(0)}%
            </FieldLabel>
            <input
              id={`${id}-size`}
              type="range"
              min={0.1}
              max={0.4}
              step={0.01}
              value={spec.logo.size}
              onChange={(e) =>
                onPatch({ logo: { ...spec.logo, size: Number(e.target.value) } })
              }
              className="w-full accent-brand"
            />
            <p className="text-[10px] leading-snug text-ink-tertiary">
              Above ~25% you must use error correction <span className="font-mono">H</span> to keep
              the symbol readable.
            </p>
          </div>
          <div className="space-y-1">
            <FieldLabel htmlFor={`${id}-margin`}>
              Padding · {spec.logo.margin} modules
            </FieldLabel>
            <input
              id={`${id}-margin`}
              type="range"
              min={0}
              max={20}
              step={1}
              value={spec.logo.margin}
              onChange={(e) =>
                onPatch({ logo: { ...spec.logo, margin: Number(e.target.value) } })
              }
              className="w-full accent-brand"
            />
          </div>
          <label className="flex items-center gap-2 text-[11px] text-ink-secondary">
            <input
              type="checkbox"
              checked={spec.logo.hideBackgroundDots}
              onChange={(e) =>
                onPatch({
                  logo: { ...spec.logo, hideBackgroundDots: e.target.checked },
                })
              }
            />
            Hide modules under the logo
          </label>
        </>
      )}
    </PanelSection>
  );
}

// -----------------------------------------------------------------------------
// Frame panel — none / callout / ribbon, with text + colors
// -----------------------------------------------------------------------------

export function FramePanel({
  spec,
  onPatch,
}: {
  spec: QrStyleSpec;
  onPatch: (patch: Partial<QrStyleSpec>) => void;
}) {
  const id = useId();
  const set = (patch: Partial<typeof spec.frame>) =>
    onPatch({ frame: { ...spec.frame, ...patch } });
  return (
    <PanelSection title="Frame" icon={PaintBucket}>
      <div className="grid grid-cols-3 gap-1.5">
        {(['none', 'callout', 'ribbon'] as const).map((k) => (
          <button
            key={k}
            type="button"
            onClick={() => set({ kind: k })}
            aria-pressed={spec.frame.kind === k}
            className={`flex flex-col items-center gap-1.5 rounded-md border px-2 py-2 text-[10px] font-medium transition ${
              spec.frame.kind === k
                ? 'border-brand bg-brand/10 text-ink-primary'
                : 'border-line bg-surface text-ink-secondary hover:bg-surface-inset'
            }`}
          >
            <FrameThumb kind={k} />
            {k === 'none' ? 'None' : k === 'callout' ? 'Card' : 'Ribbon'}
          </button>
        ))}
      </div>
      {spec.frame.kind !== 'none' && (
        <>
          <div className="space-y-1">
            <FieldLabel htmlFor={`${id}-text`}>Tagline</FieldLabel>
            <input
              id={`${id}-text`}
              value={spec.frame.text}
              onChange={(e) => set({ text: e.target.value })}
              maxLength={40}
              className="w-full rounded border border-line bg-surface px-2 py-1.5 text-xs"
            />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <FrameColorRow
              label="Card fill"
              value={spec.frame.fill}
              onChange={(fill) => set({ fill })}
            />
            <FrameColorRow
              label="Accent"
              value={spec.frame.accent}
              onChange={(accent) => set({ accent })}
            />
          </div>
          {spec.frame.kind === 'callout' && (
            <div className="space-y-1">
              <FieldLabel htmlFor={`${id}-r`}>
                Corner radius · {spec.frame.cornerRadius}
              </FieldLabel>
              <input
                id={`${id}-r`}
                type="range"
                min={0}
                max={64}
                step={1}
                value={spec.frame.cornerRadius}
                onChange={(e) => set({ cornerRadius: Number(e.target.value) })}
                className="w-full accent-brand"
              />
            </div>
          )}
        </>
      )}
    </PanelSection>
  );
}

function FrameThumb({ kind }: { kind: 'none' | 'callout' | 'ribbon' }) {
  return (
    <svg width={32} height={32} viewBox="0 0 32 32">
      {kind === 'callout' && (
        <rect x={1} y={1} width={30} height={30} rx={5} fill="#0a0c0f" />
      )}
      <rect
        x={kind === 'callout' ? 6 : 4}
        y={kind === 'callout' ? 5 : 3}
        width={kind === 'callout' ? 20 : 24}
        height={kind === 'callout' ? 17 : 20}
        rx={2}
        fill={kind === 'callout' ? '#ffffff' : 'currentColor'}
      />
      {(kind === 'callout' || kind === 'ribbon') && (
        <rect
          x={kind === 'callout' ? 7 : 6}
          y={kind === 'callout' ? 24 : 27}
          width={kind === 'callout' ? 18 : 20}
          height={kind === 'callout' ? 4 : 3}
          rx={1.5}
          fill={kind === 'callout' ? '#ffffff' : 'currentColor'}
        />
      )}
    </svg>
  );
}

function FrameColorRow({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="space-y-1">
      <FieldLabel>{label}</FieldLabel>
      <div className="flex items-center gap-1.5">
        <input
          type="color"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="h-6 w-8 cursor-pointer rounded border border-line"
        />
        <input
          value={value}
          onChange={(e) => {
            if (/^#?[0-9A-Fa-f]{0,6}$/.test(e.target.value)) {
              onChange(normalizeHex(e.target.value));
            }
          }}
          className="flex-1 rounded border border-line bg-surface px-1.5 py-1 font-mono text-[11px]"
        />
      </div>
    </div>
  );
}

// -----------------------------------------------------------------------------
// Advanced panel — anything power users might need
// -----------------------------------------------------------------------------

export function AdvancedPanel({ onReset }: { onReset: () => void }) {
  return (
    <PanelSection title="Advanced" icon={Settings2}>
      <button
        type="button"
        onClick={onReset}
        className="w-full rounded border border-line bg-surface px-2 py-1.5 text-xs text-ink-secondary hover:bg-surface-inset"
      >
        Reset to defaults
      </button>
      <p className="text-[10px] leading-snug text-ink-tertiary">
        Resetting clears the URL, removes the uploaded logo, and returns
        every style control to the default rounded-dark design.
      </p>
    </PanelSection>
  );
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function normalizeHex(v: string): string {
  let s = v.startsWith('#') ? v.slice(1) : v;
  if (s.length > 6) s = s.slice(0, 6);
  while (s.length < 6) s = s + '0';
  return `#${s}`;
}

function lighten(hex: string, amt: number): string {
  // Naive HSL-free lightener — used only as a gradient seed.
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.startsWith('#') ? hex : `#${hex}`);
  if (!m) return hex;
  const num = parseInt(m[1]!, 16);
  let r = (num >> 16) & 0xff;
  let g = (num >> 8) & 0xff;
  let b = num & 0xff;
  r = Math.min(255, Math.round(r + (255 - r) * (amt / 100)));
  g = Math.min(255, Math.round(g + (255 - g) * (amt / 100)));
  b = Math.min(255, Math.round(b + (255 - b) * (amt / 100)));
  return `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}

// silence unused-icon lint
export const __icons = { Circle };
