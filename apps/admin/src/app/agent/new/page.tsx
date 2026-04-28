'use client';

import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { useState } from 'react';
import { ArrowRight, FolderOpen, Sparkles } from 'lucide-react';
import { PageHeader, PageShell } from '@/components/page-shell';
import { ErrorBanner, PrimaryButton, SecondaryButton } from '@/components/form';
import {
  buildManifest,
  createAgentRun,
  initMuxUpload,
  pickAndScanFolder,
  startProposePhase,
  uploadAgentFile,
  uploadToMux,
  type ScannedFile,
} from '@/lib/agent';

type FileState = ScannedFile & {
  status: 'queued' | 'uploading' | 'uploaded' | 'mux_processing' | 'failed';
  uploaded: number;
  error?: string;
};

const VIDEO_MIME_PREFIX = 'video/';
const VIDEO_EXT = /\.(mp4|mov|webm|m4v|avi|mkv)$/i;

function isVideo(f: ScannedFile): boolean {
  if (f.contentType?.startsWith(VIDEO_MIME_PREFIX)) return true;
  return VIDEO_EXT.test(f.relativePath);
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export default function NewAgentRunPage() {
  const router = useRouter();
  const [rootName, setRootName] = useState<string | null>(null);
  const [files, setFiles] = useState<FileState[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [stage, setStage] = useState<'idle' | 'scanned' | 'uploading' | 'uploaded' | 'starting'>(
    'idle',
  );
  const [runId, setRunId] = useState<string | null>(null);

  async function onPick() {
    setError(null);
    try {
      const result = await pickAndScanFolder();
      if (!result) return;
      setRootName(result.rootName);
      setFiles(
        result.files.map<FileState>((f) => ({
          ...f,
          status: 'queued',
          uploaded: 0,
        })),
      );
      setStage('scanned');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function onStart() {
    if (!rootName) return;
    setError(null);
    setStage('uploading');
    try {
      const manifest = buildManifest(rootName, files);
      const run = await createAgentRun(manifest);
      setRunId(run.runId);

      // Upload files concurrently with a small pool. Each upload updates
      // its row in `files`. Videos go to Mux; the rest to /admin/agent/runs/:id/upload.
      const queue = [...files];
      const concurrency = 3;
      const inflight: Promise<void>[] = [];
      const updateFile = (path: string, patch: Partial<FileState>) =>
        setFiles((prev) =>
          prev.map((f) => (f.relativePath === path ? { ...f, ...patch } : f)),
        );

      const uploadOne = async (f: FileState) => {
        try {
          updateFile(f.relativePath, { status: 'uploading', uploaded: 0 });
          if (isVideo(f)) {
            const init = await initMuxUpload(run.runId, {
              relativePath: f.relativePath,
              size: f.size,
              contentType: f.contentType ?? 'video/mp4',
            });
            await uploadToMux(init, f, (loaded) =>
              updateFile(f.relativePath, { uploaded: loaded }),
            );
            updateFile(f.relativePath, {
              status: 'mux_processing',
              uploaded: f.size,
            });
          } else {
            await uploadAgentFile(run.runId, f, (loaded) =>
              updateFile(f.relativePath, { uploaded: loaded }),
            );
            updateFile(f.relativePath, { status: 'uploaded', uploaded: f.size });
          }
        } catch (err) {
          updateFile(f.relativePath, {
            status: 'failed',
            error: err instanceof Error ? err.message : String(err),
          });
        }
      };

      while (queue.length > 0 || inflight.length > 0) {
        while (inflight.length < concurrency && queue.length > 0) {
          const next = queue.shift()!;
          const p = uploadOne(next).finally(() => {
            const idx = inflight.indexOf(p);
            if (idx >= 0) inflight.splice(idx, 1);
          });
          inflight.push(p);
        }
        if (inflight.length > 0) await Promise.race(inflight);
      }

      setStage('uploaded');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStage('scanned');
    }
  }

  async function onPropose() {
    if (!runId) return;
    setStage('starting');
    setError(null);
    try {
      // Kick off propose; the run page will subscribe to the SSE stream
      // immediately on mount.
      await startProposePhase(runId);
      router.push(`/agent/${runId}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStage('uploaded');
    }
  }

  const totalBytes = files.reduce((s, f) => s + f.size, 0);
  const uploadedBytes = files.reduce((s, f) => s + f.uploaded, 0);
  const failedCount = files.filter((f) => f.status === 'failed').length;
  const allDone =
    files.length > 0 &&
    files.every(
      (f) => f.status === 'uploaded' || f.status === 'mux_processing' || f.status === 'failed',
    );

  return (
    <PageShell
      crumbs={[
        { label: 'Onboarding agent', href: '/agent' },
        { label: 'New run' },
      ]}
    >
      <PageHeader
        title="New agent run"
        description="Pick a customer's folder. The agent reads file types and content samples, then proposes a full tenant setup for your review."
      />
      <ErrorBanner error={error} />

      {stage === 'idle' && (
        <div className="rounded-md border border-line-subtle bg-surface-raised p-8 text-center">
          <FolderOpen className="mx-auto mb-3 text-ink-tertiary" size={32} />
          <h2 className="text-lg font-semibold">Pick the customer's onboarding folder</h2>
          <p className="mx-auto mt-2 max-w-prose text-sm text-ink-secondary">
            Use a Chromium browser (Chrome, Edge). Files stay on your computer — only filenames go
            to the server until you click <strong>Upload</strong>.
          </p>
          <p className="mx-auto mt-2 max-w-prose text-xs text-ink-tertiary">
            Recommended layout:{' '}
            <code className="font-mono">
              /&lt;OEM&gt;/&lt;Model&gt;/&#123;docs,parts,training,media&#125;
            </code>
            . Free-form folders work too — the agent will figure them out.
          </p>
          <div className="mt-5 flex justify-center">
            <PrimaryButton onClick={onPick}>
              <FolderOpen size={14} strokeWidth={2} /> Choose folder…
            </PrimaryButton>
          </div>
        </div>
      )}

      {stage !== 'idle' && rootName && (
        <div className="space-y-4">
          <div className="flex flex-wrap items-baseline justify-between gap-3 rounded-md border border-line-subtle bg-surface-raised px-4 py-3">
            <div>
              <p className="text-sm text-ink-tertiary">Root</p>
              <p className="text-base font-medium">{rootName}</p>
            </div>
            <div className="font-mono text-sm tabular-nums text-ink-secondary">
              {files.length} files · {formatBytes(totalBytes)}
            </div>
            <div className="flex items-center gap-2">
              {stage === 'scanned' && (
                <>
                  <SecondaryButton onClick={onPick}>Re-pick</SecondaryButton>
                  <PrimaryButton onClick={onStart}>
                    Upload <ArrowRight size={14} strokeWidth={2} />
                  </PrimaryButton>
                </>
              )}
              {stage === 'uploading' && (
                <span className="text-sm text-ink-secondary">
                  Uploading… {formatBytes(uploadedBytes)} / {formatBytes(totalBytes)}
                </span>
              )}
              {stage === 'uploaded' && allDone && (
                <PrimaryButton onClick={onPropose}>
                  <Sparkles size={14} strokeWidth={2} /> Run the agent
                </PrimaryButton>
              )}
              {stage === 'starting' && (
                <span className="text-sm text-ink-secondary">Starting agent…</span>
              )}
            </div>
          </div>

          {failedCount > 0 && (
            <div className="rounded-md border border-signal-fault/40 bg-signal-fault/10 p-3 text-sm text-signal-fault">
              {failedCount} file(s) failed to upload. Re-pick or proceed without them.
            </div>
          )}

          <div className="overflow-hidden rounded-md border border-line-subtle bg-surface-raised">
            <table className="data-table">
              <thead className="bg-surface-inset text-left text-xs uppercase tracking-wide text-ink-tertiary">
                <tr>
                  <th className="px-4 py-2">Path</th>
                  <th className="px-4 py-2">Size</th>
                  <th className="px-4 py-2">Type</th>
                  <th className="px-4 py-2">Status</th>
                  <th className="px-4 py-2">Progress</th>
                </tr>
              </thead>
              <tbody>
                {files.map((f) => {
                  const pct =
                    f.size === 0 ? 100 : Math.round((f.uploaded / f.size) * 100);
                  return (
                    <tr key={f.relativePath} className="border-t border-line-subtle">
                      <td className="px-4 py-1.5 font-mono text-xs">{f.relativePath}</td>
                      <td className="px-4 py-1.5 font-mono text-xs tabular-nums">
                        {formatBytes(f.size)}
                      </td>
                      <td className="px-4 py-1.5 text-xs text-ink-secondary">
                        {isVideo(f) ? 'video → Mux' : f.contentType ?? '—'}
                      </td>
                      <td className="px-4 py-1.5 text-xs">
                        {f.status === 'failed' && f.error ? (
                          <span className="text-signal-fault" title={f.error}>
                            failed
                          </span>
                        ) : (
                          f.status.replace(/_/g, ' ')
                        )}
                      </td>
                      <td className="px-4 py-1.5">
                        {f.status === 'uploading' ? (
                          <div className="h-1.5 w-32 overflow-hidden rounded bg-surface-inset">
                            <div
                              className="h-full bg-brand"
                              style={{ width: `${pct}%` }}
                            />
                          </div>
                        ) : (
                          <span className="font-mono text-xs tabular-nums text-ink-tertiary">
                            {pct}%
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div className="flex justify-end gap-2">
            <Link href="/agent">
              <SecondaryButton>Cancel</SecondaryButton>
            </Link>
          </div>
        </div>
      )}
    </PageShell>
  );
}
