'use client';

// Measurement spec editor — sub-form for measurement_required steps.
// Tabbed by spec.kind: numeric | pass_fail | free_text. The full spec
// is round-tripped through the parent form; this editor doesn't
// persist anything itself.

import { Field, Select, TextInput } from '@/components/form';
import type { MeasurementSpec } from '@/lib/api';

const KIND_LABELS: Record<MeasurementSpec['kind'], string> = {
  numeric: 'Numeric',
  pass_fail: 'Pass / fail',
  free_text: 'Free text',
};

export function MeasurementSpecEditor({
  value,
  onChange,
}: {
  value: MeasurementSpec;
  onChange: (next: MeasurementSpec) => void;
}) {
  function setKind(kind: MeasurementSpec['kind']) {
    if (kind === value.kind) return;
    if (kind === 'numeric') {
      onChange({ kind: 'numeric', label: value.label, unit: '' });
    } else if (kind === 'pass_fail') {
      onChange({ kind: 'pass_fail', label: value.label });
    } else {
      onChange({ kind: 'free_text', label: value.label });
    }
  }

  return (
    // Matches the Section card chrome used by the parent step form so
    // every group on the editor reads as a peer.
    <section className="rounded-md border border-line-subtle bg-surface-raised p-5">
      <header className="mb-3">
        <p className="form-label">Measurement spec</p>
        <p className="mt-1 text-xs text-ink-tertiary">
          What the runner enforces at run time when this step is being
          executed.
        </p>
      </header>
      <div className="flex flex-col gap-4">
      <Field label="Measurement type" required>
        <Select
          value={value.kind}
          onChange={(e) => setKind(e.target.value as MeasurementSpec['kind'])}
        >
          {(['numeric', 'pass_fail', 'free_text'] as const).map((k) => (
            <option key={k} value={k}>
              {KIND_LABELS[k]}
            </option>
          ))}
        </Select>
      </Field>

      <Field label="Label" required hint="What the tech sees above the input — e.g., 'Torque', 'Visual inspection', 'Replacement serial number'">
        <TextInput
          value={value.label}
          onChange={(e) => onChange({ ...value, label: e.target.value })}
          placeholder="Torque"
        />
      </Field>

      {value.kind === 'numeric' && (
        <NumericFields value={value} onChange={onChange} />
      )}
      {value.kind === 'pass_fail' && (
        <PassFailFields value={value} onChange={onChange} />
      )}
      {value.kind === 'free_text' && (
        <FreeTextFields value={value} onChange={onChange} />
      )}
      </div>
    </section>
  );
}

function NumericFields({
  value,
  onChange,
}: {
  value: Extract<MeasurementSpec, { kind: 'numeric' }>;
  onChange: (next: MeasurementSpec) => void;
}) {
  return (
    <>
      <Field label="Unit" required hint="Free text. Common: N·m, lbf·ft, psi, mm, °C, V">
        <TextInput
          value={value.unit}
          onChange={(e) => onChange({ ...value, unit: e.target.value })}
          placeholder="N·m"
        />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Min" hint="Lowest acceptable value">
          <TextInput
            type="number"
            inputMode="decimal"
            step="any"
            value={value.min ?? ''}
            onChange={(e) =>
              onChange({
                ...value,
                min: e.target.value === '' ? null : Number(e.target.value),
              })
            }
          />
        </Field>
        <Field label="Max" hint="Highest acceptable value">
          <TextInput
            type="number"
            inputMode="decimal"
            step="any"
            value={value.max ?? ''}
            onChange={(e) =>
              onChange({
                ...value,
                max: e.target.value === '' ? null : Number(e.target.value),
              })
            }
          />
        </Field>
      </div>
      <Field
        label="Target value (optional)"
        hint="If you have a single 'spec' value with no explicit min/max, surface it as a target the tech aims for."
      >
        <TextInput
          type="number"
          inputMode="decimal"
          step="any"
          value={value.expected ?? ''}
          onChange={(e) =>
            onChange({
              ...value,
              expected: e.target.value === '' ? null : Number(e.target.value),
            })
          }
        />
      </Field>
    </>
  );
}

function PassFailFields({
  value,
  onChange,
}: {
  value: Extract<MeasurementSpec, { kind: 'pass_fail' }>;
  onChange: (next: MeasurementSpec) => void;
}) {
  return (
    <div className="grid grid-cols-2 gap-3">
      <Field label="Pass label" hint="Defaults to 'Pass'">
        <TextInput
          value={value.passLabel ?? ''}
          onChange={(e) =>
            onChange({ ...value, passLabel: e.target.value || undefined })
          }
          placeholder="Pass"
        />
      </Field>
      <Field label="Fail label" hint="Defaults to 'Fail'">
        <TextInput
          value={value.failLabel ?? ''}
          onChange={(e) =>
            onChange({ ...value, failLabel: e.target.value || undefined })
          }
          placeholder="Fail"
        />
      </Field>
    </div>
  );
}

function FreeTextFields({
  value,
  onChange,
}: {
  value: Extract<MeasurementSpec, { kind: 'free_text' }>;
  onChange: (next: MeasurementSpec) => void;
}) {
  return (
    <>
      <Field label="Placeholder" hint="Hint text shown inside the empty input">
        <TextInput
          value={value.placeholder ?? ''}
          onChange={(e) =>
            onChange({ ...value, placeholder: e.target.value || undefined })
          }
          placeholder="Replacement part S/N"
        />
      </Field>
      <Field label="Max length" hint="Caps the response length (default 500 characters)">
        <TextInput
          type="number"
          inputMode="numeric"
          min="1"
          max="2000"
          value={value.maxLen ?? ''}
          onChange={(e) =>
            onChange({
              ...value,
              maxLen: e.target.value === '' ? undefined : Number(e.target.value),
            })
          }
        />
      </Field>
    </>
  );
}
