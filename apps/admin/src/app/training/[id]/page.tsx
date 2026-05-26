'use client';

import Link from 'next/link';
import { use, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  FileText,
  GraduationCap,
  ListChecks,
  Pencil,
  Plus,
  Presentation,
  Trash2,
  X,
} from 'lucide-react';
import { PageHeader, PageShell, Pill } from '@/components/page-shell';
import {
  Drawer,
  ErrorBanner,
  Field,
  PrimaryButton,
  SecondaryButton,
  TextInput,
  Textarea,
} from '@/components/form';
import { useToast } from '@/components/toast';
import {
  createLesson,
  createQuizActivity,
  deleteActivity,
  deleteLesson,
  deleteTrainingModule,
  getTrainingModule,
  updateActivity,
  updateLesson,
  updateTrainingModule,
  type AdminActivity,
  type AdminLesson,
  type AdminQuizQuestion,
  type AdminTrainingModuleDetail,
} from '@/lib/api';

export default function TrainingModuleDetail({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const router = useRouter();
  const toast = useToast();
  const [mod, setMod] = useState<AdminTrainingModuleDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [addLessonOpen, setAddLessonOpen] = useState(false);
  const [addActivityOpen, setAddActivityOpen] = useState(false);
  const [addSlideCourseOpen, setAddSlideCourseOpen] = useState(false);
  const [editLesson, setEditLesson] = useState<AdminLesson | null>(null);
  const [editActivity, setEditActivity] = useState<AdminActivity | null>(null);
  const [editMetaOpen, setEditMetaOpen] = useState(false);

  async function refresh() {
    try {
      const m = await getTrainingModule(id);
      if (!m) {
        setError('Not found');
        return;
      }
      setMod(m);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  async function onDeleteModule() {
    if (!mod) return;
    if (!confirm(`Delete "${mod.title}" and all its lessons + activities?`)) return;
    try {
      await deleteTrainingModule(id);
      toast.success('Module deleted');
      router.push('/training');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  }

  if (error) return <ErrorBanner error={error} />;
  if (!mod) return <p className="p-6 text-center text-sm text-ink-tertiary">Loading…</p>;

  const editable = mod.contentPack.status === 'draft';
  const statusTone =
    mod.contentPack.status === 'published'
      ? 'success'
      : mod.contentPack.status === 'draft'
      ? 'default'
      : mod.contentPack.status === 'in_review'
      ? 'warning'
      : 'default';

  return (
    <PageShell
      crumbs={[
        { label: 'Training', href: '/training' },
        { label: mod.title },
      ]}
    >
      <PageHeader
        title={mod.title}
        description={
          <>
            <Link
              href={`/content-packs/${mod.contentPack.id}`}
              className="text-brand hover:underline"
            >
              {mod.contentPack.name}
            </Link>{' '}
            · v{mod.contentPack.versionLabel ?? mod.contentPack.versionNumber}
            {' · '}
            <Pill tone={statusTone}>{mod.contentPack.status}</Pill>
          </>
        }
        actions={
          editable ? (
            <>
              <SecondaryButton onClick={() => setEditMetaOpen(true)}>
                <Pencil size={13} /> Edit module
              </SecondaryButton>
              <button
                type="button"
                onClick={onDeleteModule}
                className="btn btn-ghost text-signal-fault hover:bg-signal-fault/10"
              >
                <Trash2 size={13} /> Delete
              </button>
            </>
          ) : null
        }
      />

      {!editable && (
        <p className="mb-4 rounded border border-signal-warn/40 bg-signal-warn/10 p-3 text-sm text-signal-warn">
          This module is in a {mod.contentPack.status} content pack version.
          Editing is frozen — open a new draft version to make changes.
        </p>
      )}

      <div className="grid gap-6 md:grid-cols-2">
        <section>
          <div className="mb-2 flex items-center justify-between">
            <h2 className="text-xs font-medium uppercase tracking-wide text-ink-tertiary">
              Lessons ({mod.lessons.length})
            </h2>
            {editable && (
              <button
                type="button"
                onClick={() => setAddLessonOpen(true)}
                className="btn btn-secondary btn-sm"
              >
                <Plus size={13} /> Add lesson
              </button>
            )}
          </div>
          {mod.lessons.length === 0 ? (
            <p className="rounded-md border border-dashed border-line p-4 text-center text-sm text-ink-tertiary">
              No lessons yet.
            </p>
          ) : (
            <ul className="flex flex-col gap-1.5">
              {mod.lessons.map((l) => (
                <li
                  key={l.id}
                  className="flex items-center gap-2 rounded border border-line-subtle bg-surface-raised px-3 py-2 text-sm"
                >
                  <FileText size={14} className="shrink-0 text-ink-tertiary" />
                  <div className="flex-1 min-w-0">
                    <div className="truncate text-ink-primary">{l.title}</div>
                    {l.bodyMarkdown && (
                      <div className="truncate text-xs text-ink-tertiary">
                        {l.bodyMarkdown.slice(0, 80)}
                        {l.bodyMarkdown.length > 80 ? '…' : ''}
                      </div>
                    )}
                  </div>
                  {editable && (
                    <>
                      <button
                        type="button"
                        onClick={() => setEditLesson(l)}
                        className="p-1 text-ink-tertiary hover:text-ink-primary"
                        aria-label="Edit lesson"
                      >
                        <Pencil size={13} />
                      </button>
                      <button
                        type="button"
                        onClick={async () => {
                          if (!confirm(`Delete lesson "${l.title}"?`)) return;
                          try {
                            await deleteLesson(l.id);
                            toast.success('Lesson deleted');
                            await refresh();
                          } catch (e) {
                            toast.error(e instanceof Error ? e.message : String(e));
                          }
                        }}
                        className="p-1 text-ink-tertiary hover:text-signal-fault"
                        aria-label="Delete lesson"
                      >
                        <Trash2 size={13} />
                      </button>
                    </>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>

        <section>
          <div className="mb-2 flex items-center justify-between">
            <h2 className="text-xs font-medium uppercase tracking-wide text-ink-tertiary">
              Activities ({mod.activities.length})
            </h2>
            {editable && (
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => setAddActivityOpen(true)}
                  className="btn btn-secondary btn-sm"
                >
                  <Plus size={13} /> Add quiz
                </button>
                <button
                  type="button"
                  onClick={() => setAddSlideCourseOpen(true)}
                  className="btn btn-secondary btn-sm"
                >
                  <Presentation size={13} /> Add slide course
                </button>
              </div>
            )}
          </div>
          {mod.activities.length === 0 ? (
            <p className="rounded-md border border-dashed border-line p-4 text-center text-sm text-ink-tertiary">
              No activities yet.
            </p>
          ) : (
            <ul className="flex flex-col gap-1.5">
              {mod.activities.map((a) => {
                const questionCount = Array.isArray(a.config.questions)
                  ? a.config.questions.length
                  : 0;
                return (
                  <li
                    key={a.id}
                    className="flex items-center gap-2 rounded border border-line-subtle bg-surface-raised px-3 py-2 text-sm"
                  >
                    <ListChecks size={14} className="shrink-0 text-ink-tertiary" />
                    <div className="flex-1 min-w-0">
                      <div className="truncate text-ink-primary">{a.title}</div>
                      <div className="text-xs text-ink-tertiary">
                        {a.kind}
                        {questionCount > 0 && ` · ${questionCount} question${questionCount === 1 ? '' : 's'}`}
                        {a.weight !== 1 && ` · weight ${a.weight}`}
                      </div>
                    </div>
                    {editable && a.kind === 'quiz' && (
                      <button
                        type="button"
                        onClick={() => setEditActivity(a)}
                        className="p-1 text-ink-tertiary hover:text-ink-primary"
                        aria-label="Edit activity"
                      >
                        <Pencil size={13} />
                      </button>
                    )}
                    {editable && (
                      <button
                        type="button"
                        onClick={async () => {
                          if (!confirm(`Delete activity "${a.title}"?`)) return;
                          try {
                            await deleteActivity(a.id);
                            toast.success('Activity deleted');
                            await refresh();
                          } catch (e) {
                            toast.error(e instanceof Error ? e.message : String(e));
                          }
                        }}
                        className="p-1 text-ink-tertiary hover:text-signal-fault"
                        aria-label="Delete activity"
                      >
                        <Trash2 size={13} />
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      </div>

      <Drawer
        title="Edit module"
        open={editMetaOpen}
        onClose={() => setEditMetaOpen(false)}
      >
        <ModuleMetaForm
          module={mod}
          onSaved={async () => {
            setEditMetaOpen(false);
            await refresh();
          }}
        />
      </Drawer>

      <Drawer title="Add lesson" open={addLessonOpen} onClose={() => setAddLessonOpen(false)}>
        <LessonForm
          moduleId={id}
          onSaved={async () => {
            setAddLessonOpen(false);
            await refresh();
          }}
        />
      </Drawer>

      <Drawer
        title={`Edit lesson — ${editLesson?.title ?? ''}`}
        open={editLesson !== null}
        onClose={() => setEditLesson(null)}
      >
        {editLesson && (
          <LessonForm
            lesson={editLesson}
            onSaved={async () => {
              setEditLesson(null);
              await refresh();
            }}
          />
        )}
      </Drawer>

      <Drawer title="Add quiz" open={addActivityOpen} onClose={() => setAddActivityOpen(false)}>
        <QuizForm
          moduleId={id}
          onSaved={async () => {
            setAddActivityOpen(false);
            await refresh();
          }}
        />
      </Drawer>

      <Drawer
        title="Add slide course"
        open={addSlideCourseOpen}
        onClose={() => setAddSlideCourseOpen(false)}
      >
        <SlideCourseActivityForm
          moduleId={id}
          contentPackVersionId={mod.contentPackVersionId}
          onSaved={async () => {
            setAddSlideCourseOpen(false);
            await refresh();
          }}
        />
      </Drawer>

      <Drawer
        title={`Edit quiz — ${editActivity?.title ?? ''}`}
        open={editActivity !== null}
        onClose={() => setEditActivity(null)}
      >
        {editActivity && (
          <QuizForm
            activity={editActivity}
            onSaved={async () => {
              setEditActivity(null);
              await refresh();
            }}
          />
        )}
      </Drawer>
    </PageShell>
  );
}

function ModuleMetaForm({
  module: mod,
  onSaved,
}: {
  module: AdminTrainingModuleDetail;
  onSaved: () => Promise<void>;
}) {
  const [title, setTitle] = useState(mod.title);
  const [description, setDescription] = useState(mod.description ?? '');
  const [estimatedMinutes, setEstimatedMinutes] = useState(
    mod.estimatedMinutes?.toString() ?? '',
  );
  const [competencyTag, setCompetencyTag] = useState(mod.competencyTag ?? '');
  const [passThreshold, setPassThreshold] = useState(
    String(Math.round(mod.passThreshold * 100)),
  );
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const pct = parseInt(passThreshold, 10);
      await updateTrainingModule(mod.id, {
        title: title.trim(),
        description: description.trim() || null,
        estimatedMinutes: estimatedMinutes.trim()
          ? parseInt(estimatedMinutes, 10)
          : null,
        competencyTag: competencyTag.trim() || null,
        passThreshold: Number.isFinite(pct) ? pct / 100 : undefined,
      });
      await onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      <ErrorBanner error={error} />
      <Field label="Title" required>
        <TextInput value={title} onChange={(e) => setTitle(e.target.value)} required />
      </Field>
      <Field label="Description">
        <Textarea value={description} onChange={(e) => setDescription(e.target.value)} />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Estimated minutes">
          <TextInput
            type="number"
            min={0}
            value={estimatedMinutes}
            onChange={(e) => setEstimatedMinutes(e.target.value)}
          />
        </Field>
        <Field label="Pass threshold (%)">
          <TextInput
            type="number"
            min={0}
            max={100}
            value={passThreshold}
            onChange={(e) => setPassThreshold(e.target.value)}
          />
        </Field>
      </div>
      <Field
        label="Competency tag"
        hint="Optional. Structured tag that identifies the skill this module certifies, e.g. 'mhe.operator.forklift.class-1'."
      >
        <TextInput
          value={competencyTag}
          onChange={(e) => setCompetencyTag(e.target.value)}
          placeholder="mhe.operator.forklift.class-1"
        />
      </Field>
      <div className="flex justify-end">
        <PrimaryButton type="submit" disabled={saving}>
          {saving ? 'Saving…' : 'Save'}
        </PrimaryButton>
      </div>
    </form>
  );
}

function LessonForm({
  moduleId,
  lesson,
  onSaved,
}: {
  moduleId?: string;
  lesson?: AdminLesson;
  onSaved: () => Promise<void>;
}) {
  const [title, setTitle] = useState(lesson?.title ?? '');
  const [bodyMarkdown, setBodyMarkdown] = useState(lesson?.bodyMarkdown ?? '');
  const [orderingHint, setOrderingHint] = useState(
    String(lesson?.orderingHint ?? 0),
  );
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      if (lesson) {
        await updateLesson(lesson.id, {
          title: title.trim(),
          bodyMarkdown: bodyMarkdown.trim() || null,
          orderingHint: parseInt(orderingHint, 10) || 0,
        });
      } else {
        if (!moduleId) throw new Error('moduleId missing');
        await createLesson(moduleId, {
          title: title.trim(),
          bodyMarkdown: bodyMarkdown.trim() || undefined,
        });
      }
      await onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      <ErrorBanner error={error} />
      <Field label="Title" required>
        <TextInput value={title} onChange={(e) => setTitle(e.target.value)} required />
      </Field>
      <Field label="Body (markdown)">
        <Textarea
          value={bodyMarkdown}
          onChange={(e) => setBodyMarkdown(e.target.value)}
          rows={10}
          placeholder="# Step 1&#10;&#10;Explain the step here…"
        />
      </Field>
      {lesson && (
        <Field label="Ordering hint">
          <TextInput
            type="number"
            value={orderingHint}
            onChange={(e) => setOrderingHint(e.target.value)}
          />
        </Field>
      )}
      <div className="flex justify-end">
        <PrimaryButton type="submit" disabled={saving}>
          {saving ? 'Saving…' : lesson ? 'Save' : 'Add lesson'}
        </PrimaryButton>
      </div>
    </form>
  );
}

function QuizForm({
  moduleId,
  activity,
  onSaved,
}: {
  moduleId?: string;
  activity?: AdminActivity;
  onSaved: () => Promise<void>;
}) {
  const [title, setTitle] = useState(activity?.title ?? '');
  const [questions, setQuestions] = useState<AdminQuizQuestion[]>(
    activity?.config.questions ?? [
      { prompt: '', options: ['', ''], correctIndex: 0, explanation: '' },
    ],
  );
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  function updateQuestion(i: number, patch: Partial<AdminQuizQuestion>) {
    setQuestions((qs) =>
      qs.map((q, idx) => (idx === i ? { ...q, ...patch } : q)),
    );
  }

  function addQuestion() {
    setQuestions((qs) => [
      ...qs,
      { prompt: '', options: ['', ''], correctIndex: 0, explanation: '' },
    ]);
  }

  function removeQuestion(i: number) {
    setQuestions((qs) => qs.filter((_, idx) => idx !== i));
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      // Prune empty options and trim text before send. Server enforces
      // min 2 options per question, at least one question.
      const cleaned = questions
        .map((q) => ({
          prompt: q.prompt.trim(),
          options: q.options.map((o) => o.trim()).filter(Boolean),
          correctIndex: q.correctIndex,
          explanation: q.explanation?.trim() || undefined,
        }))
        .filter((q) => q.prompt && q.options.length >= 2);
      if (cleaned.length === 0) {
        throw new Error('At least one complete question is required.');
      }
      for (const q of cleaned) {
        if (q.correctIndex < 0 || q.correctIndex >= q.options.length) {
          throw new Error(`"${q.prompt}": correct answer index is out of range.`);
        }
      }
      if (activity) {
        await updateActivity(activity.id, { title: title.trim(), questions: cleaned });
      } else {
        if (!moduleId) throw new Error('moduleId missing');
        await createQuizActivity(moduleId, { title: title.trim(), questions: cleaned });
      }
      await onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      <ErrorBanner error={error} />
      <Field label="Quiz title" required>
        <TextInput
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Pre-operation safety check"
          required
        />
      </Field>

      <div className="flex flex-col gap-4">
        {questions.map((q, i) => (
          <div
            key={i}
            className="flex flex-col gap-2.5 rounded border border-line bg-surface-inset p-3"
          >
            <div className="flex items-center justify-between">
              <span className="caption">Question {i + 1}</span>
              {questions.length > 1 && (
                <button
                  type="button"
                  onClick={() => removeQuestion(i)}
                  className="text-xs text-ink-tertiary hover:text-signal-fault"
                >
                  Remove
                </button>
              )}
            </div>
            <Field label="Prompt" required>
              <Textarea
                value={q.prompt}
                onChange={(e) => updateQuestion(i, { prompt: e.target.value })}
                rows={2}
              />
            </Field>
            <div className="flex flex-col gap-1.5">
              <span className="form-label">Options (tap radio = correct answer)</span>
              {q.options.map((opt, oi) => (
                <div key={oi} className="flex items-center gap-2">
                  <input
                    type="radio"
                    name={`q${i}-correct`}
                    checked={q.correctIndex === oi}
                    onChange={() => updateQuestion(i, { correctIndex: oi })}
                    className="shrink-0"
                  />
                  <TextInput
                    value={opt}
                    onChange={(e) => {
                      const next = [...q.options];
                      next[oi] = e.target.value;
                      updateQuestion(i, { options: next });
                    }}
                    placeholder={`Option ${oi + 1}`}
                  />
                  {q.options.length > 2 && (
                    <button
                      type="button"
                      onClick={() => {
                        const next = q.options.filter((_, idx) => idx !== oi);
                        const correctIndex =
                          q.correctIndex >= next.length ? 0 : q.correctIndex;
                        updateQuestion(i, { options: next, correctIndex });
                      }}
                      className="shrink-0 text-ink-tertiary hover:text-signal-fault"
                      aria-label="Remove option"
                    >
                      <X size={14} />
                    </button>
                  )}
                </div>
              ))}
              {q.options.length < 8 && (
                <button
                  type="button"
                  onClick={() =>
                    updateQuestion(i, { options: [...q.options, ''] })
                  }
                  className="self-start text-xs text-brand hover:underline"
                >
                  + Add option
                </button>
              )}
            </div>
            <Field label="Explanation (shown after answering)" hint="Optional">
              <Textarea
                value={q.explanation ?? ''}
                onChange={(e) => updateQuestion(i, { explanation: e.target.value })}
                rows={2}
              />
            </Field>
          </div>
        ))}

        <button
          type="button"
          onClick={addQuestion}
          className="btn btn-secondary btn-sm self-start"
        >
          <Plus size={13} /> Add question
        </button>
      </div>

      <div className="flex justify-end">
        <PrimaryButton type="submit" disabled={saving}>
          {saving ? 'Saving…' : activity ? 'Save' : 'Add quiz'}
        </PrimaryButton>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------
// SlideCourseActivityForm — picks a converted slide deck within the module's
// content pack version and attaches it as a slide_course activity.
// ---------------------------------------------------------------------------

function SlideCourseActivityForm({
  moduleId,
  contentPackVersionId,
  onSaved,
}: {
  moduleId: string;
  contentPackVersionId: string;
  onSaved: () => Promise<void>;
}) {
  const [decks, setDecks] = useState<
    Array<{
      slideDeckId: string;
      documentId: string;
      documentTitle: string;
      slideCount: number;
      conversionStatus: string;
    }>
  >([]);
  const [loading, setLoading] = useState(true);
  const [slideDeckId, setSlideDeckId] = useState('');
  const [title, setTitle] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { listAvailableSlideDecksForVersion } = await import(
          '@/lib/slide-course-api'
        );
        const list = await listAvailableSlideDecksForVersion(contentPackVersionId);
        if (cancelled) return;
        setDecks(list);
        const firstReady = list.find((d) => d.conversionStatus === 'ready');
        if (firstReady) {
          setSlideDeckId(firstReady.slideDeckId);
          setTitle(firstReady.documentTitle);
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [contentPackVersionId]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!slideDeckId) {
      setError('Pick a slide deck.');
      return;
    }
    if (!title.trim()) {
      setError('Title is required.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const { createSlideCourseActivity } = await import('@/lib/slide-course-api');
      await createSlideCourseActivity(moduleId, {
        title: title.trim(),
        slideDeckId,
      });
      await onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return <p className="text-sm text-ink-tertiary">Loading slide decks…</p>;
  }

  if (decks.length === 0) {
    return (
      <div className="space-y-2 text-sm">
        <p className="text-ink-secondary">
          No slide decks have been converted in this content pack version yet.
        </p>
        <p className="text-ink-tertiary">
          Upload a PowerPoint as a document with kind &ldquo;slides&rdquo;. The
          extraction worker will render slide images, then the deck will appear
          here.
        </p>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      <ErrorBanner error={error} />
      <Field label="Slide deck" required>
        <select
          value={slideDeckId}
          onChange={(e) => {
            const id = e.target.value;
            setSlideDeckId(id);
            const match = decks.find((d) => d.slideDeckId === id);
            if (match && !title) setTitle(match.documentTitle);
          }}
          className="form-select"
        >
          <option value="">— Pick a deck —</option>
          {decks.map((d) => (
            <option
              key={d.slideDeckId}
              value={d.slideDeckId}
              disabled={d.conversionStatus !== 'ready'}
            >
              {d.documentTitle}
              {d.conversionStatus === 'ready'
                ? ` (${d.slideCount} slides)`
                : ` — ${d.conversionStatus}`}
            </option>
          ))}
        </select>
      </Field>
      <Field
        label="Activity title"
        hint="What the learner sees in the training module's activity list."
        required
      >
        <TextInput value={title} onChange={(e) => setTitle(e.target.value)} required />
      </Field>
      <div className="flex justify-end">
        <PrimaryButton type="submit" disabled={saving}>
          {saving ? 'Adding…' : 'Add slide course'}
        </PrimaryButton>
      </div>
    </form>
  );
}
