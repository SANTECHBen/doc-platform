'use client';

import { useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  AudioLines,
  BookPlus,
  Camera,
  ChevronDown,
  FileText,
  ListChecks,
  Play,
  Send,
  Square,
  Trash2,
  X,
} from 'lucide-react';
import type { AssetHubPayload } from '@/lib/shared-schema';
import {
  fetchMe,
  listDocuments,
  promoteAiMessageToProcedure,
  streamChat,
  uploadFile,
  type ChatCitation,
  type DocumentListItem,
  type MeIdentity,
  type UploadResult,
  type VerifyResult,
} from '@/lib/api';
import { VoiceMode } from '@/components/voice-mode';
import { VirtualJobAid } from '@/components/virtual-job-aid';
import { useToast } from '@/components/toast';

// AI emits [procedure:<uuid>] when an authored procedure matches the
// user's question — we swap the prose bubble for a launcher that opens
// VirtualJobAid. There is intentionally NO inline-steps directive: the
// product is curated authored content, and AI-improvised step lists
// would commoditize that. Procedural answers without an authored match
// render as normal prose with a "Promote to procedure" affordance for
// admins.
const PROCEDURE_DIRECTIVE_RE =
  /\[procedure:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\]/i;

function extractProcedureId(text: string): string | null {
  const m = PROCEDURE_DIRECTIVE_RE.exec(text);
  return m && m[1] ? m[1] : null;
}

type UserTurn = { role: 'user'; text: string; imageUrl?: string };
type AssistantTurn = {
  role: 'assistant';
  text: string;
  citations: ChatCitation[];
  streaming: boolean;
  verify?: VerifyResult;
  /** Server-side message id, populated on the `done` event. Required for
   *  admin actions like Promote-to-procedure that need to point back at
   *  the exact AI message. Absent on locally-injected turns (e.g. from
   *  voice mode handoff). */
  messageId?: string;
};
type Turn = UserTurn | AssistantTurn;

const DEV_USER_ID = process.env.NEXT_PUBLIC_DEV_USER_ID ?? '';
const DEV_ORG_ID = process.env.NEXT_PUBLIC_DEV_ORG_ID ?? '';

// Per-conversation store. Keyed by assetInstanceId (optionally scoped to a
// partId) so asset-wide chats and part-specific chats persist independently
// across tab switches and reloads.
const CHAT_STORAGE_VERSION = 1;
function chatStorageKey(assetInstanceId: string, partId?: string): string {
  return partId
    ? `eh:chat:v${CHAT_STORAGE_VERSION}:${assetInstanceId}:${partId}`
    : `eh:chat:v${CHAT_STORAGE_VERSION}:${assetInstanceId}`;
}

interface StoredChat {
  turns: Turn[];
  conversationId?: string;
}

function loadChat(key: string): StoredChat {
  if (typeof window === 'undefined') return { turns: [] };
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return { turns: [] };
    const parsed = JSON.parse(raw) as StoredChat;
    // A previous session might have been killed mid-stream — the saved turn
    // would still carry streaming:true. Reset that flag so the UI doesn't
    // show a phantom cursor forever.
    const turns = (parsed.turns ?? []).map((t) =>
      t.role === 'assistant' ? { ...t, streaming: false } : t,
    );
    return { turns, conversationId: parsed.conversationId };
  } catch {
    return { turns: [] };
  }
}

function saveChat(key: string, state: StoredChat): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(key, JSON.stringify(state));
  } catch {
    // localStorage quota exhaustion is rare here (max ~50 turns = tens of KB),
    // but silent on failure — losing persistence is better than breaking chat.
  }
}

function clearChat(key: string): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.removeItem(key);
  } catch {
    // ignore
  }
}

