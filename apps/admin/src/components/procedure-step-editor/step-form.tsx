'use client';

// ProcedureStepForm — the drawer-pattern editor for one procedure step.
// Mirrors components/section-editor/section-form.tsx in surface area but
// has a different field set (kind, body markdown, evidence requirements).

import { useEffect, useState } from 'react';
import {
  Field,
  PrimaryButton,
  SecondaryButton,
  Select,
  TextInput,
  ErrorBanner,
} from '@/components/form';
import { RichTextEditor } from '@/components/rich-text-editor';
import {
  listAdminParts,
  listPartsForProcedureStep,
  type AdminPart,
  type AdminProcedureStep,
  type CreateProcedureStepInput,
  type MeasurementSpec,
  type ProcedureStepKind,
} from '@/lib/api';
import { PartsPicker } from '@/components/section-editor/parts-picker';
import { MeasurementSpecEditor } from './measurement-spec-editor';

const KIND_LABELS: Record<ProcedureStepKind, string> = {
  instruction: 'Instruction (read & tap)',
  safety_check: 'Safety check (acknowledge before continuing)',
  photo_required: 'Photo required (capture evidence)',
  measurement_required: 'Measurement required (numeric / pass-fail / text)',
};

export function ProcedureStepForm({
  editing,
  onSave,
  onCancel,
}: {
  editing: AdminProcedureStep | null;
  onSave: (
    input: CreateProcedureStepInput,
    partIds: string[],
  ) => Promise<void> | void;
  onCancel: () => void;
}) {
  const [kind, setKind] = useState<ProcedureStepKind>(
    editing?.kind ?? 'instruction',
  );
  const [title, setTitle] = useState(editing?.title ?? '');
  const [bodyMarkdown, setBodyMarkdown] = useState(editing?.bodyMarkdown ?? '');
  const [safetyCritical, setSafetyCritical] = useState(
    editing?.safetyCritical ?? false,
  );
  const [requiresPhoto, setRequiresPhoto] = useState(
    editing?.requiresPhoto ?? false,
  );
  const [minPhotoCount, setMinPhotoCount] = useState<number>(
    editing?.minPhotoCount ?? 0,
  );
  const [measurementSpec, setMeasurementSpec] = useState<MeasurementSpec | null>(
    editing?.measurementSpec ?? null,
  );

  const [allParts, setAllParts] = useState<AdminPart[] | null>(null);
  const [linkedPartIds, setLinkedPartIds] = useState<Set<string>>(new Set());

  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Load parts list + (if editing) currently-linked parts.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [parts, linked] = await Promise.all([
          listAdminParts(),
          editing ? listPartsForProcedureStep(editing.id) : Promise.resolve([]),
        ]);
        if (cancelled) return;
        setAllParts(parts);
        setLinkedPartIds(new Set(linked.map((l) => l.partId)));
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [editing?.id]);

  // Auto-coerce evidence flags when the kind changes so the form mirrors
  // what the API accepts. Keeps the user from saving incoherent shapes.
  function onKindChange(next: ProcedureStepKind) {
    setKind(next);
    if (next === 'photo_required') {
      setRequiresPhoto(true);
      if (minPhotoCount < 1) setMinPhotoCount(1);
      setMeasurementSpec(null);
    } else if (next === 'measurement_required') {
      // Default to a numeric spec — most common authoring case.
      if (!measurementSpec) {
        setMeasurementSpec({ kind: 'numeric', label: '', unit: '' });
      }
    } else if (next === 'safety_check') {
      setSafetyCritical(true);
      setMeasurementSpec(null);
    } else {
      // instruction
      setMeasurementSpec(null);
    }
  }

  function buildInput(): CreateProcedureStepInput | null {
    if (!title.trim()) {
      setError('Title is required.');
      return null;
    }
    if (kind === 'measurement_required') {
      if (!measurementSpec) {
        setError('Measurement spec is required for measurement_required steps.');
        return null;
      }
      if (!measurementSpec.label.trim()) {
        setError('Measurement label is required.');
        return null;
      }
      if (measurementSpec.kind === 'numeric' && !measurementSpec.unit.trim()) {
        setError('Measurement unit is required for numeric specs.');
        return null;
      }
      if (
        measurementSpec.kind === 'numeric' &&
        measurementSpec.min != null &&
        measurementSpec.max != null &&
        measurementSpec.min > measurementSpec.max
      ) {
        setError('Numeric min must be <= max.');
        return null;
      }
    }
    if (kind === 'photo_required' && minPhotoCount < 1) {
      setError('photo_required steps must require at least 1 photo.');
      return null;
    }

    return {
      kind,
      title: title.trim(),
      bodyMarkdown: bodyMarkdown.trim() ? bodyMarkdown : null,
      safetyCritical,
      requiresPhoto,
      minPhotoCount,
      measurementSpec: kind === 'measurement_required' ? measurementSpec : null,
    };
  }

  async function onSubmit() {
    setError(null);
    const input = buildInput();
    if (!input) return;
    setBusy(true);
    try {
      await onSave(input, [...linkedPartIds]);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    // Single scroll context (the FullPageOverlay's inner div). The
    // Cancel / Save bar lives at the TOP of the form and sticks there
    // as the user scrolls down, so action buttons are always one tap
    // away without doubling the scroll surface.
    //
    // Layout language: every editable group is a Section card with a
    // consistent label, padding, and inter-field rhythm — gives the
    // page a uniform, settled look instead of a series of bare inputs.
    <div className="mx-auto flex max-w-3xl flex-col gap-4 px-6 pb-12">
      <div
        className="sticky top-0 -mx-6 z-10 flex items-center justify-end gap-2 border-b border-line bg-surface-raised px-6 py-3"
        style={{ boxShadow: '0 4px 8px -4px rgba(0,0,0,0.06)' }}
      >
        <SecondaryButton type="button" onClick={onCancel} disabled={busy}>
          Cancel
        </SecondaryButton>
        <PrimaryButton type="button" onClick={onSubmit} disabled={busy}>
          {busy ? 'Saving…' : editing ? 'Save changes' : 'Create step'}
        </PrimaryButton>
      </div>
      <ErrorBanner error={error} />

      <Section label="Step content">
        <Field label="Step kind" required>
          <Select
            value={kind}
            onChange={(e) => onKindChange(e.target.value as ProcedureStepKind)}
          >
            {(
              [
                'instruction',
                'safety_check',
                'photo_required',
                'measurement_required',
              ] as const
            ).map((k) => (
              <option key={k} value={k}>
                {KIND_LABELS[k]}
              </option>
            ))}
          </Select>
        </Field>

        <Field
          label="Title"
          required
          hint="Short imperative — 'Apply LOTO', 'Torque to 18-22 N·m', 'Inspect bearing race for scoring'"
        >
          <TextInput
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Apply LOTO"
            autoFocus
          />
        </Field>

        <Field
          label="Body"
          hint="Detailed instructions, warnings, hyperlinks. Use the toolbar for bold / italic / lists / links, or the mic to dictate."
        >
          <RichTextEditor
            value={bodyMarkdown}
            onChange={setBodyMarkdown}
            placeholder="What to do at this step. Bold, lists, and links are available in the toolbar above."
            minHeight={160}
          />
        </Field>
      </Section>

      <Section label="Flags">
        <label className="flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            checked={safetyCritical}
            onChange={(e) => setSafetyCritical(e.target.checked)}
            className="mt-0.5"
          />
          <span>
            <strong>Safety-critical</strong> — surfaces the safety rail in the
            runner; skipping requires written justification.
          </span>
        </label>
      </Section>

      {(kind === 'photo_required' || kind === 'measurement_required') && (
        <Section label="Photo evidence">
          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              checked={requiresPhoto}
              onChange={(e) => setRequiresPhoto(e.target.checked)}
              disabled={kind === 'photo_required'}
              className="mt-0.5"
            />
            <span>
              <strong>Require photo</strong> — tech can&apos;t advance without
              capturing at least one image.
            </span>
          </label>
          {requiresPhoto && (
            <div className="max-w-xs">
              <Field
                label="Minimum photos"
                hint="Common values: 1 (single before/after shot), 2 (before + after), 3 (before / during / after)"
              >
                <TextInput
                  type="number"
                  inputMode="numeric"
                  min="1"
                  max="5"
                  value={minPhotoCount}
                  onChange={(e) =>
                    setMinPhotoCount(Math.max(1, Number(e.target.value) || 1))
                  }
                />
              </Field>
            </div>
          )}
        </Section>
      )}

      {kind === 'measurement_required' && measurementSpec && (
        <MeasurementSpecEditor
          value={measurementSpec}
          onChange={setMeasurementSpec}
        />
      )}

      <Section
        label="Linked parts"
        description="Optional. When a tech opens a part, this step surfaces in its procedures list. Steps can be linked to multiple parts."
      >
        {allParts === null ? (
          <p className="text-xs text-ink-tertiary">Loading parts…</p>
        ) : (
          <PartsPicker
            allParts={allParts}
            selected={linkedPartIds}
            onChange={setLinkedPartIds}
          />
        )}
      </Section>
    </div>
  );
}

// Section — uniform card chrome for every group in the form. A small
// caption-style label sits at the top, an optional one-line description
// underneath, then the children stack with consistent rhythm.
function ProcedureStepSection({
  label,
  description,
  children,
}: {
  label: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-md border border-line-subtle bg-surface-raised p-5">
      <header className="mb-3">
        <p className="form-label">{label}</p>
        {description && (
          <p className="mt-1 text-xs text-ink-tertiary">{description}</p>
        )}
      </header>
      <div className="flex flex-col gap-4">{children}</div>
    </section>
  );
}

// Local alias so callsites read `<Section …>` without colliding with
// any future shared `<Section>` primitive added higher up.
const Section = ProcedureStepSection;
