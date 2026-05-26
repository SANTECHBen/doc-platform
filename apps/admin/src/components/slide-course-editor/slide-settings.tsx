'use client';

// SlideSettings — right pane of the editor. Tabs:
//   Content    — title, editable script (seeded from speaker notes)
//   Voiceover  — upload/replace/delete MP3, preview, duration
//   Interactions — list per slide; opens per-kind editor in overlay
//   Navigation — gate radio (free / require_voiceover / require_interactions / require_both)
//
// All edits autosave through SlideCourseEditor's onPatchSlide /
// onInteractionsChanged callbacks. Local state lives only for the
// transient form fields between debounced flushes.

import { useEffect, useRef, useState } from 'react';
import { Mic, ListChecks, Navigation, FileText, Loader2, Trash2 } from 'lucide-react';
import {
  ErrorBanner,
  Field,
  GhostButton,
  SecondaryButton,
  Textarea,
  TextInput,
} from '@/components/form';
import {
  SLIDE_NAVIGATION_GATE_LABELS,
  type SlideNavigationGate,
} from '@platform/shared';
import {
  deleteSlideVoiceover,
  patchSlideVoiceoverDuration,
  uploadSlideVoiceover,
  type SlideDto,
  type SlideInteractionDto,
} from '@/lib/slide-course-api';
import { InteractionsPanel } from './interactions-panel';
import { BlocksEditor } from './blocks-editor';
import { patchSlide } from '@/lib/slide-course-api';

type Tab = 'content' | 'voiceover' | 'interactions' | 'navigation';

interface SlideSettingsProps {
  deckId: string;
  slide: SlideDto;
  onPatchSlide: (patch: {
    title?: string | null;
    scriptMarkdown?: string | null;
    navigationGate?: SlideNavigationGate;
  }) => Promise<void>;
  // Local-only state update (no PATCH). Used by the voiceover tab so
  // post-upload UI bookkeeping doesn't trigger a slide-patch round-trip
  // — the voiceover endpoint already persisted everything server-side.
  onLocalUpdate: (patch: Partial<SlideDto>) => void;
  onInteractionsChanged: (next: SlideInteractionDto[]) => void;
  onError: (msg: string) => void;
}

export function SlideSettings(props: SlideSettingsProps) {
  const { deckId, slide, onPatchSlide, onLocalUpdate, onInteractionsChanged, onError } = props;
  const [tab, setTab] = useState<Tab>('content');

  return (
    <aside className="flex max-h-[calc(100vh-12rem)] flex-col rounded border border-line bg-surface-raised">
      <nav className="flex border-b border-line">
        <TabBtn active={tab === 'content'} onClick={() => setTab('content')}>
          <FileText className="size-3.5" /> Content
        </TabBtn>
        <TabBtn active={tab === 'voiceover'} onClick={() => setTab('voiceover')}>
          <Mic className="size-3.5" /> Voiceover
        </TabBtn>
        <TabBtn active={tab === 'interactions'} onClick={() => setTab('interactions')}>
          <ListChecks className="size-3.5" />
          Interactions{slide.interactions.length > 0 ? ` (${slide.interactions.length})` : ''}
        </TabBtn>
        <TabBtn active={tab === 'navigation'} onClick={() => setTab('navigation')}>
          <Navigation className="size-3.5" /> Gate
        </TabBtn>
      </nav>
      <div className="flex-1 overflow-y-auto p-3">
        {tab === 'content' && (
          <ContentTab
            deckId={deckId}
            slide={slide}
            onPatchSlide={onPatchSlide}
            onLocalUpdate={onLocalUpdate}
            onError={onError}
          />
        )}
        {tab === 'voiceover' && (
          <VoiceoverTab
            deckId={deckId}
            slide={slide}
            onSlideChange={onLocalUpdate}
            onError={onError}
          />
        )}
        {tab === 'interactions' && (
          <InteractionsPanel
            deckId={deckId}
            slide={slide}
            onInteractionsChanged={onInteractionsChanged}
            onError={onError}
          />
        )}
        {tab === 'navigation' && (
          <NavigationTab slide={slide} onPatchSlide={onPatchSlide} />
        )}
      </div>
    </aside>
  );
}

