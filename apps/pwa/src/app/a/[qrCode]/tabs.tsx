'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import {
  CalendarClock,
  ChevronDown,
  FileText,
  GraduationCap,
  LayoutGrid,
  Library,
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
  fetchPmPlanStatus,
  fetchPmStatus,
  fetchPreflight,
  listDocuments,
  speak,
  type DocumentListItem,
} from '@/lib/api';

const DEV_USER_ID = process.env.NEXT_PUBLIC_DEV_USER_ID ?? '';
const DEV_ORG_ID = process.env.NEXT_PUBLIC_DEV_ORG_ID ?? '';

type TabKey =
  | 'overview'
  | 'library'
  | 'parts'
  | 'maintenance'
  | 'chat';

const TABS: Array<{ key: TabKey; label: string; icon: LucideIcon }> = [
  { key: 'overview', label: 'Overview', icon: LayoutGrid },
  { key: 'library', label: 'Library', icon: Library },
  { key: 'parts', label: 'Parts', icon: Wrench },
  { key: 'maintenance', label: 'Maintenance', icon: CalendarClock },
  { key: 'chat', label: 'Assistant', icon: MessageSquare },
];

const TAB_KEYS = TABS.map((t) => t.key);

// Library subsection — persisted via the hash so a bookmark deep-links
// straight into Documents or Training. Legacy hashes (#docs / #training)
// route here too so old links keep working.
type LibrarySection = 'documents' | 'training';

