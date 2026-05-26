import { AssetHubPayloadSchema, type AssetHubPayload } from './shared-schema';

// Two base URLs by intent:
//   SERVER_API_BASE — used by server components / route handlers that can
//     reach the upstream API directly. /assets/resolve is the only endpoint
//     that the server component hits this way; everything else flows
//     through CLIENT_API_BASE so the proxy can attach the scan cookie.
//   CLIENT_API_BASE — same-origin proxy path (/api) that runs through the
//     Next.js route handler at apps/pwa/src/app/api/[...path]. That proxy
//     reads the HttpOnly scan cookie and forwards it to the upstream API
//     as X-Scan-Session. Browser code can't read the cookie directly;
//     cross-origin cookie forwarding is brittle; the proxy solves both.
const SERVER_API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? 'http://localhost:3001';
const CLIENT_API_BASE = '/api';

export type AssetResolveSource = 'qr' | 'direct' | 'blocked';

/**
 * Look up the asset hub payload for a QR code. Called from Server
 * Components — the caller MUST pass `scanSession` (the raw signed cookie
 * value) when one is present, otherwise the security-hardened
 * /assets/resolve endpoint refuses the call with 401.
 *
 * Why a param instead of `next/headers` here: this module is imported by
 * many `'use client'` components, and Next's bundler refuses to compile
 * any file that references `next/headers` (server-only) when it can be
 * reached from a client bundle. Passing the cookie in keeps the shared
 * lib client-safe.
 */
export async function resolveAssetHub(
  qrCode: string,
  source: AssetResolveSource = 'direct',
  scanSession?: string,
): Promise<AssetHubPayload | null> {
  const qs = source === 'direct' ? '' : `?source=${source}`;
  const headers: HeadersInit = {};
  if (scanSession) headers['x-scan-session'] = scanSession;
  const res = await fetch(
    `${SERVER_API_BASE}/assets/resolve/${encodeURIComponent(qrCode)}${qs}`,
    {
      headers,
      // No caching — QR resolution must always reflect current pinned version.
      cache: 'no-store',
    },
  );
  // 401 is the unauthenticated/no-scan case (URL share without /q/scan).
  // 404 is unknown QR. Both surface as "not found" to the caller.
  if (res.status === 404 || res.status === 401) return null;
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
  const json = await res.json();
  return AssetHubPayloadSchema.parse(json);
}

export type DocumentKind =
  | 'markdown'
  | 'pdf'
  | 'video'
  | 'structured_procedure'
  | 'schematic'
  | 'slides'
  | 'file'
  | 'external_video';

export interface DocumentListItem {
  id: string;
  kind: DocumentKind;
  title: string;
  language: string;
  safetyCritical: boolean;
  tags: string[];
  hasBody: boolean;
  storageKey: string | null;
  /** Resolved public URL for the file. Null when storageKey is null. */
  fileUrl?: string | null;
  streamPlaybackId: string | null;
  externalUrl?: string | null;
  originalFilename?: string | null;
  contentType?: string | null;
  sizeBytes?: number | null;
  thumbnailUrl?: string | null;
  /** Populated only when the caller passes `withSections=true`. null =
   *  legacy doc with no authored sections (render full doc); array =
   *  authored sections, post-revalidation filter, sorted. */
  sections?: PwaDocumentSection[] | null;
  /** Server-resolved Maintenance-tab bucket. Set on structured_procedure
   *  docs only; non-procedure docs return null. Pulled from the doc's
   *  procedureMetadata.category when set; otherwise inferred server-side
   *  from the title (legacy fallback so older content keeps bucketing
   *  the same way until an author opts in to the explicit picker). */
  procedureCategory?:
    | 'preventive_maintenance'
    | 'removal_replacement'
    | 'troubleshooting'
    | 'walkthrough'
    | null;
  // ---- Procedure mode v2 — field-authored documents ----
  /** 'oem' = doc lives in an authored content pack. 'field' = captured
   *  by a tech via the PWA on site. Drives the UNVERIFIED chip. */
  source?: 'oem' | 'field';
  /** Only meaningful when source='field'. true after an admin promotes. */
  verified?: boolean;
  capturedByUserId?: string | null;
  capturedByDisplayName?: string | null;
  /** Set when this doc is scoped to one asset instance only. */
  scopeAssetInstanceId?: string | null;
}

export async function listDocuments(
  versionId: string,
  lang: string = 'en',
  withSections: boolean = false,
  assetInstanceId?: string,
): Promise<DocumentListItem[]> {
  const qs = new URLSearchParams({ lang });
  if (withSections) qs.set('withSections', '1');
  // assetInstanceId is required when querying a field-captures version so
  // instance-scoped procedures don't leak to other instances of the same
  // model. Sending it for OEM versions is harmless (model-wide docs are
  // unaffected by the filter).
  if (assetInstanceId) qs.set('assetInstanceId', assetInstanceId);
  const res = await fetch(
    `${CLIENT_API_BASE}/content-pack-versions/${encodeURIComponent(versionId)}/documents?${qs.toString()}`,
    { cache: 'no-store' },
  );
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
  return (await res.json()) as DocumentListItem[];
}

export interface DocumentBody extends DocumentListItem {
  bodyMarkdown: string | null;
  /** AI-extracted markdown for binary docs (PDFs etc.). Populated by the
   *  extraction pipeline. Used by text-range section rendering as the
   *  reader-friendly text representation when bodyMarkdown isn't set. */
  extractedText: string | null;
  fileUrl: string | null;
}

