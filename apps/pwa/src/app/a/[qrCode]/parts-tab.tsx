'use client';

import { useEffect, useMemo, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  ChevronLeft,
  ChevronRight,
  FileText,
  FileType2,
  GraduationCap,
  Layers,
  Package,
  Paperclip,
  Presentation,
  Search,
  ShieldAlert,
  Video,
  X,
  Youtube,
  type LucideIcon,
} from 'lucide-react';
import {
  getDocument,
  getPartResources,
  listParts,
  type BomEntry,
  type DocumentBody,
  type PartResources,
} from '@/lib/api';

interface LightboxTarget {
  src: string;
  title: string;
  oemPartNumber: string;
}

export function PartsTab({
  assetModelId,
  assetInstanceId,
}: {
  assetModelId: string;
  assetInstanceId: string;
}) {
  const [rows, setRows] = useState<BomEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [lightbox, setLightbox] = useState<LightboxTarget | null>(null);
  const [openPartId, setOpenPartId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    listParts(assetModelId)
      .then((r) => {
        if (!cancelled) setRows(r);
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
    return () => {
      cancelled = true;
    };
  }, [assetModelId]);

  const filtered = useMemo(() => {
    if (!rows) return null;
    const q = query.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((r) => {
      const hay = [
        r.displayName,
        r.oemPartNumber,
        r.positionRef,
        ...r.crossReferences,
        r.description,
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      return hay.includes(q);
    });
  }, [rows, query]);

  if (error)
    return (
      <p
        className="rounded-md border p-3 text-sm"
        style={{
          borderColor: 'rgba(var(--signal-fault) / 0.4)',
          background: 'rgba(var(--signal-fault) / 0.1)',
          color: 'rgb(var(--signal-fault))',
        }}
      >
        {error}
      </p>
    );
  if (!rows) return <p className="py-8 text-center text-sm text-ink-tertiary">Loading…</p>;
  if (rows.length === 0)
    return (
      <p className="py-8 text-center text-sm text-ink-tertiary">
        No BOM entries for this asset model.
      </p>
    );

  return (
    <div className="flex flex-col gap-4">
      <label className="search-input">
        <Search size={16} strokeWidth={2} className="text-ink-tertiary" />
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search by part #, name, position, or cross-ref"
        />
      </label>

      <ul className="flex flex-col gap-2">
        {(filtered ?? []).map((r) => (
          <li key={r.bomEntryId} className={`part-row ${r.discontinued ? 'opacity-70' : ''}`}>
            <div className="flex items-start gap-4">
              {r.imageUrl ? (
                <button
                  type="button"
                  onClick={() =>
                    setLightbox({
                      src: r.imageUrl!,
                      title: r.displayName,
                      oemPartNumber: r.oemPartNumber ?? '',
                    })
                  }
                  aria-label={`View full image of ${r.displayName}`}
                  className="flex h-14 w-14 shrink-0 items-center justify-center rounded p-1 transition hover:border-brand/60"
                  style={{
                    background: 'rgb(var(--surface-inset))',
                    border: '1px solid rgb(var(--line-subtle))',
                  }}
                >
                  <img
                    src={r.imageUrl}
                    alt=""
                    className="max-h-full max-w-full object-contain"
                    draggable={false}
                  />
                </button>
              ) : (
                <div
                  className="flex h-14 w-14 shrink-0 items-center justify-center rounded text-ink-tertiary"
                  style={{
                    background: 'rgb(var(--surface-inset))',
                    border: '1px solid rgb(var(--line-subtle))',
                  }}
                >
                  <Package size={20} strokeWidth={1.5} />
                </div>
              )}
              <button
                type="button"
                onClick={() => setOpenPartId(r.partId)}
                aria-label={`Open ${r.displayName} details`}
                className="flex flex-1 min-w-0 flex-col items-start text-left"
              >
                <div className="mb-1.5 flex items-baseline gap-3">
                  <span className="part-num">{r.oemPartNumber}</span>
                  <span className="part-name">{r.displayName}</span>
                </div>
                {r.description && <p className="part-desc mb-2">{r.description}</p>}
                <div className="flex flex-wrap items-center gap-x-4 gap-y-1 font-mono text-[11px]">
                  {r.positionRef && (
                    <span className="flex items-center gap-1.5">
                      <span className="cap" style={{ letterSpacing: '0.08em' }}>Pos</span>
                      <span className="text-ink-primary">{r.positionRef}</span>
                    </span>
                  )}
                  <span className="flex items-center gap-1.5">
                    <span className="cap" style={{ letterSpacing: '0.08em' }}>Qty</span>
                    <span className="text-ink-primary tabular-nums">{r.quantity}</span>
                  </span>
                  {r.crossReferences.length > 0 && (
                    <span className="flex items-center gap-1.5">
                      <span className="cap" style={{ letterSpacing: '0.08em' }}>Xref</span>
                      {r.crossReferences.map((xr) => (
                        <span key={xr} className="part-xref">
                          {xr}
                        </span>
                      ))}
                    </span>
                  )}
                </div>
              </button>
              {r.discontinued && <span className="pill pill-warn">Discontinued</span>}
              <ChevronRight
                size={18}
                strokeWidth={2}
                className="shrink-0 self-center text-ink-tertiary"
              />
            </div>
          </li>
        ))}
        {filtered && filtered.length === 0 && (
          <li className="py-8 text-center text-sm text-ink-tertiary">
            No parts match your search.
          </li>
        )}
      </ul>

      {openPartId && (
        <PartDetailOverlay
          partId={openPartId}
          assetInstanceId={assetInstanceId}
          onClose={() => setOpenPartId(null)}
        />
      )}

      {lightbox && <ImageLightbox target={lightbox} onClose={() => setLightbox(null)} />}
    </div>
  );
}

// Tap a part thumb to zoom. Full-viewport overlay, native pinch-zoom on
// mobile (touch-action: pinch-zoom), Escape / backdrop tap / X to close.
// Uses object-contain on the image itself so the whole part is visible at
// its natural aspect ratio regardless of how the PWA window is sized.
function ImageLightbox({
  target,
  onClose,
}: {
  target: LightboxTarget;
  onClose: () => void;
}) {
  // Lock body scroll and wire Escape so the overlay behaves like a modal.
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', onKey);
    return () => {
      document.body.style.overflow = prev;
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  return (
    <div
      className="doc-overlay"
      role="dialog"
      aria-modal="true"
      aria-label={`Image of ${target.title}`}
      onClick={onClose}
    >
      <header className="doc-overlay-bar">
        <div className="doc-overlay-title">
          {target.oemPartNumber && (
            <span className="caption">{target.oemPartNumber}</span>
          )}
          <h2 className="truncate text-base font-semibold">{target.title}</h2>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="app-topbar-btn"
          aria-label="Close image"
        >
          <X size={20} strokeWidth={2} />
        </button>
      </header>
      <div
        className="flex flex-1 items-center justify-center overflow-auto p-4"
        style={{ touchAction: 'pinch-zoom', background: 'rgb(var(--surface-elevated))' }}
        onClick={(e) => e.stopPropagation()}
      >
        <img
          src={target.src}
          alt={target.title}
          className="max-h-full max-w-full object-contain"
          draggable={false}
        />
      </div>
    </div>
  );
}

// Full part detail — opens from a tap on a part row. Shows the image,
// metadata, and author-curated links to documents + training for this part,
// scoped to the asset instance's pinned content pack version. Documents
// themselves open the existing doc-overlay UX by reusing its shell.
function PartDetailOverlay({
  partId,
  assetInstanceId,
  onClose,
}: {
  partId: string;
  assetInstanceId: string;
  onClose: () => void;
}) {
  const [data, setData] = useState<PartResources | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openDoc, setOpenDoc] = useState<DocumentBody | null>(null);

  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', onKey);
    return () => {
      document.body.style.overflow = prev;
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  useEffect(() => {
    let cancelled = false;
    getPartResources(partId, assetInstanceId)
      .then((r) => {
        if (!cancelled) setData(r);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [partId, assetInstanceId]);

  async function openDocument(docId: string) {
    try {
      const body = await getDocument(docId);
      if (body) setOpenDoc(body);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <div className="doc-overlay" role="dialog" aria-modal="true" aria-label="Part detail">
      <header className="doc-overlay-bar">
        <button
          type="button"
          onClick={onClose}
          className="app-topbar-btn"
          aria-label="Close part detail"
        >
          <ChevronLeft size={22} strokeWidth={2} />
        </button>
        <div className="doc-overlay-title">
          <span className="caption">
            {data?.part.oemPartNumber ?? 'Part'}
          </span>
          <h2 className="truncate text-base font-semibold">
            {data?.part.displayName ?? 'Loading…'}
          </h2>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="app-topbar-btn"
          aria-label="Close part detail"
        >
          <X size={20} strokeWidth={2} />
        </button>
      </header>

      <div className="doc-overlay-scroll">
        {error && (
          <p className="mx-auto max-w-3xl rounded-md border border-signal-fault/40 bg-signal-fault/10 p-3 text-sm text-signal-fault">
            {error}
          </p>
        )}
        {!data && !error ? (
          <p className="py-12 text-center text-sm text-ink-tertiary">Loading…</p>
        ) : data ? (
          <div className="mx-auto flex max-w-3xl flex-col gap-6">
            {/* Hero image — tap to zoom (reuses the existing lightbox pattern inline) */}
            {data.part.imageUrl && (
              <div
                className="flex items-center justify-center rounded-md p-4"
                style={{
                  background: 'rgb(var(--surface-inset))',
                  border: '1px solid rgb(var(--line-subtle))',
                  minHeight: 180,
                }}
              >
                <img
                  src={data.part.imageUrl}
                  alt={data.part.displayName}
                  className="max-h-64 max-w-full object-contain"
                  draggable={false}
                />
              </div>
            )}

            {/* Metadata */}
            <section className="flex flex-col gap-3">
              {data.part.description && (
                <div className="markdown-body text-sm">
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>
                    {data.part.description}
                  </ReactMarkdown>
                </div>
              )}
              {data.part.crossReferences.length > 0 && (
                <div className="flex flex-wrap items-center gap-2">
                  <span className="caption">Cross-refs</span>
                  {data.part.crossReferences.map((xr) => (
                    <span key={xr} className="part-xref">
                      {xr}
                    </span>
                  ))}
                </div>
              )}
              {data.part.discontinued && (
                <span className="pill pill-warn w-fit">Discontinued</span>
              )}
            </section>

            {/* Linked documents */}
            <section className="flex flex-col gap-2">
              <h3 className="caption">Documents</h3>
              {data.documents.length === 0 ? (
                <p className="text-sm text-ink-tertiary">
                  No documents linked to this part.
                </p>
              ) : (
                <ul className="flex flex-col gap-1.5">
                  {data.documents.map((d) => {
                    const Icon = kindIcon(d.kind);
                    return (
                      <li key={d.id}>
                        <button
                          type="button"
                          onClick={() => openDocument(d.id)}
                          className="flex w-full items-center gap-3 rounded-md border border-line bg-surface-raised px-4 py-3 text-left transition hover:border-brand/40"
                        >
                          <Icon
                            size={18}
                            strokeWidth={2}
                            className="shrink-0 text-ink-secondary"
                          />
                          <div className="flex-1 min-w-0">
                            <div className="truncate text-sm font-medium text-ink-primary">
                              {d.title}
                            </div>
                            <div className="text-xs text-ink-tertiary">
                              {kindLabel(d.kind)}
                              {d.language !== 'en' && ` · ${d.language.toUpperCase()}`}
                            </div>
                          </div>
                          {d.safetyCritical && (
                            <span className="pill pill-safety">
                              <ShieldAlert size={10} strokeWidth={2.5} />
                              Safety
                            </span>
                          )}
                          <ChevronRight
                            size={16}
                            strokeWidth={2}
                            className="shrink-0 text-ink-tertiary"
                          />
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>

            {/* Linked training modules */}
            <section className="flex flex-col gap-2">
              <h3 className="caption">Training</h3>
              {data.trainingModules.length === 0 ? (
                <p className="text-sm text-ink-tertiary">
                  No training modules linked to this part.
                </p>
              ) : (
                <ul className="flex flex-col gap-1.5">
                  {data.trainingModules.map((m) => (
                    <li
                      key={m.id}
                      className="flex items-center gap-3 rounded-md border border-line bg-surface-raised px-4 py-3"
                    >
                      <GraduationCap
                        size={18}
                        strokeWidth={2}
                        className="shrink-0 text-ink-secondary"
                      />
                      <div className="flex-1 min-w-0">
                        <div className="text-sm font-medium text-ink-primary">
                          {m.title}
                        </div>
                        {m.description && (
                          <div className="line-clamp-2 text-xs text-ink-tertiary">
                            {m.description}
                          </div>
                        )}
                      </div>
                      {m.estimatedMinutes && (
                        <span className="font-mono text-xs text-ink-tertiary">
                          {m.estimatedMinutes}m
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>
        ) : null}
      </div>

      {openDoc && <PartDocView doc={openDoc} onBack={() => setOpenDoc(null)} />}
    </div>
  );
}

// Lightweight doc viewer for part-linked documents. Reuses the same overlay
// shell as the main Documents tab but omits the chrome around it — it's
// already inside the part overlay stack. Stacks on top of the part overlay
// with a higher z-index; tapping back returns to the part view.
function PartDocView({ doc, onBack }: { doc: DocumentBody; onBack: () => void }) {
  const isFramed =
    doc.kind === 'pdf' ||
    doc.kind === 'schematic' ||
    doc.kind === 'slides' ||
    doc.kind === 'video' ||
    doc.kind === 'external_video';

  return (
    <div
      className="doc-overlay"
      role="dialog"
      aria-modal="true"
      aria-label={doc.title}
      style={{ zIndex: 70 }}
    >
      <header className="doc-overlay-bar">
        <button
          type="button"
          onClick={onBack}
          className="app-topbar-btn"
          aria-label="Back to part"
        >
          <ChevronLeft size={22} strokeWidth={2} />
        </button>
        <div className="doc-overlay-title">
          <span className="caption">{kindLabel(doc.kind)}</span>
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
        {(doc.kind === 'markdown' || doc.kind === 'structured_procedure') &&
          doc.bodyMarkdown && (
            <div className="markdown-body text-base">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{doc.bodyMarkdown}</ReactMarkdown>
            </div>
          )}
        {doc.kind === 'pdf' && doc.fileUrl && (
          <iframe src={doc.fileUrl} title={doc.title} className="h-full w-full border-0" />
        )}
        {doc.kind === 'schematic' && doc.fileUrl && (
          <img
            src={doc.fileUrl}
            alt={doc.title}
            className="h-full w-full object-contain"
            style={{ background: 'rgb(var(--surface-elevated))' }}
          />
        )}
        {doc.kind === 'external_video' && doc.externalUrl && (
          <iframe
            src={toEmbed(doc.externalUrl)}
            title={doc.title}
            className="h-full w-full border-0 bg-black"
            allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
            allowFullScreen
          />
        )}
        {doc.kind === 'video' && doc.fileUrl && (
          <video src={doc.fileUrl} controls className="h-full w-full bg-black" />
        )}
        {doc.kind === 'file' && doc.fileUrl && (
          <div className="mx-auto flex max-w-xl flex-col gap-3 p-4">
            <p className="font-mono text-sm text-ink-primary">
              {doc.originalFilename ?? 'Attached file'}
            </p>
            <a
              href={doc.fileUrl}
              download={doc.originalFilename ?? undefined}
              className="touch self-start rounded bg-brand px-5 py-2.5 text-sm font-semibold text-brand-ink"
            >
              Download
            </a>
          </div>
        )}
      </div>
    </div>
  );
}

function toEmbed(raw: string): string {
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
    return raw;
  } catch {
    return raw;
  }
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
