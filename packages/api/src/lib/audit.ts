// Central audit-write helper + the canonical registry of event types.
//
// Why this exists: audit writes used to be open-coded as
// `db.insert(schema.auditEvents).values({...})` at ~80 call sites. That left
// three problems:
//   1. ip/userAgent were captured in exactly one place, so most events could
//      not answer "from where".
//   2. The insert was awaited inline in the request path with no error
//      handling, so a failed audit write would fail the user's actual
//      operation (a QR scan should never 500 because the log is briefly
//      unavailable).
//   3. eventType was free-form text — typos were silent and the full
//      vocabulary was undiscoverable.
//
// recordAudit() fixes all three: it is the single sanctioned way to append an
// audit event. It auto-fills actor/ip/user-agent/request-id from the request,
// is best-effort (never throws — a write failure is logged, not propagated),
// and constrains eventType to the AuditEventType union below.
//
// Integrity note: the audit_events table is append-only and tamper-evident at
// the DATABASE level (a BEFORE INSERT trigger maintains a per-org SHA-256 hash
// chain; a BEFORE UPDATE/DELETE trigger rejects mutations). This helper does
// NOT compute the hash — the database owns that, so the chain holds regardless
// of how a row is inserted. See migration 0049_audit_integrity.sql.

import type { FastifyBaseLogger, FastifyRequest } from 'fastify';
import { schema, type Database } from '@platform/db';

/**
 * The closed set of audit event types the platform may emit. Adding a new
 * event means adding it here first — that is deliberate. A typed vocabulary
 * gives us autocompletion at every call site, catches typos at compile time,
 * and makes the full surface auditable in one place.
 *
 * Naming convention: `<entity>.<verb>` in snake_case, dot-separated. Group by
 * the entity the event is about.
 */
export const AUDIT_EVENT_TYPES = [
  // ---- Authentication & identity -----------------------------------------
  'auth.sign_in.rejected',
  'auth.user.provisioned',
  'auth.platform_admin.granted',
  'auth.platform_admin.revoked',

  // ---- Organization settings (security-relevant) -------------------------
  'organization.privacy_updated',

  // ---- QR / asset hub (highest-volume, scan-path) ------------------------
  'qr.scan',
  'qr.scan.blocked',
  'asset.hub.viewed',

  // ---- Work orders --------------------------------------------------------
  'work_order.opened',
  'work_order.status_changed',

  // ---- Content packs ------------------------------------------------------
  'content_pack.published',
  'content_pack_version.deleted',

  // ---- Documents & sections ----------------------------------------------
  'document.moved_version',
  'document.field_verified',
  'document.field_capture_orphan_deleted',
  'document_section.created',
  'document_section.updated',
  'document_section.deleted',
  'document_section.parts.set',
  'document_section.revalidated',

  // ---- Procedures (authoring + runs) -------------------------------------
  'procedure.duplicated',
  'procedure.promoted_from_ai',
  'procedure_run.started',
  'procedure_run.finished',
  'procedure_run.step_completed',
  'procedure_run.step_skipped',
  'procedure_run.paused',
  'procedure_run.resumed',
  'procedure_run.abandoned',
  'procedure_run.cloned_from_template',
  'procedure_run.authoring_completed',
  'procedure_run.field_authoring_started',
  'procedure_run.field_authoring_finalized',
  'procedure_section.created',
  'procedure_section.updated',
  'procedure_section.deleted',
  'procedure_section.reordered',
  'procedure_step.created',
  'procedure_step.updated',
  'procedure_step.snippet_detached',
  'procedure_step.deleted',
  'procedure_step.reordered',
  'procedure_step.clip_range_edited',
  'procedure_step.parts.set',
  'procedure_step.media_added',
  'procedure_step.media_removed',
  'procedure_step.audio_uploaded',
  'procedure_step.audio_generated',
  'procedure_step.audio_deleted',
  'procedure_step.field_authored',
  'procedure_step.field_authored.edited',
  'procedure_step_category.created',
  'procedure_step_category.updated',
  'procedure_step_category.deleted',

  // ---- Procedure drafts (AI-assisted) ------------------------------------
  'procedure_draft.created',
  'procedure_draft.ai_started',
  'procedure_draft.proposal_edited',
  'procedure_draft.category_set',
  'procedure_draft.executed',
  'procedure_draft.cancelled',
  'procedure_draft.pwa_submitted',

  // ---- Procedure snippets -------------------------------------------------
  'procedure_snippet.created',
  'procedure_snippet.updated',
  'procedure_snippet.deleted',
  'procedure_snippet.platform_propagated',
  'procedure_snippet.audio_uploaded',
  'procedure_snippet.audio_generated',
  'procedure_snippet.audio_removed',

  // ---- Slide courses ------------------------------------------------------
  'slide_deck.manually_created',
  'slide_deck.updated',
  'slide_deck.reordered',
  'slide_deck.training_course_created',
  'slide_deck.auto_convert_requested',
  'slide_deck.retry_conversion',
  'slide_deck_slide.created',
  'slide_deck_slide.created_blank',
  'slide_deck_slide.updated',
  'slide_deck_slide.deleted',
  'slide_deck_slide.image_replaced',
  'slide_deck_slide.block_media_uploaded',
  'slide_deck_slide.block_media_presigned',
  'slide_deck_slide.voiceover_uploaded',
  'slide_deck_slide.voiceover_deleted',
  'slide_interaction.created',
  'slide_interaction.updated',
  'slide_interaction.deleted',
  'activity.slide_course_created',

  // ---- SCORM --------------------------------------------------------------
  'scorm_package.created',

  // ---- AI -----------------------------------------------------------------
  'ai.chat.message',

  // ---- Audit log itself (meta-events) ------------------------------------
  'audit.exported',
] as const;