export async function getDocument(id: string): Promise<DocumentBody | null> {
  const res = await fetch(`${CLIENT_API_BASE}/documents/${encodeURIComponent(id)}`, {
    cache: 'no-store',
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
  return (await res.json()) as DocumentBody;
}

/** Section + parent doc for one section ID. Used by SectionViewerOverlay
 *  when the AI emits a [section:UUID] directive in voice mode. */
export interface SectionBundle {
  document: DocumentBody;
  section: PwaDocumentSection;
}

export async function getSection(id: string): Promise<SectionBundle | null> {
  const res = await fetch(`${CLIENT_API_BASE}/sections/${encodeURIComponent(id)}`, {
    cache: 'no-store',
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
  return (await res.json()) as SectionBundle;
}

export interface TrainingModuleSummary {
  id: string;
  title: string;
  description: string | null;
  estimatedMinutes: number | null;
  competencyTag: string | null;
  passThreshold: number;
  lessonCount: number;
  activityCount: number;
  enrollment: { id: string; status: string; score: number | null } | null;
}

export async function listTrainingModules(
  versionId: string,
  devUserId: string,
  devOrgId: string,
): Promise<TrainingModuleSummary[]> {
  const res = await fetch(
    `${CLIENT_API_BASE}/content-pack-versions/${encodeURIComponent(versionId)}/training-modules`,
    {
      cache: 'no-store',
      headers: { 'x-dev-user': `${devUserId}:${devOrgId}` },
    },
  );
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
  return (await res.json()) as TrainingModuleSummary[];
}

export interface TrainingModuleDetail {
  id: string;
  title: string;
  description: string | null;
  estimatedMinutes: number | null;
  passThreshold: number;
  lessons: Array<{
    id: string;
    title: string;
    bodyMarkdown: string | null;
    streamPlaybackId: string | null;
    orderingHint: number;
  }>;
  activities: Array<{
    id: string;
    kind:
      | 'quiz'
      | 'checklist'
      | 'procedure_signoff'
      | 'video_knowledge_check'
      | 'practical'
      | 'slide_course';
    title: string;
    config: any;
    weight: number;
    orderingHint: number;
  }>;
}

export async function getTrainingModule(id: string): Promise<TrainingModuleDetail | null> {
  const res = await fetch(`${CLIENT_API_BASE}/training-modules/${encodeURIComponent(id)}`, {
    cache: 'no-store',
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
  return (await res.json()) as TrainingModuleDetail;
}

export async function startEnrollment(params: {
  trainingModuleId: string;
  assetInstanceId?: string;
  devUserId: string;
  devOrgId: string;
}): Promise<{ id: string; status: string; score: number | null }> {
  const res = await fetch(`${CLIENT_API_BASE}/enrollments`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-dev-user': `${params.devUserId}:${params.devOrgId}`,
    },
    body: JSON.stringify({
      trainingModuleId: params.trainingModuleId,
      assetInstanceId: params.assetInstanceId,
    }),
  });
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
  return (await res.json()) as { id: string; status: string; score: number | null };
}

export interface QuizResult {
  activityScore: number;
  correct: number;
  total: number;
  perQuestion: Array<{
    questionIndex: number;
    chosenIndex: number;
    correctIndex: number;
    correct: boolean;
  }>;
  enrollment: { id: string; status: string; score: number | null };
}

export async function submitQuiz(params: {
  enrollmentId: string;
  activityId: string;
  answers: number[];
  devUserId: string;
  devOrgId: string;
}): Promise<QuizResult> {
  const res = await fetch(
    `${CLIENT_API_BASE}/enrollments/${encodeURIComponent(params.enrollmentId)}/submit-quiz`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-dev-user': `${params.devUserId}:${params.devOrgId}`,
      },
      body: JSON.stringify({ activityId: params.activityId, answers: params.answers }),
    },
  );
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
  return (await res.json()) as QuizResult;
}

export type WorkOrderSeverity = 'info' | 'low' | 'medium' | 'high' | 'critical';
export type WorkOrderStatus =
  | 'open'
  | 'acknowledged'
  | 'in_progress'
  | 'blocked'
  | 'resolved'
  | 'closed';

export interface WorkOrderAttachment {
  key: string;
  mime: string;
  url: string;
  caption?: string;
}

export interface WorkOrder {
  id: string;
  title: string;
  description: string | null;
  status: WorkOrderStatus;
  severity: WorkOrderSeverity;
  openedAt: string;
  resolvedAt: string | null;
  closedAt: string | null;
  openedBy: { id: string; displayName: string } | null;
  assignedTo: { id: string; displayName: string } | null;
  attachments: WorkOrderAttachment[];
}

export interface UploadResult {
  storageKey: string;
  sha256: string;
  size: number;
  contentType: string;
  originalFilename: string;
  url: string;
}

export type FeedbackCategory = 'bug' | 'feature' | 'question' | 'praise' | 'other';

export async function submitFeedback(params: {
  message: string;
  category: FeedbackCategory;
  qrCode?: string;
  assetInstanceId?: string;
  contactEmail?: string;
}): Promise<{ id: string }> {
  const viewport =
    typeof window !== 'undefined'
      ? { w: window.innerWidth, h: window.innerHeight }
      : undefined;
  const res = await fetch(`${CLIENT_API_BASE}/feedback`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      ...params,
      viewport,
      browserUa: typeof navigator !== 'undefined' ? navigator.userAgent : undefined,
      appVersion: process.env.NEXT_PUBLIC_APP_VERSION ?? 'dev',
    }),
  });
  if (!res.ok) throw new Error(`Feedback ${res.status}: ${await res.text()}`);
  return (await res.json()) as { id: string };
}

// ---------------------------------------------------------------------------
// Identity / admin gating.
// ---------------------------------------------------------------------------

export interface MeIdentity {
  userId: string;
  organizationId: string;
  platformAdmin: boolean;
}

export async function fetchMe(devUserId: string, devOrgId: string): Promise<MeIdentity | null> {
  const res = await fetch(`${CLIENT_API_BASE}/me`, {
    cache: 'no-store',
    headers: { 'x-dev-user': `${devUserId}:${devOrgId}` },
  });
  if (!res.ok) return null;
  const json = (await res.json()) as
    | MeIdentity
    | { unauthenticated: true };
  if ('unauthenticated' in json) return null;
  return json;
}

// Promote an assistant message into a draft authored procedure. Returns
// the new document id so the caller can deep-link into the admin editor.
export async function promoteAiMessageToProcedure(params: {
  messageId: string;
  title?: string;
  devUserId: string;
  devOrgId: string;
}): Promise<{
  documentId: string;
  packVersionId: string;
  title: string;
  stepCount: number;
  hadStructure: boolean;
}> {
  const res = await fetch(`${CLIENT_API_BASE}/admin/procedures/from-ai-message`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-dev-user': `${params.devUserId}:${params.devOrgId}`,
    },
    body: JSON.stringify({
      messageId: params.messageId,
      ...(params.title ? { title: params.title } : {}),
    }),
  });
  if (!res.ok) {
    throw new Error(`Promote ${res.status}: ${await res.text()}`);
  }
  return (await res.json()) as {
    documentId: string;
    packVersionId: string;
    title: string;
    stepCount: number;
    hadStructure: boolean;
  };
}

// ---------------------------------------------------------------------------
// Voice (STT + TTS) and AI-first preflight brief.
// ---------------------------------------------------------------------------

export interface PreflightBrief {
  assetModelDisplayName: string;
  serialNumber: string;
  pinnedVersionLabel: string | null;
  openWorkOrders: { count: number; samples: Array<{ title: string; severity: string }> };
  recentResolved: { count: number; commonTitle: string | null };
  recentDocUpdates: Array<{ title: string; kind: string; at: string }>;
  greeting: string;
}

export async function fetchPreflight(assetInstanceId: string): Promise<PreflightBrief> {
  const res = await fetch(
    `${CLIENT_API_BASE}/ai/preflight/${encodeURIComponent(assetInstanceId)}`,
    { cache: 'no-store' },
  );
  if (!res.ok) throw new Error(`Preflight ${res.status}: ${await res.text()}`);
  return (await res.json()) as PreflightBrief;
}

export async function transcribeAudio(blob: Blob): Promise<string> {
  const form = new FormData();
  form.append('audio', blob, 'recording.webm');
  const res = await fetch(`${CLIENT_API_BASE}/ai/voice/transcribe`, {
    method: 'POST',
    body: form,
  });
  if (res.status === 503) throw new Error('Voice transcription is not configured.');
  if (!res.ok) throw new Error(`Transcribe ${res.status}: ${await res.text()}`);
  const json = (await res.json()) as { text: string };
  return json.text;
}

// ---------------------------------------------------------------------------
// Voice search
// ---------------------------------------------------------------------------

export type VoiceSearchJumpTarget =
  | {
      kind: 'jobaid';
      docId: string;
      initialStepId: string;
      sectionTitle?: string | null;
    }
  | { kind: 'section'; sectionId: string; docId: string }
  | {
      kind: 'doc';
      docId: string;
      pageStart?: number | null;
      pageEnd?: number | null;
    };

export interface VoiceSearchResult {
  id: string;
  sourceType: 'doc_chunk' | 'procedure_step' | 'document_section';
  sourceId: string;
  documentId: string | null;
  contentPackVersionId: string;
  title: string;
  snippet: string;
  score: number;
  docTitle: string | null;
  sectionTitle: string | null;
  jumpTarget: VoiceSearchJumpTarget | null;
}

