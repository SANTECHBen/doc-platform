'use client';

// SCORM player.
//
// Iframes the package's launch HTML from the same-origin proxy at
// /scorm-content/<packageId>/* so the in-frame SCORM API stub the
// parent exposes here (window.API for 1.2, window.API_1484_11 for
// 2004) is reachable across the iframe boundary.
//
// The stub satisfies common Storyline / Captivate runtime checks
// (Initialize, GetValue, SetValue, Commit, Terminate) by no-oping
// successfully. We don't persist learner progress yet — that pairs
// with an authenticated learner flow which is on the roadmap. The
// content still plays end to end because no part of SCORM playback
// depends on the LMS persisting data.

import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, Loader2 } from 'lucide-react';

interface ScormPackageInfo {
  scormPackageId: string;
  entryPath: string;
  scormVersion: string | null;
  title: string;
}

export function ScormPlayer({
  activityId,
  onExit,
}: {
  activityId: string;
  onExit?: () => void;
}) {
  const [info, setInfo] = useState<ScormPackageInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);

  // Resolve the activity → package metadata.
  useEffect(() => {
    let cancelled = false;
    fetch(`/api/scan/activities/${encodeURIComponent(activityId)}/scorm-package`, {
      cache: 'no-store',
    })
      .then(async (res) => {
        if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
        return res.json() as Promise<ScormPackageInfo>;
      })
      .then((data) => {
        if (!cancelled) setInfo(data);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [activityId]);

  // Expose the SCORM API stub on the parent window before the iframe
  // loads. SCORM 1.2 looks for window.API; SCORM 2004 looks for
  // window.API_1484_11. Both walk up window.parent until they find
  // one — since we're same-origin proxied, this works.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    type Win = Window & {
      API?: unknown;
      API_1484_11?: unknown;
    };
    const w = window as Win;
    const api12 = makeScorm12Api();
    const api2004 = makeScorm2004Api();
    w.API = api12;
    w.API_1484_11 = api2004;
    return () => {
      if (w.API === api12) delete w.API;
      if (w.API_1484_11 === api2004) delete w.API_1484_11;
    };
  }, []);

  if (error) {
    return (
      <div className="rounded border border-red-500/40 bg-red-500/10 p-4 text-sm text-red-600">
        {error}
      </div>
    );
  }
  if (!info) {
    return (
      <div className="flex items-center gap-2 p-4 text-sm text-ink-tertiary">
        <Loader2 className="size-4 animate-spin" /> Loading SCORM package…
      </div>
    );
  }

  const src = `/scorm-content/${encodeURIComponent(info.scormPackageId)}/${info.entryPath
    .split('/')
    .map((p) => encodeURIComponent(p))
    .join('/')}`;

  return (
    <div className="flex h-[100dvh] w-full flex-col bg-surface-base">
      <header className="flex shrink-0 items-center justify-between border-b border-line bg-surface-raised px-3 py-2">
        <button
          type="button"
          onClick={onExit}
          className="flex items-center gap-1 text-sm text-ink-tertiary hover:text-ink-primary"
        >
          <ArrowLeft className="size-4" /> Exit
        </button>
        <h1 className="truncate text-sm font-medium text-ink-primary">
          {info.title}
        </h1>
        <span className="text-[10px] text-ink-tertiary">
          SCORM {info.scormVersion ?? '?'}
        </span>
      </header>
      <iframe
        ref={iframeRef}
        src={src}
        title={info.title}
        // SCORM packages frequently embed audio / video / pointer-
        // locking interactions; allow the standard sandbox-friendly
        // capabilities so they run without manual user gestures.
        allow="autoplay; fullscreen; clipboard-write; microphone; camera"
        className="min-h-0 flex-1 w-full border-0 bg-white"
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// SCORM 1.2 API stub — return strings (the spec contract). All values
// are stored in-memory and never persisted; that's a follow-up for
// authenticated learner completion records.
// ---------------------------------------------------------------------------
function makeScorm12Api(): Record<string, (...args: unknown[]) => string> {
  const data: Record<string, string> = {
    'cmi.core.lesson_status': 'not attempted',
    'cmi.core.student_id': 'anonymous',
    'cmi.core.student_name': 'Learner',
    'cmi.suspend_data': '',
    'cmi.core.entry': '',
    'cmi.core.score.raw': '',
  };
  let lastError = '0';
  return {
    LMSInitialize: () => 'true',
    LMSFinish: () => 'true',
    LMSGetValue: (...args: unknown[]) => {
      const k = String(args[0] ?? '');
      lastError = '0';
      return data[k] ?? '';
    },
    LMSSetValue: (...args: unknown[]) => {
      const k = String(args[0] ?? '');
      const v = String(args[1] ?? '');
      data[k] = v;
      lastError = '0';
      return 'true';
    },
    LMSCommit: () => {
      lastError = '0';
      return 'true';
    },
    LMSGetLastError: () => lastError,
    LMSGetErrorString: () => '',
    LMSGetDiagnostic: () => '',
  };
}

// ---------------------------------------------------------------------------
// SCORM 2004 API stub. The names are the same shape minus "LMS"; the
// data model has more keys but the no-op contract is identical.
// ---------------------------------------------------------------------------
function makeScorm2004Api(): Record<string, (...args: unknown[]) => string> {
  const data: Record<string, string> = {
    'cmi.completion_status': 'unknown',
    'cmi.success_status': 'unknown',
    'cmi.learner_id': 'anonymous',
    'cmi.learner_name': 'Learner',
    'cmi.suspend_data': '',
    'cmi.entry': '',
    'cmi.score.raw': '',
    'cmi.score.scaled': '',
  };
  let lastError = '0';
  return {
    Initialize: () => 'true',
    Terminate: () => 'true',
    GetValue: (...args: unknown[]) => {
      const k = String(args[0] ?? '');
      lastError = '0';
      return data[k] ?? '';
    },
    SetValue: (...args: unknown[]) => {
      const k = String(args[0] ?? '');
      const v = String(args[1] ?? '');
      data[k] = v;
      lastError = '0';
      return 'true';
    },
    Commit: () => {
      lastError = '0';
      return 'true';
    },
    GetLastError: () => lastError,
    GetErrorString: () => '',
    GetDiagnostic: () => '',
  };
}
