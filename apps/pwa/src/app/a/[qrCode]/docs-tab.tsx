'use client';

import { useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  ChevronLeft,
  CircuitBoard,
  Download,
  FileText,
  FileType2,
  ListChecks,
  Maximize2,
  Minimize2,
  Paperclip,
  Presentation,
  Search,
  ShieldAlert,
  Video,
  X,
  Youtube,
  type LucideIcon,
} from 'lucide-react';
import { DocListSkeleton } from '@/components/skeleton';
import { EmptyState } from '@/components/empty-state';
import NoRevision from '@/components/illustrations/no-revision';
import NoDocuments from '@/components/illustrations/no-documents';
import NoSearchResults from '@/components/illustrations/no-search-results';
import { SectionRenderer } from '@/components/section-renderer';
import { ProcedureRunner } from '@/components/procedure-runner/procedure-runner';
import { ProcedureAuthoringRunner } from '@/components/procedure-runner/procedure-authoring-runner';
import { AuthPrompt } from '@/components/auth-prompt';
import { Plus } from 'lucide-react';
import {
  listDocuments,
  getDocument,
  type DocumentListItem,
  type DocumentBody,
  type PwaDocumentSection,
} from '@/lib/api';
import { formatRefCode } from '@/lib/ref-code';

// One renderable card. Either represents an entire doc (legacy: no
// authored sections) or a single section of a doc. Tapping always opens
// the doc viewer; for section entries we pass `sections=[s]` so the
// viewer scopes itself to that one section.
type DocEntry = {
  key: string;
  docId: string;
  title: string; // primary heading
  parentDocTitle: string | null; // shown above the title only for section entries
  kind: DocumentListItem['kind'];
  language: string;
  thumbnailUrl: string | null;
  tags: string[]; // surfaced only on whole-doc entries
  sections: PwaDocumentSection[] | null; // null = whole doc, [s] = scoped to that section
  // Ref code for scan-friendly identification:
  //   whole-doc: DOC-{1-indexed doc position in the API response}
  //   section:   SEC-{1-indexed section position within parent doc} · PG XX-YY
  refCode: string;
  // Field-captured doc surfacing — drives the UNVERIFIED chip + author caption.
  source: 'oem' | 'field';
  verified: boolean;
  capturedByDisplayName: string | null;
};

function buildEntries(docs: DocumentListItem[]): DocEntry[] {
  const out: DocEntry[] = [];
  docs.forEach((d, di) => {
    const source = d.source ?? 'oem';
    const verified = d.verified ?? true;
    const capturedByDisplayName = d.capturedByDisplayName ?? null;
    const sections = d.sections;
    if (!sections || sections.length === 0) {
      out.push({
        key: d.id,
        docId: d.id,
        title: d.title,
        parentDocTitle: null,
        kind: d.kind,
        language: d.language,
        thumbnailUrl: d.thumbnailUrl ?? null,
        tags: d.tags,
        sections: sections ?? null,
        refCode: formatRefCode(di + 1, null),
        source,
        verified,
        capturedByDisplayName,
      });
      return;
    }
    sections.forEach((s, si) => {
      out.push({
        key: `${d.id}:${s.id}`,
        docId: d.id,
        title: s.title || 'Untitled section',
        parentDocTitle: d.title,
        kind: d.kind,
        language: d.language,
        thumbnailUrl: d.thumbnailUrl ?? null,
        tags: [], // section cards don't repeat doc-level tags
        sections: [s],
        refCode: formatRefCode(si + 1, s),
        source,
        verified,
        capturedByDisplayName,
      });
    });
  });
  return out;
}

interface OpenDoc {
  doc: DocumentBody;
  sections: PwaDocumentSection[] | null;
}

// Threshold above which the search input renders. Below this, scanning is
// faster than typing — keep the surface clean.
const SEARCH_THRESHOLD = 8;

// Identity for procedure runs (auth-required surface). Reads stay scan-only;
// these env vars stand in for the OIDC tokens until prod sign-in is wired.
const DEV_USER_ID = process.env.NEXT_PUBLIC_DEV_USER_ID ?? '';
const DEV_ORG_ID = process.env.NEXT_PUBLIC_DEV_ORG_ID ?? '';