export interface VoiceSearchResponse {
  transcript: string;
  results: VoiceSearchResult[];
  spokenPreview: {
    text: string;
    confidence: 'none' | 'low' | 'confident';
  };
}

export async function voiceSearch(
  blob: Blob,
  opts: { assetInstanceId?: string; topK?: number },
): Promise<VoiceSearchResponse> {
  const form = new FormData();
  form.append('audio', blob, 'query.webm');
  if (opts.assetInstanceId) form.append('assetInstanceId', opts.assetInstanceId);
  if (opts.topK != null) form.append('topK', String(opts.topK));
  const res = await fetch(`${CLIENT_API_BASE}/ai/search/voice`, {
    method: 'POST',
    body: form,
  });
  if (res.status === 503) throw new Error('Voice search is not configured.');
  if (!res.ok) throw new Error(`Search ${res.status}: ${await res.text()}`);
  return (await res.json()) as VoiceSearchResponse;
}

// ---------------------------------------------------------------------------
// Procedure draft submissions (video walkthrough → AI procedure)
// ---------------------------------------------------------------------------

export interface DraftSubmissionResponse {
  runId: string;
  uploadId: string;
  uploadUrl: string;
}

export async function submitProcedureDraft(input: {
  assetInstanceId: string;
  proposedTitle: string;
  notes?: string;
  /** Tech-asserted orientation. Optional — when present, the player on
   *  the runner uses this to frame the clip instead of whatever Mux
   *  auto-detects from the asset. Lets the tech correct the published
   *  shape when the auto-detection is wrong (e.g., a sideways
   *  recording that didn't carry a rotation tag through Mux ingest). */
  orientationOverride?: 'portrait' | 'landscape';
  /** Procedure category — drives both which Maintenance bucket the
   *  promoted procedure ends up under AND the drafter's template
   *  selection. Set by the shared ProcedureIntake screens. */
  procedureCategory?: AuthoredProcedureCategory;
  /** Dev-auth credentials. Matches the rest of the PWA writers (start
   *  procedure run, submit feedback, etc.) — `x-dev-user` header is
   *  what the API auth middleware accepts in dev. Prod OIDC swap is a
   *  TODO across the whole PWA. */
  devUserId: string;
  devOrgId: string;
}): Promise<DraftSubmissionResponse> {
  const res = await fetch(`${CLIENT_API_BASE}/pwa/procedure-drafts`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-dev-user': `${input.devUserId}:${input.devOrgId}`,
    },
    body: JSON.stringify({
      assetInstanceId: input.assetInstanceId,
      proposedTitle: input.proposedTitle,
      notes: input.notes,
      ...(input.orientationOverride
        ? { orientationOverride: input.orientationOverride }
        : {}),
      ...(input.procedureCategory
        ? { procedureCategory: input.procedureCategory }
        : {}),
    }),
  });
  if (res.status === 503) {
    throw new Error('Video submissions are not configured on this environment.');
  }
  if (!res.ok) {
    throw new Error(`Submit ${res.status}: ${await res.text()}`);
  }
  return (await res.json()) as DraftSubmissionResponse;
}

/** PUT the recorded file straight to Mux. Mirrors the admin helper but
 *  lives here so PWA bundles don't import from the admin package. */
export async function uploadDraftVideoToMuxFromPwa(
  uploadUrl: string,
  file: File | Blob,
  onProgress?: (frac: number) => void,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && onProgress) onProgress(e.loaded / e.total);
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve();
      else reject(new Error(`Mux upload ${xhr.status}: ${xhr.responseText}`));
    };
    xhr.onerror = () => reject(new Error('Mux upload network error'));
    xhr.open('PUT', uploadUrl);
    xhr.send(file);
  });
}

export async function textSearch(
  query: string,
  opts: { assetInstanceId?: string; topK?: number } = {},
): Promise<{ results: VoiceSearchResult[] }> {
  const res = await fetch(`${CLIENT_API_BASE}/ai/search`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      query,
      assetInstanceId: opts.assetInstanceId,
      topK: opts.topK,
    }),
  });
  if (!res.ok) throw new Error(`Search ${res.status}: ${await res.text()}`);
  return (await res.json()) as { results: VoiceSearchResult[] };
}

// Streamed audio response. Returns the response so the caller can pipe
// `response.body` into MediaSource for true streaming or use response.blob()
// for simple end-to-end playback.
export async function speak(
  text: string,
  opts?: { voice?: string; speed?: number; signal?: AbortSignal },
): Promise<Response> {
  const res = await fetch(`${CLIENT_API_BASE}/ai/voice/speak`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text, voice: opts?.voice, speed: opts?.speed, format: 'mp3' }),
    signal: opts?.signal,
  });
  if (res.status === 503) throw new Error('Voice synthesis is not configured.');
  if (!res.ok) throw new Error(`Speak ${res.status}: ${await res.text()}`);
  return res;
}

export async function uploadFile(
  file: File,
  devUserId: string,
  devOrgId: string,
): Promise<UploadResult> {
  const form = new FormData();
  form.append('file', file, file.name);
  // Use the dedicated chat-image endpoint so the upload is bound to the
  // calling user — required by /ai/chat's ownership check (see C-AI-1 in
  // the security audit). The generic /admin/uploads endpoint still exists
  // for admin authoring flows but is no longer the chat upload path.
  const res = await fetch(`${CLIENT_API_BASE}/ai/chat-images/upload`, {
    method: 'POST',
    headers: { 'x-dev-user': `${devUserId}:${devOrgId}` },
    body: form,
  });
  if (!res.ok) throw new Error(`Upload ${res.status}: ${await res.text()}`);
  return (await res.json()) as UploadResult;
}

// ---------------------------------------------------------------------
// Preventive Maintenance — field-tech reads + service record writes
// ---------------------------------------------------------------------

export type PmStatus = 'overdue' | 'due' | 'soon' | 'upcoming';

export interface PmScheduleStatusItem {
  schedule: {
    id: string;
    name: string;
    description: string | null;
    cadenceKind: 'days';
    cadenceValue: number;
    graceDays: number;
    document: { id: string; title: string; kind: string } | null;
  };
  lastPerformedAt: string | null;
  lastPerformedById: string | null;
  nextDueAt: string;
  daysUntilDue: number;
  status: PmStatus;
  needsAction: boolean;
}

export interface PmServiceRecordItem {
  id: string;
  /** Set when this record is a schedule-based mark (PmServiceRecord). */
  pmSchedule: { id: string; name: string } | null;
  /** Set when this record is a plan-bucket mark (PmPlanServiceRecord) —
   *  one of pmSchedule / pmPlan is non-null per row. The frequencyLabel
   *  is the friendly bucket name ("Daily" / "Monthly" / ...). */
  pmPlan: { id: string; name: string; frequencyLabel: string } | null;
  document: { id: string; title: string } | null;
  /** null when the org allows anonymous PWA writes and no tech was
   *  signed in — surfaces as "Field tech" in History. */
  performedBy: { id: string; displayName: string } | null;
  performedAt: string;
  notes: string | null;
}

export interface PmStatusPayload {
  schedules: PmScheduleStatusItem[];
  history: PmServiceRecordItem[];
  summary: {
    overdue: number;
    due: number;
    soon: number;
    upcoming: number;
    needsActionCount: number;
  };
}

