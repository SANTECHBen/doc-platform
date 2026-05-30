'use client';

import { useEffect, useState, useCallback } from 'react';
import {
  CalendarClock,
  ChevronDown,
  FileText,
  GraduationCap,
  Home,
  Library,
  MessageSquare,
  Plus,
  Wrench,
  type LucideIcon,
} from 'lucide-react';
import type { AssetHubPayload } from '@/lib/shared-schema';
import { DocsTab } from './docs-tab';
import { ChatTab } from './chat-tab';
import { TrainingTab } from './training-tab';
import { PartInspector } from './parts-tab';
import { IssuesPanel } from './issues-panel';
import { MaintenanceTab } from './maintenance-tab';
import { VirtualJobAid, type JobAidSource } from '@/components/virtual-job-aid';
import { VoiceSearch } from '@/components/voice-search';
import { ImageZoom } from '@/components/image-zoom';
import { CreateProcedureSheet } from '@/components/create-procedure-sheet';
import { SegmentCard } from '@/components/segment-card';
import { ProcedureDocWizard } from '@/components/procedure-runner/procedure-doc-wizard';
import { VideoSubmission } from '@/components/video-submission';
import { AuthPrompt } from '@/components/auth-prompt';
import { listParts, type BomEntry } from '@/lib/api';

const DEV_USER_ID = process.env.NEXT_PUBLIC_DEV_USER_ID ?? '';
const DEV_ORG_ID = process.env.NEXT_PUBLIC_DEV_ORG_ID ?? '';

type TabKey = 'home' | 'library' | 'maintenance' | 'chat';

// Four bottom tabs plus a raised center "+" FAB that opens the create-
// procedure sheet. Order matches a tech's typical workflow on a scan:
// glance at the asset (Home, which carries the asset photo + parts +
// open issues), check what's due (Maintenance), capture work in
// progress via the +, read reference material (Library), ask the
// assistant last. The FAB is rendered between Maintenance and Library
// in the bottom bar.
const TABS: Array<{ key: TabKey; label: string; icon: LucideIcon }> = [
  { key: 'home', label: 'Home', icon: Home },
  { key: 'maintenance', label: 'Maintenance', icon: CalendarClock },
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
  // Back-compat: #overview is the prior name of #home. #parts no longer
  // exists as a destination — parts live on Home now. Bookmarks /
  // dispatched events still route through here, so both fold back to
  // Home rather than 404.
  if (h === 'overview' || h === 'parts') return { tab: 'home' };
  if ((TAB_KEYS as string[]).includes(h)) {
    return { tab: h as TabKey };
  }
  return null;
}

// Filter keys the Maintenance tab understands — names the browse rows
// the Overview tile can deep-link into. The tab also accepts the
// legacy 'action' / 'walkthroughs' / 'removal' strings via its own
// LEGACY_FILTER_MAP, but new callers should use the current four.
type MaintenanceFilter =
  | 'scheduled'
  | 'pm'
  | 'removal'
  | 'troubleshoot'
  | 'history';

