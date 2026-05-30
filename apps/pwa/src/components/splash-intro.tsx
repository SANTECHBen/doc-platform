'use client';

import { useEffect, useRef, useState } from 'react';

// FieldSupport intro splash. Mounts only when the URL carries ?intro=1;
// the /q/<code> route handler sets that flag on QR scans, so the splash
// plays on first arrival without replaying on refresh or back navigation.
//
// The overlay covers the hub from the very first painted frame (no
// opacity fade-in) so the user never sees the underlying page flash
// before the splash takes over. Each part of the mark then eases in
// on its own schedule on top of the opaque surface.
export function SplashIntro() {
  const [phase, setPhase] = useState<'enter' | 'hold' | 'exit' | 'done'>('enter');
  const startedRef = useRef(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;

    // Strip ?intro=1 from the URL immediately so a refresh mid-animation
    // doesn't trigger the splash again, and so a shared link that happens
    // to carry the flag doesn't replay it for someone who didn't scan.
    if (typeof window !== 'undefined') {
      const url = new URL(window.location.href);
      if (url.searchParams.has('intro')) {
        url.searchParams.delete('intro');
        window.history.replaceState(
          window.history.state,
          '',
          url.pathname + (url.search ? url.search : '') + url.hash,
        );
      }
    }

    // Respect prefers-reduced-motion — skip the show, just hand off.
    const reducedMotion =
      typeof window !== 'undefined' &&
      window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

    if (reducedMotion) {
      const t = window.setTimeout(() => setPhase('done'), 360);
      return () => window.clearTimeout(t);
    }

    // Phase timing (~5.3s total).
    //   enter (0–80ms)     paint the opaque overlay before any animation kicks.
    //   hold  (80–4660ms)  run all the per-part keyframe animations.
    //   exit  (4660–5300)  fade the overlay back out.
    const t1 = window.setTimeout(() => setPhase('hold'), 80);
    const t2 = window.setTimeout(() => setPhase('exit'), 4660);
    const t3 = window.setTimeout(() => setPhase('done'), 5300);

    void playIntroSound(audioRef).catch(() => {
      /* autoplay blocked — silent intro is fine */
    });

    return () => {
      window.clearTimeout(t1);
      window.clearTimeout(t2);
      window.clearTimeout(t3);
      const audio = audioRef.current;
      if (audio) {
        try {
          audio.pause();
          audio.src = '';
          audio.load();
        } catch {
          /* element may already be detached */
        }
        audioRef.current = null;
      }
    };
  }, []);

  if (phase === 'done') return null;

  return (
    <div className="fs-splash" data-phase={phase} role="presentation" aria-hidden="true">
      <div className="fs-splash-vignette" aria-hidden="true" />
      <div className="fs-splash-stage">
        <FieldSupportMarkSVG />
      </div>
    </div>
  );
}

