'use client';

import { useState } from 'react';
import { MessageSquarePlus, X } from 'lucide-react';
import { submitFeedback, type FeedbackCategory } from '@/lib/api';
import { useToast } from './toast';

const CATEGORIES: Array<{ value: FeedbackCategory; label: string }> = [
  { value: 'bug', label: 'Bug' },
  { value: 'feature', label: 'Idea' },
  { value: 'question', label: 'Question' },
  { value: 'praise', label: 'Praise' },
  { value: 'other', label: 'Other' },
];

export function FeedbackWidget({
  qrCode,
  assetInstanceId,
}: {
  qrCode?: string;
  assetInstanceId?: string;
}): React.ReactElement {
  const [open, setOpen] = useState(false);
  const [category, setCategory] = useState<FeedbackCategory>('bug');
  const [message, setMessage] = useState('');
  const [contactEmail, setContactEmail] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const toast = useToast();

  function reset() {
    setMessage('');
    setContactEmail('');
    setCategory('bug');
    setError(null);
  }

  async function onSubmit() {
    if (!message.trim() || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      await submitFeedback({
        message: message.trim(),
        category,
        qrCode,
        assetInstanceId,
        contactEmail: contactEmail.trim() || undefined,
      });
      toast.success('Feedback sent', 'Thanks — the SANTECH team will follow up if needed.');
      setOpen(false);
      reset();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="app-topbar-btn"
        aria-label="Send feedback"
        title="Send feedback"
      >
        <MessageSquarePlus size={18} strokeWidth={2} />
      </button>

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 px-2 pb-2 sm:items-center sm:p-4"
          role="dialog"
          aria-modal="true"
          aria-label="Send feedback"
          onClick={(e) => {
            if (e.target === e.currentTarget && !submitting) setOpen(false);
          }}
        >
          <div className="w-full max-w-lg rounded-lg border border-line bg-surface-base p-4 shadow-xl sm:p-5">
            <div className="mb-3 flex items-start justify-between gap-3">
              <div>
                <h2 className="text-base font-semibold text-ink-primary">Send feedback</h2>
                <p className="text-xs text-ink-tertiary">
                  Beta program — bugs, ideas, questions all welcome.
                </p>
              </div>
              <button
                type="button"
                onClick={() => !submitting && setOpen(false)}
                className="app-topbar-btn"
                aria-label="Close"
                disabled={submitting}
              >
                <X size={18} strokeWidth={2} />
              </button>
            </div>

            <div className="flex flex-col gap-3">
              <div className="flex flex-wrap gap-1.5">
                {CATEGORIES.map((c) => (
                  <button
                    key={c.value}
                    type="button"
                    onClick={() => setCategory(c.value)}
                    className={`btn btn-sm ${
                      category === c.value ? 'btn-primary' : 'btn-secondary'
                    }`}
                  >
                    {c.label}
                  </button>
                ))}
              </div>

              <label className="flex flex-col gap-1.5">
                <span className="caption">What happened?</span>
                <textarea
                  value={message}
                  onChange={(e) => setMessage(e.target.value)}
                  rows={5}
                  placeholder={
                    category === 'bug'
                      ? 'What were you trying to do? What did you expect? What actually happened?'
                      : 'Tell us what’s on your mind…'
                  }
                  className="rounded border border-line bg-surface-raised p-3 text-sm"
                  autoFocus
                  disabled={submitting}
                />
              </label>

              <label className="flex flex-col gap-1.5">
                <span className="caption">Email for follow-up (optional)</span>
                <input
                  type="email"
                  value={contactEmail}
                  onChange={(e) => setContactEmail(e.target.value)}
                  placeholder="you@company.com"
                  className="rounded border border-line bg-surface-raised p-2.5 text-sm"
                  disabled={submitting}
                />
              </label>

              {error && (
                <div className="rounded-md border border-signal-fault/40 bg-signal-fault/10 p-2.5 text-sm text-signal-fault">
                  {error}
                </div>
              )}

              <div className="flex items-center justify-end gap-2 pt-1">
                <button
                  type="button"
                  onClick={() => !submitting && setOpen(false)}
                  className="btn btn-ghost"
                  disabled={submitting}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={onSubmit}
                  disabled={!message.trim() || submitting}
                  className="btn btn-primary"
                >
                  {submitting ? 'Sending…' : 'Send feedback'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
