import { AssetHubPayloadSchema, type AssetHubPayload } from './shared-schema';

const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? 'http://localhost:3001';

export async function resolveAssetHub(qrCode: string): Promise<AssetHubPayload | null> {
  const res = await fetch(`${API_BASE}/assets/resolve/${encodeURIComponent(qrCode)}`, {
    // No caching — QR resolution must always reflect current pinned version.
    cache: 'no-store',
  });
  if (res.status === 404) return null;
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
  streamPlaybackId: string | null;
  externalUrl?: string | null;
  originalFilename?: string | null;
  contentType?: string | null;
  sizeBytes?: number | null;
  thumbnailUrl?: string | null;
}

export async function listDocuments(
  versionId: string,
  lang: string = 'en',
): Promise<DocumentListItem[]> {
  const res = await fetch(
    `${API_BASE}/content-pack-versions/${encodeURIComponent(versionId)}/documents?lang=${lang}`,
    { cache: 'no-store' },
  );
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
  return (await res.json()) as DocumentListItem[];
}

export interface DocumentBody extends DocumentListItem {
  bodyMarkdown: string | null;
  fileUrl: string | null;
}

export async function getDocument(id: string): Promise<DocumentBody | null> {
  const res = await fetch(`${API_BASE}/documents/${encodeURIComponent(id)}`, {
    cache: 'no-store',
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
  return (await res.json()) as DocumentBody;
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
    `${API_BASE}/content-pack-versions/${encodeURIComponent(versionId)}/training-modules`,
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
    kind: 'quiz' | 'checklist' | 'procedure_signoff' | 'video_knowledge_check' | 'practical';
    title: string;
    config: any;
    weight: number;
    orderingHint: number;
  }>;
}

export async function getTrainingModule(id: string): Promise<TrainingModuleDetail | null> {
  const res = await fetch(`${API_BASE}/training-modules/${encodeURIComponent(id)}`, {
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
  const res = await fetch(`${API_BASE}/enrollments`, {
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
    `${API_BASE}/enrollments/${encodeURIComponent(params.enrollmentId)}/submit-quiz`,
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

const API_BASE_FOR_UPLOAD = process.env.NEXT_PUBLIC_API_BASE ?? 'http://localhost:3001';

export async function uploadFile(
  file: File,
  devUserId: string,
  devOrgId: string,
): Promise<UploadResult> {
  const form = new FormData();
  form.append('file', file, file.name);
  const res = await fetch(`${API_BASE_FOR_UPLOAD}/admin/uploads`, {
    method: 'POST',
    headers: { 'x-dev-user': `${devUserId}:${devOrgId}` },
    body: form,
  });
  if (!res.ok) throw new Error(`Upload ${res.status}: ${await res.text()}`);
  return (await res.json()) as UploadResult;
}

export async function listWorkOrders(
  assetInstanceId: string,
  status: 'open' | 'all' = 'open',
): Promise<WorkOrder[]> {
  const res = await fetch(
    `${API_BASE}/asset-instances/${encodeURIComponent(assetInstanceId)}/work-orders?status=${status}`,
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
  const res = await fetch(`${API_BASE}/work-orders`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-dev-user': `${params.devUserId}:${params.devOrgId}`,
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
}

export async function listParts(modelId: string): Promise<BomEntry[]> {
  const res = await fetch(`${API_BASE}/asset-models/${encodeURIComponent(modelId)}/parts`, {
    cache: 'no-store',
  });
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
  return (await res.json()) as BomEntry[];
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
  };
  documents: Array<{
    id: string;
    title: string;
    kind: string;
    safetyCritical: boolean;
    language: string;
    orderingHint: number;
  }>;
  trainingModules: Array<{
    id: string;
    title: string;
    description: string | null;
    estimatedMinutes: number | null;
    orderingHint: number;
  }>;
}

export async function getPartResources(
  partId: string,
  assetInstanceId: string,
): Promise<PartResources> {
  const url = `${API_BASE}/parts/${encodeURIComponent(partId)}/resources?assetInstanceId=${encodeURIComponent(assetInstanceId)}`;
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

export type ChatStreamEvent =
  | { type: 'conversation'; conversationId: string }
  | { type: 'delta'; text: string }
  | { type: 'done'; messageId: string; citations: ChatCitation[]; usage: ChatReply['usage'] }
  | { type: 'error'; message: string };

export async function streamChat(
  params: {
    assetInstanceId: string;
    conversationId?: string;
    message: string;
    imageStorageKey?: string;
    devUserId: string;
    devOrgId: string;
  },
  onEvent: (e: ChatStreamEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const res = await fetch(`${API_BASE}/ai/chat`, {
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
      case 'error':
        return { type: 'error', message: data.message };
      default:
        return null;
    }
  } catch {
    return null;
  }
}
