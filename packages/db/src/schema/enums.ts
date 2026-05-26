import { pgEnum } from 'drizzle-orm/pg-core';

// Organizations have three distinct types — permissions and cascade behavior differ.
// OEMs publish base content. Dealers overlay. End-customers consume.
export const organizationTypeEnum = pgEnum('organization_type', [
  'oem',
  'dealer',
  'integrator',
  'end_customer',
]);

export const roleEnum = pgEnum('role', [
  'operator',
  'technician',
  'trainer',
  'safety_manager',
  'admin',
  'oem_author',
  'platform_admin',
]);

// ContentPack is versioned; a Version is immutable once published.
export const contentPackStatusEnum = pgEnum('content_pack_status', [
  'draft',
  'in_review',
  'published',
  'archived',
]);

// Layer type determines the resolution order when rendering for an Asset Instance:
//   base (OEM) → dealer_overlay → site_overlay
// Merged view is resolved server-side.
export const contentLayerTypeEnum = pgEnum('content_layer_type', [
  'base',
  'dealer_overlay',
  'site_overlay',
]);

export const documentKindEnum = pgEnum('document_kind', [
  'markdown',
  'pdf',
  'video',
  'structured_procedure',
  'schematic',
  'slides',
  'file',
  'external_video',
]);

export const activityKindEnum = pgEnum('activity_kind', [
  'quiz',
  'checklist',
  'procedure_signoff',
  'video_knowledge_check',
  'practical',
  // Slide-deck eLearning course (PPTX upload → per-slide PNGs → optional
  // voiceover + interactions + author-chosen navigation gating). Activity
  // config: { slideDeckId: uuid }. See schema/slide-courses.ts.
  'slide_course',
]);

export const enrollmentStatusEnum = pgEnum('enrollment_status', [
  'not_started',
  'in_progress',
  'completed',
  'failed',
  'expired',
]);

export const workOrderStatusEnum = pgEnum('work_order_status', [
  'open',
  'acknowledged',
  'in_progress',
  'blocked',
  'resolved',
  'closed',
]);

export const workOrderSeverityEnum = pgEnum('work_order_severity', [
  'info',
  'low',
  'medium',
  'high',
  'critical',
]);

export const aiMessageRoleEnum = pgEnum('ai_message_role', ['user', 'assistant', 'system', 'tool']);

// Per-document extraction lifecycle. A document uploaded as PDF/DOCX/PPTX needs
// its text pulled out and chunked before the AI can ground on it. We surface
// the state so the admin UI can show progress and failures instead of silent
// "AI doesn't know about this doc" behavior.
export const extractionStatusEnum = pgEnum('extraction_status', [
  'not_applicable', // markdown-native / external video — nothing to extract.
  'pending',        // queued, haven't started yet.
  'processing',     // extraction in flight.
  'ready',          // extracted + chunked + embedded.
  'failed',         // terminal failure; see extractionError for details.
]);

// Procedure step authoring kind. Single discriminator drives evidence
// requirements per step. Future kinds (signature_required, barcode_scan)
// extend this enum without breaking existing rows.
export const procedureStepKindEnum = pgEnum('procedure_step_kind', [
  'instruction',          // read-and-tap; no evidence
  'safety_check',         // read-and-tap; safetyCritical implied
  'photo_required',       // must capture >= minPhotoCount photos
  'measurement_required', // must enter a value matching measurementSpec
]);

// Run lifecycle. Explicit paused state separates "tech walked away" from
// "tech ran into a problem" (abandoned). completed/abandoned are terminal.
// Server enforces transitions; see packages/api/src/routes/procedures.ts.
export const procedureRunStatusEnum = pgEnum('procedure_run_status', [
  'in_progress',
  'paused',
  'completed',
  'abandoned',
]);

// Content pack kind discriminator. 'authored' = OEM/dealer/site-overlay
// packs whose contents are explicitly written + version-published.
// 'field_captures' = the always-draft pack each asset model gets so techs
// can document procedures from the PWA on site. The PWA reads from BOTH
// kinds; cards from field_captures get an UNVERIFIED chip until promoted.
export const contentPackKindEnum = pgEnum('content_pack_kind', [
  'authored',
  'field_captures',
]);

// Slide-deck PPTX-to-PNG conversion lifecycle. Independent of the per-document
// extraction pipeline because rendering slides (LibreOffice + Poppler) is a
// separate concern from text extraction (LlamaParse / pptx text reader). The
// admin UI shows both states; failure of one does not block the other.
export const slideDeckConversionStatusEnum = pgEnum('slide_deck_conversion_status', [
  'pending',
  'processing',
  'ready',
  'failed',
]);

// Per-slide playback gate. Author chooses how strict to be: free advance,
// require the voiceover to finish, require all interactions to be answered/
// passed, or both. The player at apps/pwa/src/components/slide-course-player
// enforces; the admin form in slide-settings.tsx writes.
export const slideNavigationGateEnum = pgEnum('slide_navigation_gate', [
  'free',
  'require_voiceover',
  'require_interactions',
  'require_both',
]);

// Interaction kinds within a slide. mcq/true_false/drag_match grade
// deterministically server-side; short_answer_ai dispatches to OpenAI
// gpt-4o-mini with a rubric. Future: image-region drag, hotspot, ordering.
export const slideInteractionKindEnum = pgEnum('slide_interaction_kind', [
  'mcq',
  'true_false',
  'drag_match',
  'short_answer_ai',
]);

// Slide-course attempt state machine. Distinct from enrollmentStatus because
// a single enrollment may roll up multiple activities; this tracks one course's
// own progress + scoring before it folds into activityResults.
export const slideAttemptStatusEnum = pgEnum('slide_attempt_status', [
  'in_progress',
  'submitted',
  'passed',
  'failed',
]);