export async function fetchPmStatus(
  assetInstanceId: string,
): Promise<PmStatusPayload> {
  const res = await fetch(
    `${CLIENT_API_BASE}/assets/${encodeURIComponent(assetInstanceId)}/pm-status`,
    { cache: 'no-store' },
  );
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
  return (await res.json()) as PmStatusPayload;
}

// --- PM Plans (checklist style, per-row frequency) -----------------------

export type PmPlanFrequency = 'D' | 'W' | 'M' | 'Q' | 'S' | 'Y';

export interface PmPlanBucketItem {
  id: string;
  component: string;
  checkText: string;
  remarks: string | null;
  document: { id: string; title: string; kind: string } | null;
}

export interface PmPlanBucket {
  frequency: PmPlanFrequency;
  frequencyLabel: string;
  itemCount: number;
  items: PmPlanBucketItem[];
  lastPerformedAt: string | null;
  lastPerformedById: string | null;
  nextDueAt: string;
  daysUntilDue: number;
  status: 'overdue' | 'due' | 'soon' | 'upcoming';
  needsAction: boolean;
}

export interface PmPlanStatusPayload {
  plans: Array<{
    plan: { id: string; name: string; description: string | null };
    buckets: PmPlanBucket[];
  }>;
}

export async function fetchPmPlanStatus(
  assetInstanceId: string,
): Promise<PmPlanStatusPayload> {
  const res = await fetch(
    `${CLIENT_API_BASE}/assets/${encodeURIComponent(assetInstanceId)}/pm-plan-status`,
    { cache: 'no-store' },
  );
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
  return (await res.json()) as PmPlanStatusPayload;
}

// --- Troubleshooting ---------------------------------------------------

/** Structured cause/remedy item with optional procedure link. The PWA
 *  renders each item as a numbered row; rows with a `document` get a
 *  small Run button that opens the linked procedure as a Job Aid. */
export interface TroubleshootingStructItem {
  text: string;
  document: { id: string; title: string } | null;
}

/** A single remedy step inside a cause. Multiple steps render as a
 *  bullet or numbered list; each step may carry its own Run button. */
export interface TroubleshootingRemedyStep {
  text: string;
  document: { id: string; title: string } | null;
}

/** Paired cause/remedy entry — the OEM mental model is that each cause
 *  has its own specific fix. The remedy is one or more steps rendered
 *  as a bullet or numbered list, like a mini procedure. */
export interface TroubleshootingCause {
  cause: string;
  remedyStyle: 'bullet' | 'numbered';
  remedySteps: TroubleshootingRemedyStep[];
}

export interface TroubleshootingItem {
  id: string;
  symptom: string;
  cause: string | null;
  remedy: string | null;
  /** DEPRECATED: pre-0028 unpaired parallel lists. Kept on the type so
   *  legacy guides still render until they're re-authored as paired
   *  `causes` entries. */
  causeItems: TroubleshootingStructItem[];
  remedyItems: TroubleshootingStructItem[];
  /** Canonical paired cause/remedy entries (0028+). */
  causes: TroubleshootingCause[];
  document: { id: string; title: string } | null;
}

export interface TroubleshootingGuide {
  guide: { id: string; name: string; description: string | null };
  items: TroubleshootingItem[];
}

export async function fetchTroubleshooting(
  assetInstanceId: string,
): Promise<{ guides: TroubleshootingGuide[] }> {
  const res = await fetch(
    `${CLIENT_API_BASE}/assets/${encodeURIComponent(assetInstanceId)}/troubleshooting`,
    { cache: 'no-store' },
  );
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
  return (await res.json()) as { guides: TroubleshootingGuide[] };
}

// PWA field writes intentionally omit the x-dev-user header so the
// API records them as anonymous (performedByUserId = null). The
// History card renders these as "Field tech". devUserId/devOrgId
// params remain on the signature for back-compat with existing
// callers and a future strict-mode path (OIDC sign-in), but they're
// not transmitted today.
export async function createPmPlanServiceRecord(params: {
  assetInstanceId: string;
  planId: string;
  frequency: PmPlanFrequency;
  performedAt?: string;
  notes?: string | null;
  devUserId: string;
  devOrgId: string;
}): Promise<{ id: string; performedAt: string }> {
  const res = await fetch(
    `${CLIENT_API_BASE}/assets/${encodeURIComponent(params.assetInstanceId)}/pm-plan-service-records`,
    {
      method: 'POST',
      credentials: 'include',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        planId: params.planId,
        frequency: params.frequency,
        performedAt: params.performedAt,
        notes: params.notes ?? null,
      }),
    },
  );
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
  return (await res.json()) as { id: string; performedAt: string };
}

export async function createPmServiceRecord(params: {
  assetInstanceId: string;
  pmScheduleId?: string | null;
  documentId?: string | null;
  procedureRunId?: string | null;
  performedAt?: string;
  notes?: string | null;
  devUserId: string;
  devOrgId: string;
}): Promise<{ id: string; performedAt: string }> {
  const res = await fetch(
    `${CLIENT_API_BASE}/assets/${encodeURIComponent(params.assetInstanceId)}/pm-service-records`,
    {
      method: 'POST',
      credentials: 'include',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        pmScheduleId: params.pmScheduleId ?? null,
        documentId: params.documentId ?? null,
        procedureRunId: params.procedureRunId ?? null,
        performedAt: params.performedAt,
        notes: params.notes ?? null,
      }),
    },
  );
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
  return (await res.json()) as { id: string; performedAt: string };
}

export async function listWorkOrders(
  assetInstanceId: string,
  status: 'open' | 'all' = 'open',
): Promise<WorkOrder[]> {
  const res = await fetch(
    `${CLIENT_API_BASE}/asset-instances/${encodeURIComponent(assetInstanceId)}/work-orders?status=${status}`,
    { cache: 'no-store' },
  );
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
  return (await res.json()) as WorkOrder[];
}

export async function createWorkOrder(params: {
  assetInstanceId: string;
  title: string;
  description?: string;
  severity?: WorkOrderSeverity;
  attachments?: Array<{ key: string; mime: string; caption?: string }>;
  devUserId: string;
  devOrgId: string;
}): Promise<WorkOrder> {
  // Work-order POST is anonymous from the PWA (no x-dev-user). Server
  // attributes openedByUserId = null when there's no auth header; the
  // record still ties back to assetInstance + site via the scan
  // session. Issues panel renders the reporter as "Field tech".
  const res = await fetch(`${CLIENT_API_BASE}/work-orders`, {
    method: 'POST',
    credentials: 'include',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      assetInstanceId: params.assetInstanceId,
      title: params.title,
      description: params.description,
      severity: params.severity,
      attachments: params.attachments,
    }),
  });
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
  return (await res.json()) as WorkOrder;
}

export type PartRole = 'part' | 'assembly' | 'component' | 'sub_assembly';

export interface BomEntry {
  bomEntryId: string;
  partId: string;
  positionRef: string | null;
  quantity: number;
  notes: string | null;
  oemPartNumber: string | null;
  displayName: string;
  description: string | null;
  crossReferences: string[];
  discontinued: boolean;
  imageUrl: string | null;
  role: PartRole;
}

export async function listParts(modelId: string): Promise<BomEntry[]> {
  const res = await fetch(`${CLIENT_API_BASE}/asset-models/${encodeURIComponent(modelId)}/parts`, {
    cache: 'no-store',
  });
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
  return (await res.json()) as BomEntry[];
}

