'use client';

import { use, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import {
  Activity,
  AlertTriangle,
  Check,
  ChevronRight,
  PlayCircle,
  Sparkles,
} from 'lucide-react';
import { PageHeader, PageShell, Pill } from '@/components/page-shell';
import { ErrorBanner, PrimaryButton, SecondaryButton } from '@/components/form';
import {
  getAgentRun,
  patchProposal,
  startExecutePhase,
  startProposePhase,
  subscribeAgentStream,
  type AgentRunDetail,
  type AgentSseEvent,
} from '@/lib/agent';

interface ProposalNodeShape {
  kind: string;
  clientId: string;
  confidence: number;
  fromConvention: boolean;
  rationale: string | null;
  payload: Record<string, unknown>;
}
interface ProposalShape {
  schemaVersion: number;
  summary: string;
  warnings: string[];
  nodes: ProposalNodeShape[];
}

const KIND_LABEL: Record<string, string> = {
  organization: 'Org',
  site: 'Site',
  asset_model: 'Model',
  part: 'Part',
  bom_entry: 'BOM',
  content_pack: 'Pack',
  content_pack_version: 'Version',
  document: 'Doc',
  training_module: 'Module',
  lesson: 'Lesson',
  asset_instance: 'Instance',
  qr_code: 'QR',
  publish_version: 'Publish',
};

const KIND_ORDER = [
  'organization',
  'site',
  'asset_model',
  'part',
  'bom_entry',
  'content_pack',
  'content_pack_version',
  'document',
  'training_module',
  'lesson',
  'asset_instance',
  'qr_code',
  'publish_version',
];

const STATUS_TONE: Record<string, 'default' | 'info' | 'success' | 'warning' | 'danger'> = {
  scanning: 'info',
  uploading: 'info',
  proposing: 'info',
  awaiting_review: 'warning',
  executing: 'info',
  completed: 'success',
  failed: 'danger',
  cancelled: 'default',
};

interface StreamLogEntry {
  id: number;
  type: string;
  text: string;
  ts: number;
}

export default function AgentRunDetailPage({
  params,
}: {
  params: Promise<{ runId: string }>;
}) {
  const { runId } = use(params);

  const [detail, setDetail] = useState<AgentRunDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [log, setLog] = useState<StreamLogEntry[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [executionId, setExecutionId] = useState<string | null>(null);
  const [pubToggles, setPubToggles] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState(false);
  const sseRef = useRef<{ close: () => void } | null>(null);

  // Initial fetch.
  async function refresh() {
    try {
      const d = await getAgentRun(runId);
      setDetail(d);
      // Initialize publish toggles from existing publish_version nodes.
      const tree = d.proposal?.content as ProposalShape | undefined;
      if (tree?.nodes) {
        const toggles: Record<string, boolean> = {};
        for (const n of tree.nodes) {
          if (n.kind === 'publish_version') {
            toggles[(n.payload.contentPackVersionClientId as string) ?? n.clientId] =
              Boolean(n.payload.publish);
          }
        }
        setPubToggles(toggles);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  useEffect(() => {
    void refresh();
  }, [runId]);

  // Auto-attach to propose stream if status is proposing or scaffolding.
  useEffect(() => {
    if (!detail) return;
    if (
      (detail.run.status === 'proposing' || detail.run.status === 'uploading') &&
      !streaming
    ) {
      void attachStream('propose');
    }
    if (detail.run.status === 'executing' && !streaming && executionId) {
      void attachStream('execute');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detail?.run.status]);

  function logEvent(type: string, data: Record<string, unknown>, id: number | null) {
    setLog((prev) => [
      ...prev,
      {
        id: id ?? Date.now(),
        type,
        text: summarizeEvent(type, data),
        ts: Date.now(),
      },
    ]);
  }

  async function attachStream(purpose: 'propose' | 'execute') {
    setStreaming(true);
    try {
      const tokenResp =
        purpose === 'propose'
          ? await startProposePhase(runId)
          : await (async () => {
              if (!detail?.proposal) throw new Error('No proposal yet');
              const r = await startExecutePhase(detail.proposal.id);
              setExecutionId(r.executionId);
              return r;
            })();
      const onEvt = (evt: AgentSseEvent) => {
        logEvent(evt.type, evt.data, evt.id);
        if (
          evt.type === 'node_emitted' ||
          evt.type === 'execution_step' ||
          evt.type === 'status' ||
          evt.type === 'done'
        ) {
          // Refresh proposal periodically to surface emitted nodes.
          void refresh();
        }
        if (evt.type === 'done') {
          setStreaming(false);
          sseRef.current?.close();
          sseRef.current = null;
        }
      };
      sseRef.current?.close();
      sseRef.current = subscribeAgentStream(runId, purpose, tokenResp.streamToken, onEvt, () => {
        // On error, close and stop streaming. The user can re-trigger.
        setStreaming(false);
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStreaming(false);
    }
  }

  useEffect(() => {
    return () => {
      sseRef.current?.close();
    };
  }, []);

  const tree = detail?.proposal?.content as ProposalShape | undefined;
  const grouped = useMemo(() => groupByKind(tree?.nodes ?? []), [tree]);

  async function onApply() {
    if (!detail?.proposal || !tree) return;
    setBusy(true);
    setError(null);
    try {
      // Sync publish toggles into the tree first.
      const updatedNodes = tree.nodes.map((n) => {
        if (n.kind !== 'publish_version') return n;
        const versionClientId = n.payload.contentPackVersionClientId as string | undefined;
        if (!versionClientId) return n;
        const wantPublish = Boolean(pubToggles[versionClientId]);
        return {
          ...n,
          payload: { ...n.payload, publish: wantPublish },
        };
      });
      const updatedTree = { ...tree, nodes: updatedNodes };
      const patched = await patchProposal(detail.proposal.id, {
        version: detail.proposal.version,
        content: updatedTree,
      });
      // Refresh + start execute.
      await refresh();
      const exec = await startExecutePhase(detail.proposal.id);
      setExecutionId(exec.executionId);
      // Override stream subscribe with execute purpose using the returned token.
      const onEvt = (evt: AgentSseEvent) => {
        logEvent(evt.type, evt.data, evt.id);
        if (evt.type === 'execution_step' || evt.type === 'done' || evt.type === 'status') {
          void refresh();
        }
        if (evt.type === 'done') {
          setStreaming(false);
          sseRef.current?.close();
          sseRef.current = null;
        }
      };
      sseRef.current?.close();
      sseRef.current = subscribeAgentStream(
        runId,
        'execute',
        exec.streamToken,
        onEvt,
        () => setStreaming(false),
      );
      setStreaming(true);
      void patched; // mark as used
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  if (!detail) {
    return (
      <PageShell crumbs={[{ label: 'Onboarding agent', href: '/agent' }, { label: '…' }]}>
        <ErrorBanner error={error} />
        <p className="p-6 text-center text-sm text-ink-tertiary">Loading run…</p>
      </PageShell>
    );
  }

  return (
    <PageShell
      crumbs={[
        { label: 'Onboarding agent', href: '/agent' },
        { label: detail.run.manifest?.rootName ?? detail.run.id.slice(0, 8) },
      ]}
    >
      <PageHeader
        title={detail.run.manifest?.rootName ?? 'Agent run'}
        description={
          <>
            <Pill tone={STATUS_TONE[detail.run.status]}>{detail.run.status.replace(/_/g, ' ')}</Pill>{' '}
            <span className="ml-2 text-sm text-ink-secondary">
              {detail.run.manifest?.totalFiles ?? 0} files
              {detail.proposal?.modelUsed && ` · ${detail.proposal.modelUsed}`}
              {detail.proposal?.tokenUsage &&
                ` · ${detail.proposal.tokenUsage.inputTokens + detail.proposal.tokenUsage.outputTokens} tokens`}
            </span>
          </>
        }
        actions={
          detail.run.status === 'awaiting_review' ? (
            <PrimaryButton onClick={onApply} disabled={busy}>
              <PlayCircle size={14} strokeWidth={2} /> Approve & execute
            </PrimaryButton>
          ) : detail.run.status === 'proposing' || detail.run.status === 'executing' ? (
            <span className="flex items-center gap-2 text-sm text-ink-secondary">
              <Activity size={14} className="animate-pulse" /> Streaming…
            </span>
          ) : detail.run.status === 'completed' ? (
            <Link href="/tenants">
              <SecondaryButton>
                View created entities <ChevronRight size={14} />
              </SecondaryButton>
            </Link>
          ) : detail.run.status === 'failed' ? (
            <SecondaryButton onClick={() => attachStream('propose')} disabled={busy}>
              <Sparkles size={14} strokeWidth={2} /> Retry propose
            </SecondaryButton>
          ) : null
        }
      />
      <ErrorBanner error={error} />

      {detail.run.error && (
        <div className="mb-4 rounded-md border border-signal-fault/40 bg-signal-fault/10 p-3 text-sm text-signal-fault">
          <AlertTriangle size={14} className="mr-2 inline-block" /> {detail.run.error}
        </div>
      )}

      {tree?.summary && (
        <section className="mb-4 rounded-md border border-line-subtle bg-surface-raised p-4">
          <p className="text-xs font-medium uppercase tracking-wide text-ink-tertiary">
            Agent summary
          </p>
          <p className="mt-1 text-sm text-ink-primary whitespace-pre-wrap">{tree.summary}</p>
          {tree.warnings.length > 0 && (
            <details className="mt-3">
              <summary className="cursor-pointer text-xs font-medium uppercase tracking-wide text-signal-warn">
                {tree.warnings.length} warnings
              </summary>
              <ul className="mt-1 list-disc pl-5 text-xs text-signal-warn">
                {tree.warnings.map((w, i) => (
                  <li key={i}>{w}</li>
                ))}
              </ul>
            </details>
          )}
        </section>
      )}

      <div className="grid gap-4 md:grid-cols-3">
        <section className="rounded-md border border-line-subtle bg-surface-raised md:col-span-2">
          <header className="border-b border-line-subtle px-4 py-3 text-xs font-semibold uppercase tracking-wide text-ink-tertiary">
            Proposed plan ({tree?.nodes.length ?? 0} nodes)
          </header>
          <div className="max-h-[70vh] overflow-y-auto p-4">
            {tree && tree.nodes.length > 0 ? (
              KIND_ORDER.filter((k) => grouped.get(k) && grouped.get(k)!.length > 0).map((k) => (
                <div key={k} className="mb-4">
                  <h3 className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-ink-tertiary">
                    {KIND_LABEL[k] ?? k} ({grouped.get(k)!.length})
                  </h3>
                  <ul className="flex flex-col gap-1">
                    {grouped.get(k)!.map((n) => (
                      <NodeRow
                        key={n.clientId}
                        node={n}
                        isPublishToggleRow={k === 'content_pack_version'}
                        publishOn={Boolean(pubToggles[n.clientId])}
                        onTogglePublish={(v) =>
                          setPubToggles((prev) => ({ ...prev, [n.clientId]: v }))
                        }
                      />
                    ))}
                  </ul>
                </div>
              ))
            ) : (
              <p className="text-sm text-ink-tertiary">
                {streaming ? 'Streaming proposed nodes…' : 'No proposal yet.'}
              </p>
            )}
          </div>
        </section>

        <section className="rounded-md border border-line-subtle bg-surface-raised">
          <header className="border-b border-line-subtle px-4 py-3 text-xs font-semibold uppercase tracking-wide text-ink-tertiary">
            Activity
          </header>
          <div className="max-h-[70vh] overflow-y-auto p-3">
            {log.length === 0 ? (
              <p className="text-sm text-ink-tertiary">
                {streaming
                  ? 'Waiting for events…'
                  : 'No activity yet. Click "Run the agent" or wait for execute.'}
              </p>
            ) : (
              <ul className="flex flex-col gap-1 text-xs">
                {log.slice(-200).map((e) => (
                  <li
                    key={e.id}
                    className="flex items-start gap-2 border-b border-line-subtle/50 pb-1.5 last:border-0"
                  >
                    <span
                      className={`shrink-0 font-mono text-[10px] tabular-nums ${
                        e.type === 'error'
                          ? 'text-signal-fault'
                          : e.type === 'warning'
                          ? 'text-signal-warn'
                          : 'text-ink-tertiary'
                      }`}
                    >
                      {new Date(e.ts).toLocaleTimeString().slice(0, 8)}
                    </span>
                    <span className="font-mono text-[10px] uppercase tracking-wide text-ink-tertiary">
                      {e.type}
                    </span>
                    <span className="flex-1 break-words">{e.text}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>
      </div>
    </PageShell>
  );
}

function NodeRow({
  node,
  isPublishToggleRow,
  publishOn,
  onTogglePublish,
}: {
  node: ProposalNodeShape;
  isPublishToggleRow: boolean;
  publishOn: boolean;
  onTogglePublish: (v: boolean) => void;
}) {
  return (
    <li className="flex items-start gap-2 rounded border border-line-subtle/40 bg-surface-inset/40 p-2 text-sm">
      <span
        className="mt-0.5 inline-flex h-4 w-4 items-center justify-center rounded text-[10px]"
        style={{
          background: node.fromConvention ? 'rgb(var(--brand) / 0.15)' : 'transparent',
          color: node.fromConvention ? 'rgb(var(--brand))' : 'currentColor',
        }}
        title={node.fromConvention ? 'from convention parser (high confidence)' : 'inferred by agent'}
      >
        {node.fromConvention ? <Check size={10} /> : '~'}
      </span>
      <div className="flex-1">
        <div className="font-medium">{describePayload(node)}</div>
        <div className="font-mono text-[10px] text-ink-tertiary">
          {node.clientId} · confidence {Math.round(node.confidence * 100)}%
          {node.rationale ? ` · ${node.rationale}` : ''}
        </div>
      </div>
      {isPublishToggleRow && (
        <label className="flex items-center gap-1 text-xs text-ink-secondary">
          <input
            type="checkbox"
            checked={publishOn}
            onChange={(e) => onTogglePublish(e.target.checked)}
          />
          Publish
        </label>
      )}
    </li>
  );
}

function describePayload(n: ProposalNodeShape): string {
  const p = n.payload as Record<string, unknown>;
  switch (n.kind) {
    case 'organization':
      return `${p.type} "${p.name}"`;
    case 'asset_model':
      return `${p.modelCode} — ${p.displayName}`;
    case 'part':
      return `${p.oemPartNumber} — ${p.displayName}`;
    case 'document':
      return `${p.kind} · ${p.title}`;
    case 'training_module':
      return `${p.title}`;
    case 'asset_instance':
      return `serial ${p.serialNumber}`;
    case 'site':
      return `${p.name}`;
    case 'content_pack':
      return `${p.layerType} · ${p.name}`;
    case 'content_pack_version':
      return `${p.versionLabel ?? 'v?'}${p.changelog ? ` · ${p.changelog}` : ''}`;
    case 'bom_entry':
      return `qty ${p.quantity}${p.positionRef ? ` @ ${p.positionRef}` : ''}`;
    case 'qr_code':
      return p.label ? `label "${p.label}"` : '(auto-generated)';
    case 'lesson':
      return `${p.title}`;
    case 'publish_version':
      return p.publish ? 'publish on apply' : '(draft)';
    default:
      return n.kind;
  }
}

function groupByKind(nodes: ProposalNodeShape[]): Map<string, ProposalNodeShape[]> {
  const m = new Map<string, ProposalNodeShape[]>();
  for (const n of nodes) {
    if (!m.has(n.kind)) m.set(n.kind, []);
    m.get(n.kind)!.push(n);
  }
  return m;
}

function summarizeEvent(type: string, data: Record<string, unknown>): string {
  switch (type) {
    case 'tool_call':
      return `→ ${data.name as string}`;
    case 'tool_result':
      return `← ${data.name as string}${
        data.count !== undefined ? ` (${data.count})` : data.error ? ` ERR ${data.error}` : ''
      }`;
    case 'node_emitted':
      return `+ ${data.kind as string} ${data.clientId as string}`;
    case 'execution_step':
      return `${data.kind as string} ${data.clientId as string} → ${data.status as string}${
        data.error ? ` (${data.error})` : ''
      }`;
    case 'status':
      return `status: ${data.status as string}`;
    case 'mux_ready':
      return `Mux ready: ${data.relativePath as string}`;
    case 'warning':
      return `WARN: ${data.message as string}`;
    case 'error':
      return `ERROR: ${data.message as string}`;
    case 'done':
      return data.ok
        ? `done — ok${data.stepsSucceeded ? ` (${data.stepsSucceeded} succeeded)` : ''}`
        : `done — failed`;
    default:
      return JSON.stringify(data).slice(0, 100);
  }
}