// Inline SVG so each part can be animated individually via CSS classes.
// viewBox matches the static field-support-logo.svg so visual proportions
// stay identical to what the user already sees in the topbar.
function FieldSupportMarkSVG() {
  return (
    <svg
      className="fs-mark"
      viewBox="0 0 940 240"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      focusable="false"
    >
      <defs>
        <linearGradient id="fsBrandBlue" x1="480" x2="900" y1="86" y2="146" gradientUnits="userSpaceOnUse">
          <stop stopColor="#256CD3" />
          <stop offset="1" stopColor="#1D58B2" />
        </linearGradient>
        <linearGradient id="fsTraceSteel" x1="80" x2="540" y1="60" y2="118" gradientUnits="userSpaceOnUse">
          <stop stopColor="#0E1217" />
          <stop offset="0.58" stopColor="#4A5560" />
          <stop offset="1" stopColor="#8892A0" />
        </linearGradient>
        <radialGradient id="fsGlow" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="#256CD3" stopOpacity="0.45" />
          <stop offset="60%" stopColor="#256CD3" stopOpacity="0.08" />
          <stop offset="100%" stopColor="#256CD3" stopOpacity="0" />
        </radialGradient>
      </defs>

      {/* Soft cyan-blue glow behind the gear. Fades up first, fades back
          down after the wordmark has landed. */}
      <circle className="fs-glow" cx="125" cy="118" r="135" fill="url(#fsGlow)" />

      {/* Gear assembly — teeth + dark body + light face + arc highlights. */}
      <g className="fs-gear" style={{ transformOrigin: '125px 118px' }}>
        <g className="fs-gear-teeth" fill="#0E1217">
          {Array.from({ length: 16 }).map((_, i) => (
            <rect
              key={i}
              x="117"
              y="18"
              width="16"
              height="28"
              rx="2"
              transform={`rotate(${i * 22.5} 125 118)`}
            />
          ))}
        </g>
        <circle cx="125" cy="118" r="70" fill="#0E1217" />
        <circle cx="125" cy="118" r="52" fill="#F5F6F8" />
        <path
          d="M125 72a46 46 0 0 0-34.2 76.7"
          fill="none"
          stroke="#4A5560"
          strokeWidth="8"
          strokeLinecap="round"
        />
        <path
          d="M125 86a32 32 0 0 0-24.4 53"
          fill="none"
          stroke="#0E1217"
          strokeWidth="6"
          strokeLinecap="round"
        />
      </g>

      {/* Circuit traces — drawn left-to-right via stroke-dashoffset. The
          three paths are individually animated and overlap so the result
          reads as a single wiring diagram coming online. */}
      <g
        className="fs-traces"
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path
          className="fs-trace fs-trace-a"
          d="M154 155h118l34-34h78l30-29h94"
          stroke="url(#fsTraceSteel)"
          strokeWidth="13"
        />
        <path
          className="fs-trace fs-trace-b"
          d="M158 176h130l34-31h78l29-27h94"
          stroke="#4A5560"
          strokeWidth="9"
        />
        <path
          className="fs-trace fs-trace-c"
          d="M207 134h68l27-25h86"
          stroke="#0E1217"
          strokeWidth="8"
        />
        <path
          className="fs-trace fs-trace-red"
          d="M211 134h38"
          stroke="#B02B3D"
          strokeWidth="7"
        />
        <path
          className="fs-trace fs-trace-blue-a"
          d="M323 145h68"
          stroke="#256CD3"
          strokeWidth="7"
        />
        <path
          className="fs-trace fs-trace-blue-b"
          d="M415 118h58"
          stroke="#256CD3"
          strokeWidth="6"
        />
      </g>

      {/* Connector dots. Pop on sequentially after the traces finish. */}
      <g className="fs-nodes">
        <g className="fs-node fs-node-1">
          <circle cx="391" cy="146" r="16" fill="#F5F6F8" />
          <circle cx="391" cy="146" r="11.5" fill="#256CD3" />
          <circle cx="391" cy="146" r="5.5" fill="#F5F6F8" opacity="0.92" />
        </g>
        <g className="fs-node fs-node-2">
          <circle cx="473" cy="118" r="15" fill="#F5F6F8" />
          <circle cx="473" cy="118" r="10.5" fill="#256CD3" />
          <circle cx="473" cy="118" r="5.5" fill="#F5F6F8" opacity="0.92" />
        </g>
        <g className="fs-node fs-node-3">
          <circle cx="523" cy="118" r="14" fill="#F5F6F8" />
          <circle cx="523" cy="118" r="9.5" fill="#B02B3D" />
          <circle cx="523" cy="118" r="4.5" fill="#F5F6F8" opacity="0.92" />
        </g>
      </g>

      {/* Wordmark — italic Field + Support. Skew matches the static SVG.
          Translated as a group so the rise-in keeps the kerning crisp. */}
      <g className="fs-wordmark" transform="skewX(-10)">
        <text
          x="425"
          y="194"
          fill="#0E1217"
          fontFamily="IBM Plex Sans, Inter, Arial, sans-serif"
          fontSize="76"
          fontStyle="italic"
          fontWeight={700}
          letterSpacing="-4"
        >
          Field
        </text>
        <text
          x="588"
          y="194"
          fill="url(#fsBrandBlue)"
          fontFamily="IBM Plex Sans, Inter, Arial, sans-serif"
          fontSize="76"
          fontStyle="italic"
          fontWeight={800}
          letterSpacing="-4.5"
        >
          Support
        </text>
      </g>

      {/* Two understroke swoops, drawn last after the wordmark lands. */}
      <g className="fs-underline">
        <path
          className="fs-underline-line"
          d="M84 220c143-6 314-5 492 1 125 4 244 2 363-11"
          fill="none"
          stroke="#0E1217"
          strokeWidth="4"
          strokeLinecap="round"
          opacity="0.65"
        />
        <path
          className="fs-underline-red"
          d="M338 232c95 6 189 9 282 6 88-3 180-10 293-23-91 16-187 27-286 32-102 5-199 0-289-15Z"
          fill="#B02B3D"
          opacity="0.95"
        />
        <path
          className="fs-underline-blue"
          d="M422 231c99 5 193 4 282-3 77-6 147-14 207-24-70 16-144 27-222 34-84 8-173 6-267-7Z"
          fill="#256CD3"
          opacity="0.3"
        />
      </g>
    </svg>
  );
}

// Play the production intro sound. Returns once playback is started (or
// rejects if autoplay was blocked, in which case the visual still runs).
// The element is stashed on a ref so the cleanup function in the host
// effect can pause + release it if the splash unmounts early.
async function playIntroSound(ref: React.MutableRefObject<HTMLAudioElement | null>): Promise<void> {
  if (typeof window === 'undefined') return;
  const audio = new Audio('/intro-sound.wav');
  audio.preload = 'auto';
  audio.volume = 0.85;
  ref.current = audio;
  await audio.play();
}
