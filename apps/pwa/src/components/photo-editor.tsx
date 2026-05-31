'use client';

// PhotoEditor — two-phase capture polish for field photos:
//   1. CROP    — react-easy-crop, freeform aspect, pinch/drag native.
//   2. MARKUP  — canvas overlay with arrows, lines, and text labels in
//                a chunky high-contrast palette tuned for field photos.
//
// Output is a flattened JPEG Blob suitable for upload via the regular
// step-media path. The editor is touch-first (pointer events,
// touch-action: none on the canvas) and full-screen on top of the
// wizard so it never has to fight a parent container's scroll.

import { useEffect, useMemo, useRef, useState } from 'react';
import Cropper, { type Area } from 'react-easy-crop';
import {
  ArrowUpRight,
  Check,
  ChevronLeft,
  Minus,
  Type,
  Undo2,
  X,
} from 'lucide-react';

const COLORS = ['#ef4444', '#fbbf24', '#22c55e', '#000000', '#ffffff'];
type Tool = 'arrow' | 'line' | 'text';

type Annotation =
  | {
      id: string;
      kind: 'arrow' | 'line';
      x1: number;
      y1: number;
      x2: number;
      y2: number;
      color: string;
    }
  | {
      id: string;
      kind: 'text';
      x: number;
      y: number;
      text: string;
      color: string;
    };