export function DocsTab({
  versionId,
  fieldCapturesVersionId,
  assetInstanceId,
}: {
  versionId: string | null;
  fieldCapturesVersionId: string | null;
  assetInstanceId: string;
}) {
  const [docs, setDocs] = useState<DocumentListItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<OpenDoc | null>(null);
  const [procedureDocId, setProcedureDocId] = useState<string | null>(null);
  const [authoringActive, setAuthoringActive] = useState(false);
  const [authPromptOpen, setAuthPromptOpen] = useState(false);
  const [query, setQuery] = useState('');

  // Refetch docs from BOTH the pinned OEM version AND the model's
  // field-captures version. Each row carries its own `source` ('oem' or
  // 'field') and `verified` flag so cards can render the UNVERIFIED chip.
  // Re-runs when authoring completes (incrementKey) so the new procedure
  // shows up without a manual refresh.
  const [refetchKey, setRefetchKey] = useState(0);
  useEffect(() => {
    let cancelled = false;
    const oemP = versionId
      ? listDocuments(versionId, 'en', true, assetInstanceId)
      : Promise.resolve([] as DocumentListItem[]);
    const fieldP = fieldCapturesVersionId
      ? listDocuments(fieldCapturesVersionId, 'en', true, assetInstanceId)
      : Promise.resolve([] as DocumentListItem[]);
    Promise.all([oemP, fieldP])
      .then(([oem, field]) => {
        if (cancelled) return;
        setDocs([...oem, ...field]);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [versionId, fieldCapturesVersionId, assetInstanceId, refetchKey]);

  if (!versionId && !fieldCapturesVersionId) {
    return (
      <EmptyState
        illustration={NoRevision}
        title="No revision pinned"
        description="No content version is pinned to this asset yet."
        tone="neutral"
      />
    );
  }
  if (error) return <ErrorState text={error} />;
  if (docs === null) return <DocListSkeleton />;

  function onTapDocumentProcedure() {
    if (!DEV_USER_ID) {
      setAuthPromptOpen(true);
      return;
    }
    setAuthoringActive(true);
  }

  if (authoringActive) {
    return (
      <ProcedureAuthoringRunner
        assetInstanceId={assetInstanceId}
        devUserId={DEV_USER_ID}
        devOrgId={DEV_ORG_ID}
        onClose={() => {
          setAuthoringActive(false);
          // Re-fetch so the just-captured procedure appears in the list.
          setRefetchKey((k) => k + 1);
        }}
      />
    );
  }

  if (procedureDocId) {
    return (
      <ProcedureRunner
        docId={procedureDocId}
        assetInstanceId={assetInstanceId}
        devUserId={DEV_USER_ID}
        devOrgId={DEV_ORG_ID}
        onClose={() => {
          setProcedureDocId(null);
          // Re-fetch in case the run touched verification state etc.
          setRefetchKey((k) => k + 1);
        }}
      />
    );
  }

  if (open) {
    return (
      <DocView
        doc={open.doc}
        sections={open.sections}
        onBack={() => setOpen(null)}
      />
    );
  }

  const entries = buildEntries(docs);
  const showSearch = entries.length > SEARCH_THRESHOLD;
  const q = query.trim().toLowerCase();
  const filtered = q
    ? entries.filter((e) => {
        const hay = [
          e.title,
          e.parentDocTitle,
          e.refCode,
          kindLabel(e.kind),
          ...e.tags,
        ]
          .filter(Boolean)
          .join(' ')
          .toLowerCase();
        return hay.includes(q);
      })
    : entries;

  return (
    <div className="flex flex-col gap-3">
      <button
        type="button"
        onClick={onTapDocumentProcedure}
        className="btn btn-primary self-start"
      >
        <Plus size={16} strokeWidth={2} /> Document a procedure
      </button>
      {showSearch && (
        <label className="search-input">
          <Search size={16} strokeWidth={2} className="text-ink-tertiary" />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search by title, ref code, kind, or tag"
          />
        </label>
      )}
      {entries.length === 0 ? (
        <EmptyState
          illustration={NoDocuments}
          title="No documents yet"
          description="Either nothing has been published in this revision, or no procedures have been captured here yet. Tap “Document a procedure” to capture the first one."
          tone="neutral"
        />
      ) : filtered.length === 0 ? (
        <EmptyState
          illustration={NoSearchResults}
          title="No documents match your search"
          description="Try a different keyword, ref code, or document kind."
          tone="neutral"
        />
      ) : (
        <ul className="grid grid-cols-1 gap-2.5 md:grid-cols-2 lg:grid-cols-3">
          {filtered.map((e) => {
            const Icon = kindIcon(e.kind);
            return (
          <li key={e.key}>
            <button
              onClick={async () => {
                // Procedure docs launch the interactive runner instead of
                // the static viewer. Auth gate: only required for procedure
                // runs, not for reading any other doc kind.
                if (e.kind === 'structured_procedure') {
                  if (!DEV_USER_ID) {
                    setAuthPromptOpen(true);
                    return;
                  }
                  setProcedureDocId(e.docId);
                  return;
                }
                const full = await getDocument(e.docId);
                if (full) setOpen({ doc: full, sections: e.sections });
              }}
              className="surface-etched group flex h-full w-full flex-col overflow-hidden text-left"
            >
              <div
                className="relative flex aspect-[16/9] w-full items-center justify-center overflow-hidden"
                style={{ background: 'rgb(var(--surface-elevated))' }}
              >
                {e.thumbnailUrl ? (
                  <img
                    src={e.thumbnailUrl}
                    alt=""
                    className="h-full w-full object-cover"
                  />
                ) : (
                  <div className="doc-thumb-placeholder text-ink-secondary">
                    <div className="icon-chip icon-chip-lg icon-chip-neutral">
                      <Icon size={28} strokeWidth={1.5} />
                    </div>
                    <span className="doc-thumb-label text-ink-tertiary">
                      {kindLabel(e.kind)}
                    </span>
                  </div>
                )}
              </div>
              <div className="flex flex-1 flex-col gap-2 p-4">
                <span className="inline-flex flex-wrap items-center gap-x-1.5 gap-y-0.5 caption">
                  <Icon size={12} strokeWidth={1.75} />
                  {kindLabel(e.kind)}
                  {e.language !== 'en' && ` · ${e.language.toUpperCase()}`}
                  <span className="tnum normal-case text-ink-tertiary">· {e.refCode}</span>
                  {e.parentDocTitle && (
                    <span className="ml-1 truncate text-ink-tertiary normal-case">
                      · {e.parentDocTitle}
                    </span>
                  )}
                </span>
                <h3 className="text-base font-medium text-ink-primary group-hover:text-brand">
                  {e.title}
                </h3>
                {e.source === 'field' && (
                  <span
                    className={`inline-flex w-fit items-center gap-1 rounded-sm border px-1.5 py-0.5 font-mono text-[10.5px] uppercase tracking-wider ${
                      e.verified
                        ? 'border-signal-ok/40 bg-signal-ok/10 text-signal-ok'
                        : 'border-signal-warn/40 bg-signal-warn/10 text-signal-warn'
                    }`}
                    title={
                      e.capturedByDisplayName
                        ? `Captured by ${e.capturedByDisplayName}`
                        : 'Field-captured'
                    }
                  >
                    {e.verified ? '✓ Verified · Field' : '⚠ Unverified · Field'}
                    {e.capturedByDisplayName && (
                      <span className="normal-case font-normal opacity-80">
                        · {e.capturedByDisplayName}
                      </span>
                    )}
                  </span>
                )}
                {e.tags.length > 0 && (
                  <div className="mt-auto flex flex-wrap gap-1 pt-1">
                    {e.tags.map((t) => (
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
      )}
      {authPromptOpen && (
        <AuthPrompt
          reason="start a procedure"
          onClose={() => setAuthPromptOpen(false)}
        />
      )}
    </div>
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

function kindIcon(kind: string): LucideIcon {
  switch (kind) {
    case 'markdown':
      return FileText;
    case 'structured_procedure':
      return ListChecks;
    case 'pdf':
      return FileType2;
    case 'video':
      return Video;
    case 'external_video':
      return Youtube;
    case 'schematic':
      return CircuitBoard;
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

function DocView({
  doc,
  sections,
  onBack,
}: {
  doc: DocumentBody;
  sections: PwaDocumentSection[] | null;
  onBack: () => void;
}) {
  const Icon = kindIcon(doc.kind);
  // Lock body scroll while the overlay is up so only the doc content scrolls.
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  // Sections-aware: when a non-empty array is passed, only render those
  // sections (scoped view). null/empty falls back to the kind-specific
  // full-doc renderer.
  const sectionMode = sections != null && sections.length > 0;

  const isFramed =
    !sectionMode &&
    (doc.kind === 'pdf' ||
      doc.kind === 'schematic' ||
      doc.kind === 'slides' ||
      doc.kind === 'video' ||
      doc.kind === 'external_video');

  // For a single-section view, prefer the section title in the header so
  // the user knows what they're scoped to.
  const headerTitle =
    sectionMode && sections!.length === 1 ? sections![0]!.title : doc.title;

  return (
    <div className="doc-overlay" role="dialog" aria-modal="true" aria-label={headerTitle}>
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
            <Icon size={12} strokeWidth={1.75} />
            {kindLabel(doc.kind)}
            {sectionMode && sections!.length === 1 && (
              <span className="ml-1 truncate text-ink-tertiary normal-case">
                · {doc.title}
              </span>
            )}
          </span>
          <h2 className="truncate text-base font-semibold">{headerTitle}</h2>
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
        {isFramed && (
          <>
            <span className="corner-mark tl" aria-hidden />
            <span className="corner-mark tr" aria-hidden />
            <span className="corner-mark bl" aria-hidden />
            <span className="corner-mark br" aria-hidden />
          </>
        )}
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
        {sectionMode ? (
          <div className="flex flex-col gap-1 pb-6">
            {sections!.map((s, i) => (
              <SectionRenderer key={s.id} doc={doc} section={s} index={i + 1} />
            ))}
          </div>
        ) : (
          <DocContent doc={doc} />
        )}
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
            <p className="mt-1 font-mono text-xs tabular-nums text-ink-tertiary">
              {formatBytes(doc.sizeBytes)}
            </p>
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