export type PwaSectionKind = 'page_range' | 'text_range' | 'time_range';

export interface PwaDocumentSection {
  id: string;
  kind: PwaSectionKind;
  title: string;
  description: string | null;
  safetyCritical: boolean;
  orderingHint: number;
  pageStart: number | null;
  pageEnd: number | null;
  /** 0..1 fractional crop on the first page (top-down). null = no crop. */
  startY: number | null;
  /** 0..1 fractional crop on the last page (top-down). null = no crop. */
  endY: number | null;
  textPageHint: number | null;
  anchorExcerpt: string | null;
  anchorContextBefore: string | null;
  anchorContextAfter: string | null;
  timeStartSeconds: number | null;
  timeEndSeconds: number | null;
}

export interface PartResources {
  part: {
    id: string;
    oemPartNumber: string;
    displayName: string;
    description: string | null;
    crossReferences: string[];
    discontinued: boolean;
    imageUrl: string | null;
    role: PartRole;
  };
  documents: Array<{
    id: string;
    title: string;
    kind: string;
    safetyCritical: boolean;
    language: string;
    orderingHint: number;
    /** null → render the full doc (legacy / no sections defined).
     *  array → strict-fallback: render only these sections. The API
     *  already filtered to those linking to this part and excluded any
     *  that are flagged for re-validation. */
    sections: PwaDocumentSection[] | null;
  }>;
  trainingModules: Array<{
    id: string;
    title: string;
    description: string | null;
    estimatedMinutes: number | null;
    orderingHint: number;
  }>;
  components: Array<{
    linkId: string;
    childPartId: string;
    oemPartNumber: string;
    displayName: string;
    description: string | null;
    positionRef: string | null;
    quantity: number;
    orderingHint: number;
    imageUrl: string | null;
    role: PartRole;
  }>;
}

export async function getPartResources(
  partId: string,
  assetInstanceId: string,
): Promise<PartResources> {
  const url = `${CLIENT_API_BASE}/parts/${encodeURIComponent(partId)}/resources?assetInstanceId=${encodeURIComponent(assetInstanceId)}`;
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
  return (await res.json()) as PartResources;
}

export interface ChatCitation {
  chunkId: string;
  documentId: string;
  documentTitle: string;
  safetyCritical: boolean;
  contentPackVersionId: string;
  quote: string;
  charStart?: number;
  charEnd?: number;
  page?: number;
}

export interface ChatReply {
  conversationId: string;
  messageId: string;
  text: string;
  citations: ChatCitation[];
  usage: {
    inputTokens: number;
    cachedInputTokens?: number;
    outputTokens: number;
  };
}

export interface VerifySentence {
  text: string;
  level: 'supported' | 'weak' | 'unsupported';
  chunkIds: string[];
}
export interface VerifyResult {
  sentences: VerifySentence[];
  sources: Array<{ chunkId: string; weight: number }>;
  conflict: string | null;
}

export type ChatStreamEvent =
  | { type: 'conversation'; conversationId: string }
  | { type: 'delta'; text: string }
  | { type: 'done'; messageId: string; citations: ChatCitation[]; usage: ChatReply['usage'] }
  | { type: 'verify'; verify: VerifyResult }
  | { type: 'error'; message: string };

// ---------------------------------------------------------------------------
// Procedure runs (PWA runtime). All endpoints require auth — the PWA passes
// devUserId/devOrgId via x-dev-user in dev; prod OIDC integration is a
// separate follow-up. See packages/api/src/routes/procedures.ts.
// ---------------------------------------------------------------------------

export type ProcedureStepKind =
  | 'instruction'
  | 'safety_check'
  | 'photo_required'
  | 'measurement_required';

export type ProcedureRunStatus =
  | 'in_progress'
  | 'paused'
  | 'completed'
  | 'abandoned';

export type ProcedureMeasurementSpec =
  | {
      kind: 'numeric';
      label: string;
      unit: string;
      min?: number | null;
      max?: number | null;
      expected?: number | null;
      tolerancePct?: number | null;
    }
  | {
      kind: 'pass_fail';
      label: string;
      passLabel?: string;
      failLabel?: string;
    }
  | {
      kind: 'free_text';
      label: string;
      placeholder?: string;
      maxLen?: number;
    };

// Step media discriminator:
//   'image'      — author-uploaded photograph (storageKey → public URL).
//   'video'      — author-uploaded video file (storageKey → public URL).
//   'video_clip' — synthesized clip range on a Mux HLS stream. Produced
//                  by the AI walkthrough drafter: storageKey holds a
//                  poster JPEG (still from inside the clip), and `clip`
//                  carries the Mux playbackId + start/end window. The
//                  PWA's MuxClipPlayer streams the HLS stream and
//                  clamps playback to that window on a loop.
export type ProcedureStepMedia =
  | {
      kind: 'image';
      storageKey: string;
      mime: string;
      caption?: string;
      /** Resolved on read paths via storage.publicUrl. */
      url?: string;
    }
  | {
      kind: 'video';
      storageKey: string;
      mime: string;
      caption?: string;
      url?: string;
    }
  | {
      kind: 'video_clip';
      storageKey: string;
      mime: string;
      caption?: string;
      /** Poster image URL (resolves from storageKey). */
      url?: string;
      clip: {
        playbackId: string;
        startMs: number;
        endMs: number;
        /** Mux instant-clip HLS endpoint — the manifest at this URL
         *  is pre-trimmed by Mux to the clip's [startMs..endMs] range,
         *  so the player consumes it as a small standalone HLS
         *  stream. Shape varies by deployment playback policy:
         *    * public:  https://stream.mux.com/<id>.m3u8
         *               ?asset_start_time=<s>&asset_end_time=<s>
         *    * signed:  https://stream.mux.com/<id>.m3u8?token=<JWT>
         *               (clip bounds are baked into the JWT claims).
         *  See muxClipUrlFor / muxClipStreamUrl in packages/api/src/lib/mux.ts. */
        streamUrl: string;
        /** Mux-reported aspect ratio ("16:9", "9:16"). Drives the
         *  player's container framing — portrait clips get a tall
         *  frame, landscape gets the standard 16:9 box. */
        aspectRatio?: string;
        /** Pre-classified orientation derived from aspectRatio. */
        orientation?: 'portrait' | 'landscape' | 'square';
      };
    };

export interface ProcedureSubstepDto {
  id?: string;
  title: string;
  bodyMarkdown: string | null;
  orderingHint?: number;
}

export interface ProcedureDocHeroVideo {
  /** Set when uploaded via the hero-video upload route. */
  storageKey?: string;
  /** Set when authored as an external link (YouTube/Vimeo/direct). */
  sourceUrl?: string;
  mime: string;
  sizeBytes?: number;
  caption?: string | null;
  /** Server-resolved public URL for playback — uploaded files resolve
   *  through storage; external URLs pass through. */
  url: string;
}

export interface RequiredTools {
  common: string[];
  special: string[];
  consumables: string[];
}

export interface ProcedureDocMetadata {
  toolsRequired: RequiredTools;
  safety: { enabled: boolean; notes: string | null };
  verification: { enabled: boolean; notes: string | null };
  /** Optional procedure-level intro video. Renders on "Step 0" of the
   *  Job Aid view and at the top of the scroll view. */
  heroVideo?: ProcedureDocHeroVideo | null;
  /** Author-controlled overview fields rendered on the intro screen. */
  summary?: string | null;
  estimatedMinutes?: number | null;
  skillLevel?: 'basic' | 'intermediate' | 'advanced' | null;
}

