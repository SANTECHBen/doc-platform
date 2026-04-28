'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Bot, FolderTree, Plus } from 'lucide-react';
import { PageHeader, PageShell, Pill } from '@/components/page-shell';
import { EmptyState } from '@/components/empty-state';
import { TableSkeleton } from '@/components/skeleton';
import { ErrorBanner, PrimaryButton } from '@/components/form';
import { listAgentRuns, type AgentRunSummary } from '@/lib/agent';

const STATUS_TONE: Record<AgentRunSummary['status'], 'default' | 'info' | 'success' | 'warning' | 'danger'> = {
  scanning: 'info',
  uploading: 'info',
  proposing: 'info',
  awaiting_review: 'warning',
  executing: 'info',
  completed: 'success',
  failed: 'danger',
  cancelled: 'default',
};

export default function AgentRunsPage() {
  const [rows, setRows] = useState<AgentRunSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    listAgentRuns()
      .then(setRows)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  return (
    <PageShell crumbs={[{ label: 'Onboarding agent' }]}>
      <PageHeader
        title="Onboarding agent"
        description="Drop a customer's folder and let the agent draft the org, asset models, parts, content packs, instances, and QR codes. You review and approve before anything is saved."
        actions={
          <Link href="/agent/new">
            <PrimaryButton>
              <Plus size={14} strokeWidth={2} /> New run
            </PrimaryButton>
          </Link>
        }
      />
      <ErrorBanner error={error} />
      {rows === null ? (
        <TableSkeleton cols={5} rows={4} />
      ) : rows.length === 0 ? (
        <EmptyState
          icon={Bot}
          title="No agent runs yet"
          description="Pick a folder of customer content to onboard. The agent walks the tree, classifies files, and proposes a complete tenant setup."
          action={
            <Link href="/agent/new">
              <PrimaryButton>
                <FolderTree size={14} strokeWidth={2} /> Pick a folder
              </PrimaryButton>
            </Link>
          }
        />
      ) : (
        <div className="overflow-hidden rounded-md border border-line-subtle bg-surface-raised">
          <table className="data-table">
            <thead className="bg-surface-inset text-left text-xs uppercase tracking-wide text-ink-tertiary">
              <tr>
                <th className="px-4 py-2">Folder</th>
                <th className="px-4 py-2">Status</th>
                <th className="px-4 py-2">Files</th>
                <th className="px-4 py-2">Started</th>
                <th className="px-4 py-2">Updated</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-t border-line-subtle">
                  <td className="px-4 py-2.5 text-sm">
                    <Link href={`/agent/${r.id}`} className="font-medium hover:underline">
                      {r.manifestRoot ?? '(unknown)'}
                    </Link>
                    {r.error && (
                      <p className="mt-0.5 text-xs text-signal-fault">{r.error}</p>
                    )}
                  </td>
                  <td className="px-4 py-2.5">
                    <Pill tone={STATUS_TONE[r.status]}>{r.status.replace(/_/g, ' ')}</Pill>
                  </td>
                  <td className="px-4 py-2.5 font-mono text-sm tabular-nums">
                    {r.manifestFiles}
                  </td>
                  <td className="px-4 py-2.5 text-sm text-ink-secondary">
                    {new Date(r.createdAt).toLocaleString()}
                  </td>
                  <td className="px-4 py-2.5 text-sm text-ink-secondary">
                    {new Date(r.updatedAt).toLocaleString()}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </PageShell>
  );
}