function readTabFromHash(): { tab: TabKey; library?: LibrarySection } | null {
  if (typeof window === 'undefined') return null;
  const h = window.location.hash.replace(/^#/, '');
  // Back-compat: #docs and #training fold into Library with the
  // corresponding sub-section pre-selected.
  if (h === 'docs') return { tab: 'library', library: 'documents' };
  if (h === 'training') return { tab: 'library', library: 'training' };
  if ((TAB_KEYS as string[]).includes(h)) {
    return { tab: h as TabKey };
  }
  return null;
}

// Mode choice gates the asset hub. 'choosing' shows the ModeChooser
// overlay; 'voice' opens VoiceMode immediately; 'browse' renders the
// normal hub. The choice is intentional and not persisted — every QR
// scan / refresh starts in 'choosing'.
type Mode = 'choosing' | 'voice' | 'browse';

export function AssetHubTabs({ hub, qrCode }: { hub: AssetHubPayload; qrCode: string }) {
  const [active, setActive] = useState<TabKey>('overview');
  const [librarySection, setLibrarySection] =
    useState<LibrarySection>('documents');
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
    if (initial && initial.tab !== 'overview') {
      setActive(initial.tab);
      if (initial.library) setLibrarySection(initial.library);
    }
    function onPop() {
      const fromHash = readTabFromHash();
      setActive(fromHash?.tab ?? 'overview');
      if (fromHash?.library) setLibrarySection(fromHash.library);
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

  return (
    <>
      <TabBar hub={hub} active={active} setActive={changeTab} position="top" />

      <div key={active} className="tab-pane flex flex-col gap-4">
        {active === 'overview' ? (
          <div className="flex flex-col gap-4">
            <IdentityBand hub={hub} />
            <StatusStrip
              hub={hub}
              openIssueCount={openIssueCount}
              onOpenMaintenance={() => changeTab('maintenance')}
            />
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
            <IssuesPanel
              assetInstanceId={hub.assetInstance.id}
              onCountChange={setOpenIssueCount}
            />
            <DetailsDisclosure>
              <OverviewSpecs hub={hub} openIssueCount={openIssueCount} />
            </DetailsDisclosure>
          </div>
        ) : active === 'library' ? (
          /* Library renders directly into the scroll region — its
             segmented control + filter chips + list rows already carry
             their own structure and don't need a surrounding raised
             panel. */
          <LibraryTab
            hub={hub}
            section={librarySection}
            onSectionChange={setLibrarySection}
          />
        ) : (
          <section className="rounded-md border border-line bg-surface-raised p-4 md:p-6">
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
          // PM checklists + troubleshooting are synthesized as inline
          // step lists; those are quick-reference walkthroughs and
          // shouldn't auto-narrate. Authored doc procedures keep the
          // default voice-over behavior.
          autoSpeak={jobAidRequest.source.kind !== 'inline'}
          onClose={({ completed }) => {
            if (completed) jobAidRequest.onCompleted?.();
            setJobAidRequest(null);
          }}
        />
      )}
    </>
  );
}

// Library — merged Documents + Training surface. A 2-button segmented
// control at the top picks which view renders below. Documents and
// Training were peer tabs before this; merging them frees a slot in
// the bottom tabbar while keeping both surfaces a single tap away.
function LibraryTab({
  hub,
  section,
  onSectionChange,
}: {
  hub: AssetHubPayload;
  section: LibrarySection;
  onSectionChange: (s: LibrarySection) => void;
}) {
  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-2 gap-2">
        <LibrarySegmentButton
          icon={FileText}
          label="Documents"
          active={section === 'documents'}
          onClick={() => onSectionChange('documents')}
        />
        <LibrarySegmentButton
          icon={GraduationCap}
          label="Training"
          active={section === 'training'}
          onClick={() => onSectionChange('training')}
        />
      </div>
      {section === 'documents' ? (
        <DocsTab
          versionId={hub.pinnedContentPackVersion?.id ?? null}
          fieldCapturesVersionId={hub.fieldCapturesVersionId ?? null}
          assetInstanceId={hub.assetInstance.id}
        />
      ) : (
        <TrainingTab hub={hub} />
      )}
    </div>
  );
}

function LibrarySegmentButton({
  icon: Icon,
  label,
  active,
  onClick,
}: {
  icon: LucideIcon;
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className="surface-etched flex items-center justify-center gap-2 py-2.5"
      style={
        active
          ? {
              borderColor: 'rgb(var(--brand))',
              boxShadow:
                'inset 0 1px 0 rgb(var(--surface-plate-top)), inset 0 -1px 0 rgba(0,0,0,0.18), 0 0 0 1px rgba(var(--brand) / 0.35)',
              color: 'rgb(var(--ink-primary))',
            }
          : { color: 'rgb(var(--ink-secondary))' }
      }
    >
      <Icon size={15} strokeWidth={2} />
      <span className="text-sm font-medium">{label}</span>
    </button>
  );
}

// Overview action band. Lists the asset's authored procedures as
// large tap targets so a tech who just scanned the QR has a one-tap
// entry into "how do I work on this thing right now?" without
// browsing Library. Rendered as null when there's nothing to show so
// the Overview tab stays clean for unconfigured assets.
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
          .slice(0, 6);
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
    <section aria-label="Procedures" className="flex flex-col gap-2">
      <div className="cap px-1">Procedures</div>
      <div className="action-band-list">
        {procs.map((p) => (
          <button
            key={p.id}
            type="button"
            onClick={() => onLaunch(p.id)}
            className="action-row"
          >
            <span className="action-row-icon">
              <ListChecks size={18} strokeWidth={2} />
            </span>
            <span className="action-row-body">
              <span className="action-row-title">{p.title}</span>
              <span className="action-row-sub">Run procedure</span>
            </span>
            <Play size={16} strokeWidth={2.25} className="action-row-play" />
          </button>
        ))}
      </div>
    </section>
  );
}

// Identity band — Overview hero. Full-bleed asset photo with title +
// model code + serial overlaid on a dark gradient. When no photo is
// configured, falls back to a plate surface with corner marks so the
// surface still reads as an ID plate (not an empty box). This
// replaced the prior multi-row "milled aluminum nameplate" which
// stacked status LEDs + customer caption + photo + metrics — those
// pieces live in the topbar and StatusStrip now.
function IdentityBand({ hub }: { hub: AssetHubPayload }) {
  return (
    <header className="identity-band" aria-label="Asset identity">
      {hub.assetModel.imageUrl ? (
        <ImageZoom
          src={hub.assetModel.imageUrl}
          alt={hub.assetModel.displayName}
          triggerLabel={`Enlarge ${hub.assetModel.displayName} photo`}
        >
          <img
            src={hub.assetModel.imageUrl}
            alt=""
            className="identity-band-image"
          />
        </ImageZoom>
      ) : (
        <div className="identity-band-placeholder">
          <span className="corner-mark tl" />
          <span className="corner-mark tr" />
          <span className="corner-mark bl" />
          <span className="corner-mark br" />
        </div>
      )}
      <div className="identity-band-overlay">
        <h1 className="identity-band-title">{hub.assetModel.displayName}</h1>
        <div className="identity-band-meta">
          <span>{hub.assetModel.modelCode}</span>
          <span className="sep">·</span>
          <span>
            S/N <span className="serial">{hub.assetInstance.serialNumber}</span>
          </span>
        </div>
      </div>
    </header>
  );
}

