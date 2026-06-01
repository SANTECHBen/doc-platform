'use client';

// GenerateAudioDialog — opens before a "Generate with AI" click on a
// procedure step. Pre-fills an editable textarea with the spoken script
// the server would build automatically (title + flattened blocks), so the
// author can:
//   - tweak the wording for pronunciation ("twenty-five Newton meters"
//     instead of "25 N·m" that would read as letters)
//   - shorten or expand the narration without touching the on-screen text
//   - leave the displayed step content alone for the tech to read
//
// The edited script is sent to the API as the `script` body field on the
// generate route. The server uses it verbatim when present (otherwise it
// builds from blocks). Edits are NOT persisted between generations — each
// re-generate re-derives from the current step content. If users start
// needing persistent script overrides we can add an audioOverrideScript
// column to procedure_steps later; for now the round-trip is fine because
// the most common case is "tweak once, generate, done."

import { useEffect, useRef, useState } from 'react';
import { Loader2, Sparkles, X } from 'lucide-react';
import type { AdminProcedureStep } from '@/lib/api';
import { buildSpokenScript } from '@/lib/spoken-script';

interface Props {
  open: boolean;
  step: AdminProcedureStep;
  /** Submitted text. Caller invokes the generate API with this as the
   *  `script` body field. Closes the dialog on success. */
  onGenerate: (script: string) => Promise<void> | void;
  onClose: () => void;
  /** Whether a generate request is in flight. Disables inputs + buttons
   *  during the round-trip so the author can't double-fire. */
  busy: boolean;
  /** Surfaced inside the dialog when generation fails so the author sees
   *  the cause without dismissing the modal. */
  error: string | null;
}

const MAX_SCRIPT_CHARS = 4000; // matches the API's GenerateBody.script max
const MIN_SCRIPT_CHARS = 2;

export function GenerateAudioDialog({
  open,
  step,
  onGenerate,
  onClose,
  busy,
  error,
}: Props) {
  // Each open re-derives the pre-filled script from the latest step
  // content. We use a key off step.id + open to reset state when the
  // dialog reopens after the step changed.
  const [script, setScript] = useState(() => buildSpokenScript(step));
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  // When the dialog opens (or the underlying step changes while open),
  // refresh the textarea with the current step content. Author can still
  // override; this just makes the open state honest.
  useEffect(() => {
    if (open) {
      setScript(buildSpokenScript(step));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, step.id, step.updatedAt]);

  // Focus the textarea + select-all on open so the author can immediately
  // overwrite if they want a totally different script.
  useEffect(() => {
    if (!open) return;
    const t = setTimeout(() => {
      textareaRef.current?.focus();
      textareaRef.current?.select();
    }, 50);
    return () => clearTimeout(t);
  }, [open]);

  // Escape closes — but only when not busy. We don't want to cancel a
  // generation by accident.
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape' && !busy) onClose();
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !busy && canSubmit) {
        e.preventDefault();
        void onGenerate(script.trim());
      }
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, busy, script]);

  const trimmed = script.trim();
  const canSubmit =
    trimmed.length >= MIN_SCRIPT_CHARS && trimmed.length <= MAX_SCRIPT_CHARS;
  const tooLong = trimmed.length > MAX_SCRIPT_CHARS;

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="gen-audio-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink-primary/40 backdrop-blur-sm p-4"
      onClick={() => !busy && onClose()}
    >
      <div
        className="flex w-full max-w-2xl flex-col overflow-hidden rounded-lg border border-line bg-surface-raised shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-start justify-between gap-4 border-b border-line-subtle px-4 py-3">
          <div className="flex flex-col gap-0.5">
            <h2
              id="gen-audio-title"
              className="inline-flex items-center gap-2 text-sm font-semibold text-ink-primary"
            >
              <Sparkles className="size-4 text-accent" />
              Generate voiceover
            </h2>
            <p className="text-xs text-ink-tertiary">
              Edit the script that will be read aloud. The step's on-screen
              text isn't affected.
            </p>
          </div>
          <button
            type="button"
            onClick={() => !busy && onClose()}
            disabled={busy}
            aria-label="Close"
            className="rounded p-1 text-ink-tertiary transition hover:bg-surface hover:text-ink-primary disabled:opacity-40"
          >
            <X className="size-4" />
          </button>
        </header>

        <div className="flex flex-col gap-3 px-4 py-3">
          <label className="flex flex-col gap-1.5">
            <span className="caption text-ink-secondary">Script</span>
            <textarea
              ref={textareaRef}
              value={script}
              onChange={(e) => setScript(e.target.value)}
              disabled={busy}
              rows={10}
              maxLength={MAX_SCRIPT_CHARS + 200 /* allow slight overflow so we can show the count error rather than silently truncating */}
              placeholder='What should the AI voice read for this step?'
              className="w-full resize-y rounded-md border border-line bg-surface px-3 py-2 text-sm leading-relaxed text-ink-primary outline-none placeholder:text-ink-tertiary/60 focus:border-accent disabled:opacity-50"
            />
          </label>
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
            <span
              className={[
                'tabular-nums',
                tooLong
                  ? 'font-semibold text-signal-fault'
                  : 'text-ink-tertiary',
              ].join(' ')}
            >
              {trimmed.length.toLocaleString('en-US')} / {MAX_SCRIPT_CHARS.toLocaleString('en-US')} characters
              {tooLong && ' — too long, please shorten before generating'}
            </span>
            <span className="text-ink-tertiary">
              Voice + model picked from your Fly env (ELEVENLABS_VOICE_ID
              / ELEVENLABS_TTS_MODEL_ID).
            </span>
          </div>
          {error && (
            <p
              role="alert"
              className="rounded-md border border-signal-fault/40 bg-signal-fault/10 px-3 py-2 text-xs text-signal-fault"
            >
              {error}
            </p>
          )}
          <p className="text-[11px] text-ink-tertiary">
            Tip: pronunciation tweaks (&ldquo;twenty-five Newton meters&rdquo;
            for &ldquo;25 N&middot;m&rdquo;), pauses (use commas), or trimming a
            block of caveat text are common. The step text on-screen stays
            exactly what your techs see.
          </p>
        </div>

        <footer className="flex items-center justify-end gap-2 border-t border-line-subtle bg-surface px-4 py-3">
          <button
            type="button"
            onClick={() => !busy && onClose()}
            disabled={busy}
            className="rounded-md border border-line bg-surface-raised px-3 py-1.5 text-xs font-medium text-ink-primary transition hover:border-accent/40 hover:bg-accent/5 disabled:opacity-40"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void onGenerate(trimmed)}
            disabled={busy || !canSubmit}
            className="inline-flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-xs font-semibold text-white shadow-sm transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50"
            title="⌘ Enter to submit"
          >
            {busy ? (
              <>
                <Loader2 className="size-3.5 animate-spin" />
                Generating…
              </>
            ) : (
              <>
                <Sparkles className="size-3.5" />
                Generate
              </>
            )}
          </button>
        </footer>
      </div>
    </div>
  );
}