// Discriminated union for typed step content blocks rendered by the
// VirtualJobAid template. Authoring side is in the admin app; the PWA
// only consumes the result.
export type StepBlock =
  | { kind: 'paragraph'; text: string }
  | {
      kind: 'callout';
      tone: 'safety' | 'warning' | 'tip' | 'note';
      title?: string;
      text: string;
    }
  | { kind: 'bullet_list'; items: string[] }
  | { kind: 'numbered_list'; items: string[] }
  | {
      kind: 'key_value';
      columns: [string, string];
      rows: Array<[string, string]>;
    }
  | { kind: 'photo_inline'; storageKey: string; caption?: string };

// Procedure step category — author-extensible semantic tag that drives
// the PWA phase-progress strip's section color/icon and the per-step
// in-body badge. Resolved server-side; the runner just renders.
export interface ProcedureStepCategoryDto {
  id: string;
  /** NULL for built-in / platform-wide categories. */
  organizationId: string | null;
  name: string;
  /** CSS color string (hex). Used verbatim. */
  color: string;
  /** Lucide icon name from the allowlist, or null. */
  icon: string | null;
  sortOrder: number;
  isBuiltIn: boolean;
}

// Optional grouping above procedure steps. Sections render as headers in
// the viewer / runner; step numbering restarts within each section.
export interface ProcedureSectionDto {
  id: string;
  documentId?: string;
  title: string;
  description: string | null;
  orderingHint: number;
  /** Optional category — drives the phase-progress strip's segment
   *  color and icon. Null = neutral. */
  categoryId?: string | null;
  category?: ProcedureStepCategoryDto | null;
}

export interface ProcedureStepDto {
  id: string;
  documentId: string;
  /** Nullable: steps with no sectionId render above the first explicit
   *  section ("ungrouped" — used by pre-section procedures). */
  sectionId: string | null;
  /** When set, this step has a linked sub-procedure. The PWA Job Aid
   *  renders a "Run sub-procedure" button below the step that pushes
   *  the linked procedure as a nested Job Aid (stacked with breadcrumb). */
  linkedProcedureDocId?: string | null;
  /** Summary of the linked sub-procedure (id + title) so the PWA can
   *  render the button label without a separate fetch. Null when the
   *  link is unset; the API populates it from the same content pack
   *  version when set. */
  linkedProcedureDoc?: { id: string; title: string } | null;
  /** Optional subset of steps from the linked sub-procedure. Empty array
   *  (or omitted) plays the full procedure; non-empty filters the nested
   *  Job Aid to just these step IDs, preserving their natural order. */
  linkedProcedureStepIds?: string[];
  kind: ProcedureStepKind;
  title: string;
  bodyMarkdown: string | null;
  safetyCritical: boolean;
  orderingHint: number;
  requiresPhoto: boolean;
  minPhotoCount: number;
  measurementSpec: ProcedureMeasurementSpec | null;
  media?: ProcedureStepMedia[];
  substeps?: ProcedureSubstepDto[];
  /** Authored voiceover URL when present (admin-uploaded or AI-generated).
   *  When set, the runner plays this file instead of synthesizing TTS at
   *  run time — better fidelity, zero per-play vendor cost. */
  audioUrl?: string | null;
  audioDurationMs?: number | null;
  audioSource?: 'uploaded' | 'generated' | null;
  /** Typed structured content. When non-empty, the runner renders these
   *  in order (template owns the visual style) and ignores bodyMarkdown. */
  blocks?: StepBlock[];
  /** Optional category override for this step. When set, the runner
   *  shows a badge above the step title in the category's color. When
   *  null, the section's category drives the visual treatment. */
  categoryId?: string | null;
  category?: ProcedureStepCategoryDto | null;
}

export interface ProcedureRunDto {
  id: string;
  documentId: string | null;
  userId: string;
  assetInstanceId: string | null;
  workOrderId: string | null;
  status: ProcedureRunStatus;
  abandonedReason: string | null;
  startedAt: string;
  completedAt: string | null;
  lastActivityAt: string;
  totalActiveMs: number;
  pausedAt: string | null;
}

export interface ProcedureStepCompletionDto {
  id: string;
  runId: string;
  stepId: string;
  outcome: 'completed' | 'skipped';
  skipReason: string | null;
  photos: Array<{ key: string; mime: string; caption?: string }>;
  numericValue: number | null;
  passFailValue: string | null;
  textValue: string | null;
  measurementOutOfSpec: boolean;
  measurementOverrideReason: string | null;
  notes: string | null;
  enteredAt: string;
  completedAt: string;
  timeMs: number;
}

export interface ProcedureBundle {
  run: ProcedureRunDto;
  document: {
    id: string;
    title: string;
    kind: string;
    safetyCritical: boolean;
  };
  /** Optional grouping above steps. Empty array = ungrouped procedure
   *  (legacy / new-authoring-not-yet-sectioned). */
  sections?: ProcedureSectionDto[];
  steps: ProcedureStepDto[];
  completions: ProcedureStepCompletionDto[];
}

export type StepCompletionPayload =
  | {
      outcome: 'completed';
      photos: Array<{ key: string; mime: string; caption?: string }>;
      measurement?:
        | { kind: 'numeric'; value: number; overrideReason?: string }
        | { kind: 'pass_fail'; value: 'pass' | 'fail' }
        | { kind: 'free_text'; value: string }
        | null;
      notes?: string;
      enteredAt: string;
    }
  | {
      outcome: 'skipped';
      skipReason: string;
      notes?: string;
      enteredAt: string;
    };

function authHeaders(devUserId: string, devOrgId: string): Record<string, string> {
  return { 'x-dev-user': `${devUserId}:${devOrgId}` };
}

export async function startProcedureRun(params: {
  docId: string;
  assetInstanceId?: string | null;
  workOrderId?: string | null;
  devUserId: string;
  devOrgId: string;
}): Promise<ProcedureBundle> {
  const res = await fetch(
    `${CLIENT_API_BASE}/documents/${encodeURIComponent(params.docId)}/procedure-runs`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeaders(params.devUserId, params.devOrgId) },
      body: JSON.stringify({
        assetInstanceId: params.assetInstanceId ?? null,
        workOrderId: params.workOrderId ?? null,
      }),
    },
  );
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
  return (await res.json()) as ProcedureBundle;
}

export async function getProcedureRun(
  runId: string,
  devUserId: string,
  devOrgId: string,
): Promise<ProcedureBundle> {
  const res = await fetch(
    `${CLIENT_API_BASE}/procedure-runs/${encodeURIComponent(runId)}`,
    { cache: 'no-store', headers: authHeaders(devUserId, devOrgId) },
  );
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
  return (await res.json()) as ProcedureBundle;
}

export async function patchProcedureStep(params: {
  runId: string;
  stepId: string;
  payload: StepCompletionPayload;
  devUserId: string;
  devOrgId: string;
}): Promise<ProcedureStepCompletionDto> {
  const res = await fetch(
    `${CLIENT_API_BASE}/procedure-runs/${encodeURIComponent(params.runId)}/steps/${encodeURIComponent(params.stepId)}`,
    {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', ...authHeaders(params.devUserId, params.devOrgId) },
      body: JSON.stringify(params.payload),
    },
  );
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
  return (await res.json()) as ProcedureStepCompletionDto;
}

