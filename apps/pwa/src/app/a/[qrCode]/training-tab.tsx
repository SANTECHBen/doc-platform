'use client';

import { useEffect, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  ArrowLeft,
  Award,
  CheckCircle2,
  ChevronRight,
  Clock,
  FileText,
  GraduationCap,
  ListChecks,
  Presentation,
  XCircle,
} from 'lucide-react';
import type { AssetHubPayload } from '@/lib/shared-schema';
import {
  listTrainingModules,
  getTrainingModule,
  startEnrollment,
  submitQuiz,
  type TrainingModuleSummary,
  type TrainingModuleDetail,
  type QuizResult,
} from '@/lib/api';
import { RowListSkeleton } from '@/components/skeleton';
import { EmptyState } from '@/components/empty-state';

const DEV_USER_ID = process.env.NEXT_PUBLIC_DEV_USER_ID ?? '';
const DEV_ORG_ID = process.env.NEXT_PUBLIC_DEV_ORG_ID ?? '';

export function TrainingTab({
  hub,
  qrCode,
}: {
  hub: AssetHubPayload;
  qrCode: string;
}) {
  const versionId = hub.pinnedContentPackVersion?.id ?? null;
  const [modules, setModules] = useState<TrainingModuleSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [active, setActive] = useState<string | null>(null);

  useEffect(() => {
    if (!versionId || !DEV_USER_ID) return;
    let cancelled = false;
    listTrainingModules(versionId, DEV_USER_ID, DEV_ORG_ID)
      .then((rows) => {
        if (!cancelled) setModules(rows);
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
    return () => {
      cancelled = true;
    };
  }, [versionId]);

  if (!versionId) {
    return (
      <EmptyState
        icon={GraduationCap}
        title="No content version pinned"
        description="No published content is linked to this asset yet."
        tone="neutral"
      />
    );
  }
  if (!DEV_USER_ID || !DEV_ORG_ID) {
    return (
      <EmptyState
        icon={GraduationCap}
        title="Sign in required"
        description="Training enrollment needs an authenticated tech identity. See the Assistant tab for setup help."
        tone="neutral"
      />
    );
  }
  if (error) return <ErrorBanner text={error} />;
  if (!modules) return <RowListSkeleton />;

  if (active) {
    return (
      <ModuleRunner
        moduleId={active}
        hub={hub}
        qrCode={qrCode}
        onDone={(summary) => {
          setModules((prev) =>
            prev ? prev.map((m) => (m.id === summary.id ? summary : m)) : prev,
          );
          setActive(null);
        }}
      />
    );
  }

  const hasModules = modules.length > 0;

  if (!hasModules) {
    return (
      <EmptyState
        icon={GraduationCap}
        title="No training modules"
        description="An admin needs to create a training module for this content pack and attach activities (quizzes or slide courses)."
        tone="neutral"
      />
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {hasModules && (
        <section className="flex flex-col gap-2">
          <ul className="flex flex-col gap-2">
            {modules.map((m) => (
              <li key={m.id}>
                <button
                  onClick={() => setActive(m.id)}
                  className="surface-etched flex w-full flex-col gap-2 px-4 py-3.5 text-left transition"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex items-center gap-2.5">
                      <div className="icon-chip icon-chip-info">
                        <GraduationCap size={16} strokeWidth={1.75} />
                      </div>
                      <span className="text-sm font-medium text-ink-primary">
                        {m.title}
                      </span>
                    </div>
                    <EnrollmentBadge enrollment={m.enrollment} />
                  </div>
                  {m.description && (
                    <p className="line-clamp-2 pl-[42px] text-xs text-ink-secondary">
                      {m.description}
                    </p>
                  )}
                  <div className="flex flex-wrap items-center gap-x-4 gap-y-1 pl-[42px] font-mono text-[11px] text-ink-tertiary">
                    <span className="inline-flex items-center gap-1">
                      <FileText size={11} strokeWidth={1.75} />
                      {m.lessonCount} lesson{m.lessonCount === 1 ? '' : 's'}
                    </span>
                    <span className="inline-flex items-center gap-1">
                      <ListChecks size={11} strokeWidth={1.75} />
                      {m.activityCount} activit{m.activityCount === 1 ? 'y' : 'ies'}
                    </span>
                    {m.estimatedMinutes != null && (
                      <span className="inline-flex items-center gap-1">
                        <Clock size={11} strokeWidth={1.75} />~{m.estimatedMinutes} min
                      </span>
                    )}
                  </div>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}


function EnrollmentBadge({
  enrollment,
}: {
  enrollment: TrainingModuleSummary['enrollment'];
}) {
  if (!enrollment) return null;
  const pct = enrollment.score !== null ? Math.round(enrollment.score * 100) : null;
  if (enrollment.status === 'completed') {
    return (
      <span className="pill pill-ok shrink-0">
        Passed{pct !== null ? ` · ${pct}%` : ''}
      </span>
    );
  }
  if (enrollment.status === 'failed') {
    return (
      <span className="pill pill-fault shrink-0">
        Failed{pct !== null ? ` · ${pct}%` : ''}
      </span>
    );
  }
  if (enrollment.status === 'in_progress') {
    return <span className="pill pill-info shrink-0">In progress</span>;
  }
  return null;
}

function ModuleRunner({
  moduleId,
  hub,
  qrCode,
  onDone,
}: {
  moduleId: string;
  hub: AssetHubPayload;
  qrCode: string;
  onDone: (summary: TrainingModuleSummary) => void;
}) {
  const [detail, setDetail] = useState<TrainingModuleDetail | null>(null);
  // Enrollment is lazy. Slide-course activities don't need it (the
  // scan-session player at /a/[qr]/courses/[activityId] grades
  // anonymously). Quiz activities still require an enrollment for
  // server-side scoring — we start one when the learner taps a quiz.
  const [enrollmentId, setEnrollmentId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<QuizResult | null>(null);
  const [answers, setAnswers] = useState<Record<string, number[]>>({});
  const [activeActivityId, setActiveActivityId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    // Module detail is scan-session-readable — no enrollment yet.
    getTrainingModule(moduleId)
      .then((mod) => {
        if (cancelled) return;
        setDetail(mod);
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
    return () => {
      cancelled = true;
    };
  }, [moduleId]);

  async function ensureEnrollment(): Promise<string | null> {
    if (enrollmentId) return enrollmentId;
    if (!DEV_USER_ID || !DEV_ORG_ID) {
      setError(
        'Quizzes need an authenticated learner — Microsoft sign-in for the PWA is not wired up yet.',
      );
      return null;
    }
    try {
      const enr = await startEnrollment({
        trainingModuleId: moduleId,
        assetInstanceId: hub.assetInstance.id,
        devUserId: DEV_USER_ID,
        devOrgId: DEV_ORG_ID,
      });
      setEnrollmentId(enr.id);
      return enr.id;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return null;
    }
  }

  if (error) return <ErrorBanner text={error} />;
  if (!detail) return <RowListSkeleton count={3} />;

  function summarize(): TrainingModuleSummary {
    return {
      id: detail!.id,
      title: detail!.title,
      description: detail!.description,
      estimatedMinutes: detail!.estimatedMinutes,
      competencyTag: null,
      passThreshold: detail!.passThreshold,
      lessonCount: detail!.lessons.length,
      activityCount: detail!.activities.length,
      enrollment: result?.enrollment ?? null,
    };
  }

  if (result) {
    return <QuizResultView result={result} module={detail} onDone={() => onDone(summarize())} />;
  }

  const activity = activeActivityId
    ? detail.activities.find((a) => a.id === activeActivityId)
    : null;

  if (activity && activity.kind === 'quiz') {
    return (
      <QuizRunner
        module={detail}
        activity={activity}
        answers={answers[activity.id] ?? []}
        onChange={(next) => setAnswers((prev) => ({ ...prev, [activity.id]: next }))}
        submitting={submitting}
        onCancel={() => setActiveActivityId(null)}
        onSubmit={async () => {
          setSubmitting(true);
          try {
            const enrId = await ensureEnrollment();
            if (!enrId) return;
            const res = await submitQuiz({
              enrollmentId: enrId,
              activityId: activity.id,
              answers: answers[activity.id] ?? [],
              devUserId: DEV_USER_ID,
              devOrgId: DEV_ORG_ID,
            });
            setResult(res);
          } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
          } finally {
            setSubmitting(false);
          }
        }}
      />
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <button onClick={() => onDone(summarize())} className="btn btn-ghost btn-sm self-start">
        <ArrowLeft size={14} strokeWidth={2} /> Back to training
      </button>
      <header className="flex flex-col gap-1">
        <span className="caption">Module</span>
        <h2 className="text-xl font-semibold text-ink-primary">{detail.title}</h2>
        {detail.description && (
          <p className="text-sm text-ink-secondary">{detail.description}</p>
        )}
      </header>

      {detail.lessons.length > 0 && (
        <section className="flex flex-col gap-2">
          <span className="caption">Lessons</span>
          <ul className="flex flex-col gap-2">
            {detail.lessons.map((l) => (
              <li
                key={l.id}
                className="surface-etched px-4 py-3"
              >
                <h4 className="text-sm font-medium text-ink-primary">{l.title}</h4>
                {l.bodyMarkdown && (
                  <div className="markdown-body mt-2 text-sm">
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>
                      {l.bodyMarkdown}
                    </ReactMarkdown>
                  </div>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="flex flex-col gap-2">
        <span className="caption">Activities</span>
        <ul className="flex flex-col gap-2">
          {detail.activities.map((a) => {
            const isQuiz = a.kind === 'quiz';
            const isSlideCourse = a.kind === 'slide_course';
            const isScormCourse = a.kind === 'scorm_course';
            const launchable = isQuiz || isSlideCourse || isScormCourse;
            return (
              <li key={a.id}>
                <button
                  onClick={() => {
                    if (isQuiz) setActiveActivityId(a.id);
                    else if (isSlideCourse) {
                      // Slide course plays anonymously via the
                      // scan-session — no enrollment or sign-in
                      // required, just the activity ID.
                      window.location.href = `/a/${encodeURIComponent(
                        qrCode,
                      )}/courses/${encodeURIComponent(a.id)}`;
                    } else if (a.kind === 'scorm_course') {
                      window.location.href = `/a/${encodeURIComponent(
                        qrCode,
                      )}/scorm/${encodeURIComponent(a.id)}`;
                    }
                  }}
                  disabled={!launchable}
                  className="surface-etched flex w-full items-center gap-3 px-4 py-3 text-left disabled:cursor-not-allowed disabled:opacity-60"
                >
                  <div className="icon-chip icon-chip-info">
                    {isSlideCourse ? (
                      <Presentation size={16} strokeWidth={1.75} />
                    ) : (
                      <ListChecks size={16} strokeWidth={1.75} />
                    )}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium text-ink-primary">{a.title}</div>
                    <div className="font-mono text-[11px] uppercase tracking-wider text-ink-tertiary">
                      {a.kind.replace(/_/g, ' ')}
                    </div>
                  </div>
                  {launchable ? (
                    <span className="inline-flex items-center gap-1 text-sm font-medium text-brand">
                      Start <ChevronRight size={14} strokeWidth={2} />
                    </span>
                  ) : (
                    <span className="caption">UI pending</span>
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      </section>
    </div>
  );
}

function QuizRunner({
  module,
  activity,
  answers,
  onChange,
  submitting,
  onCancel,
  onSubmit,
}: {
  module: TrainingModuleDetail;
  activity: TrainingModuleDetail['activities'][number];
  answers: number[];
  onChange: (next: number[]) => void;
  submitting: boolean;
  onCancel: () => void;
  onSubmit: () => void;
}) {
  const questions: Array<{ prompt: string; options: string[]; correctIndex: number }> =
    activity.config?.questions ?? [];
  const allAnswered = questions.every((_, i) => answers[i] !== undefined && answers[i] >= 0);
  const answeredCount = questions.filter((_, i) => answers[i] !== undefined && answers[i] >= 0)
    .length;

  return (
    <div className="flex flex-col gap-4">
      <button onClick={onCancel} className="btn btn-ghost btn-sm self-start">
        <ArrowLeft size={14} strokeWidth={2} /> Back to module
      </button>
      <header className="flex flex-col gap-1">
        <span className="caption">{module.title}</span>
        <h2 className="text-xl font-semibold text-ink-primary">{activity.title}</h2>
        <p className="font-mono text-[11px] text-ink-tertiary">
          {answeredCount} / {questions.length} answered · pass at{' '}
          {Math.round(module.passThreshold * 100)}%
        </p>
      </header>

      <ol className="flex flex-col gap-3">
        {questions.map((q, qi) => (
          <li key={qi} className="surface-etched p-4">
            <p className="font-medium text-ink-primary">
              <span className="mr-2 font-mono text-ink-tertiary">{qi + 1}.</span>
              {q.prompt}
            </p>
            <div className="mt-3 flex flex-col gap-2">
              {q.options.map((opt, oi) => {
                const selected = answers[qi] === oi;
                return (
                  <label
                    key={oi}
                    className={`flex cursor-pointer items-start gap-3 rounded-md border px-3 py-2.5 transition ${
                      selected
                        ? 'border-brand bg-brand-soft text-ink-primary'
                        : 'border-line bg-surface-raised text-ink-secondary hover:border-line-strong hover:bg-surface-elevated'
                    }`}
                  >
                    <input
                      type="radio"
                      name={`q-${qi}`}
                      className="mt-0.5 accent-brand"
                      checked={selected}
                      onChange={() => {
                        const next = answers.slice();
                        next[qi] = oi;
                        onChange(next);
                      }}
                    />
                    <span className="text-sm">{opt}</span>
                  </label>
                );
              })}
            </div>
          </li>
        ))}
      </ol>

      <button
        onClick={onSubmit}
        disabled={!allAnswered || submitting}
        className={`btn btn-primary self-end ${submitting ? 'btn-loading' : ''}`}
      >
        Submit quiz
      </button>
    </div>
  );
}

function QuizResultView({
  result,
  module,
  onDone,
}: {
  result: QuizResult;
  module: TrainingModuleDetail;
  onDone: () => void;
}) {
  const pct = Math.round(result.activityScore * 100);
  const passed = result.enrollment.status === 'completed';
  const enrollmentPct =
    result.enrollment.score !== null ? Math.round(result.enrollment.score * 100) : null;
  return (
    <div className="flex flex-col gap-4">
      <div
        className={`flex items-start gap-3 rounded-md border p-4 ${
          passed
            ? 'border-signal-ok/50'
            : 'border-signal-fault/50'
        }`}
      >
        <div
          className={`flex h-10 w-10 shrink-0 items-center justify-center ${
            passed ? 'text-signal-ok' : 'text-signal-fault'
          }`}
        >
          {passed ? (
            <Award size={20} strokeWidth={2} />
          ) : (
            <XCircle size={20} strokeWidth={2} />
          )}
        </div>
        <div className="flex-1">
          <p className="text-base font-semibold text-ink-primary">
            {passed ? 'Competency achieved' : 'Below pass threshold'}
          </p>
          <p className="mt-0.5 font-mono text-sm text-ink-secondary tabular-nums">
            {result.correct} / {result.total} correct · {pct}%
          </p>
          {enrollmentPct !== null && (
            <p className="mt-1 text-xs text-ink-tertiary">
              Module score: {enrollmentPct}% (pass {Math.round(module.passThreshold * 100)}%)
            </p>
          )}
          {!passed && (
            <p className="mt-2 text-sm text-ink-secondary">Retake to re-score.</p>
          )}
        </div>
      </div>

      <section className="flex flex-col gap-1">
        <span className="caption">Per-question</span>
        <ul className="flex flex-col gap-1.5">
          {result.perQuestion.map((q) => (
            <li
              key={q.questionIndex}
              className={`flex items-center gap-3 rounded-md border px-3 py-2 text-sm ${
                q.correct
                  ? 'border-signal-ok/40 text-signal-ok'
                  : 'border-signal-fault/40 text-signal-fault'
              }`}
            >
              {q.correct ? (
                <CheckCircle2 size={16} strokeWidth={2} className="shrink-0" />
              ) : (
                <XCircle size={16} strokeWidth={2} className="shrink-0" />
              )}
              <span className="font-mono tabular-nums">Q{q.questionIndex + 1}</span>
              <span className="text-ink-secondary">
                {q.correct
                  ? 'Correct'
                  : `Incorrect — correct was option ${q.correctIndex + 1}`}
              </span>
            </li>
          ))}
        </ul>
      </section>

      <button onClick={onDone} className="btn btn-secondary self-end">
        Done
      </button>
    </div>
  );
}

function ErrorBanner({ text }: { text: string }) {
  return (
    <p className="rounded-md border border-signal-fault/40 bg-signal-fault/10 p-3 text-sm text-signal-fault">
      {text}
    </p>
  );
}
