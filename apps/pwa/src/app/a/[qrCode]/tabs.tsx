'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import {
  CalendarClock,
  FileText,
  GraduationCap,
  LayoutGrid,
  ListChecks,
  MessageSquare,
  Play,
  Wrench,
  type LucideIcon,
} from 'lucide-react';
import type { AssetHubPayload } from '@/lib/shared-schema';
import { DocsTab } from './docs-tab';
import { ChatTab } from './chat-tab';
import { TrainingTab } from './training-tab';
import { PartsTab } from './parts-tab';
import { IssuesPanel } from './issues-panel';
import { MaintenanceTab } from './maintenance-tab';
import { VoiceMode, type PrefetchedGreeting } from '@/components/voice-mode';
import { VirtualJobAid, type JobAidSource } from '@/components/virtual-job-aid';
import { ModeChooser, type ChosenMode } from '@/components/mode-chooser';
import { ImageZoom } from '@/components/image-zoom';
import {
  fetchPreflight,
  listDocuments,
  speak,
  type DocumentListItem,
} from '@/lib/api';

const DEV_USER_ID = process.env.NEXT_PUBLIC_DEV_USER_ID ?? '';
const DEV_ORG_ID = process.env.NEXT_PUBLIC_DEV_ORG_ID ?? '';

type TabKey =
  | 'overview'
  | 'docs'
  | 'training'
  | 'parts'
  | 'maintenance'
  | 'chat';

const TABS: Array<{ key: TabKey; label: string; icon: LucideIcon }> = [
  { key: 'overview', label: 'Overview', icon: LayoutGrid },
  { key: 'docs', label: 'Documents', icon: FileText },
  { key: 'training', label: 'Training', icon: GraduationCap },
  { key: 'parts', label: 'Parts', icon: Wrench },
  { key: 'maintenance', label: 'Maintenance', icon: CalendarClock },
  { key: 'chat', label: 'Assistant', icon: MessageSquare },
];

const TAB_KEYS = TABS.map((t) => t.key);

