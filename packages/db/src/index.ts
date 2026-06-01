export * from './client';
export * as schema from './schema';
// Selected type re-exports so consumers can `import type { ... } from '@platform/db'`
// without piercing the schema namespace. Add new ones sparingly — most code
// should reach for the schema namespace itself.
export type { VoiceQuotaConfig, VoiceUsage, NewVoiceUsage } from './schema/voice-usage';
export type { RequiredTools, ProcedureDocMetadata } from './schema/content';
export { normalizeRequiredTools } from './schema/content';
export type { PmPlanFrequency } from './schema/preventive-maintenance';
export type {
  ProcedureSnippet,
  NewProcedureSnippet,
  ProcedureSnippetRevision,
  NewProcedureSnippetRevision,
} from './schema/snippets';
export type {
  SearchIndexItem,
  NewSearchIndexItem,
  SearchSourceType,
} from './schema/search-index';
export type { StepBlock, MeasurementSpec, ProcedureStepMedia } from './schema/procedures';
export type {
  ProcedureDraftRun,
  NewProcedureDraftRun,
  ProcedureDraftProposal,
  NewProcedureDraftProposal,
  ProcedureDraftExecution,
  NewProcedureDraftExecution,
  ProcedureDraftExecutionStep,
  NewProcedureDraftExecutionStep,
  ProcedureDraftRunStatus,
  ProcedureDraftSourceKind,
  DraftFigure,
  ProcedureDraftExecutionStatus,
  ProcedureDraftExecutionStepStatus,
  ProcedureDraftTokenUsage,
} from './schema/procedure-drafts';
export {
  PM_PLAN_FREQUENCY_DAYS,
  PM_PLAN_FREQUENCY_LABEL,
} from './schema/preventive-maintenance';
