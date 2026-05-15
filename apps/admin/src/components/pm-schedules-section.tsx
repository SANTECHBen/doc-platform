'use client';

// Author preventive maintenance schedules for an asset model. Mounted
// on the asset-model detail page so PM plans live next to the
// equipment they apply to. Every instance of the model inherits these
// schedules — there's nothing per-instance to author. Service records
// (the "this PM was performed at this time" log) are written from the
// PWA when techs run the procedure; admins read them via the asset
// instance's PM history.

import { useEffect, useMemo, useState } from 'react';
import { CalendarClock, Pencil, Plus, Trash2, Pause, Play } from 'lucide-react';
import {
  Drawer,
  ErrorBanner,
  Field,
  PrimaryButton,
  SecondaryButton,
  Select,
  TextInput,
  Textarea,
} from './form';
import { useToast } from './toast';
import { Pill } from './page-shell';
import {
  createPmSchedule,
  deletePmSchedule,
  listPmProcedureDocs,
  listPmSchedules,
  updatePmSchedule,
  type AdminPmProcedureDoc,
  type AdminPmSchedule,
} from '@/lib/api';

export function PMSchedulesSection({
  assetModelId,
}: {
  assetModelId: string;
}) {
  const [schedules, setSchedules] = useState<AdminPmSchedule[] | null>(null);
  const [docs, setDocs] = useState<AdminPmProcedureDoc[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [drawerMode, setDrawerMode] = useState<
    | { kind: 'closed' }
    | { kind: 'create' }
    | { kind: 'edit'; schedule: AdminPmSchedule }
  >({ kind: 'closed' });
  const toast = useToast();

  async function refresh() {
    try {
      const [s, d] = await Promise.all([
        listPmSchedules(assetModelId),
        listPmProcedureDocs(assetModelId),
      ]);
      setSchedules(s);
      setDocs(d);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [assetModelId]);

  return (
    <section id="pm-section" className="mt-8 scroll-mt-24">
      <div className="mb-2 flex items-center justify-between">
        <div>
          <h2 className="text-xs font-medium uppercase tracking-wide text-ink-tertiary">
            Preventive maintenance ({schedules?.length ?? 0})
          </h2>
          <p className="text-xs text-ink-tertiary">
            Schedules apply to every instance of this model. Field techs see
            "Run now" buttons in the PWA when a schedule is due.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setDrawerMode({ kind: 'create' })}
          className="btn btn-primary btn-sm"
          disabled={docs.length === 0}
          title={
            docs.length === 0
              ? 'Add a structured procedure to a content pack first.'
              : 'New PM schedule'
          }
        >
          <Plus size={14} strokeWidth={2} /> New schedule
        </button>
      </div>

      <ErrorBanner error={error} />

      {schedules === null ? (
        <p className="rounded-md border border-line-subtle bg-surface-raised p-4 text-center text-sm text-ink-tertiary">
          Loading…
        </p>
      ) : schedules.length === 0 ? (
        <div className="flex flex-col items-center gap-3 rounded-md border border-dashed border-line bg-surface-raised p-6 text-center">
          <CalendarClock size={28} strokeWidth={1.5} className="text-ink-tertiary" />
          <p className="text-sm text-ink-secondary">
            No PM schedules yet for this model.
          </p>
          {docs.length === 0 ? (
            <p className="text-xs text-ink-tertiary">
              Add a structured procedure to one of this model's content packs
              first — schedules need a procedure to point at.
            </p>
          ) : (
            <SecondaryButton onClick={() => setDrawerMode({ kind: 'create' })}>
              <Plus size={14} strokeWidth={2} /> Add the first schedule
            </SecondaryButton>
          )}
        </div>
      ) : (
        <div className="overflow-hidden rounded-md border border-line-subtle bg-surface-raised">
          <table className="data-table">
            <thead className="bg-surface-inset text-left text-xs uppercase tracking-wide text-ink-tertiary">
              <tr>
                <th className="px-4 py-2">Name</th>
                <th className="px-4 py-2">Procedure</th>
                <th className="px-4 py-2">Cadence</th>
                <th className="px-4 py-2">Grace</th>
                <th className="px-4 py-2">Status</th>
                <th className="px-4 py-2 text-right"></th>
              </tr>
            </thead>
            <tbody>
              {schedules.map((s) => (
                <tr
                  key={s.id}
                  className="border-t border-line-subtle align-top"
                >
                  <td className="px-4 py-3">
                    <div className="font-medium text-ink-primary">{s.name}</div>
                    {s.description && (
                      <div className="mt-0.5 text-xs text-ink-tertiary">
                        {s.description}
                      </div>
                    )}
                  </td>
                  <td className="px-4 py-3 text-ink-secondary">
                    {s.document?.title ?? (
                      <span className="text-signal-warn">no procedure attached</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-ink-secondary">
                    every {s.cadenceValue} day{s.cadenceValue === 1 ? '' : 's'}
                  </td>
                  <td className="px-4 py-3 text-ink-secondary">
                    {s.graceDays} day{s.graceDays === 1 ? '' : 's'}
                  </td>
                  <td className="px-4 py-3">
                    {s.disabled ? (
                      <Pill>paused</Pill>
                    ) : (
                      <Pill tone="success">active</Pill>
                    )}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <div className="inline-flex gap-1">
                      <button
                        type="button"
                        title={s.disabled ? 'Resume' : 'Pause'}
                        onClick={async () => {
                          try {
                            await updatePmSchedule(s.id, { disabled: !s.disabled });
                            toast.success(
                              s.disabled ? 'Schedule resumed' : 'Schedule paused',
                            );
                            await refresh();
                          } catch (e) {
                            toast.error(
                              e instanceof Error ? e.message : String(e),
                            );
                          }
                        }}
                        className="btn btn-ghost btn-sm"
                      >
                        {s.disabled ? (
                          <Play size={12} strokeWidth={2} />
                        ) : (
                          <Pause size={12} strokeWidth={2} />
                        )}
                      </button>
                      <button
                        type="button"
                        onClick={() =>
                          setDrawerMode({ kind: 'edit', schedule: s })
                        }
                        className="btn btn-ghost btn-sm"
                        title="Edit"
                      >
                        <Pencil size={12} strokeWidth={2} />
                      </button>
                      <button
                        type="button"
                        onClick={async () => {
                          if (
                            !confirm(
                              `Delete "${s.name}"? Service records that referenced this schedule will be retained as ad-hoc service.`,
                            )
                          )
                            return;
                          try {
                            await deletePmSchedule(s.id);
                            toast.success('Schedule deleted');
                            await refresh();
                          } catch (e) {
                            toast.error(
                              e instanceof Error ? e.message : String(e),
                            );
                          }
                        }}
                        className="btn btn-ghost btn-sm text-signal-fault"
                        title="Delete"
                      >
                        <Trash2 size={12} strokeWidth={2} />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Drawer
        title={
          drawerMode.kind === 'edit' ? 'Edit PM schedule' : 'New PM schedule'
        }
        open={drawerMode.kind !== 'closed'}
        onClose={() => setDrawerMode({ kind: 'closed' })}
      >
        {drawerMode.kind !== 'closed' && (
          <ScheduleForm
            mode={drawerMode}
            assetModelId={assetModelId}
            docs={docs}
            onSaved={async () => {
              setDrawerMode({ kind: 'closed' });
              await refresh();
            }}
          />
        )}
      </Drawer>
    </section>
  );
}

function ScheduleForm({
  mode,
  assetModelId,
  docs,
  onSaved,
}: {
  mode:
    | { kind: 'create' }
    | { kind: 'edit'; schedule: AdminPmSchedule };
  assetModelId: string;
  docs: AdminPmProcedureDoc[];
  onSaved: () => Promise<void>;
}) {
  const initial = useMemo(() => {
    if (mode.kind === 'edit') {
      return {
        documentId: mode.schedule.documentId ?? '',
        name: mode.schedule.name,
        description: mode.schedule.description ?? '',
        cadenceValue: mode.schedule.cadenceValue,
        graceDays: mode.schedule.graceDays,
      };
    }
    return {
      documentId: docs[0]?.id ?? '',
      name: '',
      description: '',
      cadenceValue: 90,
      graceDays: 0,
    };
  }, [mode, docs]);

  const [documentId, setDocumentId] = useState(initial.documentId);
  const [name, setName] = useState(initial.name);
  const [description, setDescription] = useState(initial.description);
  const [cadenceValue, setCadenceValue] = useState(initial.cadenceValue);
  const [graceDays, setGraceDays] = useState(initial.graceDays);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const toast = useToast();

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      if (mode.kind === 'create') {
        await createPmSchedule(assetModelId, {
          documentId: documentId || null,
          name: name.trim(),
          description: description.trim() || null,
          cadenceValue,
          graceDays,
        });
        toast.success(`${name.trim()} created`, 'PM schedule active.');
      } else {
        await updatePmSchedule(mode.schedule.id, {
          documentId: documentId || null,
          name: name.trim(),
          description: description.trim() || null,
          cadenceValue,
          graceDays,
        });
        toast.success(`${name.trim()} updated`);
      }
      await onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      <ErrorBanner error={error} />
      <Field label="Name" required>
        <TextInput
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Quarterly belt inspection"
          required
        />
      </Field>
      <Field
        label="Description"
        hint="Optional. Shown to techs in the PWA when this PM is due."
      >
        <Textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={2}
        />
      </Field>
      <Field
        label="Procedure to run"
        required
        hint="Pick a structured procedure attached to one of this model's content packs."
      >
        <Select
          value={documentId}
          onChange={(e) => setDocumentId(e.target.value)}
          required
        >
          <option value="">Select procedure…</option>
          {docs.map((d) => (
            <option key={d.id} value={d.id}>
              {d.title}
              {d.contentPack ? ` · ${d.contentPack.name}` : ''}
              {d.contentPackVersion
                ? ` v${
                    d.contentPackVersion.versionLabel ??
                    d.contentPackVersion.versionNumber
                  }`
                : ''}
            </option>
          ))}
        </Select>
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field
          label="Cadence (days)"
          required
          hint="Run every N days. v1 supports calendar cadence only."
        >
          <TextInput
            type="number"
            value={String(cadenceValue)}
            onChange={(e) => setCadenceValue(Number(e.target.value || 0))}
            min={1}
            max={3650}
            required
          />
        </Field>
        <Field
          label="Grace days"
          hint="Days late beyond due date before status flips to overdue. 0 = overdue immediately."
        >
          <TextInput
            type="number"
            value={String(graceDays)}
            onChange={(e) => setGraceDays(Number(e.target.value || 0))}
            min={0}
            max={365}
          />
        </Field>
      </div>
      <div className="mt-2 flex justify-end gap-2">
        <PrimaryButton type="submit" disabled={submitting}>
          {submitting
            ? 'Saving…'
            : mode.kind === 'edit'
            ? 'Save changes'
            : 'Create schedule'}
        </PrimaryButton>
      </div>
    </form>
  );
}