export function ChatTab({
  hub,
  qrCode: _qrCode,
  partId,
  partName,
}: {
  hub: AssetHubPayload;
  qrCode: string;
  /** When set, chat is scoped to a specific part's linked docs. */
  partId?: string;
  /** Optional display name for the part — shown in the grounding banner. */
  partName?: string;
}) {
  const assetInstanceId = hub.assetInstance.id;
  const storageKey = chatStorageKey(assetInstanceId, partId);
  // Lazy-init from localStorage so the first render already has the saved
  // history — no flash of empty state on tab re-open.
  const [turns, setTurns] = useState<Turn[]>(() => loadChat(storageKey).turns);
  const [conversationId, setConversationId] = useState<string | undefined>(
    () => loadChat(storageKey).conversationId,
  );
  const [input, setInput] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [attachment, setAttachment] = useState<UploadResult | null>(null);
  const [uploading, setUploading] = useState(false);
  // Hold the last failed file so the tech can tap "Retry" instead of
  // re-picking from the camera roll. Cleared on successful upload, on
  // retry success, or when the user dismisses.
  const [failedUpload, setFailedUpload] = useState<File | null>(null);
  const cameraRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const [voiceOpen, setVoiceOpen] = useState(false);
  const [jobAid, setJobAid] = useState<{ procedureId: string } | null>(null);
  const [me, setMe] = useState<MeIdentity | null>(null);
  const [promoting, setPromoting] = useState<string | null>(null);
  // Suggestions shown in the empty state. Derived from this asset's
  // authored procedures + doc titles so the prompts are real options
  // for THIS equipment, not hard-coded examples. null = still loading,
  // empty array = no usable content yet (we'll fall back to generic).
  const [suggestions, setSuggestions] = useState<string[] | null>(null);
  const toast = useToast();

  // Pull identity once. The /me result decides whether we render the
  // admin-only "Promote to procedure" affordance. Server still enforces
  // auth on the actual promote call — this is purely UI gating.
  useEffect(() => {
    if (!DEV_USER_ID || !DEV_ORG_ID) return;
    void fetchMe(DEV_USER_ID, DEV_ORG_ID)
      .then(setMe)
      .catch(() => setMe(null));
  }, []);

  // Build empty-state suggestions from this asset's actual content.
  // Procedures first (they map directly to the [procedure:UUID] runner),
  // then a few PDF/markdown titles. Cheap one-shot fetch on mount.
  useEffect(() => {
    const versionId = hub.pinnedContentPackVersion?.id;
    if (!versionId) {
      setSuggestions([]);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const docs = await listDocuments(versionId);
        if (cancelled) return;
        const procedures = docs.filter((d: DocumentListItem) => d.kind === 'structured_procedure');
        const otherDocs = docs.filter(
          (d: DocumentListItem) => d.kind !== 'structured_procedure' && d.title.trim().length > 0,
        );
        const prompts: string[] = [];
        for (const p of procedures.slice(0, 3)) {
          prompts.push(`Walk me through ${p.title.toLowerCase()}`);
        }
        for (const d of otherDocs) {
          if (prompts.length >= 3) break;
          prompts.push(`What does ${d.title} cover?`);
        }
        setSuggestions(prompts);
      } catch {
        if (!cancelled) setSuggestions([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [hub.pinnedContentPackVersion?.id]);

  const adminBaseUrl = process.env.NEXT_PUBLIC_ADMIN_ORIGIN ?? '';

  async function onPromote(turn: AssistantTurn) {
    if (!turn.messageId || promoting) return;
    setPromoting(turn.messageId);
    try {
      const result = await promoteAiMessageToProcedure({
        messageId: turn.messageId,
        devUserId: DEV_USER_ID,
        devOrgId: DEV_ORG_ID,
      });
      const editorUrl = adminBaseUrl
        ? `${adminBaseUrl}/procedures/${encodeURIComponent(result.documentId)}/edit`
        : null;
      toast.success(
        `Created draft procedure with ${result.stepCount} step${result.stepCount === 1 ? '' : 's'}`,
        result.hadStructure
          ? 'Refine in the admin editor — add media and voiceover.'
          : 'AI prose was kept as one step; split it in the editor.',
      );
      if (editorUrl) {
        window.open(editorUrl, '_blank', 'noopener,noreferrer');
      }
    } catch (err) {
      toast.error('Could not promote answer', err instanceof Error ? err.message : String(err));
    } finally {
      setPromoting(null);
    }
  }

  // Listen for launcher events fired by ProcedureLauncherCard. A window
  // event keeps launchers decoupled from where they're rendered (chat tab,
  // voice mode, future surfaces).
  useEffect(() => {
    function onOpen(e: Event) {
      const detail = (e as CustomEvent<{ source: { kind: 'doc'; procedureId: string } }>).detail;
      if (detail?.source?.kind === 'doc') {
        setJobAid({ procedureId: detail.source.procedureId });
      }
    }
    window.addEventListener('virtual-job-aid:open', onOpen);
    return () => window.removeEventListener('virtual-job-aid:open', onOpen);
  }, []);

  // Persist whenever a meaningful piece of the conversation changes.
  useEffect(() => {
    saveChat(storageKey, { turns, conversationId });
  }, [storageKey, turns, conversationId]);

  // If the scope (partId) changes, rehydrate from the new storage key. Keeps
  // per-part conversations distinct and survives part-to-part navigation
  // within the part hub.
  useEffect(() => {
    const loaded = loadChat(storageKey);
    setTurns(loaded.turns);
    setConversationId(loaded.conversationId);
    abortRef.current?.abort();
    setError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storageKey]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [turns, pending]);

  function onClearConversation() {
    if (turns.length === 0) return;
    abortRef.current?.abort();
    setTurns([]);
    setConversationId(undefined);
    setError(null);
    clearChat(storageKey);
  }

  if (!DEV_USER_ID || !DEV_ORG_ID) {
    return (
      <div
        className="flex flex-col gap-2 rounded-md border p-4 text-sm"
        style={{
          borderColor: 'rgba(var(--signal-warn) / 0.4)',
          background: 'rgba(var(--signal-warn) / 0.1)',
          color: 'rgb(var(--signal-warn))',
        }}
      >
        <p className="font-semibold">Assistant needs a dev user.</p>
        <p className="text-ink-secondary">
          Run <code className="rounded-sm bg-surface-inset px-1">pnpm db:prepare-ai</code>, then add
          the printed IDs to <code>apps/pwa/.env.local</code> and restart dev.
        </p>
      </div>
    );
  }

  async function tryUpload(file: File) {
    setUploading(true);
    setError(null);
    try {
      const r = await uploadFile(file, DEV_USER_ID, DEV_ORG_ID);
      setAttachment(r);
      setFailedUpload(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setFailedUpload(file);
    } finally {
      setUploading(false);
    }
  }

  async function onImagePicked(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (cameraRef.current) cameraRef.current.value = '';
    if (!file) return;
    await tryUpload(file);
  }

  async function onRetryUpload() {
    if (!failedUpload) return;
    await tryUpload(failedUpload);
  }

  function dismissFailedUpload() {
    setFailedUpload(null);
    setError(null);
  }

  async function send(overrideText?: string) {
    // overrideText lets the Try Asking buttons fire a prompt directly
    // without going through setInput first (state updates aren't
    // synchronous, so reading from `input` immediately after setInput
    // would still see the old value).
    const text = (overrideText ?? input).trim();
    if ((!text && !attachment) || pending) return;
    setInput('');
    setError(null);
    setPending(true);

    const currentAttachment = attachment;
    setAttachment(null);

    setTurns((t) => [
      ...t,
      {
        role: 'user',
        text: text || (currentAttachment ? '[photo]' : ''),
        imageUrl: currentAttachment?.url,
      },
      { role: 'assistant', text: '', citations: [], streaming: true },
    ]);

    const abort = new AbortController();
    abortRef.current = abort;

    try {
      await streamChat(
        {
          assetInstanceId: hub.assetInstance.id,
          conversationId,
          message: text,
          imageStorageKey: currentAttachment?.storageKey,
          devUserId: DEV_USER_ID,
          devOrgId: DEV_ORG_ID,
          partId,
        },
        (event) => {
          if (event.type === 'conversation') {
            setConversationId(event.conversationId);
          } else if (event.type === 'delta') {
            setTurns((t) => updateLastAssistant(t, (a) => ({ ...a, text: a.text + event.text })));
          } else if (event.type === 'done') {
            setTurns((t) =>
              updateLastAssistant(t, (a) => ({
                ...a,
                citations: event.citations,
                streaming: false,
                messageId: event.messageId,
              })),
            );
          } else if (event.type === 'verify') {
            setTurns((t) => updateLastAssistant(t, (a) => ({ ...a, verify: event.verify })));
          } else if (event.type === 'error') {
            setError(event.message);
            setTurns((t) => updateLastAssistant(t, (a) => ({ ...a, streaming: false })));
          }
        },
        abort.signal,
      );
    } catch (e) {
      if (abort.signal.aborted) return;
      setError(e instanceof Error ? e.message : String(e));
      setTurns((t) => updateLastAssistant(t, (a) => ({ ...a, streaming: false })));
    } finally {
      setPending(false);
      abortRef.current = null;
    }
  }

  function cancel() {
    abortRef.current?.abort();
  }

  return (
    <div className="flex flex-col gap-4">
      {/* Part-scoped chats keep a thin grounding banner so a tech
          knows the assistant is answering about that specific part
          (and not the whole asset). Asset-scoped chats no longer need
          one — the topbar asset chip already carries identity. */}
      {partId && partName && (
        <div className="chat-banner">
          <span className="led" />
          <span className="font-mono text-[11.5px] text-ink-secondary">{partName}</span>
          {turns.length > 0 && (
            <button
              type="button"
              onClick={onClearConversation}
              className="ml-auto inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11.5px] font-medium text-ink-tertiary transition hover:bg-surface-elevated hover:text-signal-fault"
              title="Clear conversation"
              aria-label="Clear conversation"
            >
              <Trash2 size={11} strokeWidth={2} />
              Clear
            </button>
          )}
        </div>
      )}
      {!partId && turns.length > 0 && (
        <div className="flex justify-end">
          <button
            type="button"
            onClick={onClearConversation}
            className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11.5px] font-medium text-ink-tertiary transition hover:bg-surface-elevated hover:text-signal-fault"
            title="Clear conversation"
            aria-label="Clear conversation"
          >
            <Trash2 size={11} strokeWidth={2} />
            Clear
          </button>
        </div>
      )}

      <div
        ref={scrollRef}
        className="flex max-h-[60vh] min-h-[300px] flex-col gap-4 overflow-y-auto pr-1"
      >
        {turns.length === 0 && (
          <div className="chat-empty">
            <div className="chat-empty-intro">
              <h2>
                {partName ? `Ask about ${partName}` : `Ask about ${hub.assetModel.displayName}`}
              </h2>
              <p>
                Answers are grounded in this asset's procedures, documents, work orders, and parts.
              </p>
            </div>
            <div className="chat-empty-prompts">
              <span className="chat-empty-cap">Try asking</span>
              {(suggestions && suggestions.length > 0
                ? suggestions
                : [
                    // Generic fallback only when this asset has no
                    // authored content yet.
                    'What does this equipment do?',
                    'Are there any open work orders?',
                    'What documentation is available?',
                  ]
              ).map((q) => (
                <button
                  key={q}
                  type="button"
                  className="chat-empty-prompt"
                  onClick={() => void send(q)}
                  disabled={pending}
                >
                  <span className="chat-empty-prompt-mark">›</span>
                  <span className="chat-empty-prompt-text">{q}</span>
                </button>
              ))}
            </div>
          </div>
        )}
        {turns.map((t, i) => (
          <TurnView
            key={i}
            turn={t}
            canPromote={!!me?.platformAdmin}
            promotingMessageId={promoting}
            onPromote={onPromote}
          />
        ))}
        {error && (
          <div
            className="flex flex-wrap items-center justify-between gap-3 rounded-md border p-3 text-sm"
            style={{
              borderColor: 'rgba(var(--signal-fault) / 0.4)',
              background: 'rgba(var(--signal-fault) / 0.1)',
              color: 'rgb(var(--signal-fault))',
            }}
          >
            <span className="min-w-0 flex-1">{error}</span>
            {failedUpload && (
              <div className="flex shrink-0 items-center gap-2">
                <button
                  type="button"
                  onClick={onRetryUpload}
                  disabled={uploading}
                  className="btn btn-sm btn-outline"
                >
                  Retry upload
                </button>
                <button
                  type="button"
                  onClick={dismissFailedUpload}
                  className="btn btn-sm btn-ghost"
                  aria-label="Dismiss"
                >
                  Dismiss
                </button>
              </div>
            )}
          </div>
        )}
      </div>

      {attachment && (
        <div className="flex items-center gap-3 rounded border border-line bg-surface-inset p-2">
          <img
            src={attachment.url}
            alt=""
            className="h-14 w-14 rounded object-cover"
            style={{ border: '1px solid rgb(var(--line))' }}
          />
          <div className="flex-1 text-xs text-ink-secondary">
            <p className="font-medium text-ink-primary">Photo attached</p>
            <p className="font-mono text-ink-tertiary">{attachment.originalFilename}</p>
          </div>
          <button
            type="button"
            onClick={() => setAttachment(null)}
            className="inline-flex h-7 w-7 items-center justify-center rounded text-ink-tertiary hover:bg-surface-elevated hover:text-signal-fault"
            aria-label="Remove attachment"
          >
            <X size={14} strokeWidth={2} />
          </button>
        </div>
      )}

      <form
        onSubmit={(e) => {
          e.preventDefault();
          send();
        }}
        className="composer"
      >
        {/* Camera moves to the LEFT as an attach affordance — frees the
            right side to be a clean two-button cluster (voice + send)
            sized for gloved hands. */}
        <label
          className="composer-icon-btn"
          title="Attach photo for fault diagnosis"
          aria-disabled={uploading || pending}
        >
          <Camera size={18} strokeWidth={2} />
          <input
            ref={cameraRef}
            type="file"
            accept="image/*"
            capture="environment"
            onChange={onImagePicked}
            className="hidden"
            disabled={uploading || pending}
          />
        </label>
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={
            attachment
              ? 'Describe what to do with the photo...'
              : `Ask about ${partName ?? hub.assetModel.displayName}...`
          }
          disabled={pending}
        />
        <button
          type="button"
          onClick={() => setVoiceOpen(true)}
          disabled={pending}
          aria-label="Voice mode"
          title="Voice mode"
          className="composer-icon-btn"
        >
          <AudioLines size={18} strokeWidth={2} />
        </button>
        {pending ? (
          <button
            type="button"
            onClick={cancel}
            aria-label="Stop"
            className="send-btn"
            data-state="stop"
          >
            <Square size={14} strokeWidth={2} fill="currentColor" />
          </button>
        ) : (
          <button
            type="submit"
            disabled={!input.trim() && !attachment}
            aria-label="Ask"
            className="send-btn"
          >
            <Send size={16} strokeWidth={2.25} />
          </button>
        )}
      </form>

      {voiceOpen && (
        <VoiceMode
          assetInstanceId={hub.assetInstance.id}
          {...(partId ? { partId } : {})}
          {...(conversationId ? { initialConversationId: conversationId } : {})}
          devUserId={DEV_USER_ID}
          devOrgId={DEV_ORG_ID}
          onClose={({ conversationId: cid, turns: voiceTurns }) => {
            setVoiceOpen(false);
            if (cid) setConversationId(cid);
            if (voiceTurns.length === 0) return;
            setTurns((existing) => [
              ...existing,
              ...voiceTurns.map((t) =>
                t.role === 'user'
                  ? ({ role: 'user', text: t.text } satisfies UserTurn)
                  : ({
                      role: 'assistant',
                      text: t.text,
                      citations: [],
                      streaming: false,
                    } satisfies AssistantTurn),
              ),
            ]);
          }}
        />
      )}

      {jobAid && (
        <VirtualJobAid
          source={{
            kind: 'doc',
            docId: jobAid.procedureId,
            devUserId: DEV_USER_ID,
            devOrgId: DEV_ORG_ID,
          }}
          onClose={() => setJobAid(null)}
        />
      )}
    </div>
  );
}

function updateLastAssistant(turns: Turn[], fn: (a: AssistantTurn) => AssistantTurn): Turn[] {
  for (let i = turns.length - 1; i >= 0; i--) {
    const t = turns[i];
    if (t && t.role === 'assistant') {
      const next = turns.slice();
      next[i] = fn(t);
      return next;
    }
  }
  return turns;
}

function TurnView({
  turn,
  canPromote,
  promotingMessageId,
  onPromote,
}: {
  turn: Turn;
  canPromote: boolean;
  promotingMessageId: string | null;
  onPromote: (t: AssistantTurn) => void;
}) {
  if (turn.role === 'user') {
    return (
      <div className="flex flex-col items-end gap-1.5">
        {turn.imageUrl && (
          <img
            src={turn.imageUrl}
            alt=""
            className="max-h-48 max-w-[80%] rounded-lg object-cover"
            style={{ border: '1px solid rgb(var(--line))' }}
          />
        )}
        {turn.text && turn.text !== '[photo]' && <div className="user-msg">{turn.text}</div>}
      </div>
    );
  }

  // Directive — render a launcher card instead of prose. Only applies
  // after streaming completes (otherwise we'd flicker between partial
  // text and the card as the directive arrives token-by-token).
  if (!turn.streaming) {
    const procedureId = extractProcedureId(turn.text);
    if (procedureId) {
      return <ProcedureLauncherCard procedureId={procedureId} />;
    }
  }

  const { rewritten, ordered } = rewriteCitations(turn.text, turn.citations);

  return (
    <div className="max-w-[92%]">
      <div className="mb-2 flex items-center gap-2">
        <span className="led" />
        <span className="caption" style={{ color: 'rgb(var(--ink-brand))' }}>
          Assistant
        </span>
        {!turn.streaming && turn.verify && <GroundingBadge verify={turn.verify} />}
      </div>

      {!turn.streaming && turn.verify?.conflict && <ConflictBanner reason={turn.verify.conflict} />}

      <div className="assistant-msg">
        <div className="markdown-body">
          {turn.text.length === 0 && turn.streaming ? (
            <p className="text-ink-tertiary">Thinking…</p>
          ) : (
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{rewritten || turn.text}</ReactMarkdown>
          )}
          {turn.streaming && turn.text.length > 0 && (
            <span
              className="ml-0.5 inline-block h-4 w-[2px] translate-y-0.5 animate-pulse"
              style={{ background: 'rgb(var(--brand))' }}
            />
          )}
        </div>

        {!turn.streaming && ordered.length > 0 && <SourcesList sources={ordered} />}

        {!turn.streaming && canPromote && turn.messageId && (
          <div className="mt-3 border-t border-line pt-2.5">
            <button
              type="button"
              onClick={() => onPromote(turn)}
              disabled={promotingMessageId === turn.messageId}
              className="inline-flex items-center gap-1.5 text-xs font-medium text-ink-secondary transition hover:text-ink-primary disabled:opacity-50"
              title="Promote this answer to an authored procedure"
            >
              <BookPlus size={12} strokeWidth={2} />
              {promotingMessageId === turn.messageId ? 'Promoting…' : 'Author this as a procedure'}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// Mounted inside an assistant turn whose text is exactly a procedure
// directive. Fetches the procedure title in the background so the card
// shows "Walk me through: <title>" instead of an opaque UUID. Tapping
// opens VirtualJobAid via a window-level event so any host (chat tab or
// voice mode) can listen.
function ProcedureLauncherCard({ procedureId }: { procedureId: string }): React.ReactElement {
  const [title, setTitle] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const mod = await import('@/lib/api');
        const doc = await mod.getProcedureDoc(procedureId, DEV_USER_ID, DEV_ORG_ID);
        if (!cancelled) setTitle(doc.document.title);
      } catch {
        // Title is decorative — fail soft. Card still works.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [procedureId]);

  function open() {
    window.dispatchEvent(
      new CustomEvent('virtual-job-aid:open', {
        detail: { source: { kind: 'doc', procedureId } },
      }),
    );
  }
  return (
    <div className="max-w-[92%]">
      <div className="mb-2 flex items-center gap-2">
        <span className="led" />
        <span className="caption" style={{ color: 'rgb(var(--ink-brand))' }}>
          Assistant
        </span>
      </div>
      <button
        type="button"
        onClick={open}
        className="procedure-launcher"
        aria-label={`Open ${title ?? 'procedure'} walkthrough`}
      >
        <span className="procedure-launcher-icon">
          <ListChecks size={20} strokeWidth={2} />
        </span>
        <span className="procedure-launcher-text">
          <span className="procedure-launcher-eyebrow">Walk me through</span>
          <span className="procedure-launcher-title">{title ?? 'Loading procedure…'}</span>
        </span>
        <span className="procedure-launcher-cta">
          <Play size={16} strokeWidth={2.5} />
        </span>
      </button>
    </div>
  );
}

function summarizeVerify(verify: VerifyResult): {
  total: number;
  supported: number;
  weak: number;
  unsupported: number;
  level: 'verified' | 'mostly' | 'speculative';
} {
  let supported = 0;
  let weak = 0;
  let unsupported = 0;
  for (const s of verify.sentences) {
    if (s.level === 'supported') supported += 1;
    else if (s.level === 'weak') weak += 1;
    else unsupported += 1;
  }
  const total = verify.sentences.length;
  const level: 'verified' | 'mostly' | 'speculative' =
    total > 0 && unsupported === 0 && weak === 0
      ? 'verified'
      : total > 0 && unsupported === 0
        ? 'mostly'
        : 'speculative';
  return { total, supported, weak, unsupported, level };
}

// One-word LED chip. The earlier "Mostly grounded" / "Review needed"
// labels carried more nuance than a tech in the field can act on —
// either trust it ("Verified") or look at the sources before relying
// on it ("Review"). The summary tooltip still carries the breakdown
// for anyone who wants it.
function GroundingBadge({ verify }: { verify: VerifyResult }): React.ReactElement {
  const s = summarizeVerify(verify);
  const trustworthy = s.level === 'verified' || s.level === 'mostly';
  const label = trustworthy ? 'Verified' : 'Review';
  const chipLevel = trustworthy ? 'verified' : 'speculative';
  return (
    <span
      className={`grounding-badge grounding-${chipLevel}`}
      title={`${s.supported}/${s.total} claims supported`}
    >
      {label}
    </span>
  );
}

function ConflictBanner({ reason }: { reason: string }): React.ReactElement {
  return (
    <div className="conflict-banner" role="alert">
      <span className="led led-warn" />
      <span className="conflict-banner-label">Sources differ</span>
      <span className="conflict-banner-reason">{reason}</span>
    </div>
  );
}

// Collapsible source list. Grounding is still emitted by the retriever and
// cited inline as [1] [2] markers in the prose — the full list is tucked
// behind a button so casual users aren't buried in quotes. Click to toggle.
function SourcesList({ sources }: { sources: ChatCitation[] }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="mt-3 border-t border-line pt-2.5">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="inline-flex items-center gap-1.5 text-xs font-medium text-ink-secondary transition hover:text-ink-primary"
      >
        <FileText size={12} strokeWidth={2} />
        {sources.length} source{sources.length === 1 ? '' : 's'}
        <ChevronDown
          size={12}
          strokeWidth={2.5}
          className="transition-transform"
          style={{ transform: open ? 'rotate(180deg)' : 'none' }}
        />
      </button>
      {open && (
        <ol className="mt-2.5 flex flex-col gap-1.5">
          {sources.map((c, idx) => (
            <li key={c.chunkId} className="source-item">
              <span className="source-num">[{idx + 1}]</span>
              <div className="flex-1">
                <div className="source-title">{c.documentTitle}</div>
                <div className="source-quote">“{c.quote}”</div>
              </div>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

function rewriteCitations(
  text: string,
  citations: ChatCitation[],
): { rewritten: string; ordered: ChatCitation[] } {
  // Strip raw `[pdfpage:DOC:START:END]` directives from rendered chat
  // text. They're a machine-readable signal for voice mode (which opens
  // an inline PDF viewer overlay) — in the regular chat surface they
  // just read as noise. cite/section/procedure get their own handling.
  const stripPdfPage = (s: string) => s.replace(/\[pdfpage:[a-f0-9-]{8,}(?::\d+){0,2}\]/gi, '');

  if (citations.length === 0) {
    return {
      rewritten: stripPdfPage(text.replace(/\[cite:[a-f0-9-]{8,}\]/gi, '')),
      ordered: [],
    };
  }
  const byChunkId = new Map(citations.map((c) => [c.chunkId, c]));
  const orderMap = new Map<string, number>();
  let nextIndex = 1;
  const rewritten = stripPdfPage(
    text.replace(/\[cite:([a-f0-9-]{8,})\]/gi, (_, id: string) => {
      if (!byChunkId.has(id)) return '';
      if (!orderMap.has(id)) {
        orderMap.set(id, nextIndex);
        nextIndex += 1;
      }
      return ` [${orderMap.get(id)}]`;
    }),
  );
  const ordered = [...orderMap.entries()]
    .sort((a, b) => a[1] - b[1])
    .map(([id]) => byChunkId.get(id)!)
    .filter(Boolean);
  return { rewritten, ordered };
}