export async function uploadProcedureStepPhoto(params: {
  runId: string;
  stepId: string;
  file: File;
  devUserId: string;
  devOrgId: string;
}): Promise<{ key: string; mime: string; size: number; url: string }> {
  const form = new FormData();
  form.append('file', params.file, params.file.name);
  const res = await fetch(
    `${CLIENT_API_BASE}/procedure-runs/${encodeURIComponent(params.runId)}/steps/${encodeURIComponent(params.stepId)}/photo`,
    {
      method: 'POST',
      headers: authHeaders(params.devUserId, params.devOrgId),
      body: form,
    },
  );
  if (!res.ok) throw new Error(`Upload ${res.status}: ${await res.text()}`);
  return (await res.json()) as { key: string; mime: string; size: number; url: string };
}

export async function pauseProcedureRun(
  runId: string,
  devUserId: string,
  devOrgId: string,
): Promise<ProcedureRunDto> {
  const res = await fetch(
    `${CLIENT_API_BASE}/procedure-runs/${encodeURIComponent(runId)}/pause`,
    { method: 'POST', headers: authHeaders(devUserId, devOrgId) },
  );
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
  return (await res.json()) as ProcedureRunDto;
}

export async function resumeProcedureRun(
  runId: string,
  devUserId: string,
  devOrgId: string,
): Promise<ProcedureRunDto> {
  const res = await fetch(
    `${CLIENT_API_BASE}/procedure-runs/${encodeURIComponent(runId)}/resume`,
    { method: 'POST', headers: authHeaders(devUserId, devOrgId) },
  );
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
  return (await res.json()) as ProcedureRunDto;
}

export async function finishProcedureRun(
  runId: string,
  devUserId: string,
  devOrgId: string,
): Promise<ProcedureRunDto> {
  const res = await fetch(
    `${CLIENT_API_BASE}/procedure-runs/${encodeURIComponent(runId)}/finish`,
    { method: 'POST', headers: authHeaders(devUserId, devOrgId) },
  );
  if (!res.ok) {
    // Surface 409 missingStepIds payload to the caller for inline UI.
    const text = await res.text();
    const err: Error & { missingStepIds?: string[]; status?: number } = new Error(
      `API ${res.status}: ${text}`,
    );
    err.status = res.status;
    try {
      const parsed = JSON.parse(text) as { missingStepIds?: string[] };
      if (parsed.missingStepIds) err.missingStepIds = parsed.missingStepIds;
    } catch {
      // ignore
    }
    throw err;
  }
  return (await res.json()) as ProcedureRunDto;
}

// ---------------------------------------------------------------------------
// Field-authored procedures (procedure mode v2). Capture-as-you-go from
// the PWA on site — the first run of a brand-new procedure IS the
// authoring. See packages/api/src/routes/field-procedures.ts.
// ---------------------------------------------------------------------------

export async function startFieldProcedure(params: {
  assetInstanceId: string;
  title?: string;
  devUserId: string;
  devOrgId: string;
}): Promise<ProcedureBundle> {
  const res = await fetch(
    `${CLIENT_API_BASE}/asset-instances/${encodeURIComponent(params.assetInstanceId)}/field-procedures`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...authHeaders(params.devUserId, params.devOrgId),
      },
      body: JSON.stringify({ title: params.title }),
    },
  );
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
  return (await res.json()) as ProcedureBundle;
}

export async function addAuthoringStep(params: {
  runId: string;
  step: {
    kind: ProcedureStepKind;
    title: string;
    bodyMarkdown?: string | null;
    safetyCritical?: boolean;
    requiresPhoto?: boolean;
    minPhotoCount?: number;
    measurementSpec?: ProcedureMeasurementSpec | null;
    media?: ProcedureStepMedia[];
    substeps?: Array<{ title: string; bodyMarkdown?: string | null }>;
  };
  devUserId: string;
  devOrgId: string;
}): Promise<ProcedureStepDto> {
  const res = await fetch(
    `${CLIENT_API_BASE}/procedure-runs/${encodeURIComponent(params.runId)}/authoring-steps`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...authHeaders(params.devUserId, params.devOrgId),
      },
      body: JSON.stringify(params.step),
    },
  );
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
  return (await res.json()) as ProcedureStepDto;
}

export async function updateAuthoringStep(params: {
  runId: string;
  stepId: string;
  step: {
    kind?: ProcedureStepKind;
    title?: string;
    bodyMarkdown?: string | null;
    safetyCritical?: boolean;
    requiresPhoto?: boolean;
    minPhotoCount?: number;
    measurementSpec?: ProcedureMeasurementSpec | null;
    media?: ProcedureStepMedia[];
    substeps?: Array<{ title: string; bodyMarkdown?: string | null }>;
  };
  devUserId: string;
  devOrgId: string;
}): Promise<ProcedureStepDto> {
  const res = await fetch(
    `${CLIENT_API_BASE}/procedure-runs/${encodeURIComponent(params.runId)}/authoring-steps/${encodeURIComponent(params.stepId)}`,
    {
      method: 'PATCH',
      headers: {
        'content-type': 'application/json',
        ...authHeaders(params.devUserId, params.devOrgId),
      },
      body: JSON.stringify(params.step),
    },
  );
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
  return (await res.json()) as ProcedureStepDto;
}

export async function reorderAuthoringSteps(params: {
  runId: string;
  orderedStepIds: string[];
  devUserId: string;
  devOrgId: string;
}): Promise<{ ok: true; count: number }> {
  const res = await fetch(
    `${CLIENT_API_BASE}/procedure-runs/${encodeURIComponent(params.runId)}/authoring-steps/reorder`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...authHeaders(params.devUserId, params.devOrgId),
      },
      body: JSON.stringify({ orderedIds: params.orderedStepIds }),
    },
  );
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
  return (await res.json()) as { ok: true; count: number };
}

export interface ProcedureTemplateDto {
  documentId: string;
  title: string;
  stepCount: number;
  capturedByDisplayName: string | null;
  source: 'oem' | 'field';
  verified: boolean;
  finishedAt: string | null;
}

export async function listProcedureTemplates(params: {
  assetInstanceId: string;
  devUserId: string;
  devOrgId: string;
}): Promise<ProcedureTemplateDto[]> {
  const res = await fetch(
    `${CLIENT_API_BASE}/asset-instances/${encodeURIComponent(params.assetInstanceId)}/procedure-templates`,
    {
      cache: 'no-store',
      headers: authHeaders(params.devUserId, params.devOrgId),
    },
  );
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
  return (await res.json()) as ProcedureTemplateDto[];
}

export async function cloneFromTemplate(params: {
  runId: string;
  templateDocId: string;
  devUserId: string;
  devOrgId: string;
}): Promise<{ ok: true; stepCount: number; steps: ProcedureStepDto[] }> {
  const res = await fetch(
    `${CLIENT_API_BASE}/procedure-runs/${encodeURIComponent(params.runId)}/clone-from/${encodeURIComponent(params.templateDocId)}`,
    {
      method: 'POST',
      headers: authHeaders(params.devUserId, params.devOrgId),
    },
  );
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
  return (await res.json()) as { ok: true; stepCount: number; steps: ProcedureStepDto[] };
}

/** Procedure category — matches the server's ProcedureCategory enum and
 *  drives the Maintenance tab bucket the procedure shows up under. */