function readTabFromHash(): TabKey | null {
  if (typeof window === 'undefined') return null;
  const h = window.location.hash.replace(/^#/, '') as TabKey;
  return (TAB_KEYS as string[]).includes(h) ? (h as TabKey) : null;
}

// Mode choice gates the asset hub. 'choosing' shows the ModeChooser
// overlay; 'voice' opens VoiceMode immediately; 'browse' renders the
// normal hub. The choice is intentional and not persisted — every QR
// scan / refresh starts in 'choosing'.
type Mode = 'choosing' | 'voice' | 'browse';

export function AssetHubTabs({ hub, qrCode }: { hub: AssetHubPayload; qrCode: string }) {
  const [active, setActive] = useState<TabKey>('overview');
  const [openIssueCount, setOpenIssueCount] = useState<number>(
    hub.tabs.openWorkOrders.count,
  );
  const [mode, setMode] = useState<Mode>(
    DEV_USER_ID && DEV_ORG_ID ? 'choosing' : 'browse',
  );
  const [voiceOpen, setVoiceOpen] = useState(false);
  // VirtualJobAid mount for procedures launched from the Overview quick
  // actions card OR from the Maintenance tab (PM bucket → inline steps,
  // troubleshooting row → inline steps, scheduled procedure → docId).
  // Voice mode owns its own handoff and never writes here.
  const [jobAidRequest, setJobAidRequest] = useState<{
    source: JobAidSource;
    onCompleted?: () => void;
  } | null>(null);

  // Prefetch the greeting (preflight + TTS blob) the moment the chooser
  // is up, so tapping Hands-Free starts speaking ~immediately rather than
  // waiting on a serial round-trip to OpenAI TTS. We accept that ~half of
  // chooser displays will end up picking Browse and discarding the audio
  // — the per-greeting cost is ~$0.003 and the perceived-latency win is
  // significant. Stored as a promise so VoiceMode can await it.
  const greetingPrefetchRef = useRef<Promise<PrefetchedGreeting | null> | null>(
    null,
  );

  useEffect(() => {
    if (mode !== 'choosing') return;
    if (!DEV_USER_ID || !DEV_ORG_ID) return;
    if (greetingPrefetchRef.current) return;
    greetingPrefetchRef.current = (async () => {
      try {
        const brief = await fetchPreflight(hub.assetInstance.id);
        if (!brief.greeting) return { brief, blob: null };
        const resp = await speak(brief.greeting);
        const blob = await resp.blob();
        return { brief, blob };
      } catch (err) {
        console.warn('[hub] greeting prefetch failed', err);
        return null;
      }
    })();
  }, [mode, hub.assetInstance.id]);

  function pickMode(chosen: ChosenMode) {
    if (chosen === 'voice') {
      setMode('voice');
      setVoiceOpen(true);
    } else {
      setMode('browse');
    }
  }

  // Hydrate the active tab from the URL hash on mount so deep links
  // (`#docs`) land on the right tab. Then keep the hash in sync as the
  // tech moves around — and, critically, push a real history entry on
  // tab change so the device's back button steps through tabs instead of
  // immediately popping out to the QR scanner.
  useEffect(() => {
    const initial = readTabFromHash();
    if (initial && initial !== 'overview') {
      setActive(initial);
    }
    function onPop() {
      const fromHash = readTabFromHash();
      setActive(fromHash ?? 'overview');
    }
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  const changeTab = useCallback((next: TabKey) => {
    setActive((prev) => {
      if (prev === next) return prev;
      // Update history so phone back button returns to the previous tab.
      // Overview is the canonical "no hash" state.
      const url = new URL(window.location.href);
      url.hash = next === 'overview' ? '' : next;
      window.history.pushState({ tab: next }, '', url.toString());
      return next;
    });
  }, []);

  // Nameplate only appears on Overview — every other tab gets straight
  // to its own content. The page-level topbar already carries the brand
  // logo, so techs don't lose context.
  const showNameplate = active === 'overview';

  return (
    <>
      {showNameplate && (
        <Nameplate hub={hub} compact={false} openIssueCount={openIssueCount} />
      )}

      <TabBar hub={hub} active={active} setActive={changeTab} position="top" />

      <div key={active} className="tab-pane flex flex-col gap-4">
        {active === 'overview' ? (
          <div className="flex flex-col gap-4">
            <ProceduresQuickActions
              versionId={hub.pinnedContentPackVersion?.id ?? null}
              onLaunch={(docId) =>
                setJobAidRequest({
                  source: {
                    kind: 'doc',
                    docId,
                    devUserId: DEV_USER_ID,
                    devOrgId: DEV_ORG_ID,
                  },
                })
              }
            />
            <div className="spec-panel">
              <OverviewSpecs hub={hub} openIssueCount={openIssueCount} />
            </div>
            <div className="spec-panel">
              <IssuesPanel
                assetInstanceId={hub.assetInstance.id}
                onCountChange={setOpenIssueCount}
              />
            </div>
          </div>
        ) : (
          <section className="rounded-md border border-line bg-surface-raised p-4 md:p-6">
            {active === 'docs' && (
              <DocsTab
                versionId={hub.pinnedContentPackVersion?.id ?? null}
                fieldCapturesVersionId={hub.fieldCapturesVersionId ?? null}
                assetInstanceId={hub.assetInstance.id}
              />
            )}
            {active === 'training' && <TrainingTab hub={hub} />}
            {active === 'parts' && <PartsTab hub={hub} qrCode={qrCode} />}
            {active === 'maintenance' && (
              <MaintenanceTab
                assetInstanceId={hub.assetInstance.id}
                versionId={hub.pinnedContentPackVersion?.id ?? null}
                fieldCapturesVersionId={hub.fieldCapturesVersionId ?? null}
                onLaunchJobAid={(source, onCompleted) =>
                  setJobAidRequest({ source, onCompleted })
                }
              />
            )}
            {active === 'chat' && <ChatTab hub={hub} qrCode={qrCode} />}
          </section>
        )}
      </div>

      <TabBar hub={hub} active={active} setActive={changeTab} position="bottom" />

      {mode === 'choosing' && DEV_USER_ID && DEV_ORG_ID && (
        <ModeChooser
          assetName={hub.assetModel.displayName}
          serialNumber={hub.assetInstance.serialNumber}
          onPick={pickMode}
        />
      )}

      {voiceOpen && DEV_USER_ID && DEV_ORG_ID && (
        <VoiceMode
          assetInstanceId={hub.assetInstance.id}
          devUserId={DEV_USER_ID}
          devOrgId={DEV_ORG_ID}
          prefetched={greetingPrefetchRef.current ?? undefined}
          onClose={({ conversationId, turns, switchToChat }) => {
            setVoiceOpen(false);
            // Discard the prefetch — it was for the initial scan greeting.
            // If the tech re-engages voice via the Talk pill we'll fetch
            // fresh (preflight may have changed; greeting was one-shot).
            greetingPrefetchRef.current = null;
            // Drop back into Browse mode so the chooser doesn't reappear
            // (and so the Talk pill becomes visible for re-entry).
            setMode('browse');
            // Hand the conversation off to the chat tab so the tech can
            // see the transcript and continue typing or scrolling.
            if (conversationId || turns.length > 0) {
              try {
                const key = `eh:chat:v1:${hub.assetInstance.id}`;
                const existingRaw = window.localStorage.getItem(key);
                const existing = existingRaw ? JSON.parse(existingRaw) : null;
                const merged = {
                  conversationId:
                    conversationId ?? existing?.conversationId,
                  turns: [
                    ...(existing?.turns ?? []),
                    ...turns.map((t) =>
                      t.role === 'user'
                        ? { role: 'user' as const, text: t.text }
                        : {
                            role: 'assistant' as const,
                            text: t.text,
                            citations: [],
                            streaming: false,
                          },
                    ),
                  ],
                };
                window.localStorage.setItem(key, JSON.stringify(merged));
              } catch {
                // localStorage failures are non-fatal — conversation lives on
                // the server.
              }
            }
            // Switch to the chat tab when the user explicitly chose Keyboard,
            // or whenever there's a transcript to show.
            if (switchToChat || turns.length > 0) {
              changeTab('chat');
            }
          }}
        />
      )}

      {/* VirtualJobAid mount for procedures + synthesized step lists
          launched from Overview quick-actions or the Maintenance tab.
          Voice mode uses its own VirtualJobAid mount for [procedure:UUID]
          handoffs — these don't overlap because voiceOpen and
          jobAidRequest are independent state. */}
      {jobAidRequest && DEV_USER_ID && DEV_ORG_ID && (
        <VirtualJobAid
          source={jobAidRequest.source}
          onClose={({ completed }) => {
            if (completed) jobAidRequest.onCompleted?.();
            setJobAidRequest(null);
          }}
        />
      )}
    </>
  );
}

// Overview quick-actions card. Lists the asset's authored procedures as
// tappable rows so a tech who just scanned the QR has a one-tap entry
// into "how do I work on this thing right now?" without browsing Docs.
// Empty / loading state is rendered as null so the Overview tab stays
// clean for assets with no procedures yet.
function ProceduresQuickActions({
  versionId,
  onLaunch,
}: {
  versionId: string | null;
  onLaunch: (docId: string) => void;
}): React.ReactElement | null {
  const [procs, setProcs] = useState<DocumentListItem[] | null>(null);

  useEffect(() => {
    if (!versionId) {
      setProcs([]);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const docs = await listDocuments(versionId);
        if (cancelled) return;
        const authored = docs
          .filter((d) => d.kind === 'structured_procedure')
          .sort((a, b) =>
            a.title.localeCompare(b.title, undefined, { sensitivity: 'base' }),
          )
          .slice(0, 5);
        setProcs(authored);
      } catch {
        if (!cancelled) setProcs([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [versionId]);

  if (!procs || procs.length === 0) return null;

  return (
    <div className="spec-panel">
      <div className="caption mb-2 text-ink-tertiary">What you can do here</div>
      <ul className="flex flex-col gap-1">
        {procs.map((p) => (
          <li key={p.id}>
            <button
              type="button"
              onClick={() => onLaunch(p.id)}
              className="group flex w-full items-center gap-3 rounded border border-line bg-surface-elevated px-3 py-2.5 text-left transition hover:border-brand/40 hover:bg-surface-raised"
            >
              <ListChecks
                size={16}
                strokeWidth={2}
                className="shrink-0 text-ink-brand"
              />
              <span className="flex-1 truncate text-sm font-medium text-ink-primary">
                {p.title}
              </span>
              <Play
                size={14}
                strokeWidth={2.25}
                className="shrink-0 text-ink-tertiary group-hover:text-brand"
              />
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

// Nameplate — full milled-aluminum identification panel on the Overview
// tab; collapses to a thin single-line strip on every other tab so techs
// keep reading docs/parts/etc. instead of re-reading the asset's name.
// The strip carries enough identity (LED + model + serial) that a tech
// glancing up still knows what they're looking at, but adds only ~36px
// of vertical chrome instead of the full plate's ~140px.
function Nameplate({
  hub,
  compact,
  openIssueCount,
}: {
  hub: AssetHubPayload;
  compact: boolean;
  openIssueCount: number;
}) {
  const ledClass = openIssueCount > 0 ? 'led-warn' : 'led-ok';

  if (compact) {
    return (
      <header className="nameplate-strip" aria-label="Asset identity">
        <span className={`led ${ledClass}`} />
        <div className="nameplate-strip-id">
          {hub.assetModel.imageUrl && (
            <ImageZoom
              src={hub.assetModel.imageUrl}
              alt={hub.assetModel.displayName}
              triggerLabel={`Enlarge ${hub.assetModel.displayName} photo`}
            >
              <img
                src={hub.assetModel.imageUrl}
                alt=""
                className="nameplate-strip-thumb"
              />
            </ImageZoom>
          )}
          <span className="nameplate-strip-name">{hub.assetModel.displayName}</span>
          <span className="nameplate-strip-sep">·</span>
          <span className="nameplate-strip-serial">
            <span className="cap">S/N</span>
            <span className="serial">{hub.assetInstance.serialNumber}</span>
          </span>
        </div>
        {openIssueCount > 0 && (
          <span className="pill pill-warn">{openIssueCount} open</span>
        )}
      </header>
    );
  }

  return (
    <header className="nameplate">
      <span className="corner-mark tl" />
      <span className="corner-mark tr" />
      <span className="corner-mark bl" />
      <span className="corner-mark br" />

      <div className="nameplate-top">
        <span className={`led ${ledClass}`} />
        <span className="caption">
          {hub.organization.name} · {hub.site.name}
        </span>
      </div>

      {/* Image-prominent hero band: the asset photo fills the full
          width of the plate, with title + meta overlaid at the bottom
          on a dark gradient so white text reads on any frame. The
          industrial framing (corner marks, brand rail, plate gradient)
          stays around it for brand continuity. */}
      <div className="nameplate-hero">
        {hub.assetModel.imageUrl ? (
          <ImageZoom
            src={hub.assetModel.imageUrl}
            alt={hub.assetModel.displayName}
            triggerLabel={`Enlarge ${hub.assetModel.displayName} photo`}
          >
            <img
              src={hub.assetModel.imageUrl}
              alt=""
              className="nameplate-hero-image"
            />
          </ImageZoom>
        ) : (
          <div className="nameplate-hero-image-placeholder" />
        )}
        <div className="nameplate-hero-overlay">
          <h1 className="nameplate-hero-title">{hub.assetModel.displayName}</h1>
          <div className="nameplate-hero-meta">
            <span>{hub.assetModel.modelCode}</span>
            <span className="sep">·</span>
            <span>
              S/N <span className="serial">{hub.assetInstance.serialNumber}</span>
            </span>
            {hub.assetModel.category && (
              <>
                <span className="sep">·</span>
                <span style={{ textTransform: 'uppercase' }}>
                  {hub.assetModel.category}
                </span>
              </>
            )}
          </div>
        </div>
      </div>

      <div className="nameplate-metrics-bar">
        <div className="nameplate-metric-h">
          <span className="cap">Open WO</span>
          <span
            className="val"
            style={{
              color:
                openIssueCount > 0
                  ? 'rgb(var(--signal-warn))'
                  : 'rgb(var(--signal-ok))',
            }}
          >
            {openIssueCount}
          </span>
        </div>
        <div className="nameplate-metric-h">
          <span className="cap">PM Due</span>
          <span
            className="val"
            style={{
              color:
                hub.tabs.pm.needsAction > 0
                  ? hub.tabs.pm.overdue > 0
                    ? 'rgb(var(--signal-fault))'
                    : 'rgb(var(--signal-warn))'
                  : 'rgb(var(--signal-ok))',
            }}
          >
            {hub.tabs.pm.needsAction}
          </span>
        </div>
      </div>
    </header>
  );
}

function TabBar({
  hub,
  active,
  setActive,
  position,
}: {
  hub: AssetHubPayload;
  active: TabKey;
  setActive: (k: TabKey) => void;
  position: 'top' | 'bottom';
}) {
  const className = `app-tabbar${position === 'top' ? ' app-tabbar-top' : ''}`;
  return (
    <nav className={className} role="tablist" aria-label="Sections">
      {TABS.map((t) => {
        const Icon = t.icon;
        const isActive = active === t.key;
        return (
          <button
            key={t.key}
            role="tab"
            aria-selected={isActive}
            data-active={isActive}
            onClick={() => setActive(t.key)}
            className="app-tabbar-item"
          >
            <Icon size={22} strokeWidth={isActive ? 2.25 : 1.75} />
            <span>{t.label}</span>
          </button>
        );
      })}
    </nav>
  );
}

// UTC + explicit locale so the same markup renders on the server (Fly/Chicago)
// and every client browser. Using toLocaleDateString() without these knobs
// causes React hydration mismatch (#418) when the client's locale/timezone
// differs from the server.
const INSTALLED_FMT = new Intl.DateTimeFormat('en-US', {
  year: 'numeric',
  month: 'short',
  day: 'numeric',
  timeZone: 'UTC',
});
function formatInstalledAt(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : INSTALLED_FMT.format(d);
}

function OverviewSpecs({
  hub,
  openIssueCount,
}: {
  hub: AssetHubPayload;
  openIssueCount: number;
}) {
  return (
    <div className="spec-grid">
      <SpecField label="Model code" value={hub.assetModel.modelCode} mono />
      <SpecField label="Serial" value={hub.assetInstance.serialNumber} mono brand />
      <SpecField label="Site" value={hub.site.name} />
      <SpecField label="Customer" value={hub.organization.name} />
      <SpecField
        label="Open issues"
        value={String(openIssueCount)}
        mono
        tone={openIssueCount > 0 ? 'warn' : 'ok'}
      />
      <SpecField
        label="Installed"
        value={formatInstalledAt(hub.assetInstance.installedAt)}
      />
    </div>
  );
}

function SpecField({
  label,
  value,
  mono,
  brand,
  tone,
}: {
  label: string;
  value: string;
  mono?: boolean;
  brand?: boolean;
  tone?: 'ok' | 'warn' | 'fault';
}) {
  const cls = [
    'val',
    mono && 'mono',
    brand && 'brand',
    tone === 'ok' && 'ok',
    tone === 'warn' && 'warn',
    tone === 'fault' && 'fault',
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <div className="spec-field">
      <span className="cap">{label}</span>
      <span className={cls}>{value}</span>
    </div>
  );
}
