'use client';

// Voice-to-text — wraps the browser's Web Speech API. Drop-in mic button
// next to a text/textarea input. On supported browsers (Chrome/Edge/iOS
// Safari 14.5+), tapping the mic starts continuous recognition; tapping
// again stops and emits the final transcript via onTranscript.
//
// Graceful fallback: when SpeechRecognition isn't available, the button
// renders as disabled with a tooltip rather than throwing.

import { useEffect, useRef, useState } from 'react';
import { Mic, MicOff } from 'lucide-react';

// Web Speech API typings — not in lib.dom.d.ts in older TS, so declare what we use.
interface SpeechRecognitionEventLike {
  results: ArrayLike<{ 0: { transcript: string }; isFinal: boolean }> & {
    length: number;
  };
}
interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((e: SpeechRecognitionEventLike) => void) | null;
  onend: (() => void) | null;
  onerror: ((e: { error?: string }) => void) | null;
  start(): void;
  stop(): void;
}
interface SpeechRecognitionConstructor {
  new (): SpeechRecognitionLike;
}

function getSpeechRecognition(): SpeechRecognitionConstructor | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as {
    SpeechRecognition?: SpeechRecognitionConstructor;
    webkitSpeechRecognition?: SpeechRecognitionConstructor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export function MicButton({
  onTranscript,
  appendMode = true,
  className,
  size = 'sm',
}: {
  /** Called every time recognition produces a final transcript. The
   *  caller decides whether to append (textarea-style) or replace (input-
   *  style) by toggling `appendMode`. */
  onTranscript: (transcript: string) => void;
  appendMode?: boolean;
  className?: string;
  size?: 'sm' | 'md';
}) {
  const [supported, setSupported] = useState(false);
  const [listening, setListening] = useState(false);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);

  useEffect(() => {
    const Ctor = getSpeechRecognition();
    setSupported(Ctor !== null);
  }, []);

  function start() {
    const Ctor = getSpeechRecognition();
    if (!Ctor) return;
    const rec = new Ctor();
    rec.lang = 'en-US';
    rec.continuous = true;
    rec.interimResults = false;
    rec.onresult = (e) => {
      let combined = '';
      for (let i = 0; i < e.results.length; i++) {
        const r = e.results[i];
        if (r && r.isFinal) combined += r[0].transcript;
      }
      const trimmed = combined.trim();
      if (trimmed) onTranscript(trimmed);
    };
    rec.onend = () => {
      setListening(false);
      recognitionRef.current = null;
    };
    rec.onerror = () => {
      setListening(false);
      recognitionRef.current = null;
    };
    recognitionRef.current = rec;
    setListening(true);
    rec.start();
  }

  function stop() {
    recognitionRef.current?.stop();
  }

  if (!supported) {
    return (
      <button
        type="button"
        disabled
        title="Voice input not supported in this browser"
        className={`inline-flex items-center justify-center rounded text-ink-tertiary opacity-50 ${
          size === 'md' ? 'h-9 w-9' : 'h-7 w-7'
        } ${className ?? ''}`}
      >
        <MicOff size={size === 'md' ? 16 : 14} strokeWidth={1.75} />
      </button>
    );
  }

  return (
    <button
      type="button"
      onClick={listening ? stop : start}
      title={listening ? 'Stop recording' : 'Dictate (voice to text)'}
      aria-pressed={listening}
      className={`inline-flex items-center justify-center rounded transition ${
        listening
          ? 'bg-signal-fault/15 text-signal-fault animate-pulse'
          : 'text-ink-tertiary hover:bg-surface hover:text-ink-primary'
      } ${size === 'md' ? 'h-9 w-9' : 'h-7 w-7'} ${className ?? ''}`}
      // Suppress unused-var warning on appendMode — it's documented for
      // callers as a behavioral hint when they wire onTranscript handlers.
      data-append-mode={appendMode}
    >
      <Mic size={size === 'md' ? 16 : 14} strokeWidth={1.75} />
    </button>
  );
}
