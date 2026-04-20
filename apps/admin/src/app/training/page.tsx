'use client';

import Link from 'next/link';
import { DataLoader, PageHeader, PageShell } from '@/components/page-shell';
import { listAdminTrainingModules } from '@/lib/api';

export default function TrainingPage() {
  return (
    <PageShell crumbs={[{ label: 'Training' }]}>
      <PageHeader
        title="Training"
        description="Modules authored against content packs, with enrollment and completion stats across all users."
      />
      <DataLoader load={listAdminTrainingModules} empty={(d) => d.length === 0} deps={[]}>
        {(rows) => (
          <div className="overflow-hidden rounded-md border border-line-subtle bg-surface-raised">
            <table className="data-table">
              <thead className="bg-surface-inset text-left text-xs uppercase tracking-wide text-ink-tertiary">
                <tr>
                  <th className="px-4 py-2">Module</th>
                  <th className="px-4 py-2">Content pack</th>
                  <th className="px-4 py-2">Asset model</th>
                  <th className="px-4 py-2">Duration</th>
                  <th className="px-4 py-2">Pass</th>
                  <th className="px-4 py-2">Enrolled</th>
                  <th className="px-4 py-2">Completion</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((m) => {
                  const pct =
                    m.enrollments > 0
                      ? Math.round((m.completed / m.enrollments) * 100)
                      : null;
                  return (
                    <tr key={m.id} className="border-t border-line-subtle align-top">
                      <td className="px-4 py-3">
                        <Link
                          href={`/training/${m.id}`}
                          className="block font-medium text-ink-primary hover:text-brand"
                        >
                          {m.title}
                        </Link>
                        {m.competencyTag && (
                          <span className="block font-mono text-xs text-ink-tertiary">
                            {m.competencyTag}
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-ink-secondary">{m.contentPack}</td>
                      <td className="px-4 py-3 text-ink-secondary">{m.assetModel}</td>
                      <td className="px-4 py-3 text-ink-secondary">
                        {m.estimatedMinutes ? `${m.estimatedMinutes} min` : '—'}
                      </td>
                      <td className="px-4 py-3 text-ink-secondary">
                        {Math.round(m.passThreshold * 100)}%
                      </td>
                      <td className="px-4 py-3">{m.enrollments}</td>
                      <td className="px-4 py-3">
                        {pct === null ? (
                          <span className="text-ink-tertiary">—</span>
                        ) : (
                          <span className="text-ink-secondary">
                            {pct}% <span className="text-xs text-ink-tertiary">
                              ({m.completed}/{m.enrollments}, {m.failed} failed)
                            </span>
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </DataLoader>
    </PageShell>
  );
}
