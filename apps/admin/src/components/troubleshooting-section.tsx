'use client';

// Author OEM-style Troubleshooting Guides for an asset model. One guide =
// one named triage table (e.g., "ARB Flow Splitter — Mechanical").
// Each row is a (Symptom / Cause / Remedy) tuple with an optional
// procedure link the tech can launch from the PWA.
//
// Mirrors PMPlansSection in shape but with three text columns and no
// frequency. Distinct from PM Plans (recurring scheduled checks) — this
// is reactive triage.

import { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  ChevronDown,
  ChevronUp,
  Plus,
  Trash2,
} from 'lucide-react';
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
import {
  createTroubleshootingGuide,
  createTroubleshootingItem,
  deleteTroubleshootingGuide,
  deleteTroubleshootingItem,
  listTroubleshootingGuides,
  listPmProcedureDocs,
  updateTroubleshootingGuide,
  updateTroubleshootingItem,
  type AdminPmProcedureDoc,
  type AdminTroubleshootingCause,
  type AdminTroubleshootingGuide,
  type AdminTroubleshootingItem,
  type AdminTroubleshootingRemedyStep,
} from '@/lib/api';

export function TroubleshootingSection({ assetModelId }: { assetModelId: string }) {
  const [guides, setGuides] = useState<AdminTroubleshootingGuide[] | null>(null);
  const [docs, setDocs] = useState<AdminPmProcedureDoc[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const toast = useToast();

  async function refresh() {
    try {
      const [g, d] = await Promise.all([
        listTroubleshootingGuides(assetModelId),
        // Reuses the PM procedure-doc list — same scope (structured_procedure
        // docs attached to this asset model's packs). No reason for
        // troubleshooting to have its own picker source.
        listPmProcedureDocs(assetModelId),
      ]);
      setGuides(g);
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
    <section id="troubleshooting-section" className="scroll-mt-24">
      <div className="mb-2 flex items-center justify-between">
        <div>
          <h2 className="text-xs font-medium uppercase tracking-wide text-ink-tertiary">
            Troubleshooting guides{guides ? ` (${guides.length})` : ''}
          </h2>
          <p className="text-xs text-ink-tertiary">
            OEM-style triage tables. Each guide owns rows of (Symptom / Cause /
            Remedy). Optional procedure link per row.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setCreateOpen(true)}
          className="btn btn-primary btn-sm"
        >
          <Plus size={14} strokeWidth={2} /> New guide
        </button>
      </div>

      <ErrorBanner error={error} />

      {guides === null ? (
        <p className="rounded-md border border-line-subtle bg-surface-raised p-4 text-center text-sm text-ink-tertiary">
          Loading…
        </p>
      ) : guides.length === 0 ? (
        <div className="flex flex-col items-center gap-3 rounded-md border border-dashed border-line bg-surface-raised p-6 text-center">
          <AlertTriangle size={28} strokeWidth={1.5} className="text-ink-tertiary" />
          <p className="text-sm text-ink-secondary">No troubleshooting guides yet for this model.</p>
          <SecondaryButton onClick={() => setCreateOpen(true)}>
            <Plus size={14} strokeWidth={2} /> Add the first guide
          </SecondaryButton>
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          {guides.map((g) => (
            <GuideCard
              key={g.id}
              guide={g}
              docs={docs}
              onChanged={refresh}
              onToast={(t, b) => (t === 'ok' ? toast.success(b) : toast.error(b))}
            />
          ))}
        </div>
      )}

      <Drawer
        title="New troubleshooting guide"
        open={createOpen}
        onClose={() => setCreateOpen(false)}
      >
        {createOpen && (
          <CreateGuideForm
            assetModelId={assetModelId}
            onCreated={async () => {
              setCreateOpen(false);
              await refresh();
            }}
          />
        )}
      </Drawer>
    </section>
  );
}

function CreateGuideForm({
  assetModelId,
  onCreated,
}: {
  assetModelId: string;
  onCreated: () => Promise<void>;
}) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await createTroubleshootingGuide(assetModelId, {
        name: name.trim(),
        description: description.trim() || null,
      });
      await onCreated();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      <ErrorBanner error={error} />
      <Field label="Guide name" required>
        <TextInput
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g., ARB Flow Splitter — Mechanical"
          required
        />
      </Field>
      <Field label="Description" hint="Optional. Shown above the rows in the PWA.">
        <Textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={2}
        />
      </Field>
      <div className="flex justify-end">
        <PrimaryButton type="submit" disabled={busy || !name.trim()}>
          {busy ? 'Creating…' : 'Create guide'}
        </PrimaryButton>
      </div>
    </form>
  );
}