export function AssetHubTabs({ hub, qrCode }: { hub: AssetHubPayload; qrCode: string }) {
  const [active, setActive] = useState<TabKey>('home');
  const [librarySection, setLibrarySection] = useState<LibrarySection>('documents');
  const [openIssueCount, setOpenIssueCount] = useState<number>(hub.tabs.openWorkOrders.count);
  // One-shot preselect for the Maintenance tab. Consumed on the next
  // MaintenanceTab mount (the tab pane is keyed on `active`, so it
  // remounts on every tab switch). Cleared after consumption so a
  // subsequent return to Maintenance opens with no slice selected.
  const [pendingMaintenanceFilter, setPendingMaintenanceFilter] =
    useState<MaintenanceFilter | null>(null);
  // When a tech taps a part chip (from Overview or the Parts tab list)
  // we swap the active tab's content with PartInspector — which renders
  // inline, so the bottom TabBar stays visible and the tech keeps the
  // same nav as the rest of the app. Tapping any main tab in the bottom
  // bar clears this and shows the chosen tab normally.
  const [inspectingPartId, setInspectingPartId] = useState<string | null>(null);
  // VirtualJobAid mount for procedures launched from the Overview quick
  // actions card OR from the Maintenance tab (PM bucket → inline steps,
  // troubleshooting row → inline steps, scheduled procedure → docId).
  // The Assistant tab's VoiceMode owns its own handoff for AI-emitted
  // [procedure:UUID] directives and never writes here.
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

  // Center "+" FAB → CreateProcedureSheet → one of two authoring flows.
  // Hoisted to this top-level component so the FAB works from any tab
  // (the previous in-Maintenance buttons only worked while the tech was
  // on the Maintenance tab). Both overlays are full-screen self-contained
  // — they sit above the tabbar and the topbar via their own z-index.
  const [createSheetOpen, setCreateSheetOpen] = useState(false);
  const [manualAuthoringOpen, setManualAuthoringOpen] = useState(false);
  const [videoSubmissionOpen, setVideoSubmissionOpen] = useState(false);
  // Auth gate — both authoring flows require an identified user (they
  // create persistent server-side artifacts). When the dev IDs are
  // missing we open AuthPrompt instead of the flow itself; the prompt
  // explains why and points to sign-in.
  const [authPromptOpen, setAuthPromptOpen] = useState(false);
  function openCreate(mode: 'ai' | 'manual') {
    setCreateSheetOpen(false);
    if (!DEV_USER_ID || !DEV_ORG_ID) {
      setAuthPromptOpen(true);
      return;
    }
    if (mode === 'ai') setVideoSubmissionOpen(true);
    else setManualAuthoringOpen(true);
  }
  useEffect(() => {
    const onOpen = () => setVoiceSearchOpen(true);
    window.addEventListener('asset-hub:open-search', onOpen);
    return () => window.removeEventListener('asset-hub:open-search', onOpen);
  }, []);

  // Hydrate the active tab from the URL hash on mount so deep links
  // (`#docs`) land on the right tab. Then keep the hash in sync as the
  // tech moves around — and, critically, push a real history entry on
  // tab change so the device's back button steps through tabs instead of
  // immediately popping out to the QR scanner.
  useEffect(() => {
    const initial = readTabFromHash();
    if (initial && initial.tab !== 'home') {
      setActive(initial.tab);
      if (initial.library) setLibrarySection(initial.library);
    }
    function onPop() {
      const fromHash = readTabFromHash();
      setActive(fromHash?.tab ?? 'home');
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
      // Home is the canonical "no hash" state.
      const url = new URL(window.location.href);
      url.hash = next === 'home' ? '' : next;
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

  return (
    <>
      <TabBar
        hub={hub}
        active={active}
        setActive={changeTab}
        position="top"
        onCreateTap={() => setCreateSheetOpen(true)}
      />

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
        ) : active === 'home' ? (
          <div className="flex flex-col gap-4">
            <IdentityBand hub={hub} />
            {/* Tiles + Details disclosure stack as a single visual block
                — the bottom of the tile card and the top of the
                disclosure share an edge (no double border, no gap), so
                the chevron reads as part of the action summary rather
                than a separate card below it. */}
            <div className="overview-action-stack">
              <OverviewActionSummary
                hub={hub}
                openIssueCount={openIssueCount}
                onOpenMaintenanceAction={() => {
                  // Overview's PM-due tile lands the tech on Maintenance
                  // with the Scheduled queue open — the hero already
                  // promotes the single most-urgent item; opening
                  // Scheduled gives them the full list.
                  setPendingMaintenanceFilter('scheduled');
                  changeTab('maintenance');
                }}
              />
              <DetailsDisclosure
                preview={
                  <>
                    <span className="details-disclosure-preview-mono">
                      SN {hub.assetInstance.serialNumber}
                    </span>
                    {hub.assetInstance.installedAt && (
                      <>
                        <span className="details-disclosure-preview-sep" aria-hidden>
                          ·
                        </span>
                        <span>
                          Installed {formatInstalledAt(hub.assetInstance.installedAt)}
                        </span>
                      </>
                    )}
                  </>
                }
              >
                <OverviewSpecs hub={hub} openIssueCount={openIssueCount} />
              </DetailsDisclosure>
            </div>
            <IssuesPanel assetInstanceId={hub.assetInstance.id} onCountChange={setOpenIssueCount} />
            <PartsQuickActions
              assetModelId={hub.assetModel.id}
              onOpenPart={(partId) => setInspectingPartId(partId)}
            />
          </div>
        ) : active === 'library' ? (
          /* Library renders directly into the scroll region — its
             segmented control + filter chips + list rows already carry
             their own structure and don't need a surrounding raised
             panel. */
          <LibraryTab hub={hub} qrCode={qrCode} section={librarySection} onSectionChange={setLibrarySection} />
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
            {active === 'chat' && <ChatTab hub={hub} qrCode={qrCode} />}
          </section>
        )}
      </div>

      <TabBar
        hub={hub}
        active={active}
        setActive={changeTab}
        position="bottom"
        onCreateTap={() => setCreateSheetOpen(true)}
      />

      {/* VirtualJobAid mount for procedures + synthesized step lists
          launched from Overview quick-actions or the Maintenance tab.
          The Assistant tab owns its own VoiceMode + VirtualJobAid mounts
          for [procedure:UUID] handoffs from AI chat; the two never
          overlap because jobAidRequest is local to this hub state. */}
      {jobAidRequest && DEV_USER_ID && DEV_ORG_ID && (
        <VirtualJobAid
          source={jobAidRequest.source}
          initialStepId={jobAidRequest.initialStepId}
          onClose={({ completed }) => {
            if (completed) jobAidRequest.onCompleted?.();
            setJobAidRequest(null);
          }}
        />
      )}

      {/* Create-procedure bottom sheet, opened by the center "+" FAB.
          Two tiles: AI walkthrough (VideoSubmission) and Manual
          procedure (ProcedureDocWizard). Both flows require auth — if
          missing, openCreate routes through the AuthPrompt instead. */}
      <CreateProcedureSheet
        open={createSheetOpen}
        onClose={() => setCreateSheetOpen(false)}
        onPick={openCreate}
      />

      {/* Manual procedure capture — full-screen wizard the tech walks
          through step by step. Self-contained (uses FullScreenShell);
          mounts above everything when open. */}
      {manualAuthoringOpen && DEV_USER_ID && DEV_ORG_ID && (
        <ProcedureDocWizard
          assetInstanceId={hub.assetInstance.id}
          devUserId={DEV_USER_ID}
          devOrgId={DEV_ORG_ID}
          onClose={() => setManualAuthoringOpen(false)}
        />
      )}

      {/* AI walkthrough video submission — full-screen camera + upload
          panel. The drafter slices the upload into per-step proposals
          for an admin reviewer; the tech doesn't see those here. */}
      {videoSubmissionOpen && DEV_USER_ID && DEV_ORG_ID && (
        <VideoSubmission
          assetInstanceId={hub.assetInstance.id}
          devUserId={DEV_USER_ID}
          devOrgId={DEV_ORG_ID}
          onClose={() => setVideoSubmissionOpen(false)}
        />
      )}

      {authPromptOpen && (
        <AuthPrompt
          reason="document a procedure"
          onClose={() => setAuthPromptOpen(false)}
        />
      )}

      {/* Voice search is launched from the topbar (search icon) — not a
          floating FAB — so it never covers content. The topbar dispatches
          `asset-hub:open-search`; the listener below opens the overlay. */}
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
  qrCode,
  section,
  onSectionChange,
}: {
  hub: AssetHubPayload;
  qrCode: string;
  section: LibrarySection;
  onSectionChange: (s: LibrarySection) => void;
}) {
  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-2 gap-2">
        <SegmentCard
          icon={FileText}
          label="Documents"
          active={section === 'documents'}
          onClick={() => onSectionChange('documents')}
        />
        <SegmentCard
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
        <TrainingTab hub={hub} qrCode={qrCode} />
      )}
    </div>
  );
}

