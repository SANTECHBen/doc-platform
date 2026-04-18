'use client';

import { useEffect, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { AssetHubPayload } from '@platform/shared';
import {
  listTrainingModules,
  getTrainingModule,
  startEnrollment,
  submitQuiz,
  type TrainingModuleSummary,
  type TrainingModuleDetail,
  type QuizResult,
} from '@/lib/api';

const DEV_USER_ID = process.env.NEXT_PUBLIC_DEV_USER_ID ?? '';
const DEV_ORG_ID = process.env.NEXT_PUBLIC_DEV_ORG_ID ?? '';

export function TrainingTab({ hub }: { hub: AssetHubPayload }) {
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
    return <p className="py-6 text-center text-sm text-slate-400">No content version pinned.</p>;
  }
  if (!DEV_USER_ID || !DEV_ORG_ID) {
    return (
      <p className="py-6 text-center text-sm text-slate-400">
        Dev user required for training — see AI tab for setup.
      </p>
    );
  }
  if (error) return <p className="py-6 text-center text-sm text-rose-300">{error}</p>;
  if (!modules) return <p className="py-6 text-center text-sm text-slate-400">Loading…</p>;
  if (modules.length === 0)
    return <p className="py-6 text-center text-sm text-slate-400">No modules published yet.</p>;

  if (active) {
    return (
      <ModuleRunner
        moduleId={active}
        hub={hub}
        onDone={(summary) => {
          setModules((prev) =>
            prev
              ? prev.map((m) => (m.id === summary.id ? summary : m))
              : prev,
          );
          setActive(null);
        }}
      />
    );
  }

  return (
    <ul className="flex flex-col gap-2">
      {modules.map((m) => (
        <li key={m.id}>
          <button
            onClick={() => setActive(m.id)}
            className="flex w-full flex-col gap-1 rounded-xl bg-slate-800 p-3 text-left transition hover:bg-slate-700"
          >
            <span className="flex items-start justify-between gap-3">
              <span className="font-medium text-slate-100">{m.title}</span>
              <EnrollmentBadge enrollment={m.enrollment} />
            </span>
            {m.description && (
              <span className="text-sm text-slate-400">{m.description}</span>
            )}
            <span className="flex gap-3 text-xs text-slate-500">
              <span>{m.lessonCount} lessons</span>
              <span>{m.activityCount} activities</span>
              {m.estimatedMinutes != null && <span>~{m.estimatedMinutes} min</span>}
            </span>
          </button>
        </li>
      ))}
    </ul>
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
      <span className="rounded bg-emerald-500/20 px-2 py-0.5 text-xs font-medium text-emerald-300">
        Passed{pct !== null ? ` · ${pct}%` : ''}
      </span>
    );
  }
  if (enrollment.status === 'failed') {
    return (
      <span className="rounded bg-rose-500/20 px-2 py-0.5 text-xs font-medium text-rose-300">
        Failed{pct !== null ? ` · ${pct}%` : ''}
      </span>
    );
  }
  if (enrollment.status === 'in_progress') {
    return (
      <span className="rounded bg-sky-500/20 px-2 py-0.5 text-xs font-medium text-sky-300">
        In progress
      </span>
    );
  }
  return null;
}

