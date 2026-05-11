'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import {
  FileText,
  GraduationCap,
  LayoutGrid,
  MessageSquare,
  Wrench,
  type LucideIcon,
} from 'lucide-react';
import type { AssetHubPayload } from '@/lib/shared-schema';
import { DocsTab } from './docs-tab';
import { ChatTab } from './chat-tab';
import { TrainingTab } from './training-tab';
import { PartsTab } from './parts-tab';
import { IssuesPanel } from './issues-panel';
import { VoiceMode, type PrefetchedGreeting } from '@/components/voice-mode';
import { ModeChooser, type ChosenMode } from '@/components/mode-chooser';
import { TalkFab } from '@/components/talk-fab';
import { fetchPreflight, speak } from '@/lib/api';

const DEV_USER_ID = process.env.NEXT_PUBLIC_DEV_USER_ID ?? '';
const DEV_ORG_ID = process.env.NEXT_PUBLIC_DEV_ORG_ID ?? '';

type TabKey = 'overview' | 'docs' | 'training' | 'parts' | 'chat';

const TABS: Array<{ key: TabKey; label: string; icon: LucideIcon }> = [
  { key: 'overview', label: 'Overview', icon: LayoutGrid },
  { key: 'docs', label: 'Documents', icon: FileText },
  { key: 'training', label: 'Training', icon: GraduationCap },
  { key: 'parts', label: 'Parts', icon: Wrench },
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

  const compactNameplate = active !== 'overview';

  return (
    <>
      <Nameplate hub={hub} compact={compactNameplate} openIssueCount={openIssueCount} />

      <TabBar hub={hub} active={active} setActive={changeTab} position="top" />

      <div key={active} className="tab-pane flex flex-col gap-4">
        {active === 'overview' ? (
          <div className="flex flex-col gap-4">
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
            {active === 'chat' && <ChatTab hub={hub} qrCode={qrCode} />}
          </section>
        )}
      </div>

      <TabBar hub={hub} active={active} setActive={changeTab} position="bottom" />

      {/* Floating Talk pill — re-entry into voice mode after dismissal.
          Hidden on the chat tab (composer has its own mic icon) and while
          the voice overlay is already open. */}
      {mode === 'browse' && active !== 'chat' && !voiceOpen && DEV_USER_ID && DEV_ORG_ID && (
        <TalkFab
          onClick={() => {
            setMode('voice');
            setVoiceOpen(true);
          }}
        />
      )}

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
    </>
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
            <img
              src={hub.assetModel.imageUrl}
              alt=""
              className="nameplate-strip-thumb"
            />
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

      <div className="nameplate-row">
        {hub.assetModel.imageUrl && (
          <div
            className="nameplate-thumb"
            style={{
              width: 56,
              height: 56,
              borderRadius: 8,
              border: '1px solid rgb(var(--surface-plate-edge))',
              background: 'rgb(var(--surface-elevated))',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              flexShrink: 0,
              overflow: 'hidden',
              padding: 4,
            }}
          >
            <img
              src={hub.assetModel.imageUrl}
              alt=""
              style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }}
            />
          </div>
        )}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="nameplate-title">{hub.assetModel.displayName}</div>
          <div className="nameplate-meta">
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

        <div className="nameplate-metrics">
          <div className="nameplate-metric">
            <span className="cap">Rev</span>
            <span className="val">
              {hub.pinnedContentPackVersion?.versionLabel ?? '—'}
            </span>
          </div>
          <div className="nameplate-metric">
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
      <SpecField label="Category" value={hub.assetModel.category.toUpperCase()} />
      <SpecField label="Serial" value={hub.assetInstance.serialNumber} mono brand />
      <SpecField label="Site" value={hub.site.name} />
      <SpecField label="Customer" value={hub.organization.name} />
      <SpecField
        label="Content rev"
        value={hub.pinnedContentPackVersion?.versionLabel ?? '—'}
        mono
      />
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