export type AuthoredProcedureCategory =
  | 'preventive_maintenance'
  | 'removal_replacement'
  | 'troubleshooting'
  | 'walkthrough';

export async function finalizeAuthoring(params: {
  runId: string;
  title: string;
  scopeAssetInstanceOnly: boolean;
  linkedPartIds: string[];
  procedureCategory?: AuthoredProcedureCategory;
  devUserId: string;
  devOrgId: string;
}): Promise<{
  ok: true;
  documentId: string;
  title: string;
  scopeAssetInstanceId: string | null;
}> {
  const res = await fetch(
    `${CLIENT_API_BASE}/procedure-runs/${encodeURIComponent(params.runId)}/authoring-finalize`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...authHeaders(params.devUserId, params.devOrgId),
      },
      body: JSON.stringify({
        title: params.title,
        scopeAssetInstanceOnly: params.scopeAssetInstanceOnly,
        linkedPartIds: params.linkedPartIds,
        ...(params.procedureCategory
          ? { procedureCategory: params.procedureCategory }
          : {}),
      }),
    },
  );
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
  return (await res.json()) as {
    ok: true;
    documentId: string;
    title: string;
    scopeAssetInstanceId: string | null;
  };
}

// Doc-authoring v3 helpers — full procedure tree, media upload (authored
// content, not run-time evidence), metadata patch, completion without
// the run-time evidence gate.

export interface ProcedureDocFullDto {
  document: {
    id: string;
    title: string;
    kind: string;
    safetyCritical: boolean;
    source: 'oem' | 'field';
    verified: boolean;
    capturedByDisplayName: string | null;
    scopeAssetInstanceId: string | null;
  };
  metadata: ProcedureDocMetadata | null;
  /** Optional grouping above steps. Empty / missing = ungrouped procedure. */
  sections?: ProcedureSectionDto[];
  steps: Array<
    ProcedureStepDto & {
      media: ProcedureStepMedia[];
      substeps: ProcedureSubstepDto[];
    }
  >;
}

export async function getProcedureDoc(
  docId: string,
  devUserId: string,
  devOrgId: string,
): Promise<ProcedureDocFullDto> {
  const res = await fetch(
    `${CLIENT_API_BASE}/procedure-docs/${encodeURIComponent(docId)}`,
    { cache: 'no-store', headers: authHeaders(devUserId, devOrgId) },
  );
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
  return (await res.json()) as ProcedureDocFullDto;
}

export async function uploadStepMedia(params: {
  runId: string;
  stepId: string;
  file: File;
  devUserId: string;
  devOrgId: string;
}): Promise<{
  kind: 'image' | 'video';
  storageKey: string;
  mime: string;
  size: number;
  url: string;
}> {
  const form = new FormData();
  form.append('file', params.file, params.file.name);
  const res = await fetch(
    `${CLIENT_API_BASE}/procedure-runs/${encodeURIComponent(params.runId)}/authoring-steps/${encodeURIComponent(params.stepId)}/media`,
    {
      method: 'POST',
      headers: authHeaders(params.devUserId, params.devOrgId),
      body: form,
    },
  );
  if (!res.ok) throw new Error(`Upload ${res.status}: ${await res.text()}`);
  return (await res.json()) as {
    kind: 'image' | 'video';
    storageKey: string;
    mime: string;
    size: number;
    url: string;
  };
}

export async function patchProcedureMetadata(params: {
  runId: string;
  metadata: ProcedureDocMetadata;
  devUserId: string;
  devOrgId: string;
}): Promise<{ documentId: string; procedureMetadata: ProcedureDocMetadata }> {
  const res = await fetch(
    `${CLIENT_API_BASE}/procedure-runs/${encodeURIComponent(params.runId)}/authoring-metadata`,
    {
      method: 'PATCH',
      headers: {
        'content-type': 'application/json',
        ...authHeaders(params.devUserId, params.devOrgId),
      },
      body: JSON.stringify(params.metadata),
    },
  );
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
  return (await res.json()) as {
    documentId: string;
    procedureMetadata: ProcedureDocMetadata;
  };
}

export async function completeAuthoring(
  runId: string,
  devUserId: string,
  devOrgId: string,
): Promise<{
  runId: string;
  documentId: string;
  status: string;
  completedAt: string | null;
}> {
  const res = await fetch(
    `${CLIENT_API_BASE}/procedure-runs/${encodeURIComponent(runId)}/complete-authoring`,
    { method: 'POST', headers: authHeaders(devUserId, devOrgId) },
  );
  if (!res.ok) {
    const text = await res.text();
    const err = new Error(`API ${res.status}: ${text}`) as Error & {
      status?: number;
    };
    err.status = res.status;
    throw err;
  }
  return (await res.json()) as {
    runId: string;
    documentId: string;
    status: string;
    completedAt: string | null;
  };
}

export async function abandonProcedureRun(params: {
  runId: string;
  reason: string;
  devUserId: string;
  devOrgId: string;
}): Promise<ProcedureRunDto> {
  const res = await fetch(
    `${CLIENT_API_BASE}/procedure-runs/${encodeURIComponent(params.runId)}/abandon`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeaders(params.devUserId, params.devOrgId) },
      body: JSON.stringify({ reason: params.reason }),
    },
  );
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
  return (await res.json()) as ProcedureRunDto;
}

export async function streamChat(
  params: {
    assetInstanceId: string;
    conversationId?: string;
    message: string;
    imageStorageKey?: string;
    devUserId: string;
    devOrgId: string;
    /** Scope retrieval to a specific part (author-linked docs only). */
    partId?: string;
    /** Surface hint. 'voice' routes to a faster model server-side. */
    mode?: 'voice' | 'text';
  },
  onEvent: (e: ChatStreamEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const res = await fetch(`${CLIENT_API_BASE}/ai/chat`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'text/event-stream',
      'x-dev-user': `${params.devUserId}:${params.devOrgId}`,
    },
    body: JSON.stringify({
      assetInstanceId: params.assetInstanceId,
      conversationId: params.conversationId,
      message: params.message,
      imageStorageKey: params.imageStorageKey,
      partId: params.partId,
      mode: params.mode,
    }),
    signal,
  });
  if (!res.ok || !res.body) {
    throw new Error(`API ${res.status}: ${await res.text().catch(() => '')}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    // SSE events are separated by a blank line.
    let idx: number;
    while ((idx = buffer.indexOf('\n\n')) !== -1) {
      const raw = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const parsed = parseSSE(raw);
      if (parsed) onEvent(parsed);
    }
  }
}

function parseSSE(raw: string): ChatStreamEvent | null {
  let eventName = 'message';
  let dataLines: string[] = [];
  for (const line of raw.split('\n')) {
    if (line.startsWith('event:')) eventName = line.slice(6).trim();
    else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
  }
  if (dataLines.length === 0) return null;
  try {
    const data = JSON.parse(dataLines.join('\n'));
    switch (eventName) {
      case 'conversation':
        return { type: 'conversation', conversationId: data.conversationId };
      case 'delta':
        return { type: 'delta', text: data.text };
      case 'done':
        return {
          type: 'done',
          messageId: data.messageId,
          citations: data.citations,
          usage: data.usage,
        };
      case 'verify':
        return { type: 'verify', verify: data as VerifyResult };
      case 'error':
        return { type: 'error', message: data.message };
      default:
        return null;
    }
  } catch {
    return null;
  }
}
