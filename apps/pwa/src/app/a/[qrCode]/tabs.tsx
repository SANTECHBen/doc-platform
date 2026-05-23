'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import {
  CalendarClock,
  ChevronDown,
  FileText,
  GraduationCap,
  LayoutGrid,
  Library,
  MessageSquare,
  Wrench,
  type LucideIcon,
} from 'lucide-react';
import type { AssetHubPayload } from '@/lib/shared-schema';
import { DocsTab } from './docs-tab';
import { ChatTab } from './chat-tab';
import { TrainingTab } from './training-tab';
import { PartInspector, PartsTab } from './parts-tab';
import { IssuesPanel } from './issues-panel';
import { MaintenanceTab } from './maintenance-tab';
import { VoiceMode, type PrefetchedGreeting } from '@/components/voice-mode';
import { VirtualJobAid, type JobAidSource } from '@/components/virtual-job-aid';
import { ModeChooser, type ChosenMode } from '@/components/mode-chooser';
import { VoiceSearch } from '@/components/voice-search';
import { ImageZoom } from '@/components/image-zoom';
import { fetchPreflight, listParts, speak, type BomEntry } from '@/lib/api';

const DEV_USER_ID = process.env.NEXT_PUBLIC_DEV_USER_ID ?? '';
const DEV_ORG_ID = process.env.NEXT_PUBLIC_DEV_ORG_ID ?? '';

type TabKey = 'overview' | 'library' | 'parts' | 'maintenance' | 'chat';