export type AuditEventType =
  | (typeof AUDIT_EVENT_TYPES)[number]
  // The onboarding agent emits a dynamic `agent.<kind>.<status>` family
  // (see lib/agent-executor.ts) generated from runtime step state. These are
  // internal and machine-produced, so they get a structured escape hatch
  // rather than one enumerated entry per kind×status combination.
  | `agent.${string}`;

/** Fast membership check for runtime-supplied event-type strings (e.g. a
 *  facet filter coming off the wire). */
const AUDIT_EVENT_TYPE_SET: ReadonlySet<string> = new Set(AUDIT_EVENT_TYPES);
export function isAuditEventType(value: string): value is AuditEventType {
  return AUDIT_EVENT_TYPE_SET.has(value);
}

export interface AuditEventInput {
  /** The org the event belongs to. Required — every event is org-scoped. */
  organizationId: string;
  eventType: AuditEventType;
  /** Canonical entity this event is about (e.g. 'work_order', 'asset_instance'). */
  targetType: string;
  targetId?: string | null;
  /** Small structured payload. Keep large bodies elsewhere and reference. */
  payload?: Record<string, unknown>;
  /**
   * Override the actor. Defaults to request.auth?.userId. Pass `null`
   * explicitly for system-originated events, or a specific id when recording
   * an action on behalf of a user outside the normal request-auth path (e.g.
   * first-sign-in provisioning, where auth isn't attached to the request yet).
   */
  actorUserId?: string | null;
}

/**
 * The slice of a Fastify request recordAudit reads. Accepting a structural
 * type (rather than the full FastifyRequest) lets non-HTTP callers — workers,
 * the auth preHandler before request.auth is set — pass a partial or null.
 */
export type AuditRequestContext = {
  auth?: { userId: string } | undefined;
  ip?: string;
  headers?: Record<string, unknown>;
  id?: string;
  log?: FastifyBaseLogger;
} | null;

function headerString(headers: Record<string, unknown> | undefined, key: string): string | null {
  const v = headers?.[key];
  if (typeof v === 'string') return v;
  if (Array.isArray(v) && typeof v[0] === 'string') return v[0];
  return null;
}

/**
 * Append an audit event. Best-effort: a failed write is logged and swallowed,
 * never thrown, so the audit log can never take down the operation it records.
 *
 * The DB trigger fills seq/prev_hash/row_hash; callers must not supply them.
 */
export async function recordAudit(
  db: Database,
  request: AuditRequestContext | FastifyRequest,
  event: AuditEventInput,
): Promise<void> {
  const req = request as AuditRequestContext;
  const actorUserId =
    event.actorUserId !== undefined ? event.actorUserId : req?.auth?.userId ?? null;
  try {
    await db.insert(schema.auditEvents).values({
      organizationId: event.organizationId,
      actorUserId,
      eventType: event.eventType,
      targetType: event.targetType,
      targetId: event.targetId ?? null,
      payload: event.payload ?? {},
      ipAddress: req?.ip ?? null,
      userAgent: headerString(req?.headers, 'user-agent'),
      requestId: req?.id ?? null,
    });
  } catch (err) {
    const log: Pick<FastifyBaseLogger, 'warn'> = req?.log ?? console;
    log.warn(
      { err, eventType: event.eventType, targetType: event.targetType },
      'audit: write failed (event dropped)',
    );
  }
}