export function PhotoEditor({
  file,
  onSave,
  onCancel,
}: {
  file: File;
  onSave: (blob: Blob) => void;
  onCancel: () => void;
}) {
  const originalUrl = useMemo(() => URL.createObjectURL(file), [file]);
  const [phase, setPhase] = useState<'crop' | 'annotate'>('crop');
  const [busy, setBusy] = useState(false);

  // ---- Crop --------------------------------------------------------
  const [cropPos, setCropPos] = useState({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);
  const [croppedAreaPixels, setCroppedAreaPixels] = useState<Area | null>(null);
  const [croppedUrl, setCroppedUrl] = useState<string | null>(null);

  // ---- Markup ------------------------------------------------------
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const [tool, setTool] = useState<Tool>('arrow');
  const [color, setColor] = useState<string>(COLORS[0]!);
  const [textInput, setTextInput] = useState<{
    x: number;
    y: number;
    text: string;
  } | null>(null);
  const [drag, setDrag] = useState<{
    x1: number;
    y1: number;
    x2: number;
    y2: number;
  } | null>(null);

  const [imgEl, setImgEl] = useState<HTMLImageElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // Cleanup blob URLs on unmount.
  useEffect(() => {
    return () => {
      URL.revokeObjectURL(originalUrl);
    };
  }, [originalUrl]);
  useEffect(() => {
    return () => {
      if (croppedUrl) URL.revokeObjectURL(croppedUrl);
    };
  }, [croppedUrl]);

  // Decode the cropped image once the URL is set.
  useEffect(() => {
    if (!croppedUrl) return;
    let cancelled = false;
    loadImage(croppedUrl).then((img) => {
      if (!cancelled) setImgEl(img);
    });
    return () => {
      cancelled = true;
    };
  }, [croppedUrl]);

  // Redraw on any state that affects the canvas.
  useEffect(() => {
    if (phase !== 'annotate') return;
    if (!imgEl || !canvasRef.current) return;
    drawAll(canvasRef.current, imgEl, annotations, drag, tool, color);
  }, [phase, imgEl, annotations, drag, tool, color]);

  // ---- Phase transitions ------------------------------------------

  async function applyCropAndContinue() {
    setBusy(true);
    try {
      const blob = croppedAreaPixels
        ? await cropImageToBlob(originalUrl, croppedAreaPixels)
        : file;
      const url = URL.createObjectURL(blob);
      setCroppedUrl(url);
      setPhase('annotate');
    } finally {
      setBusy(false);
    }
  }

  async function finalize() {
    if (!canvasRef.current || !imgEl) return;
    setBusy(true);
    try {
      const blob = await canvasToBlob(canvasRef.current);
      onSave(blob);
    } finally {
      setBusy(false);
    }
  }

  // ---- Pointer handlers (canvas) ----------------------------------

  function onPointerDown(e: React.PointerEvent<HTMLCanvasElement>) {
    if (!canvasRef.current || !imgEl) return;
    const { x, y } = canvasPoint(canvasRef.current, e.clientX, e.clientY);
    if (tool === 'text') {
      setTextInput({ x, y, text: '' });
      return;
    }
    setDrag({ x1: x, y1: y, x2: x, y2: y });
    canvasRef.current.setPointerCapture(e.pointerId);
  }

  function onPointerMove(e: React.PointerEvent<HTMLCanvasElement>) {
    if (!drag || !canvasRef.current) return;
    const { x, y } = canvasPoint(canvasRef.current, e.clientX, e.clientY);
    setDrag({ ...drag, x2: x, y2: y });
  }

  function onPointerUp() {
    if (!drag) return;
    const { x1, y1, x2, y2 } = drag;
    // Discard hairline taps so a missed text-tap doesn't leave a dot.
    if (Math.hypot(x2 - x1, y2 - y1) > 6) {
      setAnnotations((prev) => [
        ...prev,
        {
          id: String(Date.now()) + Math.random().toString(36).slice(2, 6),
          kind: tool === 'arrow' ? 'arrow' : 'line',
          x1,
          y1,
          x2,
          y2,
          color,
        },
      ]);
    }
    setDrag(null);
  }

  function commitText() {
    if (!textInput) return;
    if (!textInput.text.trim()) {
      setTextInput(null);
      return;
    }
    setAnnotations((prev) => [
      ...prev,
      {
        id: String(Date.now()) + Math.random().toString(36).slice(2, 6),
        kind: 'text',
        x: textInput.x,
        y: textInput.y,
        text: textInput.text.trim(),
        color,
      },
    ]);
    setTextInput(null);
  }

  function undoLast() {
    setAnnotations((prev) => prev.slice(0, -1));
  }

  // ---- Render ------------------------------------------------------

  if (phase === 'crop') {
    return (
      <div className="fixed inset-0 z-[70] flex flex-col bg-black">
        <header className="flex items-center justify-between border-b border-zinc-800 px-4 py-3 text-white">
          <button
            type="button"
            onClick={onCancel}
            aria-label="Cancel"
            className="rounded p-1 hover:bg-zinc-800"
          >
            <X size={20} strokeWidth={2} />
          </button>
          <span className="text-xs font-semibold uppercase tracking-wider">
            Crop
          </span>
          <button
            type="button"
            onClick={applyCropAndContinue}
            disabled={busy}
            className="rounded bg-white px-3 py-1.5 text-sm font-semibold text-black disabled:opacity-50"
          >
            Next
          </button>
        </header>
        <div className="relative flex-1">
          <Cropper
            image={originalUrl}
            crop={cropPos}
            zoom={zoom}
            onCropChange={setCropPos}
            onZoomChange={setZoom}
            onCropComplete={(_, area) => setCroppedAreaPixels(area)}
            objectFit="contain"
          />
        </div>
        <footer className="bg-zinc-900 px-4 py-3 text-xs text-zinc-400">
          Drag to reposition · pinch or drag the slider to zoom
          <input
            type="range"
            min={1}
            max={4}
            step={0.05}
            value={zoom}
            onChange={(e) => setZoom(Number(e.target.value))}
            className="mt-2 w-full accent-white"
          />
        </footer>
      </div>
    );
  }

  // ---- ANNOTATE phase --------------------------------------------

  return (
    <div className="fixed inset-0 z-[70] flex flex-col bg-black">
      <header className="flex items-center justify-between border-b border-zinc-800 px-4 py-3 text-white">
        <button
          type="button"
          onClick={() => {
            setPhase('crop');
            setAnnotations([]);
          }}
          aria-label="Back to crop"
          className="rounded p-1 hover:bg-zinc-800"
        >
          <ChevronLeft size={22} strokeWidth={2} />
        </button>
        <span className="text-xs font-semibold uppercase tracking-wider">
          Markup
        </span>
        <button
          type="button"
          onClick={finalize}
          disabled={busy || !imgEl}
          className="flex items-center gap-1.5 rounded bg-white px-3 py-1.5 text-sm font-semibold text-black disabled:opacity-50"
        >
          <Check size={14} strokeWidth={2.5} /> Done
        </button>
      </header>

      <div className="relative flex flex-1 items-center justify-center overflow-hidden bg-zinc-950">
        {imgEl ? (
          <canvas
            ref={canvasRef}
            width={imgEl.naturalWidth}
            height={imgEl.naturalHeight}
            className="max-h-full max-w-full select-none"
            style={{ touchAction: 'none' }}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
          />
        ) : (
          <span className="text-xs text-zinc-500">Loading…</span>
        )}
      </div>

      <footer className="flex flex-col gap-3 border-t border-zinc-800 bg-zinc-900 px-3 py-3 text-white">
        <div className="flex items-center justify-center gap-2">
          <ToolButton
            active={tool === 'arrow'}
            onClick={() => setTool('arrow')}
            label="Arrow"
          >
            <ArrowUpRight size={18} strokeWidth={2} />
          </ToolButton>
          <ToolButton
            active={tool === 'line'}
            onClick={() => setTool('line')}
            label="Line"
          >
            <Minus size={18} strokeWidth={2} />
          </ToolButton>
          <ToolButton
            active={tool === 'text'}
            onClick={() => setTool('text')}
            label="Text"
          >
            <Type size={18} strokeWidth={2} />
          </ToolButton>
          <span className="mx-2 h-7 w-px bg-zinc-700" aria-hidden />
          <ToolButton
            active={false}
            onClick={undoLast}
            label="Undo"
            disabled={annotations.length === 0}
          >
            <Undo2 size={18} strokeWidth={2} />
          </ToolButton>
        </div>
        <div className="flex items-center justify-center gap-2">
          {COLORS.map((c) => (
            <button
              key={c}
              type="button"
              onClick={() => setColor(c)}
              aria-label={`Color ${c}`}
              className={`h-8 w-8 rounded-full border-2 ${
                color === c ? 'border-white' : 'border-zinc-700'
              }`}
              style={{ background: c }}
            />
          ))}
        </div>
      </footer>

      {textInput && (
        <div
          className="fixed inset-0 z-[80] flex items-center justify-center bg-black/70 p-4"
          onClick={() => setTextInput(null)}
        >
          <div
            className="w-full max-w-md rounded-md bg-zinc-900 p-4 text-white"
            onClick={(e) => e.stopPropagation()}
          >
            <p className="cap-mono mb-2 text-zinc-400">LABEL TEXT</p>
            <input
              autoFocus
              type="text"
              value={textInput.text}
              onChange={(e) =>
                setTextInput({ ...textInput, text: e.target.value })
              }
              placeholder="e.g. wear here · scoring · 0.4 mm"
              className="w-full rounded bg-zinc-800 p-3 text-base"
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitText();
                if (e.key === 'Escape') setTextInput(null);
              }}
            />
            <div className="mt-3 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setTextInput(null)}
                className="rounded px-3 py-2 text-sm text-zinc-300 hover:bg-zinc-800"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={commitText}
                className="rounded bg-white px-4 py-2 text-sm font-semibold text-black"
              >
                Add label
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function ToolButton({
  active,
  onClick,
  label,
  disabled,
  children,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      className={`flex min-w-[64px] flex-col items-center gap-0.5 rounded px-3 py-2 text-[10px] font-semibold uppercase tracking-wider ${
        active
          ? 'bg-white text-black'
          : 'bg-zinc-800 text-zinc-200 hover:bg-zinc-700 disabled:opacity-40'
      }`}
    >
      {children}
      <span>{label}</span>
    </button>
  );
}

// ---------------------------------------------------------------------
// Geometry + drawing helpers
// ---------------------------------------------------------------------

function canvasPoint(
  canvas: HTMLCanvasElement,
  clientX: number,
  clientY: number,
): { x: number; y: number } {
  const rect = canvas.getBoundingClientRect();
  // Convert from CSS pixels (rect) to canvas-internal pixels (image res).
  const sx = canvas.width / rect.width;
  const sy = canvas.height / rect.height;
  return { x: (clientX - rect.left) * sx, y: (clientY - rect.top) * sy };
}

function drawAll(
  canvas: HTMLCanvasElement,
  img: HTMLImageElement,
  anns: Annotation[],
  drag: { x1: number; y1: number; x2: number; y2: number } | null,
  tool: Tool,
  color: string,
) {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(img, 0, 0);
  for (const a of anns) drawAnnotation(ctx, a);
  if (drag && tool !== 'text') {
    drawAnnotation(ctx, {
      id: 'preview',
      kind: tool,
      x1: drag.x1,
      y1: drag.y1,
      x2: drag.x2,
      y2: drag.y2,
      color,
    });
  }
}

function drawAnnotation(
  ctx: CanvasRenderingContext2D,
  a: Annotation,
) {
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  if (a.kind === 'text') {
    const fontSize = Math.max(28, ctx.canvas.width * 0.045);
    ctx.font = `bold ${fontSize}px -apple-system, system-ui, sans-serif`;
    ctx.textBaseline = 'middle';
    // Stroke for contrast against the photo.
    ctx.lineWidth = Math.max(4, fontSize * 0.18);
    ctx.strokeStyle = a.color === '#000000' ? '#ffffff' : '#000000';
    ctx.strokeText(a.text, a.x, a.y);
    ctx.fillStyle = a.color;
    ctx.fillText(a.text, a.x, a.y);
    return;
  }
  const w = Math.max(6, ctx.canvas.width * 0.01);
  ctx.lineWidth = w;
  ctx.strokeStyle = a.color;
  ctx.fillStyle = a.color;
  ctx.beginPath();
  ctx.moveTo(a.x1, a.y1);
  ctx.lineTo(a.x2, a.y2);
  ctx.stroke();
  if (a.kind === 'arrow') {
    drawArrowHead(ctx, a.x1, a.y1, a.x2, a.y2, w);
  }
}

function drawArrowHead(
  ctx: CanvasRenderingContext2D,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  lineWidth: number,
) {
  const angle = Math.atan2(y2 - y1, x2 - x1);
  const len = lineWidth * 5;
  ctx.beginPath();
  ctx.moveTo(x2, y2);
  ctx.lineTo(
    x2 - len * Math.cos(angle - Math.PI / 6),
    y2 - len * Math.sin(angle - Math.PI / 6),
  );
  ctx.lineTo(
    x2 - len * Math.cos(angle + Math.PI / 6),
    y2 - len * Math.sin(angle + Math.PI / 6),
  );
  ctx.closePath();
  ctx.fill();
}

async function cropImageToBlob(
  srcUrl: string,
  area: Area,
): Promise<Blob> {
  const img = await loadImage(srcUrl);
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(area.width);
  canvas.height = Math.round(area.height);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('canvas 2d unavailable');
  ctx.drawImage(
    img,
    area.x,
    area.y,
    area.width,
    area.height,
    0,
    0,
    area.width,
    area.height,
  );
  return canvasToBlob(canvas);
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = (e) =>
      reject(e instanceof Error ? e : new Error('image load failed'));
    img.src = src;
  });
}

function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error('canvas.toBlob returned null'))),
      'image/jpeg',
      0.92,
    );
  });
}