// Overview action summary — two status counts (Open work orders + PM
// actions due) that share the same "needs attention now" purpose.
// Docs/training used to live here as a third tile but didn't fit the
// urgency model and competed with the Parts section below; techs reach
// Library via the bottom tab. The Open work orders tile stays
// non-interactive because the WO list renders right below on the same
// page — there's nowhere meaningful to navigate to.
function OverviewActionSummary({
  hub,
  openIssueCount,
  onOpenMaintenanceAction,
}: {
  hub: AssetHubPayload;
  openIssueCount: number;
  onOpenMaintenanceAction: () => void;
}) {
  const pmNeedsAction = hub.tabs.pm.needsAction;
  return (
    <section className="overview-action-summary" aria-label="Asset status">
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
    <section aria-label="Parts and procedures" className="flex flex-col gap-2">
      {/* Section header — sentence-case sans-serif, sits visually with
          the card below it. Tighter spacing (gap-2) groups header to
          content; the previous tiny-caption treatment read as a label
          orphan with too much daylight above the list. The "and
          procedures" suffix surfaces that each part's detail page is
          also the entry point to its linked procedures (a discovery
          path techs were missing under the bare "Parts" label). */}
      <h2 className="section-heading">Parts and procedures</h2>
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
function DetailsDisclosure({
  children,
  preview,
}: {
  children: React.ReactNode;
  /** Optional muted snippet shown to the right of "Details" when the
   *  disclosure is closed — fills what would otherwise be empty space
   *  on a full-width row with the most-asked-about facts (typically
   *  serial + installed date). Hidden when the disclosure is open
   *  since the full content is visible below. */
  preview?: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="details-disclosure" data-open={open}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="details-disclosure-summary"
      >
        <span className="details-disclosure-label">Details</span>
        {!open && preview && (
          <span className="details-disclosure-preview" aria-hidden="true">
            {preview}
          </span>
        )}
        <ChevronDown size={12} strokeWidth={2.5} className="details-disclosure-chevron" />
      </button>
      {open && <div className="details-disclosure-content">{children}</div>}
    </div>
  );
}

function TabBar({
  hub: _hub,
  active,
  setActive,
  position,
  onCreateTap,
}: {
  hub: AssetHubPayload;
  active: TabKey;
  setActive: (k: TabKey) => void;
  position: 'top' | 'bottom';
  /** Center "+" FAB tap handler. Renders only on the bottom bar — the
   *  top bar uses the four flat tabs without an authoring entry point
   *  because the FAB needs to sit on top of content, which only the
   *  bottom bar guarantees. */
  onCreateTap?: () => void;
}) {
  const className = `app-tabbar ${position === 'top' ? 'app-tabbar-top' : 'app-tabbar-bottom'}`;
  // YouTube layout: two flat tabs, then the raised FAB, then the
  // remaining flat tabs. Split the tab list at the midpoint and
  // interleave the FAB in the bottom bar. The top bar keeps a simple
  // four-flat-tab layout (no FAB) to avoid duplicating the prominent
  // create affordance.
  const half = Math.ceil(TABS.length / 2);
  const lead = TABS.slice(0, half);
  const tail = TABS.slice(half);
  const renderTab = (t: (typeof TABS)[number]) => {
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
  };
  if (position === 'bottom' && onCreateTap) {
    return (
      <nav className={className} role="tablist" aria-label="Sections">
        {lead.map(renderTab)}
        {/* The FAB sits inside an equal-flex slot so it occupies the same
            horizontal share as each flat tab — that's what keeps it on
            exact screen center, even when neighboring labels have
            different widths. The visible circle is sized independently
            and centered within the slot. */}
        <span className="app-tabbar-fab-slot">
          <button
            type="button"
            onClick={onCreateTap}
            className="app-tabbar-fab"
            aria-label="Document a procedure"
          >
            <Plus size={20} strokeWidth={2.5} />
          </button>
        </span>
        {tail.map(renderTab)}
      </nav>
    );
  }
  return (
    <nav className={className} role="tablist" aria-label="Sections">
      {TABS.map(renderTab)}
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
  // Mirrors the DESCRIPTION block on the OEM drawing — same order, same
  // labels (Conveyor, Length, Flow rate, Speed, Manufacturer, Serial #,
  // Model #, Location). Drawing-spec values (Conveyor/Length/Flow
  // rate/Speed) are authored on the asset model in the admin
  // (Edit drawer → Drawing specs); Location is per-instance, authored
  // from the asset model's instance row → Edit. Empty values render as
  // an em-dash so the row is still visible and prompts authoring.
  // Operational context (Site, Customer, Open issues, Installed) is
  // appended below — useful to the tech but not on the drawing.
  const specs = hub.assetModel.specifications ?? {};
  const location = hub.assetInstance.location;
  const dash = '—';
  return (
    <div className="spec-grid">
      <SpecField label="Conveyor" value={specs.conveyor || dash} />
      <SpecField label="Length" value={specs.length || dash} mono />
      <SpecField label="Flow rate" value={specs.flowRate || dash} mono />
      <SpecField label="Speed" value={specs.speed || dash} mono />
      <SpecField label="Manufacturer" value={hub.brand.displayName} />
      <SpecField label="Serial #" value={hub.assetInstance.serialNumber} mono brand />
      <SpecField label="Model #" value={hub.assetModel.modelCode} mono />
      <SpecField label="Location" value={location || dash} mono />
      {/* EPN is optional — many installs don't carry one. Only render
          the row when authored so the grid doesn't pad with em-dashes. */}
      {hub.assetInstance.epn && (
        <SpecField label="EPN" value={hub.assetInstance.epn} mono />
      )}
      <SpecField label="Site" value={hub.site.name} />
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
