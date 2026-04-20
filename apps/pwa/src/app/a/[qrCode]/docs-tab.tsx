'use client';

import { useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  ChevronLeft,
  Download,
  FileText,
  FileType2,
  FolderOpen,
  Layers,
  Maximize2,
  Minimize2,
  Paperclip,
  Presentation,
  ShieldAlert,
  Video,
  X,
  Youtube,
  type LucideIcon,
} from 'lucide-react';
import { DocListSkeleton } from '@/components/skeleton';
import { EmptyState } from '@/components/empty-state';
import { listDocuments, getDocument, type DocumentListItem, type DocumentBody } from '@/lib/api';

export function DocsTab({ versionId }: { versionId: string | null }) {
  const [docs, setDocs] = useState<DocumentListItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<DocumentBody | null>(null);

  useEffect(() => {
    if (!versionId) return;
    let cancelled = false;
    listDocuments(versionId)
      .then((rows) => {
        if (!cancelled) setDocs(rows);
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
    return () => {
      cancelled = true;
    };
  }, [versionId]);

  if (!versionId) {
    return (
      <EmptyState
        icon={FolderOpen}
        title="No revision pinned"
        description="No content version is pinned to this asset yet."
        tone="neutral"
      />
    );
  }
  if (error) return <ErrorState text={error} />;
  if (docs === null) return <DocListSkeleton />;
  if (docs.length === 0) {
    return (
      <EmptyState
        icon={FolderOpen}
        title="No documents"
        description="No documents have been published in this revision."
        tone="neutral"
      />
    );
  }

  if (open) {
    return <DocView doc={open} onBack={() => setOpen(null)} />;
  }

  return (
    <ul className="grid grid-cols-1 gap-2.5 md:grid-cols-2 lg:grid-cols-3">
      {docs.map((d) => {
        const Icon = kindIcon(d.kind);
        const tint = kindTint(d.kind);
        return (
          <li key={d.id}>
            <button
              onClick={async () => {
                const full = await getDocument(d.id);
                if (full) setOpen(full);
              }}
              className="group flex h-full w-full flex-col overflow-hidden rounded-md border border-line-subtle bg-surface-raised text-left transition hover:-translate-y-0.5 hover:border-brand/40 hover:shadow-[0_4px_14px_-4px_rgba(11,95,191,0.25)]"
            >
              <div className="relative flex aspect-[16/9] w-full items-center justify-center overflow-hidden">
                {d.thumbnailUrl ? (
                  <img
                    src={d.thumbnailUrl}
                    alt=""
                    className="h-full w-full object-cover"
                  />
                ) : (
                  <div
                    className="doc-thumb-placeholder"
                    style={{
                      background: `linear-gradient(135deg, ${tint.bgStart} 0%, ${tint.bgEnd} 100%)`,
                    }}
                  >
                    <div
                      className="icon-chip icon-chip-lg"
                      style={{ color: tint.fg, background: tint.chip }}
                    >
                      <Icon size={28} strokeWidth={2} />
                    </div>
                    <span className="doc-thumb-label" style={{ color: tint.fg }}>
                      {kindLabel(d.kind)}
                    </span>
                  </div>
                )}
                {d.safetyCritical && (
                  <span className="absolute right-2 top-2 inline-flex items-center gap-1 rounded-sm bg-signal-safety/15 px-2 py-0.5 text-caption font-semibold uppercase text-signal-safety backdrop-blur-sm">
                    <ShieldAlert size={11} strokeWidth={2.5} />
                    Safety
                  </span>
                )}
              </div>
              <div className="flex flex-1 flex-col gap-2 p-4">
                <span className="inline-flex items-center gap-1.5 caption">
                  <Icon size={12} strokeWidth={2} />
                  {kindLabel(d.kind)}
                  {d.language !== 'en' && ` · ${d.language.toUpperCase()}`}
                </span>
                <h3 className="text-base font-medium text-ink-primary group-hover:text-brand">
                  {d.title}
                </h3>
                {d.tags.length > 0 && (
                  <div className="mt-auto flex flex-wrap gap-1 pt-1">
                    {d.tags.map((t) => (
                      <span
                        key={t}
                        className="rounded-sm border border-line-subtle bg-surface-inset px-1.5 py-0.5 font-mono text-xs text-ink-tertiary"
                      >
                        {t}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

function kindLabel(kind: string): string {
  switch (kind) {
    case 'markdown':
      return 'Document';
    case 'pdf':
      return 'PDF';
    case 'video':
      return 'Video';
    case 'external_video':
      return 'Video · External';
    case 'structured_procedure':
      return 'Procedure';
    case 'schematic':
      return 'Schematic';
    case 'slides':
      return 'Slides';
    case 'file':
      return 'File';
    default:
      return kind;
  }
}

// Per-kind color scheme for the placeholder. Each pair uses a soft tinted
// background, a saturated accent for the icon chip, and a readable ink color
// for the kind label. Designed to read as "intentional card" not "missing
// image".
interface KindTint {
  bgStart: string;
  bgEnd: string;
  chip: string;
  fg: string;
}
function kindTint(kind: string): KindTint {
  switch (kind) {
    case 'pdf':
      return {
        bgStart: 'rgba(220, 38, 38, 0.12)',
        bgEnd: 'rgba(220, 38, 38, 0.04)',
        chip: 'rgba(220, 38, 38, 0.16)',
        fg: '#b91c1c',
      };
    case 'video':
    case 'external_video':
      return {
        bgStart: 'rgba(14, 165, 233, 0.14)',
        bgEnd: 'rgba(14, 165, 233, 0.04)',
        chip: 'rgba(14, 165, 233, 0.18)',
        fg: '#0369a1',
      };
    case 'slides':
      return {
        bgStart: 'rgba(234, 88, 12, 0.12)',
        bgEnd: 'rgba(234, 88, 12, 0.03)',
        chip: 'rgba(234, 88, 12, 0.18)',
        fg: '#c2410c',
      };
    case 'schematic':
      return {
        bgStart: 'rgba(124, 58, 237, 0.12)',
        bgEnd: 'rgba(124, 58, 237, 0.03)',
        chip: 'rgba(124, 58, 237, 0.18)',
        fg: '#6d28d9',
      };
    case 'structured_procedure':
      return {
        bgStart: 'rgba(5, 150, 105, 0.12)',
        bgEnd: 'rgba(5, 150, 105, 0.03)',
        chip: 'rgba(5, 150, 105, 0.18)',
        fg: '#047857',
      };
    case 'markdown':
      return {
        bgStart: 'rgba(37, 108, 211, 0.10)',
        bgEnd: 'rgba(37, 108, 211, 0.02)',
        chip: 'rgba(37, 108, 211, 0.16)',
        fg: '#256CD3',
      };
    case 'file':
    default:
      return {
        bgStart: 'rgba(82, 82, 91, 0.10)',
        bgEnd: 'rgba(82, 82, 91, 0.02)',
        chip: 'rgba(82, 82, 91, 0.14)',
        fg: '#52525b',
      };
  }
}

function kindIcon(kind: string): LucideIcon {
  switch (kind) {
    case 'markdown':
    case 'structured_procedure':
      return FileText;
    case 'pdf':
      return FileType2;
    case 'video':
      return Video;
    case 'external_video':
      return Youtube;
    case 'schematic':
      return Layers;
    case 'slides':
      return Presentation;
    case 'file':
    default:
      return Paperclip;
  }
}

function InlineEmpty({ text }: { text: string }) {
  return <p className="py-8 text-center text-sm text-ink-tertiary">{text}</p>;
}

function ErrorState({ text }: { text: string }) {
  return (
    <p className="rounded-md border border-signal-fault/40 bg-signal-fault/10 p-3 text-sm text-signal-fault">
      {text}
    </p>
  );
}

function DocView({ doc, onBack }: { doc: DocumentBody; onBack: () => void }) {
  const Icon = kindIcon(doc.kind);
  // Lock body scroll while the overlay is up so only the doc content scrolls.
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  const isFramed =
    doc.kind === 'pdf' ||
    doc.kind === 'schematic' ||
    doc.kind === 'slides' ||
    doc.kind === 'video' ||
    doc.kind === 'external_video';

  return (
    <div className="doc-overlay" role="dialog" aria-modal="true" aria-label={doc.title}>
      <header className="doc-overlay-bar">
        <button
          type="button"
          onClick={onBack}
          className="app-topbar-btn"
          aria-label="Close document"
        >
          <ChevronLeft size={22} strokeWidth={2} />
        </button>
        <div className="doc-overlay-title">
          <span className="inline-flex items-center gap-1.5 caption">
            <Icon size={12} strokeWidth={2} />
            {kindLabel(doc.kind)}
          </span>
          <h2 className="truncate text-base font-semibold">{doc.title}</h2>
        </div>
        <button
          type="button"
          onClick={onBack}
          className="app-topbar-btn"
          aria-label="Close document"
        >
          <X size={20} strokeWidth={2} />
        </button>
      </header>
      <div className={isFramed ? 'doc-overlay-frame' : 'doc-overlay-scroll'}>
        {doc.safetyCritical && (
          <div className="mx-auto max-w-3xl rounded-md border border-signal-safety/50 bg-signal-safety/10 p-4 mt-4">
            <div className="flex items-start gap-3">
              <ShieldAlert size={20} strokeWidth={2} className="mt-0.5 text-signal-safety" />
              <div>
                <p className="font-semibold text-signal-safety">Safety-critical procedure</p>
                <p className="text-sm text-ink-secondary">
                  Follow verbatim. Do not skip steps. If unsure, stop and ask.
                </p>
              </div>
            </div>
          </div>
        )}
        <DocContent doc={doc} />
      </div>
    </div>
  );
}

function DocContent({ doc }: { doc: DocumentBody }) {
  if (doc.kind === 'markdown' || doc.kind === 'structured_procedure') {
    if (!doc.bodyMarkdown)
      return <InlineEmpty text="This document has no body." />;
    return (
      <div className="markdown-body text-base">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{doc.bodyMarkdown}</ReactMarkdown>
      </div>
    );
  }

  if (doc.kind === 'pdf') {
    if (!doc.fileUrl) return <InlineEmpty text="No file attached." />;
    return <FramedFile url={doc.fileUrl} filename={doc.originalFilename} title={doc.title} />;
  }

  if (doc.kind === 'video') {
    if (doc.streamPlaybackId) {
      return (
        <div className="overflow-hidden rounded-md border border-line">
          <iframe
            src={`https://stream.mux.com/${doc.streamPlaybackId}.m3u8`}
            title={doc.title}
            className="aspect-video w-full bg-black"
            allowFullScreen
          />
        </div>
      );
    }
    if (doc.fileUrl) {
      return (
        <video
          controls
          preload="metadata"
          className="aspect-video w-full rounded-md border border-line bg-black"
          src={doc.fileUrl}
        />
      );
    }
    return <InlineEmpty text="Video source missing." />;
  }

  if (doc.kind === 'external_video') {
    if (!doc.externalUrl) return <InlineEmpty text="No URL set." />;
    const embed = toEmbedUrl(doc.externalUrl);
    if (!embed) {
      return (
        <a
          href={doc.externalUrl}
          target="_blank"
          rel="noreferrer"
          className="text-sm text-brand hover:underline"
        >
          Open video in new tab ↗
        </a>
      );
    }
    return (
      <div className="overflow-hidden rounded-md border border-line">
        <iframe
          src={embed}
          title={doc.title}
          className="aspect-video w-full bg-black"
          allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
          allowFullScreen
        />
      </div>
    );
  }

  if (doc.kind === 'schematic') {
    if (!doc.fileUrl) return <InlineEmpty text="No file attached." />;
    const isImage = (doc.contentType ?? '').startsWith('image/');
    if (isImage) {
      return (
        <img
          src={doc.fileUrl}
          alt={doc.title}
          className="max-h-[80vh] w-full rounded-md border border-line bg-white object-contain"
        />
      );
    }
    return <FramedFile url={doc.fileUrl} filename={doc.originalFilename} title={doc.title} />;
  }

  if (doc.kind === 'slides') {
    if (!doc.fileUrl) return <InlineEmpty text="No file attached." />;
    const officeViewer = `https://view.officeapps.live.com/op/embed.aspx?src=${encodeURIComponent(doc.fileUrl)}`;
    const isLocalhost = /^https?:\/\/localhost|127\.0\.0\.1/i.test(doc.fileUrl);
    return (
      <div className="flex flex-col gap-3">
        {isLocalhost ? (
          <div className="rounded-md border border-line bg-surface-inset p-4 text-sm text-ink-secondary">
            Microsoft's slide viewer only renders files served from public URLs. In local
            dev, download the deck to view it.
          </div>
        ) : (
          <iframe
            src={officeViewer}
            title={doc.title}
            className="h-[70vh] w-full rounded-md border border-line bg-white"
          />
        )}
        <a
          href={doc.fileUrl}
          download={doc.originalFilename ?? undefined}
          className="touch self-start rounded border border-line bg-surface-elevated px-4 text-sm text-ink-primary hover:bg-surface-raised"
        >
          Download {doc.originalFilename ?? 'slides'}
        </a>
      </div>
    );
  }

  if (doc.kind === 'file') {
    if (!doc.fileUrl) return <InlineEmpty text="No file attached." />;
    return (
      <div className="flex items-center justify-between rounded-md border border-line bg-surface-elevated p-5">
        <div>
          <p className="font-mono text-sm text-ink-primary">
            {doc.originalFilename ?? 'Attached file'}
          </p>
          {doc.sizeBytes && (
            <p className="mt-1 text-xs text-ink-tertiary">{formatBytes(doc.sizeBytes)}</p>
          )}
        </div>
        <a
          href={doc.fileUrl}
          download={doc.originalFilename ?? undefined}
          className="touch rounded bg-brand px-5 text-sm font-semibold text-brand-ink hover:bg-brand-strong"
        >
          Download
        </a>
      </div>
    );
  }

  return <InlineEmpty text={`Unsupported document kind (${doc.kind}).`} />;
}

// Iframe viewer with fullscreen toggle. Used for PDFs and schematics. Rotating
// a tablet to landscape gives wide drawings the space they need.
function FramedFile({
  url,
  filename,
  title,
}: {
  url: string;
  filename: string | null | undefined;
  title: string;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);

  useEffect(() => {
    function onChange() {
      setIsFullscreen(document.fullscreenElement === containerRef.current);
    }
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);

  async function toggleFullscreen() {
    const el = containerRef.current;
    if (!el) return;
    try {
      if (!document.fullscreenElement) {
        await el.requestFullscreen();
      } else {
        await document.exitFullscreen();
      }
    } catch {
      window.open(url, '_blank', 'noreferrer');
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <div
        ref={containerRef}
        className={
          isFullscreen
            ? 'relative h-screen w-screen bg-black'
            : 'relative h-[65vh] w-full overflow-hidden rounded-md border border-line bg-white md:h-[75vh]'
        }
      >
        <iframe src={url} title={title} className="h-full w-full" />
        <button
          type="button"
          onClick={toggleFullscreen}
          className="absolute right-3 top-3 touch inline-flex items-center gap-2 rounded bg-surface-base/90 px-4 text-sm font-medium text-ink-primary shadow-[0_2px_10px_-2px_rgba(15,19,27,0.2)] backdrop-blur hover:bg-surface-raised"
        >
          {isFullscreen ? (
            <>
              <Minimize2 size={14} strokeWidth={2} /> Exit fullscreen
            </>
          ) : (
            <>
              <Maximize2 size={14} strokeWidth={2} /> Fullscreen
            </>
          )}
        </button>
      </div>
      <div className="flex items-center justify-between text-xs text-ink-tertiary">
        <span className="md:hidden">Rotate for landscape pages.</span>
        <a
          href={url}
          download={filename ?? undefined}
          target="_blank"
          rel="noreferrer"
          className="ml-auto inline-flex items-center gap-1.5 transition hover:text-ink-primary"
        >
          <Download size={12} strokeWidth={2} />
          Download {filename ?? 'file'}
        </a>
      </div>
    </div>
  );
}

function toEmbedUrl(raw: string): string | null {
  try {
    const url = new URL(raw);
    const host = url.hostname.replace(/^www\./, '');
    if (host === 'youtube.com' || host === 'm.youtube.com') {
      const id = url.searchParams.get('v');
      if (id) return `https://www.youtube.com/embed/${id}`;
    }
    if (host === 'youtu.be') {
      const id = url.pathname.replace(/^\//, '');
      if (id) return `https://www.youtube.com/embed/${id}`;
    }
    if (host === 'vimeo.com') {
      const id = url.pathname.replace(/^\//, '').split('/')[0];
      if (id) return `https://player.vimeo.com/video/${id}`;
    }
    if (host.endsWith('mux.com')) return raw;
    return raw;
  } catch {
    return null;
  }
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