// Status strip — one-row dashboard readout sitting between the
// identity band and the action band. Open WO / PM Due / Rev /
// Installed. Open WO and PM Due are tappable when their counts > 0
// and route the tech to the appropriate tab.
//
// PM Due reconciles with the Maintenance tab: the server-side
// hub.tabs.pm.needsAction only counts PmSchedule rows, while
// Maintenance's "Action" count merges both PmSchedule.needsAction
// and PmPlanBucket overdue/due statuses. Without this client-side
// fetch the Overview would show "PM DUE 0" while Maintenance shows
// several overdue plan-bucket items — bad signal for a tech making
// a stop/work decision.
function StatusStrip({
  hub,
  openIssueCount,
  onOpenMaintenance,
}: {
  hub: AssetHubPayload;
  openIssueCount: number;
  onOpenMaintenance: () => void;
}) {
  // Seed from the server payload so first paint shows something
  // sensible; replace with the merged client count once the
  // additional plan-status fetch resolves.
  const [pmAction, setPmAction] = useState<number>(hub.tabs.pm.needsAction);
  const [pmOverdue, setPmOverdue] = useState<number>(hub.tabs.pm.overdue);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [flat, plans] = await Promise.all([
          fetchPmStatus(hub.assetInstance.id),
          fetchPmPlanStatus(hub.assetInstance.id),
        ]);
        if (cancelled) return;
        const scheduleAction = flat.schedules.filter((s) => s.needsAction)
          .length;
        const scheduleOverdue = flat.schedules.filter(
          (s) => s.status === 'overdue',
        ).length;
        let bucketAction = 0;
        let bucketOverdue = 0;
        for (const p of plans.plans) {
          for (const b of p.buckets) {
            if (b.status === 'overdue' || b.status === 'due') bucketAction += 1;
            if (b.status === 'overdue') bucketOverdue += 1;
          }
        }
        setPmAction(scheduleAction + bucketAction);
        setPmOverdue(scheduleOverdue + bucketOverdue);
      } catch {
        // Fall through to the server-seeded counts — non-fatal.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [hub.assetInstance.id]);

  const woTone =
    openIssueCount > 0 ? 'warn' : ('ok' as 'warn' | 'ok' | 'fault' | 'muted');
  const pmTone: 'warn' | 'ok' | 'fault' | 'muted' =
    pmAction === 0 ? 'ok' : pmOverdue > 0 ? 'fault' : 'warn';

  return (
    <div className="status-strip" aria-label="Asset status">
      <StatusCell cap="Open WO" value={String(openIssueCount)} tone={woTone} />
      <StatusCell
        cap="PM Due"
        value={String(pmAction)}
        tone={pmTone}
        onClick={pmAction > 0 ? onOpenMaintenance : undefined}
      />
      <StatusCell
        cap="Rev"
        value={hub.pinnedContentPackVersion?.versionLabel ?? '—'}
        tone="muted"
      />
      <StatusCell
        cap="Installed"
        value={formatInstalledAt(hub.assetInstance.installedAt)}
        tone="muted"
      />
    </div>
  );
}

function StatusCell({
  cap,
  value,
  tone,
  onClick,
}: {
  cap: string;
  value: string;
  tone: 'ok' | 'warn' | 'fault' | 'muted';
  onClick?: () => void;
}) {
  const valClass = `status-strip-val ${tone}`;
  const inner = (
    <>
      <span className="status-strip-cap">{cap}</span>
      <span className={valClass}>{value}</span>
    </>
  );
  if (onClick) {
    return (
      <button type="button" onClick={onClick} className="status-strip-cell">
        {inner}
      </button>
    );
  }
  return <div className="status-strip-cell">{inner}</div>;
}

// Collapsible spec grid. Reference info (model code, site, customer,
// installed date) lives behind a chevron so the Overview surface
// stays focused on action — none of these change during a service
// call. Defaults closed.
function DetailsDisclosure({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="details-disclosure" data-open={open}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="details-disclosure-summary"
      >
        Details
        <ChevronDown
          size={12}
          strokeWidth={2.5}
          className="details-disclosure-chevron"
        />
      </button>
      {open && <div className="details-disclosure-content">{children}</div>}
    </div>
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
