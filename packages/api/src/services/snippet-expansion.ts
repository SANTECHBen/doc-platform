// Snippet expansion — resolves procedure_steps.snippet_id references at read
// time. This is the heart of "always-latest" snippet semantics: when an
// author edits a snippet, every non-detached referring step picks up the
// change on the next read, with no DB writes to fan out across the step
// table.
//
// Detach semantics:
//   - step.snippetId set, step.snippetDetached=false → expand (replace
//     step.blocks with snippet.blocks; replace step.title with snippet.title
//     when the step has none). Attach a `_snippetBadge` annotation so the
//     editor and runner can render the "From snippet: …" pill.
//   - step.snippetId set, step.snippetDetached=true  → return as-is. The
//     step copied snippet content on its first inline edit and now drifts
//     independently. The badge is still surfaced for provenance.
//   - step.snippetId null                            → return as-is.
//
// Authors can re-attach by inserting the same snippet again (which the
// picker treats as a fresh insert that overwrites the step). v1 doesn't
// expose an explicit "re-attach without overwrite" flow because the
// merge UX is fiddly and rarely useful.

import { inArray } from 'drizzle-orm';
import { schema, type Database } from '@platform/db';
import type { ProcedureSnippet } from '@platform/db';

/**
 * Snippet badge surfaced on expanded step DTOs. Lets the admin editor and
 * the PWA Job Aid render a "From: <title>" pill without a second round-
 * trip. `detached` tracks whether the step has drifted from the snippet —
 * the editor uses this to decide whether to render the read-only badge
 * (attached) or the informational chip (detached).
 */
export interface SnippetBadge {
  id: string;
  title: string;
  isPlatform: boolean;
  detached: boolean;
  /** When the step is attached AND its own audio is null, the runner
   *  plays this snippet-level audio at run time. Surfaces here so the
   *  expanded DTO can carry an audioUrl for snippet-inherited audio
   *  without the caller having to load the snippet row separately. */
  hasInheritedAudio: boolean;
}

/**
 * The minimal shape we need from a procedure_steps row to apply expansion.
 * Declared structurally so callers can pass either the full row or a
 * subset projected in a `findMany` with `columns: { ... }`.
 */
export interface ExpandableStep {
  snippetId: string | null;
  snippetDetached: boolean;
  title: string;
  blocks: typeof schema.procedureSteps.$inferSelect['blocks'];
  /** Step's own audio key, if any. When the step is snippet-attached and
   *  this is null, the snippet's audio is inherited at render time. */
  audioStorageKey?: string | null;
}

/**
 * Result of applying snippet expansion to a step.
 *
 *   blocks/title are the resolved values (snippet-overridden when attached).
 *   inheritedAudioStorageKey is the snippet's audio key when the attached
 *     step has no audio of its own — caller turns it into a publicUrl.
 *   _snippetBadge is non-null when the step references a snippet.
 */
export interface ExpandedFields {
  blocks: typeof schema.procedureSteps.$inferSelect['blocks'];
  title: string;
  inheritedAudioStorageKey: string | null;
  _snippetBadge: SnippetBadge | null;
}

/**
 * Load a Map<snippetId, snippet> for the given ids. Used by callers that
 * are about to render many steps; one round-trip resolves them all rather
 * than fan-out reads per step. Unknown ids (FK race, snippet deleted) are
 * silently omitted — expandStep falls back to the step's own content.
 */
export async function loadSnippetMap(
  db: Database,
  snippetIds: ReadonlyArray<string | null | undefined>,
): Promise<Map<string, ProcedureSnippet>> {
  const ids = [...new Set(snippetIds.filter((s): s is string => !!s))];
  if (ids.length === 0) return new Map();
  const rows = await db.query.procedureSnippets.findMany({
    where: inArray(schema.procedureSnippets.id, ids),
  });
  return new Map(rows.map((r) => [r.id, r]));
}

/**
 * Apply expansion to a single step using a pre-loaded snippet map.
 * Returns { blocks, title, _snippetBadge } — the caller spreads these
 * into its DTO shape, overriding the step's own blocks/title fields.
 */
export function expandStep(
  step: ExpandableStep,
  snippetMap: Map<string, ProcedureSnippet>,
): ExpandedFields {
  if (!step.snippetId) {
    return {
      blocks: step.blocks,
      title: step.title,
      inheritedAudioStorageKey: null,
      _snippetBadge: null,
    };
  }
  const snippet = snippetMap.get(step.snippetId);
  if (!snippet) {
    return {
      blocks: step.blocks,
      title: step.title,
      inheritedAudioStorageKey: null,
      _snippetBadge: null,
    };
  }
  // Audio fallback: step's own audio wins when present; otherwise the
  // snippet's audio is "inherited" at render time. We only surface the
  // inherited key when the step is attached AND has no audio of its
  // own — detached steps are fully independent.
  const hasInheritedAudio =
    !step.snippetDetached && !step.audioStorageKey && !!snippet.audioStorageKey;
  const badge: SnippetBadge = {
    id: snippet.id,
    title: snippet.title,
    isPlatform: snippet.isPlatform,
    detached: step.snippetDetached,
    hasInheritedAudio,
  };
  if (step.snippetDetached) {
    return {
      blocks: step.blocks,
      title: step.title,
      inheritedAudioStorageKey: null,
      _snippetBadge: badge,
    };
  }
  return {
    blocks: snippet.blocks,
    title: step.title && step.title.length > 0 ? step.title : snippet.title,
    inheritedAudioStorageKey: hasInheritedAudio ? snippet.audioStorageKey : null,
    _snippetBadge: badge,
  };
}

/**
 * Convenience: load snippets for a list of steps and return a parallel
 * array of { step, expanded } records. Most callers will spread expanded
 * into a DTO and drop step.blocks/step.title.
 */
export async function expandSteps<S extends ExpandableStep>(
  db: Database,
  steps: ReadonlyArray<S>,
): Promise<Array<{ step: S; expanded: ExpandedFields }>> {
  const snippetMap = await loadSnippetMap(
    db,
    steps.map((s) => s.snippetId),
  );
  return steps.map((step) => ({ step, expanded: expandStep(step, snippetMap) }));
}