function GuideCard({
  guide,
  docs,
  onChanged,
  onToast,
}: {
  guide: AdminTroubleshootingGuide;
  docs: AdminPmProcedureDoc[];
  onChanged: () => Promise<void>;
  onToast: (tone: 'ok' | 'err', body: string) => void;
}) {
  const [editingName, setEditingName] = useState(false);
  const [name, setName] = useState(guide.name);
  const [collapsed, setCollapsed] = useState(false);
  useEffect(() => setName(guide.name), [guide.name]);

  async function saveName() {
    const v = name.trim();
    if (!v || v === guide.name) {
      setEditingName(false);
      setName(guide.name);
      return;
    }
    try {
      await updateTroubleshootingGuide(guide.id, { name: v });
      onToast('ok', 'Guide renamed');
      setEditingName(false);
      await onChanged();
    } catch (e) {
      onToast('err', e instanceof Error ? e.message : String(e));
    }
  }

  async function onDelete() {
    if (
      !confirm(
        `Delete guide "${guide.name}"? Its ${guide.items.length} row${guide.items.length === 1 ? '' : 's'} will be removed too.`,
      )
    ) {
      return;
    }
    try {
      await deleteTroubleshootingGuide(guide.id);
      onToast('ok', 'Guide deleted');
      await onChanged();
    } catch (e) {
      onToast('err', e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <section className="rounded-md border border-line bg-surface-raised">
      <header className="flex items-center gap-2 border-b border-line-subtle px-4 py-2.5">
        <button
          type="button"
          onClick={() => setCollapsed((c) => !c)}
          className="rounded p-1 text-ink-tertiary hover:bg-surface-elevated"
          aria-label={collapsed ? 'Expand' : 'Collapse'}
        >
          {collapsed ? <ChevronDown size={16} /> : <ChevronUp size={16} />}
        </button>
        {editingName ? (
          <form
            className="flex-1"
            onSubmit={(e) => {
              e.preventDefault();
              void saveName();
            }}
          >
            <input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              onBlur={() => void saveName()}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  setEditingName(false);
                  setName(guide.name);
                }
              }}
              className="w-full rounded border border-line bg-surface px-2 py-1 text-base font-semibold"
            />
          </form>
        ) : (
          <button
            type="button"
            onClick={() => setEditingName(true)}
            className="flex-1 truncate text-left text-base font-semibold text-ink-primary hover:text-brand"
          >
            {guide.name}
          </button>
        )}
        <span className="text-xs text-ink-tertiary">
          {guide.items.length} row{guide.items.length === 1 ? '' : 's'}
        </span>
        <button
          type="button"
          onClick={onDelete}
          className="rounded p-1 text-ink-tertiary hover:bg-signal-fault/10 hover:text-signal-fault"
          title="Delete guide"
        >
          <Trash2 size={14} />
        </button>
      </header>

      {!collapsed && (
        <div className="overflow-hidden">
          {guide.items.length === 0 ? (
            <p className="px-4 py-3 text-sm text-ink-tertiary">
              No rows yet. Use the form below to add the first one.
            </p>
          ) : (
            <table className="data-table w-full text-sm">
              <thead className="bg-surface-inset text-left text-[10px] uppercase tracking-wider text-ink-tertiary">
                <tr>
                  <th className="w-64 px-3 py-2">Symptom</th>
                  <th className="px-3 py-2">Possible causes &amp; remedies</th>
                  <th className="w-8 px-3 py-2"></th>
                </tr>
              </thead>
              <tbody>
                {guide.items.map((it) => (
                  <ItemRow
                    key={it.id}
                    item={it}
                    docs={docs}
                    onChanged={onChanged}
                    onToast={onToast}
                  />
                ))}
              </tbody>
            </table>
          )}
          <NewItemForm
            guideId={guide.id}
            onAdded={onChanged}
            onToast={onToast}
          />
        </div>
      )}
    </section>
  );
}