// Order matches a tech's typical workflow on a scan: glance at the
// asset (Overview), check what's due (Maintenance), look up a part
// (Parts), read reference material (Library), and ask the assistant
// last. Bottom tabbar reads left-to-right in priority order.
const TABS: Array<{ key: TabKey; label: string; icon: LucideIcon }> = [
  { key: 'overview', label: 'Overview', icon: LayoutGrid },
  { key: 'maintenance', label: 'Maintenance', icon: CalendarClock },
  { key: 'parts', label: 'Parts', icon: Wrench },
  { key: 'library', label: 'Library', icon: Library },
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

// Filter keys the Maintenance tab understands. Kept in sync with its
// internal FilterKey union — when Overview deep-links into Maintenance
// (PM-due tile → 'action'), we seed the tab's initial selection.
type MaintenanceFilter = 'action' | 'upcoming' | 'walkthroughs' | 'removal' | 'troubleshoot' | 'history';

export function AssetHubTabs({ hub, qrCode }: { hub: AssetHubPayload; qrCode: string }) {
  const [active, setActive] = useState<TabKey>('overview');
  const [librarySection, setLibrarySection] = useState<LibrarySection>('documents');
  const [openIssueCount, setOpenIssueCount] = useState<number>(hub.tabs.openWorkOrders.count);
  // One-shot preselect for the Maintenance tab. Consumed on the next
  // MaintenanceTab mount (the tab pane is keyed on `active`, so it
  // remounts on every tab switch). Cleared after consumption so a
  // subsequent return to Maintenance opens with no slice selected.
  const [pendingMaintenanceFilter, setPendingMaintenanceFilter] =
    useState<MaintenanceFilter | null>(null);
  const [mode, setMode] = useState<Mode>(DEV_USER_ID && DEV_ORG_ID ? 'choosing' : 'browse');
  const [voiceOpen, setVoiceOpen] = useState(false);
  // When a tech taps a part chip (from Overview or the Parts tab list)
  // we swap the active tab's content with PartInspector — which renders
  // inline, so the bottom TabBar stays visible and the tech keeps the
  // same nav as the rest of the app. Tapping any main tab in the bottom
  // bar clears this and shows the chosen tab normally.
  const [inspectingPartId, setInspectingPartId] = useState<string | null>(null);
  // VirtualJobAid mount for procedures launched from the Overview quick
  // actions card OR from the Maintenance tab (PM bucket → inline steps,
  // troubleshooting row → inline steps, scheduled procedure → docId).
  // Voice mode owns its own handoff and never writes here.
  const [jobAidRequest, setJobAidRequest] = useState<{
    source: JobAidSource;
    onCompleted?: () => void;
    /** When set, VirtualJobAid mounts at this step instead of the intro.
     *  Wired from voice-search jump targets so the tech lands at the
     *  matched step directly. */
    initialStepId?: string;
  } | null>(null);
  // Voice-search overlay state. Distinct from voice mode (chat) — search
  // returns ranked results + a spoken preview, not a streamed answer.
  // Opened by the topbar's magnifier button via a window event so the
  // server-rendered topbar stays decoupled from this client tree.
  const [voiceSearchOpen, setVoiceSearchOpen] = useState(false);
  useEffect(() => {
    const onOpen = () => {
      // Don't reopen while voice assistant owns the screen — they'd
      // fight over the mic.
      if (mode === 'voice') return;
      setVoiceSearchOpen(true);
    };
    window.addEventListener('asset-hub:open-search', onOpen);
    return () => window.removeEventListener('asset-hub:open-search', onOpen);
  }, [mode]);

  // Prefetch the greeting (preflight + TTS blob) the moment the chooser
  // is up, so tapping Hands-Free starts speaking ~immediately rather than
  // waiting on a serial round-trip to OpenAI TTS. We accept that ~half of
  // chooser displays will end up picking Browse and discarding the audio
  // — the per-greeting cost is ~$0.003 and the perceived-latency win is
  // significant. Stored as a promise so VoiceMode can await it.
  const greetingPrefetchRef = useRef<Promise<PrefetchedGreeting | null> | null>(null);

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
    // Topbar fires this when the brand mark is tapped (goHome). Re-read
    // the hash so we sync to Overview without requiring the user to use
    // the phone's back button.
    window.addEventListener('asset-hub:tab', onPop);
    return () => {
      window.removeEventListener('popstate', onPop);
      window.removeEventListener('asset-hub:tab', onPop);
    };
  }, []);

  const changeTab = useCallback((next: TabKey) => {
    setActive((prev) => {
      if (prev === next) return prev;
      // Update history so phone back button returns to the previous tab.
      // Overview is the canonical "no hash" state.
      const url = new URL(window.location.href);
      url.hash = next === 'overview' ? '' : next;
      window.history.pushState({ tab: next }, '', url.toString());
      // history.pushState() does NOT fire popstate/hashchange. The topbar
      // listens for this custom event so its brand/asset-chip swap stays
      // in sync without each consumer hand-rolling a polling check.
      window.dispatchEvent(new Event('asset-hub:tab'));
      return next;
    });
    // Any explicit tab change dismisses the inline part inspector — the
    // tech asked to go somewhere else, the part panel was situational.
    setInspectingPartId(null);
    // Clear the one-shot Maintenance preselect once the tech navigates
    // away from Maintenance — a manual re-tap of the Maintenance tab
    // should land on the empty-card grid, not whatever Overview pushed
    // last time.
    if (next !== 'maintenance') setPendingMaintenanceFilter(null);
  }, []);

  if (mode === 'choosing' && DEV_USER_ID && DEV_ORG_ID) {
    return (
      <ModeChooser
        assetName={hub.assetModel.displayName}
        onPick={pickMode}
      />
    );
  }

  return (
    <>
      <TabBar hub={hub} active={active} setActive={changeTab} position="top" />

      <div key={inspectingPartId ?? active} className="tab-pane flex flex-col gap-4">
        {inspectingPartId ? (
          // Inline part view — replaces the active tab's body but the
          // bottom TabBar stays visible. Same nav as the rest of the app;
          // tapping any bottom tab clears this and shows that tab.
          <PartInspector
            partId={inspectingPartId}
            hub={hub}
            qrCode={qrCode}
            onBack={() => setInspectingPartId(null)}
          />
        ) : active === 'overview' ? (
          <div className="flex flex-col gap-4">
            <IdentityBand hub={hub} />
            <OverviewActionSummary
              hub={hub}
              openIssueCount={openIssueCount}
              onOpenMaintenanceAction={() => {
                setPendingMaintenanceFilter('action');
                changeTab('maintenance');
              }}
              onOpenLibrary={() => {
                setLibrarySection('documents');
                changeTab('library');
              }}
            />
            <IssuesPanel assetInstanceId={hub.assetInstance.id} onCountChange={setOpenIssueCount} />
            <PartsQuickActions
              assetModelId={hub.assetModel.id}
              onOpenPart={(partId) => setInspectingPartId(partId)}
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
          <LibraryTab hub={hub} section={librarySection} onSectionChange={setLibrarySection} />
        ) : active === 'maintenance' ? (
          <MaintenanceTab
            assetInstanceId={hub.assetInstance.id}
            versionId={hub.pinnedContentPackVersion?.id ?? null}
            fieldCapturesVersionId={hub.fieldCapturesVersionId ?? null}
            onLaunchJobAid={(source, onCompleted) => setJobAidRequest({ source, onCompleted })}
            {...(pendingMaintenanceFilter
              ? { initialFilter: pendingMaintenanceFilter }
              : {})}
          />
        ) : (
          <section className="rounded-md border border-line bg-surface-raised p-4 md:p-6">
            {active === 'parts' && (
              <PartsTab
                hub={hub}
                qrCode={qrCode}
                onInspectPart={(partId) => setInspectingPartId(partId)}
              />
            )}
            {active === 'chat' && <ChatTab hub={hub} qrCode={qrCode} />}
          </section>
        )}
      </div>

      <TabBar hub={hub} active={active} setActive={changeTab} position="bottom" />

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
                  conversationId: conversationId ?? existing?.conversationId,
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
          initialStepId={jobAidRequest.initialStepId}
          onClose={({ completed }) => {
            if (completed) jobAidRequest.onCompleted?.();
            setJobAidRequest(null);
          }}
        />
      )}

      {/* Voice search is launched from the topbar (search icon) — not a
          floating FAB — so it never covers content and it sits visually
          apart from the post-scan Voice assistant mode. The topbar
          dispatches `asset-hub:open-search`; the listener below opens
          the overlay. We don't reopen during voice mode (voice already
          owns the screen) or while the chooser is up. */}
      {voiceSearchOpen && (
        <VoiceSearch
          assetInstanceId={hub.assetInstance.id}
          onClose={() => setVoiceSearchOpen(false)}
          onJump={(result) => {
            setVoiceSearchOpen(false);
            if (!result.jumpTarget) return;
            if (result.jumpTarget.kind === 'jobaid' && DEV_USER_ID && DEV_ORG_ID) {
              setJobAidRequest({
                source: {
                  kind: 'doc',
                  docId: result.jumpTarget.docId,
                  devUserId: DEV_USER_ID,
                  devOrgId: DEV_ORG_ID,
                },
                initialStepId: result.jumpTarget.initialStepId,
              });
              return;
            }
            // doc + section jumps route to the Library tab; the existing
            // SectionViewerOverlay flow inside the voice-mode handler is
            // tuned for hands-free chat. For v1 we surface a fallback that
            // navigates to the Library tab and the user can click through
            // — a future iteration can mount SectionViewerOverlay directly.
            const params = new URLSearchParams();
            params.set('docId', result.jumpTarget.docId);
            if (result.jumpTarget.kind === 'section') {
              params.set('sectionId', result.jumpTarget.sectionId);
            }
            window.location.hash = `library?${params.toString()}`;
            changeTab('library');
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

// Overview action band — top parts list. A tech scanning the QR
// usually wants to look up a specific part on the equipment (PN
// match for a sticker, find a sub-assembly to inspect). Surface the
// BOM here as a one-tap entry instead of authored procedures —
// procedures live in Maintenance, parts get the prime real estate.
//
// The PM-due and Docs tiles are tappable shortcuts into the
// Maintenance/Action slice and Library tab respectively. The Open
// work orders tile stays non-interactive because the WO list itself
// renders right below the summary on the same Overview page — there's
// nowhere meaningful to navigate to.
function OverviewActionSummary({
  hub,
  openIssueCount,
  onOpenMaintenanceAction,
  onOpenLibrary,
}: {
  hub: AssetHubPayload;
  openIssueCount: number;
  onOpenMaintenanceAction: () => void;
  onOpenLibrary: () => void;
}) {
  const pmNeedsAction = hub.tabs.pm.needsAction;
  const docCount = hub.tabs.docs.count + hub.tabs.training.count;
  return (
    <section className="overview-action-summary" aria-label="Asset status">
      <div className="overview-action-summary-head">
        <span className="overview-action-summary-head-label">Today at</span>
        <span className="overview-action-summary-site">{hub.site.name}</span>
      </div>
      <div className="overview-action-summary-grid">
        <div
          className="overview-action-summary-item"
          // 'ok' = idle/safe (renders muted), 'warn' = needs attention now.
          // Only one color per surface — see overview-action-summary CSS.
          data-tone={openIssueCount > 0 ? 'warn' : 'ok'}
        >
          <span className="overview-action-summary-value">{openIssueCount}</span>
          <span className="overview-action-summary-label">
            {openIssueCount === 1 ? 'Open work order' : 'Open work orders'}
          </span>
        </div>
        <button
          type="button"
          onClick={onOpenMaintenanceAction}
          className="overview-action-summary-item overview-action-summary-item-button"
          data-tone={pmNeedsAction > 0 ? 'warn' : 'ok'}
          aria-label={
            pmNeedsAction === 1
              ? 'Open Maintenance — 1 PM due now'
              : `Open Maintenance — ${pmNeedsAction} PM actions due`
          }
        >
          <span className="overview-action-summary-value">{pmNeedsAction}</span>
          <span className="overview-action-summary-label">
            {pmNeedsAction === 1 ? 'PM due now' : 'PM actions due'}
          </span>
        </button>
        <button
          type="button"
          onClick={onOpenLibrary}
          className="overview-action-summary-item overview-action-summary-item-button"
          // Reference data — never urgent. Render as neutral primary ink
          // (no data-tone), so it doesn't compete with the urgency cells.
          aria-label={`Open Library — ${docCount} docs and training`}
        >
          <span className="overview-action-summary-value">{docCount}</span>
          <span className="overview-action-summary-label">Docs and training</span>
        </button>
      </div>
    </section>
  );
}

function PartsQuickActions({
  assetModelId,
  onOpenPart,
}: {
  assetModelId: string;
  onOpenPart: (partId: string) => void;
}): React.ReactElement | null {
  const [parts, setParts] = useState<BomEntry[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const rows = await listParts(assetModelId);
        if (cancelled) return;
        // Surface top-level structural items first (assemblies and
        // sub-assemblies sort above loose parts); cap at 6 so the
        // Overview doesn't drown in BOM rows. Full list is one tap
        // away in the Parts tab.
        const rank = (r: BomEntry) =>
          r.role === 'assembly' ? 0 : r.role === 'sub_assembly' ? 1 : 2;
        const top = rows
          .slice()
          .sort((a, b) => {
            const rd = rank(a) - rank(b);
            if (rd !== 0) return rd;
            return a.displayName.localeCompare(b.displayName, undefined, {
              sensitivity: 'base',
            });
          })
          .slice(0, 6);
        setParts(top);
      } catch {
        if (!cancelled) setParts([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [assetModelId]);

  if (!parts || parts.length === 0) return null;

  return (
    <section aria-label="Parts" className="flex flex-col gap-2">
      {/* Section header — sentence-case sans-serif, sits visually with
          the card below it. Tighter spacing (gap-2) groups header to
          content; the previous tiny-caption treatment read as a label
          orphan with too much daylight above the list. */}
      <h2 className="section-heading">Parts</h2>
      <div className="action-band-list">
        {parts.map((p) => {
          const partNumber = p.oemPartNumber?.trim();
          const showPartNumber =
            partNumber && partNumber.toLowerCase() !== p.displayName.trim().toLowerCase();
          return (
            <button
              key={p.partId}
              type="button"
              onClick={() => onOpenPart(p.partId)}
              className="action-row"
              aria-label={`Open ${p.displayName} part details`}
            >
              {p.imageUrl ? (
                <img src={p.imageUrl} alt="" className="action-row-thumb" />
              ) : (
                <span className="action-row-icon">
                  <Wrench size={18} strokeWidth={2} />
                </span>
              )}
              <span className="action-row-body">
                <span className="action-row-title">{p.displayName}</span>
                <span className="action-row-sub">
                  {showPartNumber ? `PN ${partNumber}` : formatRoleLabel(p.role)}
                </span>
              </span>
            </button>
          );
        })}
      </div>
    </section>
  );
}

function formatRoleLabel(role: BomEntry['role']): string {
  if (role === 'assembly') return 'Assembly';
  if (role === 'sub_assembly') return 'Sub-assembly';
  return 'Part';
}

// Identity band — Overview hero. Full-bleed asset photo with title +
// model code + serial overlaid on a dark gradient. When no photo is
// configured, falls back to a plate surface with corner marks so the
// surface still reads as an ID plate (not an empty box). This
// replaced the prior multi-row "milled aluminum nameplate" which
// stacked status LEDs + customer caption + photo + metrics — those
// pieces live in the topbar and StatusStrip now.
function IdentityBand({ hub }: { hub: AssetHubPayload }) {
  // Prefer the per-instance hero photo when authored — different units
  // at different sites can look distinct (paint scheme, attached
  // accessories, surrounding context). Falls back to the model SKU's
  // canonical photo when no override is set.
  const heroUrl = hub.assetInstance.imageUrl ?? hub.assetModel.imageUrl;
  return (
    <header className="identity-band" aria-label="Asset identity">
      {heroUrl ? (
        <ImageZoom
          src={heroUrl}
          alt={hub.assetModel.displayName}
          triggerLabel={`Enlarge ${hub.assetModel.displayName} photo`}
        >
          <img src={heroUrl} alt="" className="identity-band-image" />
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
          {/* Serial moved to the Details disclosure below — keeping it
              off the hero reduces the identity stack to model name +
              model code, which is what techs read at a glance. The
              serial is still one tap away when they need it. */}
          <span>{hub.assetModel.modelCode}</span>
        </div>
      </div>
    </header>
  );
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
        <ChevronDown size={12} strokeWidth={2.5} className="details-disclosure-chevron" />
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
  const className = `app-tabbar ${position === 'top' ? 'app-tabbar-top' : 'app-tabbar-bottom'}`;
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
            aria-current={isActive ? 'page' : undefined}
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

function OverviewSpecs({ hub, openIssueCount }: { hub: AssetHubPayload; openIssueCount: number }) {
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
      <SpecField label="Installed" value={formatInstalledAt(hub.assetInstance.installedAt)} />
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
