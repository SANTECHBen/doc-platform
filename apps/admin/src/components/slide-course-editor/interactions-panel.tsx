'use client';

// InteractionsPanel — lists interactions on the selected slide, and lets
// the author add/edit/delete them. Editing opens an in-place form below
// the row (rather than a separate overlay) because the right pane is
// narrow and a sliding overlay would obscure the canvas the author is
// authoring against.

import { useState } from 'react';
import { Plus, Pencil, Trash2 } from 'lucide-react';
import { GhostButton, SecondaryButton } from '@/components/form';
import { SLIDE_INTERACTION_KIND_LABELS } from '@platform/shared';
import {
  createInteraction,
  deleteInteraction,
  patchInteraction,
  type SlideDto,
  type SlideInteractionDto,
  type SlideInteractionKind,
} from '@/lib/slide-course-api';
import { InteractionForm } from './interaction-form';

type EditingState =
  | { mode: 'add'; kind: SlideInteractionKind }
  | { mode: 'edit'; interaction: SlideInteractionDto }
  | null;

interface InteractionsPanelProps {
  deckId: string;
  slide: SlideDto;
  onInteractionsChanged: (next: SlideInteractionDto[]) => void;
  onError: (msg: string) => void;
}

export function InteractionsPanel(props: InteractionsPanelProps) {
  const { deckId, slide, onInteractionsChanged, onError } = props;
  const [editing, setEditing] = useState<EditingState>(null);

  async function onSave(payload: {
    kind: SlideInteractionKind;
    prompt: string;
    config: Record<string, unknown>;
    weight: number;
    orderingHint: number;
  }) {
    try {
      if (editing?.mode === 'edit') {
        const updated = await patchInteraction(editing.interaction.id, {
          prompt: payload.prompt,
          config: payload.config,
          weight: payload.weight,
          orderingHint: payload.orderingHint,
        });
        onInteractionsChanged(
          slide.interactions.map((i) => (i.id === updated.id ? updated : i)),
        );
      } else {
        const created = await createInteraction(deckId, slide.id, {
          kind: payload.kind,
          // The server-side schema picks the right config by kind, but
          // the discriminated-union type can't statically prove
          // payload.config matches the kind chosen at runtime. The
          // server re-validates with the matching schema.
          config: payload.config as never,
          prompt: payload.prompt,
          weight: payload.weight,
          orderingHint: payload.orderingHint,
        });
        onInteractionsChanged([...slide.interactions, created]);
      }
      setEditing(null);
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    }
  }

  async function onDelete(interactionId: string) {
    if (!confirm('Delete this interaction?')) return;
    try {
      await deleteInteraction(interactionId);
      onInteractionsChanged(slide.interactions.filter((i) => i.id !== interactionId));
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <div className="space-y-2">
      {slide.interactions.length === 0 && editing === null && (
        <p className="rounded border border-dashed border-line bg-surface p-3 text-xs text-ink-tertiary">
          No interactions on this slide yet. Add one below to require the
          learner to respond before advancing.
        </p>
      )}

      {slide.interactions.map((it, i) => (
        <div
          key={it.id}
          className="space-y-2 rounded border border-line bg-surface p-2"
        >
          <div className="flex items-start gap-2">
            <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-accent text-xs font-medium text-on-accent">
              {i + 1}
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-xs font-medium uppercase tracking-wide text-ink-tertiary">
                {SLIDE_INTERACTION_KIND_LABELS[it.kind]}
              </p>
              <p className="mt-0.5 break-words text-sm">{it.prompt}</p>
            </div>
            <div className="flex gap-1">
              <GhostButton
                type="button"
                onClick={() => setEditing({ mode: 'edit', interaction: it })}
                aria-label="Edit"
              >
                <Pencil className="size-3.5" />
              </GhostButton>
              <GhostButton
                type="button"
                onClick={() => void onDelete(it.id)}
                aria-label="Delete"
              >
                <Trash2 className="size-3.5" />
              </GhostButton>
            </div>
          </div>
          {editing?.mode === 'edit' && editing.interaction.id === it.id && (
            <div className="border-t border-line pt-2">
              <InteractionForm
                initial={editing.interaction}
                onSave={onSave}
                onCancel={() => setEditing(null)}
              />
            </div>
          )}
        </div>
      ))}

      {editing?.mode === 'add' && (
        <div className="rounded border border-line bg-surface p-2">
          <InteractionForm
            initial={null}
            initialKind={editing.kind}
            onSave={onSave}
            onCancel={() => setEditing(null)}
            defaultOrderingHint={slide.interactions.length}
          />
        </div>
      )}

      {editing === null && (
        <div className="flex flex-wrap gap-2 pt-1">
          {(['mcq', 'true_false', 'drag_match', 'short_answer_ai'] as SlideInteractionKind[]).map(
            (k) => (
              <SecondaryButton
                key={k}
                type="button"
                onClick={() => setEditing({ mode: 'add', kind: k })}
              >
                <Plus className="size-3.5" /> {SLIDE_INTERACTION_KIND_LABELS[k]}
              </SecondaryButton>
            ),
          )}
        </div>
      )}
    </div>
  );
}