function ItemRow({
  item,
  docs,
  onChanged,
  onToast,
}: {
  item: AdminTroubleshootingItem;
  docs: AdminPmProcedureDoc[];
  onChanged: () => Promise<void>;
  onToast: (tone: 'ok' | 'err', body: string) => void;
}) {
  const [symptom, setSymptom] = useState(item.symptom);
  useEffect(() => setSymptom(item.symptom), [item.symptom]);

  async function flush(patch: Parameters<typeof updateTroubleshootingItem>[1]) {
    try {
      await updateTroubleshootingItem(item.id, patch);
      await onChanged();
    } catch (e) {
      onToast('err', e instanceof Error ? e.message : String(e));
    }
  }

  async function onDelete() {
    if (!confirm(`Delete row "${item.symptom}"?`)) return;
    try {
      await deleteTroubleshootingItem(item.id);
      await onChanged();
    } catch (e) {
      onToast('err', e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <tr className="border-t border-line-subtle align-top">
      <td className="px-3 py-2">
        <textarea
          value={symptom}
          onChange={(e) => setSymptom(e.target.value)}
          onBlur={() => {
            const v = symptom.trim();
            if (v && v !== item.symptom) void flush({ symptom: v });
          }}
          rows={2}
          className="w-full rounded border border-transparent bg-transparent px-1 py-0.5 font-medium hover:border-line focus:border-accent focus:bg-surface"
        />
      </td>
      <td className="px-3 py-2">
        <PairedCausesEditor
          causes={item.causes}
          legacyCause={item.cause}
          legacyRemedy={item.remedy}
          docs={docs}
          onChange={(next) => void flush({ causes: next })}
        />
      </td>
      <td className="px-3 py-2">
        <button
          type="button"
          onClick={onDelete}
          className="rounded p-1 text-ink-tertiary hover:bg-signal-fault/10 hover:text-signal-fault"
          aria-label="Delete row"
        >
          <Trash2 size={14} />
        </button>
      </td>
    </tr>
  );
}

function NewItemForm({
  guideId,
  onAdded,
  onToast,
}: {
  guideId: string;
  onAdded: () => Promise<void>;
  onToast: (tone: 'ok' | 'err', body: string) => void;
}) {
  const [symptom, setSymptom] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!symptom.trim()) return;
    setBusy(true);
    try {
      // Create the row with just the symptom — the author fills in
      // structured cause/remedy items inline on the freshly-added row.
      // Keeps the add-form short and matches the inline-editing pattern
      // the rest of the page uses.
      await createTroubleshootingItem(guideId, {
        symptom: symptom.trim(),
      });
      setSymptom('');
      await onAdded();
    } catch (e) {
      onToast('err', e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      onSubmit={submit}
      className="flex flex-col gap-2 border-t border-line-subtle bg-surface-inset px-3 py-3"
    >
      <textarea
        value={symptom}
        onChange={(e) => setSymptom(e.target.value)}
        placeholder="Symptom (e.g., Conveyor belt not moving)"
        rows={2}
        className="rounded border border-line bg-surface px-2 py-1.5 text-sm"
      />
      <button
        type="submit"
        disabled={busy || !symptom.trim()}
        className="group flex w-full items-center justify-center gap-1.5 rounded-md border border-dashed border-line bg-surface px-3 py-2 text-xs font-medium text-ink-secondary transition hover:border-accent/40 hover:bg-accent/5 hover:text-accent disabled:cursor-not-allowed disabled:opacity-50"
      >
        <Plus size={14} strokeWidth={2} className="transition group-hover:rotate-90" />
        {busy ? 'Adding…' : 'Add row'}
      </button>
    </form>
  );
}

// PairedCausesEditor — the canonical authoring shape. Each entry is one
// possible cause for the symptom, paired with its specific remedy and
// an optional procedure link. Replaces the old "two parallel lists"
// model that didn't capture which cause maps to which remedy.
//
// Layout per entry: a bordered block with two stacked textareas
// (Cause on top, Remedy below) + a chip-style procedure attachment
// + a hover-only delete. "+ Add cause" appends a blank pair.
function PairedCausesEditor({
  causes,
  legacyCause,
  legacyRemedy,
  docs,
  onChange,
}: {
  causes: AdminTroubleshootingCause[];
  legacyCause: string | null;
  legacyRemedy: string | null;
  docs: AdminPmProcedureDoc[];
  onChange: (next: AdminTroubleshootingCause[]) => void;
}) {
  // Normalize on load — pre-0029 entries stored a single `remedy`
  // string and an optional per-cause documentId; collapse those into a
  // single bullet step so the editor only deals with one shape. The
  // normalized entry round-trips on save, which drops the legacy fields
  // from the stored jsonb on first edit (migrate-on-write).
  const normalized = useMemo(() => causes.map(normalizeCause), [causes]);
  const [local, setLocal] = useState<AdminTroubleshootingCause[]>(normalized);
  useEffect(() => setLocal(normalized), [normalized]);

  function update(next: AdminTroubleshootingCause[], commit: boolean) {
    setLocal(next);
    if (commit) onChange(next);
  }
  function setCause(idx: number, value: string, commit: boolean) {
    const next = local.slice();
    next[idx] = { ...local[idx]!, cause: value };
    update(next, commit);
  }
  function setStyle(idx: number, value: 'bullet' | 'numbered') {
    const next = local.slice();
    next[idx] = { ...local[idx]!, remedyStyle: value };
    update(next, true);
  }
  function setStep(
    cIdx: number,
    sIdx: number,
    patch: Partial<AdminTroubleshootingRemedyStep>,
    commit: boolean,
  ) {
    const next = local.slice();
    const entry = local[cIdx]!;
    const steps = (entry.remedySteps ?? []).slice();
    steps[sIdx] = { ...steps[sIdx]!, ...patch };
    next[cIdx] = { ...entry, remedySteps: steps };
    update(next, commit);
  }
  function addStep(cIdx: number) {
    const next = local.slice();
    const entry = local[cIdx]!;
    next[cIdx] = {
      ...entry,
      remedySteps: [
        ...(entry.remedySteps ?? []),
        { text: '', documentId: null },
      ],
    };
    update(next, true);
  }
  function deleteStep(cIdx: number, sIdx: number) {
    const next = local.slice();
    const entry = local[cIdx]!;
    next[cIdx] = {
      ...entry,
      remedySteps: (entry.remedySteps ?? []).filter((_, i) => i !== sIdx),
    };
    update(next, true);
  }

  const hasLegacy =
    local.length === 0 &&
    (((legacyCause ?? '').trim().length > 0) ||
      ((legacyRemedy ?? '').trim().length > 0));

  return (
    <div className="flex flex-col gap-3">
      {hasLegacy && (
        // Legacy free-text fallback — surfaces pre-0028 unpaired data so
        // the author can see it and retype into the structured fields
        // below to migrate.
        <div className="rounded-sm border border-dashed border-line-subtle bg-surface-inset/50 px-3 py-2 text-xs italic text-ink-tertiary">
          {legacyCause && (
            <div>
              <span className="font-semibold not-italic text-ink-tertiary">Cause:</span>{' '}
              {legacyCause}
            </div>
          )}
          {legacyRemedy && (
            <div className={legacyCause ? 'mt-1' : ''}>
              <span className="font-semibold not-italic text-ink-tertiary">Remedy:</span>{' '}
              {legacyRemedy}
            </div>
          )}
          <div className="mt-1 text-[10px]">
            Legacy unpaired data — add a structured cause below to migrate.
          </div>
        </div>
      )}
      {local.map((entry, idx) => {
        const style = entry.remedyStyle ?? 'bullet';
        const steps = entry.remedySteps ?? [];
        return (
          <div
            key={idx}
            className="group relative rounded-md border border-line-subtle bg-surface px-3 py-2"
          >
            <button
              type="button"
              onClick={() => update(local.filter((_, i) => i !== idx), true)}
              className="absolute right-1.5 top-1.5 rounded p-1 text-ink-tertiary opacity-0 transition group-hover:opacity-100 hover:bg-signal-fault/10 hover:text-signal-fault"
              aria-label="Delete cause"
              title="Delete this cause + remedy"
            >
              <Trash2 size={12} />
            </button>
            <div className="flex flex-col gap-1">
              <label className="text-[10px] font-semibold uppercase tracking-wider text-ink-tertiary">
                Cause
              </label>
              <textarea
                value={entry.cause}
                onChange={(e) => setCause(idx, e.target.value, false)}
                onBlur={() => {
                  const v = local[idx]!.cause.trim();
                  if (v !== normalized[idx]?.cause) setCause(idx, v, true);
                }}
                placeholder="e.g., Sprockets misaligned (2.2)"
                rows={1}
                style={{ fieldSizing: 'content' } as React.CSSProperties}
                className="min-h-[1.75rem] w-full resize-none rounded-sm border border-line bg-surface px-2 py-1 leading-snug focus:border-accent focus:bg-surface"
              />
            </div>
            <div className="mt-2 flex items-center justify-between">
              <label className="text-[10px] font-semibold uppercase tracking-wider text-ink-tertiary">
                Remedy steps
              </label>
              {/* Style toggle — bullet vs numbered list. Numbered when
                  the steps are sequential ("do this, then this"); bullet
                  when they're alternatives or unordered checks. */}
              <div className="flex rounded border border-line-subtle text-[10px]">
                <button
                  type="button"
                  onClick={() => setStyle(idx, 'bullet')}
                  className={`px-1.5 py-0.5 ${
                    style === 'bullet'
                      ? 'bg-accent/10 text-accent'
                      : 'text-ink-tertiary hover:text-ink-secondary'
                  }`}
                  title="Bulleted list"
                  aria-pressed={style === 'bullet'}
                >
                  •
                </button>
                <button
                  type="button"
                  onClick={() => setStyle(idx, 'numbered')}
                  className={`border-l border-line-subtle px-1.5 py-0.5 ${
                    style === 'numbered'
                      ? 'bg-accent/10 text-accent'
                      : 'text-ink-tertiary hover:text-ink-secondary'
                  }`}
                  title="Numbered list"
                  aria-pressed={style === 'numbered'}
                >
                  1.
                </button>
              </div>
            </div>
            <div className="mt-1 flex flex-col gap-1.5">
              {steps.map((step, sIdx) => {
                const linkedDoc = step.documentId
                  ? docs.find((d) => d.id === step.documentId)
                  : null;
                return (
                  <div
                    key={sIdx}
                    className="group/step flex items-start gap-1.5"
                  >
                    <span
                      className="mt-2 w-5 shrink-0 select-none text-center text-[11px] text-ink-tertiary"
                      aria-hidden
                    >
                      {style === 'numbered' ? `${sIdx + 1}.` : '•'}
                    </span>
                    <div className="min-w-0 flex-1 flex flex-col gap-1">
                      <textarea
                        value={step.text}
                        onChange={(e) =>
                          setStep(idx, sIdx, { text: e.target.value }, false)
                        }
                        onBlur={() => {
                          const v = local[idx]!.remedySteps![sIdx]!.text.trim();
                          if (
                            v !== normalized[idx]?.remedySteps?.[sIdx]?.text
                          ) {
                            setStep(idx, sIdx, { text: v }, true);
                          }
                        }}
                        placeholder="What to do for this step"
                        rows={1}
                        style={{ fieldSizing: 'content' } as React.CSSProperties}
                        className="min-h-[1.75rem] w-full resize-none rounded-sm border border-line bg-surface px-2 py-1 leading-snug focus:border-accent focus:bg-surface"
                      />
                      <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-ink-tertiary">
                        {linkedDoc ? (
                          <>
                            <span className="inline-flex items-center gap-1 rounded-full border border-brand/30 bg-brand/5 px-2 py-0.5 text-brand">
                              ↗ {linkedDoc.title}
                            </span>
                            <select
                              value=""
                              onChange={(e) => {
                                const v = e.target.value || null;
                                setStep(idx, sIdx, { documentId: v }, true);
                              }}
                              className="rounded border border-transparent bg-transparent px-1 py-0.5 text-[10px] text-ink-tertiary hover:border-line"
                              aria-label="Change or unlink the procedure"
                              title="Change or unlink"
                            >
                              <option value="">change…</option>
                              <option value="">— unlink —</option>
                              {docs
                                .filter((d) => d.id !== step.documentId)
                                .map((d) => (
                                  <option key={d.id} value={d.id}>
                                    {d.title}
                                  </option>
                                ))}
                            </select>
                          </>
                        ) : (
                          <select
                            value=""
                            onChange={(e) => {
                              const v = e.target.value || null;
                              setStep(idx, sIdx, { documentId: v }, true);
                            }}
                            className="rounded border border-dashed border-line-subtle bg-transparent px-1.5 py-0.5 text-[10px] text-ink-tertiary hover:border-accent/40 hover:text-accent"
                            aria-label="Link a procedure to this step"
                          >
                            <option value="">+ link procedure</option>
                            {docs.map((d) => (
                              <option key={d.id} value={d.id}>
                                {d.title}
                              </option>
                            ))}
                          </select>
                        )}
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => deleteStep(idx, sIdx)}
                      className="mt-2 shrink-0 rounded p-1 text-ink-tertiary opacity-0 transition group-hover/step:opacity-100 hover:bg-signal-fault/10 hover:text-signal-fault"
                      aria-label="Delete step"
                      title="Delete step"
                    >
                      <Trash2 size={11} />
                    </button>
                  </div>
                );
              })}
              <button
                type="button"
                onClick={() => addStep(idx)}
                className="ml-6 self-start inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-medium text-ink-tertiary hover:bg-accent/10 hover:text-accent"
              >
                <Plus size={11} strokeWidth={2} /> Add step
              </button>
            </div>
          </div>
        );
      })}
      <button
        type="button"
        onClick={() => {
          // Append an empty cause with one empty step; commit
          // immediately so the row exists server-side and onBlur on the
          // new inputs flushes the text. Empty entries are filtered out
          // by the PWA renderer.
          update(
            [
              ...local,
              {
                cause: '',
                remedyStyle: 'bullet',
                remedySteps: [{ text: '', documentId: null }],
              },
            ],
            true,
          );
        }}
        className="self-start inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-medium text-ink-tertiary hover:bg-accent/10 hover:text-accent"
      >
        <Plus size={11} strokeWidth={2} /> Add cause
      </button>
    </div>
  );
}

// Normalize a stored cause entry into the editor's canonical shape:
// always has `remedyStyle` + `remedySteps`. Pre-0029 entries with only
// `remedy` + per-cause `documentId` collapse into a single bullet step,
// and the legacy fields are dropped so the next save migrates the row.
function normalizeCause(c: AdminTroubleshootingCause): AdminTroubleshootingCause {
  if (c.remedySteps && c.remedySteps.length > 0) {
    return {
      cause: c.cause,
      remedyStyle: c.remedyStyle ?? 'bullet',
      remedySteps: c.remedySteps,
    };
  }
  const legacyText = (c.remedy ?? '').trim();
  return {
    cause: c.cause,
    remedyStyle: 'bullet',
    remedySteps: legacyText
      ? [{ text: legacyText, documentId: c.documentId ?? null }]
      : [{ text: '', documentId: null }],
  };
}
