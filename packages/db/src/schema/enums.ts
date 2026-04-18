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