function TabBtn({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={[
        '-mb-px flex flex-1 items-center justify-center gap-1.5 border-b-2 px-2 py-2 text-xs transition',
        active
          ? 'border-accent text-ink-primary'
          : 'border-transparent text-ink-tertiary hover:text-ink-primary',
      ].join(' ')}
    >
      {children}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Content tab — title + script
// ---------------------------------------------------------------------------

function ContentTab({
  deckId,
  slide,
  onPatchSlide,
  onLocalUpdate,
  onError,
}: {
  deckId: string;
  slide: SlideDto;
  onPatchSlide: (patch: { title?: string | null; scriptMarkdown?: string | null }) => Promise<void>;
  onLocalUpdate: (patch: Partial<SlideDto>) => void;
  onError: (msg: string) => void;
}) {
  const [title, setTitle] = useState(slide.title ?? '');
  const [script, setScript] = useState(slide.scriptMarkdown ?? '');
  const titleSave = useDebouncedFlush(title, 400, async (v) => {
    if (v.trim() === (slide.title ?? '').trim()) return;
    await onPatchSlide({ title: v.trim() || null });
  });
  const scriptSave = useDebouncedFlush(script, 500, async (v) => {
    if (v === (slide.scriptMarkdown ?? '')) return;
    await onPatchSlide({ scriptMarkdown: v || null });
  });

  return (
    <div className="flex flex-col gap-3">
      <Field
        label="Slide title"
        hint="Shown in the rail and in the player header."
        error={titleSave.error}
      >
        <TextInput
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder={`Slide ${slide.slideIndex + 1}`}
          maxLength={200}
        />
      </Field>
      <Field
        label="Voiceover script"
        hint={
          slide.speakerNotesMarkdown
            ? 'Seeded from PowerPoint speaker notes. Paste this into ElevenLabs to generate the audio.'
            : 'No speaker notes were in the PPTX. Write the script you want narrated.'
        }
        error={scriptSave.error}
      >
        <Textarea
          value={script}
          onChange={(e) => setScript(e.target.value)}
          rows={10}
          placeholder="Write or paste the narration text…"
          maxLength={16000}
        />
      </Field>
      {script.length > 0 && (
        <SecondaryButton
          type="button"
          onClick={async () => {
            await navigator.clipboard.writeText(script);
          }}
        >
          Copy script to clipboard
        </SecondaryButton>
      )}
      {(titleSave.saving || scriptSave.saving) && (
        <p className="flex items-center gap-1.5 text-xs text-ink-tertiary">
          <Loader2 className="size-3 animate-spin" /> Saving…
        </p>
      )}
      <hr className="border-line" />
      <div>
        <p className="mb-2 text-xs font-medium uppercase tracking-wide text-ink-tertiary">
          Content blocks
        </p>
        <BlocksEditor
          deckId={deckId}
          slideId={slide.id}
          blocks={slide.blocks}
          onChange={async (next) => {
            // Optimistic local update so the editor stays snappy;
            // server persists the array via slide PATCH.
            onLocalUpdate({ blocks: next });
            try {
              await patchSlide(deckId, slide.id, { blocks: next });
            } catch (e) {
              onError(e instanceof Error ? e.message : String(e));
            }
          }}
          onError={onError}
        />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Voiceover tab — upload + preview + delete
// ---------------------------------------------------------------------------

function VoiceoverTab({
  deckId,
  slide,
  onSlideChange,
  onError,
}: {
  deckId: string;
  slide: SlideDto;
  onSlideChange: (patch: Partial<SlideDto>) => void;
  onError: (msg: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  async function onPickFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ''; // allow re-picking the same file
    if (!file) return;
    setBusy(true);
    setLocalError(null);
    try {
      const result = await uploadSlideVoiceover(deckId, slide.id, file);
      onSlideChange({
        voiceoverStorageKey: result.voiceoverStorageKey,
        voiceoverUrl: result.voiceoverUrl,
        voiceoverDurationSec: null,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setLocalError(msg);
      onError(msg);
    } finally {
      setBusy(false);
    }
  }

  async function onDelete() {
    if (!confirm('Remove this slide\'s voiceover?')) return;
    setBusy(true);
    try {
      await deleteSlideVoiceover(deckId, slide.id);
      onSlideChange({
        voiceoverStorageKey: null,
        voiceoverUrl: null,
        voiceoverDurationSec: null,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setLocalError(msg);
      onError(msg);
    } finally {
      setBusy(false);
    }
  }

  // After upload, when the <audio> loads metadata, push the probed duration
  // back to the server so the player's require_voiceover gate has a
  // duration to wait on.
  useEffect(() => {
    if (!slide.voiceoverUrl || slide.voiceoverDurationSec) return;
    const el = audioRef.current;
    if (!el) return;
    const onLoaded = () => {
      const sec = Math.round(el.duration * 10) / 10;
      if (!Number.isFinite(sec) || sec <= 0) return;
      void patchSlideVoiceoverDuration(deckId, slide.id, sec).then(() => {
        onSlideChange({ voiceoverDurationSec: sec });
      }).catch(() => undefined);
    };
    el.addEventListener('loadedmetadata', onLoaded);
    return () => el.removeEventListener('loadedmetadata', onLoaded);
  }, [slide.voiceoverUrl, slide.voiceoverDurationSec, deckId, slide.id, onSlideChange]);

  return (
    <div className="flex flex-col gap-3">
      <ErrorBanner error={localError} />
      {slide.voiceoverUrl ? (
        <div className="space-y-2">
          <audio ref={audioRef} src={slide.voiceoverUrl} controls preload="metadata" className="w-full" />
          <p className="text-xs text-ink-tertiary">
            {slide.voiceoverDurationSec
              ? `${slide.voiceoverDurationSec.toFixed(1)}s`
              : 'Probing duration…'}
          </p>
          <div className="flex flex-wrap gap-2">
            <label className="inline-flex">
              <SecondaryButton
                type="button"
                disabled={busy}
                onClick={() => (document.getElementById('voiceover-file') as HTMLInputElement)?.click()}
              >
                Replace
              </SecondaryButton>
              <input
                id="voiceover-file"
                type="file"
                accept="audio/mpeg,audio/mp3,audio/mp4,audio/m4a,audio/wav,audio/ogg,audio/webm"
                className="hidden"
                onChange={onPickFile}
              />
            </label>
            <GhostButton type="button" disabled={busy} onClick={onDelete}>
              <Trash2 className="size-4" /> Delete
            </GhostButton>
          </div>
        </div>
      ) : (
        <label className="block cursor-pointer rounded border border-dashed border-line bg-surface p-4 text-center text-sm text-ink-tertiary transition hover:border-accent hover:text-ink-primary">
          <input
            type="file"
            accept="audio/mpeg,audio/mp3,audio/mp4,audio/m4a,audio/wav,audio/ogg,audio/webm"
            className="hidden"
            onChange={onPickFile}
            disabled={busy}
          />
          {busy ? (
            <span className="flex items-center justify-center gap-2">
              <Loader2 className="size-4 animate-spin" /> Uploading…
            </span>
          ) : (
            <>
              <Mic className="mx-auto mb-2 size-6" />
              <span className="block">Upload voiceover (MP3/M4A/WAV, up to 25 MB)</span>
              <span className="mt-1 block text-xs">Click or drop a file here</span>
            </>
          )}
        </label>
      )}
      <p className="text-xs text-ink-tertiary">
        Tip: paste the script from the Content tab into{' '}
        <a
          href="https://elevenlabs.io/app/speech-synthesis"
          target="_blank"
          rel="noopener noreferrer"
          className="text-accent underline"
        >
          ElevenLabs
        </a>{' '}
        to generate high-quality narration, then upload the MP3 here.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Navigation tab — gate radio
// ---------------------------------------------------------------------------

function NavigationTab({
  slide,
  onPatchSlide,
}: {
  slide: SlideDto;
  onPatchSlide: (patch: { navigationGate?: SlideNavigationGate }) => Promise<void>;
}) {
  const [gate, setGate] = useState<SlideNavigationGate>(slide.navigationGate);

  return (
    <div className="space-y-3">
      <p className="text-xs text-ink-tertiary">
        Decide what the learner must do on this slide before they can advance.
      </p>
      {(Object.keys(SLIDE_NAVIGATION_GATE_LABELS) as SlideNavigationGate[]).map((g) => (
        <label
          key={g}
          className={[
            'flex cursor-pointer items-start gap-2 rounded border px-3 py-2 transition',
            gate === g ? 'border-accent bg-accent/10' : 'border-line hover:border-accent/50',
          ].join(' ')}
        >
          <input
            type="radio"
            name="gate"
            className="mt-0.5"
            checked={gate === g}
            onChange={() => {
              setGate(g);
              void onPatchSlide({ navigationGate: g });
            }}
          />
          <span className="text-sm">{SLIDE_NAVIGATION_GATE_LABELS[g]}</span>
        </label>
      ))}
      {gate === 'require_voiceover' && !slide.voiceoverUrl && (
        <p className="rounded border border-signal-warn/40 bg-signal-warn/10 px-3 py-2 text-xs text-signal-warn">
          This slide has no voiceover yet. The gate won't block until one is uploaded.
        </p>
      )}
      {(gate === 'require_interactions' || gate === 'require_both') &&
        slide.interactions.length === 0 && (
          <p className="rounded border border-signal-warn/40 bg-signal-warn/10 px-3 py-2 text-xs text-signal-warn">
            This slide has no interactions yet. The gate won't block until at least one is added.
          </p>
        )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// useDebouncedFlush — generic value → save hook with error surface.
// ---------------------------------------------------------------------------

function useDebouncedFlush<T>(
  value: T,
  delayMs: number,
  saver: (v: T) => Promise<void>,
): { saving: boolean; error: string | null } {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const firstRender = useRef(true);
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    const t = setTimeout(async () => {
      setSaving(true);
      setError(null);
      try {
        await saver(value);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setSaving(false);
      }
    }, delayMs);
    return () => clearTimeout(t);
  }, [value, delayMs, saver]);
  return { saving, error };
}