function ModuleRunner({
  moduleId,
  hub,
  onDone,
}: {
  moduleId: string;
  hub: AssetHubPayload;
  onDone: (summary: TrainingModuleSummary) => void;
}) {
  const [detail, setDetail] = useState<TrainingModuleDetail | null>(null);
  const [enrollmentId, setEnrollmentId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<QuizResult | null>(null);
  const [answers, setAnswers] = useState<Record<string, number[]>>({});
  const [activeActivityId, setActiveActivityId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      getTrainingModule(moduleId),
      startEnrollment({
        trainingModuleId: moduleId,
        assetInstanceId: hub.assetInstance.id,
        devUserId: DEV_USER_ID,
        devOrgId: DEV_ORG_ID,
      }),
    ])
      .then(([mod, enr]) => {
        if (cancelled) return;
        setDetail(mod);
        setEnrollmentId(enr.id);
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
    return () => {
      cancelled = true;
    };
  }, [moduleId, hub.assetInstance.id]);

  if (error) return <p className="py-6 text-center text-sm text-rose-300">{error}</p>;
  if (!detail || !enrollmentId)
    return <p className="py-6 text-center text-sm text-slate-400">Loading…</p>;

  if (result) {
    return (
      <QuizResultView
        result={result}
        module={detail}
        onDone={() => {
          onDone({
            id: detail.id,
            title: detail.title,
            description: detail.description,
            estimatedMinutes: detail.estimatedMinutes,
            competencyTag: null,
            passThreshold: detail.passThreshold,
            lessonCount: detail.lessons.length,
            activityCount: detail.activities.length,
            enrollment: result.enrollment,
          });
        }}
      />
    );
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
            const res = await submitQuiz({
              enrollmentId,
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
      <button
        onClick={() => onDone({
          id: detail.id,
          title: detail.title,
          description: detail.description,
          estimatedMinutes: detail.estimatedMinutes,
          competencyTag: null,
          passThreshold: detail.passThreshold,
          lessonCount: detail.lessons.length,
          activityCount: detail.activities.length,
          enrollment: null,
        })}
        className="self-start text-sm text-sky-400 hover:text-sky-300"
      >
        ← Back to training
      </button>
      <h2 className="text-xl font-semibold">{detail.title}</h2>
      {detail.description && <p className="text-slate-400">{detail.description}</p>}
      {detail.lessons.length > 0 && (
        <section className="flex flex-col gap-3">
          <h3 className="text-xs font-medium uppercase tracking-wide text-slate-500">
            Lessons
          </h3>
          {detail.lessons.map((l) => (
            <div key={l.id} className="rounded-xl bg-slate-800 p-3">
              <h4 className="font-medium text-slate-100">{l.title}</h4>
              {l.bodyMarkdown && (
                <div className="markdown-body mt-2 text-sm">
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>{l.bodyMarkdown}</ReactMarkdown>
                </div>
              )}
            </div>
          ))}
        </section>
      )}
      <section className="flex flex-col gap-2">
        <h3 className="text-xs font-medium uppercase tracking-wide text-slate-500">
          Activities
        </h3>
        {detail.activities.map((a) => (
          <button
            key={a.id}
            onClick={() => a.kind === 'quiz' && setActiveActivityId(a.id)}
            disabled={a.kind !== 'quiz'}
            className="flex items-center justify-between rounded-xl bg-slate-800 p-3 text-left transition hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-60"
          >
            <span>
              <span className="block font-medium text-slate-100">{a.title}</span>
              <span className="block text-xs text-slate-500">{a.kind}</span>
            </span>
            {a.kind === 'quiz' ? (
              <span className="text-sm text-sky-400">Start →</span>
            ) : (
              <span className="text-xs text-slate-500">UI pending</span>
            )}
          </button>
        ))}
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

  return (
    <div className="flex flex-col gap-4">
      <button
        onClick={onCancel}
        className="self-start text-sm text-sky-400 hover:text-sky-300"
      >
        ← Back to module
      </button>
      <header>
        <p className="text-xs uppercase tracking-wide text-slate-500">{module.title}</p>
        <h2 className="text-xl font-semibold">{activity.title}</h2>
      </header>
      <ol className="flex flex-col gap-4">
        {questions.map((q, qi) => (
          <li key={qi} className="rounded-xl bg-slate-800 p-3">
            <p className="font-medium text-slate-100">
              {qi + 1}. {q.prompt}
            </p>
            <div className="mt-3 flex flex-col gap-2">
              {q.options.map((opt, oi) => {
                const selected = answers[qi] === oi;
                return (
                  <label
                    key={oi}
                    className={`flex cursor-pointer items-start gap-3 rounded-lg border px-3 py-2 transition ${
                      selected
                        ? 'border-sky-500 bg-sky-500/10 text-slate-100'
                        : 'border-slate-700 bg-slate-900 text-slate-300 hover:border-slate-600'
                    }`}
                  >
                    <input
                      type="radio"
                      name={`q-${qi}`}
                      className="mt-0.5"
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
        className="self-end rounded-xl bg-sky-500 px-6 py-2 font-medium text-slate-950 disabled:opacity-50"
      >
        {submitting ? 'Submitting…' : 'Submit'}
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
      <h2 className="text-xl font-semibold">Quiz result</h2>
      <div
        className={`rounded-2xl p-4 text-sm ${
          passed
            ? 'border border-emerald-500/40 bg-emerald-500/10 text-emerald-200'
            : 'border border-slate-700 bg-slate-800 text-slate-200'
        }`}
      >
        <p className="text-lg font-semibold">
          {result.correct} / {result.total} correct · {pct}%
        </p>
        {enrollmentPct !== null && (
          <p className="mt-1 text-slate-300">
            Module score: {enrollmentPct}% (pass: {Math.round(module.passThreshold * 100)}%)
          </p>
        )}
        {passed && <p className="mt-1">Competency achieved.</p>}
        {result.enrollment.status === 'failed' && (
          <p className="mt-1 text-rose-300">Below pass threshold — retake to re-score.</p>
        )}
      </div>
      <ol className="flex flex-col gap-2 text-sm">
        {result.perQuestion.map((q) => (
          <li
            key={q.questionIndex}
            className={`rounded-lg px-3 py-2 ${
              q.correct ? 'bg-emerald-500/10 text-emerald-200' : 'bg-rose-500/10 text-rose-200'
            }`}
          >
            Q{q.questionIndex + 1}: {q.correct ? 'correct' : `incorrect (correct was option ${q.correctIndex + 1})`}
          </li>
        ))}
      </ol>
      <button
        onClick={onDone}
        className="self-end rounded-xl bg-slate-700 px-6 py-2 text-sm font-medium text-slate-100 hover:bg-slate-600"
      >
        Done
      </button>
    </div>
  );
}
