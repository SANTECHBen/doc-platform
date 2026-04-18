'use client';

import { useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { ArrowUp, Camera, ShieldAlert, Sparkles, Square, X } from 'lucide-react';
import type { AssetHubPayload } from '@/lib/shared-schema';
import { streamChat, uploadFile, type ChatCitation, type UploadResult } from '@/lib/api';

type UserTurn = { role: 'user'; text: string; imageUrl?: string };
type AssistantTurn = {
  role: 'assistant';
  text: string;
  citations: ChatCitation[];
  streaming: boolean;
};
type Turn = UserTurn | AssistantTurn;

const DEV_USER_ID = process.env.NEXT_PUBLIC_DEV_USER_ID ?? '';
const DEV_ORG_ID = process.env.NEXT_PUBLIC_DEV_ORG_ID ?? '';

export function ChatTab({ hub, qrCode: _qrCode }: { hub: AssetHubPayload; qrCode: string }) {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conversationId, setConversationId] = useState<string | undefined>();
  const [attachment, setAttachment] = useState<UploadResult | null>(null);
  const [uploading, setUploading] = useState(false);
  const cameraRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [turns, pending]);

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
          Run <code className="rounded-sm bg-surface-inset px-1">pnpm db:prepare-ai</code>, then
          add the printed IDs to <code>apps/pwa/.env.local</code> and restart dev.
        </p>
      </div>
    );
  }

  async function onImagePicked(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    setError(null);
    try {
      const r = await uploadFile(file, DEV_USER_ID, DEV_ORG_ID);
      setAttachment(r);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setUploading(false);
      if (cameraRef.current) cameraRef.current.value = '';
    }
  }

  async function send() {
    const text = input.trim();
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
              })),
            );
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
      <div className="chat-banner">
        <span className="led" />
        <span
          className="font-mono text-[10.5px] font-medium uppercase tracking-[0.1em]"
          style={{ color: 'rgb(var(--ink-brand))' }}
        >
          Grounded on this asset
        </span>
        <span className="text-ink-tertiary">·</span>
        <span className="font-mono text-[11.5px] text-ink-secondary">
          {hub.assetModel.displayName} · rev{' '}
          {hub.pinnedContentPackVersion?.versionLabel ?? 'current'}
        </span>
      </div>

      <div
        ref={scrollRef}
        className="flex max-h-[60vh] min-h-[300px] flex-col gap-4 overflow-y-auto pr-1"
      >
        {turns.length === 0 && (
          <div className="flex flex-col items-center gap-2 py-12 text-center">
            <p className="text-base text-ink-secondary">Ask about this equipment.</p>
            <p className="max-w-sm text-sm text-ink-tertiary">
              Answers are grounded on the published content for this exact serial.
              Safety-critical procedures are quoted verbatim.
            </p>
          </div>
        )}
        {turns.map((t, i) => (
          <TurnView key={i} turn={t} />
        ))}
        {error && (
          <div
            className="rounded-md border p-3 text-sm"
            style={{
              borderColor: 'rgba(var(--signal-fault) / 0.4)',
              background: 'rgba(var(--signal-fault) / 0.1)',
              color: 'rgb(var(--signal-fault))',
            }}
          >
            {error}
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
        <Sparkles size={16} strokeWidth={2} style={{ color: 'rgb(var(--ink-brand))' }} />
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={attachment ? 'Describe what to do with the photo…' : 'What does fault E-217 mean?'}
          disabled={pending}
        />
        <label
          className={`inline-flex h-9 w-9 cursor-pointer items-center justify-center rounded text-ink-secondary transition hover:bg-surface-elevated hover:text-ink-primary ${
            uploading || pending ? 'opacity-50' : ''
          }`}
          title="Attach photo for fault diagnosis"
        >
          <Camera size={16} strokeWidth={2} />
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
        {pending ? (
          <button
            type="button"
            onClick={cancel}
            aria-label="Stop"
            className="send-btn"
            style={{
              background: 'rgb(var(--surface-elevated))',
              color: 'rgb(var(--ink-primary))',
              boxShadow: 'none',
            }}
          >
            <Square size={12} strokeWidth={2} fill="currentColor" />
          </button>
        ) : (
          <button
            type="submit"
            disabled={!input.trim() && !attachment}
            aria-label="Ask"
            className="send-btn"
          >
            <ArrowUp size={16} strokeWidth={2.5} />
          </button>
        )}
      </form>
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

function TurnView({ turn }: { turn: Turn }) {
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
        {turn.text && turn.text !== '[photo]' && (
          <div className="user-msg">{turn.text}</div>
        )}
      </div>
    );
  }

  const { rewritten, ordered } = rewriteCitations(turn.text, turn.citations);

  return (
    <div className="max-w-[92%]">
      <div className="mb-2 flex items-center gap-2">
        <span className="led" />
        <span className="caption" style={{ color: 'rgb(var(--ink-brand))' }}>
          Assistant
        </span>
      </div>
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

        {!turn.streaming && ordered.length > 0 && (
          <div className="mt-4 border-t border-line pt-3">
            <div className="mb-2.5 flex items-center gap-2.5">
              <span className="caption">Sources</span>
              <span className="h-px flex-1" style={{ background: 'rgb(var(--line-subtle))' }} />
            </div>
            <ol className="flex flex-col gap-1.5">
              {ordered.map((c, idx) => (
                <li key={c.chunkId} className="source-item">
                  <span className="source-num">[{idx + 1}]</span>
                  <div className="flex-1">
                    <div className="source-title">
                      {c.documentTitle}
                      {c.safetyCritical && (
                        <span className="pill pill-safety">
                          <ShieldAlert size={10} strokeWidth={2.5} />
                          Safety
                        </span>
                      )}
                    </div>
                    <div className="source-quote">“{c.quote}”</div>
                  </div>
                </li>
              ))}
            </ol>
          </div>
        )}
      </div>
    </div>
  );
}

function rewriteCitations(
  text: string,
  citations: ChatCitation[],
): { rewritten: string; ordered: ChatCitation[] } {
  if (citations.length === 0) {
    return { rewritten: text.replace(/\[cite:[a-f0-9-]{8,}\]/gi, ''), ordered: [] };
  }
  const byChunkId = new Map(citations.map((c) => [c.chunkId, c]));
  const orderMap = new Map<string, number>();
  let nextIndex = 1;
  const rewritten = text.replace(/\[cite:([a-f0-9-]{8,})\]/gi, (_, id: string) => {
    if (!byChunkId.has(id)) return '';
    if (!orderMap.has(id)) {
      orderMap.set(id, nextIndex);
      nextIndex += 1;
    }
    return ` [${orderMap.get(id)}]`;
  });
  const ordered = [...orderMap.entries()]
    .sort((a, b) => a[1] - b[1])
    .map(([id]) => byChunkId.get(id)!)
    .filter(Boolean);
  return { rewritten, ordered };
}
