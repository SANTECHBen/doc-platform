'use client';

import { useEffect, useRef, useState } from 'react';
import { Camera, Paperclip, Plus, X } from 'lucide-react';
import { useToast } from '@/components/toast';
import {
  listWorkOrders,
  createWorkOrder,
  uploadFile,
  type UploadResult,
  type WorkOrder,
  type WorkOrderSeverity,
} from '@/lib/api';

const DEV_USER_ID = process.env.NEXT_PUBLIC_DEV_USER_ID ?? '';
const DEV_ORG_ID = process.env.NEXT_PUBLIC_DEV_ORG_ID ?? '';

const SEVERITIES: WorkOrderSeverity[] = ['info', 'low', 'medium', 'high', 'critical'];

export function IssuesPanel({
  assetInstanceId,
  onCountChange,
}: {
  assetInstanceId: string;
  onCountChange?: (count: number) => void;
}) {
  const [orders, setOrders] = useState<WorkOrder[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [severity, setSeverity] = useState<WorkOrderSeverity>('medium');
  const [submitting, setSubmitting] = useState(false);
  const [attachments, setAttachments] = useState<UploadResult[]>([]);
  const [uploading, setUploading] = useState(false);
  const cameraRef = useRef<HTMLInputElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const toast = useToast();

  async function onFilesPicked(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    if (files.length === 0) return;
    setUploading(true);
    try {
      for (const f of files) {
        const r = await uploadFile(f, DEV_USER_ID, DEV_ORG_ID);
        setAttachments((prev) => [...prev, r]);
      }
    } catch (err) {
      toast.error('Upload failed', err instanceof Error ? err.message : String(err));
    } finally {
      setUploading(false);
      // Allow picking the same file again later
      if (cameraRef.current) cameraRef.current.value = '';
      if (fileRef.current) fileRef.current.value = '';
    }
  }

  function removeAttachment(key: string) {
    setAttachments((prev) => prev.filter((a) => a.storageKey !== key));
  }

  async function refresh() {
    try {
      const rows = await listWorkOrders(assetInstanceId, 'open');
      setOrders(rows);
      onCountChange?.(rows.length);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [assetInstanceId]);

  async function submit() {
    if (!title.trim() || submitting) return;
    if (!DEV_USER_ID || !DEV_ORG_ID) {
      setError('Dev user required to open a work order.');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await createWorkOrder({
        assetInstanceId,
        title: title.trim(),
        description: description.trim() || undefined,
        severity,
        attachments: attachments.map((a) => ({
          key: a.storageKey,
          mime: a.contentType,
        })),
        devUserId: DEV_USER_ID,
        devOrgId: DEV_ORG_ID,
      });
      toast.success(
        'Work order opened',
        `${severity} severity${attachments.length ? ` · ${attachments.length} photo${attachments.length === 1 ? '' : 's'}` : ''}`,
      );
      setTitle('');
      setDescription('');
      setSeverity('medium');
      setAttachments([]);
      setShowForm(false);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }

  const count = orders?.length ?? 0;

  return (
    <section>
      <div className="spec-divider">
        <span className="caption">Work orders</span>
        <span className="line" />
        <span className="count">{count} open</span>
        {!showForm && (
          <button onClick={() => setShowForm(true)} className="btn btn-secondary btn-sm">
            <Plus size={14} strokeWidth={2} />
            Report issue
          </button>
        )}
      </div>

      {error && (
        <div
          className="mb-3 rounded-md border p-3 text-sm"
          style={{
            borderColor: 'rgba(var(--signal-fault) / 0.4)',
            background: 'rgba(var(--signal-fault) / 0.1)',
            color: 'rgb(var(--signal-fault))',
          }}
        >
          {error}
        </div>
      )}

      {showForm && (
        <div className="mb-3 flex flex-col gap-3 rounded-md border border-line bg-surface-inset p-4">
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Short title — e.g., Fault E-217 on shuttle 12"
            className="rounded border border-line bg-surface-raised px-3 py-2.5 text-sm text-ink-primary placeholder:text-ink-tertiary focus:border-brand focus:outline-none"
          />
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="What happened, what you tried, any error codes…"
            rows={3}
            className="rounded border border-line bg-surface-raised px-3 py-2.5 text-sm text-ink-primary placeholder:text-ink-tertiary focus:border-brand focus:outline-none"
          />
          <div className="flex items-center gap-3">
            <span className="caption">Severity</span>
            <div className="flex rounded border border-line bg-surface-raised p-0.5">
              {SEVERITIES.map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => setSeverity(s)}
                  className={`rounded-sm px-3 py-1.5 text-xs font-medium capitalize transition ${
                    severity === s
                      ? severityActiveClass(s)
                      : 'text-ink-tertiary hover:text-ink-secondary'
                  }`}
                >
                  {s}
                </button>
              ))}
            </div>
          </div>

          {/* Photo attachments — camera capture on mobile, file picker on desktop */}
          <div className="flex flex-col gap-2">
            <span className="caption">Photos</span>
            {attachments.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {attachments.map((a) => (
                  <div key={a.storageKey} className="relative">
                    <img
                      src={a.url}
                      alt=""
                      className="h-16 w-16 rounded object-cover"
                      style={{ border: '1px solid rgb(var(--line))' }}
                    />
                    <button
                      type="button"
                      onClick={() => removeAttachment(a.storageKey)}
                      className="absolute -right-1.5 -top-1.5 inline-flex h-5 w-5 items-center justify-center rounded-full border border-line bg-surface-raised text-ink-tertiary shadow-sm hover:text-signal-fault"
                      aria-label="Remove"
                    >
                      <X size={11} strokeWidth={2} />
                    </button>
                  </div>
                ))}
              </div>
            )}
            <div className="flex flex-wrap gap-2">
              <label
                className={`touch inline-flex cursor-pointer items-center gap-2 rounded border border-line bg-surface-raised px-3 text-sm text-ink-primary transition hover:bg-surface-elevated ${
                  uploading ? 'opacity-50' : ''
                }`}
              >
                <Camera size={14} strokeWidth={2} />
                {uploading ? 'Uploading…' : 'Take photo'}
                <input
                  ref={cameraRef}
                  type="file"
                  accept="image/*"
                  capture="environment"
                  multiple
                  onChange={onFilesPicked}
                  className="hidden"
                  disabled={uploading}
                />
              </label>
              <label
                className={`touch inline-flex cursor-pointer items-center gap-2 rounded border border-line bg-surface-raised px-3 text-sm text-ink-secondary transition hover:bg-surface-elevated hover:text-ink-primary ${
                  uploading ? 'opacity-50' : ''
                }`}
              >
                <Paperclip size={14} strokeWidth={2} />
                Attach file
                <input
                  ref={fileRef}
                  type="file"
                  accept="image/*,video/*,application/pdf"
                  multiple
                  onChange={onFilesPicked}
                  className="hidden"
                  disabled={uploading}
                />
              </label>
            </div>
          </div>
          <div className="flex justify-end gap-2">
            <button
              onClick={() => {
                setShowForm(false);
                setError(null);
              }}
              className="btn btn-secondary btn-sm"
            >
              Cancel
            </button>
            <button
              onClick={submit}
              disabled={submitting || !title.trim()}
              className="btn btn-primary btn-sm"
            >
              {submitting ? 'Opening…' : 'Open work order'}
            </button>
          </div>
        </div>
      )}

      {!orders ? null : orders.length === 0 ? (
        <div className="empty-row">No open issues on this asset.</div>
      ) : (
        <ul className="mt-3 flex flex-col gap-2">
          {orders.map((o) => (
            <li key={o.id} className="workorder">
              <span className={`led ${severityLed(o.severity)}`} style={{ marginTop: 6 }} />
              <div className="workorder-body">
                <div className="workorder-title">{o.title}</div>
                {o.description && <div className="workorder-desc">{o.description}</div>}
                <div className="workorder-meta">
                  {o.openedBy?.displayName ?? 'Unknown'} · {new Date(o.openedAt).toLocaleString()}
                </div>
                {o.attachments && o.attachments.length > 0 && (
                  <div className="mt-2 flex gap-1.5">
                    {o.attachments
                      .filter((a) => a.mime.startsWith('image/'))
                      .map((a) => (
                        <a
                          key={a.key}
                          href={a.url}
                          target="_blank"
                          rel="noreferrer"
                          className="shrink-0"
                        >
                          <img
                            src={a.url}
                            alt=""
                            className="h-12 w-12 rounded object-cover"
                            style={{ border: '1px solid rgb(var(--line))' }}
                          />
                        </a>
                      ))}
                  </div>
                )}
              </div>
              <div className="workorder-pills">
                <span className={severityPillClass(o.severity)}>{o.severity}</span>
                <span className="pill">{o.status.replace('_', ' ')}</span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function severityPillClass(s: WorkOrderSeverity): string {
  switch (s) {
    case 'critical':
      return 'pill pill-fault';
    case 'high':
      return 'pill pill-warn';
    case 'medium':
      return 'pill pill-info';
    default:
      return 'pill';
  }
}

function severityActiveClass(s: WorkOrderSeverity): string {
  switch (s) {
    case 'critical':
      return 'bg-signal-fault text-brand-ink';
    case 'high':
      return 'bg-signal-warn text-brand-ink';
    case 'medium':
      return 'bg-brand text-brand-ink';
    default:
      return 'bg-surface-elevated text-ink-primary';
  }
}

function severityLed(s: WorkOrderSeverity): string {
  switch (s) {
    case 'critical':
      return 'led-fault';
    case 'high':
    case 'medium':
      return 'led-warn';
    default:
      return 'led-idle';
  }
}
