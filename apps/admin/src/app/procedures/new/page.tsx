'use client';

// Full-page "create procedure" form. Replaces the drawer flow for the
// structured_procedure case so authors land on a page-level surface
// from the very first click. The form asks for only what's needed to
// create the row (title, optional safety / language / tags) — everything
// else (steps, blocks, voiceover) is authored in the editor we redirect
// to on submit.

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { ArrowLeft, ListChecks, Loader2, ShieldAlert } from 'lucide-react';
import {
  ErrorBanner,
  Field,
  PrimaryButton,
  SecondaryButton,
  TextInput,
} from '@/components/form';
import { createDocument } from '@/lib/api';

export default function NewProcedurePage() {
  const router = useRouter();
  const params = useSearchParams();
  const versionId = params.get('versionId');

  const [title, setTitle] = useState('');
  const [safetyCritical, setSafetyCritical] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Guard: if someone hits this page without a versionId we redirect
  // them to /content-packs to pick one. Otherwise we'd happily POST a
  // doc to undefined.
  useEffect(() => {
    if (!versionId) {
      router.replace('/content-packs');
    }
  }, [versionId, router]);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!versionId) return;
    const t = title.trim();
    if (!t) {
      setError('Title is required.');
      return;
    }
    setSubmitting(true);
    try {
      const created = await createDocument(versionId, {
        kind: 'structured_procedure',
        title: t,
        language: 'en',
        safetyCritical,
        tags: [],
      });
      // Land directly in the full-page authoring view. The author never
      // sees a half-baked doc-detail page or a drawer in between.
      router.replace(`/procedures/${encodeURIComponent(created.id)}/edit`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setSubmitting(false);
    }
  }

  return (
    <main className="min-h-screen bg-surface">
      <header className="sticky top-0 z-30 border-b border-line bg-surface-raised/85 backdrop-blur-md">
        <div className="mx-auto flex max-w-3xl items-center gap-3 px-4 py-3">
          <Link
            href={versionId ? `/content-packs` : '/'}
            className="inline-flex size-9 items-center justify-center rounded-md text-ink-tertiary transition hover:bg-surface hover:text-ink-primary"
            aria-label="Back"
          >
            <ArrowLeft className="size-5" />
          </Link>
          <div className="flex flex-col gap-0.5">
            <span className="inline-flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-accent">
              <ListChecks className="size-3.5" />
              New procedure
            </span>
            <span className="text-xs text-ink-tertiary">
              Title now, steps next.
            </span>
          </div>
        </div>
      </header>

      <div className="mx-auto max-w-2xl px-4 py-10">
        <form onSubmit={onSubmit} className="flex flex-col gap-6">
          <ErrorBanner error={error} />

          <div className="flex flex-col gap-2">
            <label htmlFor="proc-title" className="text-sm font-medium text-ink-secondary">
              What does this procedure do?
            </label>
            <input
              id="proc-title"
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="e.g., Replace divert actuator assembly"
              autoFocus
              required
              className="w-full rounded-md border border-line bg-surface-raised px-4 py-3 text-lg font-semibold text-ink-primary outline-none placeholder:text-ink-tertiary/60 focus:border-accent"
            />
            <p className="text-xs text-ink-tertiary">
              A short imperative reads best. You can change it later.
            </p>
          </div>

          <Field
            label="Safety-critical?"
            hint="Forces verbatim quoting in AI answers, surfaces a warning rail in the runner, and requires written justification when a tech skips a step."
          >
            <label className="flex items-center gap-2 text-sm text-ink-primary">
              <input
                type="checkbox"
                checked={safetyCritical}
                onChange={(e) => setSafetyCritical(e.target.checked)}
              />
              <ShieldAlert className="size-4 text-signal-warn" />
              <span>This procedure involves LOTO, electrical isolation, or PPE</span>
            </label>
          </Field>

          <div className="flex items-center justify-end gap-2 pt-2">
            <SecondaryButton
              type="button"
              onClick={() => router.back()}
              disabled={submitting}
            >
              Cancel
            </SecondaryButton>
            <PrimaryButton type="submit" disabled={submitting || !title.trim()}>
              {submitting ? (
                <>
                  <Loader2 className="size-4 animate-spin" /> Creating…
                </>
              ) : (
                <>Create &amp; open editor</>
              )}
            </PrimaryButton>
          </div>
        </form>
      </div>
    </main>
  );
}
