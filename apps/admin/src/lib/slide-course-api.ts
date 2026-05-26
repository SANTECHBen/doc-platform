// Typed admin client for the slide-course authoring API.
//
// Lives in its own file (rather than appending to the already-massive
// api.ts) because the slide-course surface is self-contained and
// imported only by the slide-course editor components.

import type {
  SlideInteractionConfig,
  SlideNavigationGate,
} from '@platform/shared';

const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? 'http://localhost:3001';

async function authHeaders(): Promise<Record<string, string>> {
  if (typeof window === 'undefined') return {};
  try {
    const res = await fetch('/api/auth/session', { cache: 'no-store' });
    if (res.ok) {
      const session = (await res.json()) as { idToken?: string } | null;
      if (session?.idToken) {
        return { authorization: `Bearer ${session.idToken}` };
      }
    }
  } catch {
    /* fall through */
  }
  return {};
}

// ---------------------------------------------------------------------------
// DTO types — match the server response shapes in admin-slide-courses.ts
// ---------------------------------------------------------------------------

export type ConversionStatus = 'pending' | 'processing' | 'ready' | 'failed';
export type SlideInteractionKind =
  | 'mcq'
  | 'true_false'
  | 'drag_match'
  | 'short_answer_ai';

export interface SlideDeckSummary {
  id: string;
  documentId: string;
  documentTitle: string;
  conversionStatus: ConversionStatus;
  conversionError: string | null;
  conversionStartedAt: string | null;
  conversionCompletedAt: string | null;
  slideCount: number;
  passThreshold: number;
  createdAt: string;
  updatedAt: string;
}

export interface SlideInteractionDto {
  id: string;
  slideId: string;
  kind: SlideInteractionKind;
  prompt: string;
  config: Record<string, unknown>;
  weight: number;
  orderingHint: number;
  updatedAt: string;
}

export interface SlideDto {
  id: string;
  slideDeckId: string;
  slideIndex: number;
  orderingHint: number;
  title: string | null;
  speakerNotesMarkdown: string | null;
  scriptMarkdown: string | null;
  imageStorageKey: string | null;
  imageUrl: string | null;
  imageWidth: number | null;
  imageHeight: number | null;
  voiceoverStorageKey: string | null;
  voiceoverUrl: string | null;
  voiceoverDurationSec: number | null;
  navigationGate: SlideNavigationGate;
  updatedAt: string;
  interactions: SlideInteractionDto[];
}

export interface SlideDeckDetail {
  deck: SlideDeckSummary;
  slides: SlideDto[];
}

// ---------------------------------------------------------------------------
// Client functions
// ---------------------------------------------------------------------------

export async function getSlideDeckByDocument(
  documentId: string,
): Promise<SlideDeckSummary | null> {
  const res = await fetch(
    `${API_BASE}/admin/slide-decks/by-document/${encodeURIComponent(documentId)}`,
    { cache: 'no-store', headers: await authHeaders() },
  );
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
  const body = await res.json();
  return body as SlideDeckSummary | null;
}

export async function getSlideDeck(slideDeckId: string): Promise<SlideDeckDetail> {
  const res = await fetch(
    `${API_BASE}/admin/slide-decks/${encodeURIComponent(slideDeckId)}`,
    { cache: 'no-store', headers: await authHeaders() },
  );
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
  return (await res.json()) as SlideDeckDetail;
}

export async function patchSlideDeck(
  slideDeckId: string,
  patch: { title?: string; passThreshold?: number },
): Promise<SlideDeckSummary> {
  const res = await fetch(
    `${API_BASE}/admin/slide-decks/${encodeURIComponent(slideDeckId)}`,
    {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', ...(await authHeaders()) },
      body: JSON.stringify(patch),
    },
  );
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
  return (await res.json()) as SlideDeckSummary;
}

export async function createTrainingCourse(
  contentPackVersionId: string,
  body: { title: string },
): Promise<{
  documentId: string;
  slideDeckId: string;
  trainingModuleId: string;
  activityId: string;
}> {
  const res = await fetch(
    `${API_BASE}/admin/content-pack-versions/${encodeURIComponent(
      contentPackVersionId,
    )}/training-courses`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(await authHeaders()) },
      body: JSON.stringify(body),
    },
  );
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
  return (await res.json()) as {
    documentId: string;
    slideDeckId: string;
    trainingModuleId: string;
    activityId: string;
  };
}

export async function autoConvertDocumentToSlideDeck(
  documentId: string,
): Promise<SlideDeckSummary> {
  const res = await fetch(
    `${API_BASE}/admin/documents/${encodeURIComponent(documentId)}/slide-deck/auto-convert`,
    { method: 'POST', headers: await authHeaders() },
  );
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
  return (await res.json()) as SlideDeckSummary;
}

export async function createSlideDeckForDocument(
  documentId: string,
): Promise<SlideDeckSummary> {
  const res = await fetch(
    `${API_BASE}/admin/documents/${encodeURIComponent(documentId)}/slide-deck`,
    { method: 'POST', headers: await authHeaders() },
  );
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
  return (await res.json()) as SlideDeckSummary;
}

export async function createBlankSlide(
  slideDeckId: string,
  options?: { title?: string },
): Promise<SlideDto> {
  const res = await fetch(
    `${API_BASE}/admin/slide-decks/${encodeURIComponent(slideDeckId)}/blank-slide`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(await authHeaders()) },
      body: JSON.stringify({ title: options?.title }),
    },
  );
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
  const row = (await res.json()) as Omit<SlideDto, 'interactions'>;
  return { ...row, interactions: [] };
}

export async function uploadSlideImage(
  slideDeckId: string,
  file: File,
): Promise<SlideDto> {
  const form = new FormData();
  form.append('file', file);
  const res = await fetch(
    `${API_BASE}/admin/slide-decks/${encodeURIComponent(slideDeckId)}/slides`,
    { method: 'POST', headers: await authHeaders(), body: form },
  );
  if (!res.ok) throw new Error(`Upload ${res.status}: ${await res.text()}`);
  const row = (await res.json()) as Omit<SlideDto, 'interactions'>;
  return { ...row, interactions: [] };
}

export async function replaceSlideImage(
  slideDeckId: string,
  slideId: string,
  file: File,
): Promise<SlideDto> {
  const form = new FormData();
  form.append('file', file);
  const res = await fetch(
    `${API_BASE}/admin/slide-decks/${encodeURIComponent(slideDeckId)}/slides/${encodeURIComponent(slideId)}/image`,
    { method: 'PATCH', headers: await authHeaders(), body: form },
  );
  if (!res.ok) throw new Error(`Upload ${res.status}: ${await res.text()}`);
  const row = (await res.json()) as Omit<SlideDto, 'interactions'>;
  return { ...row, interactions: [] };
}

export async function deleteSlide(
  slideDeckId: string,
  slideId: string,
): Promise<void> {
  const res = await fetch(
    `${API_BASE}/admin/slide-decks/${encodeURIComponent(slideDeckId)}/slides/${encodeURIComponent(slideId)}`,
    { method: 'DELETE', headers: await authHeaders() },
  );
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
}

export async function retrySlideDeckConversion(slideDeckId: string): Promise<void> {
  const res = await fetch(
    `${API_BASE}/admin/slide-decks/${encodeURIComponent(slideDeckId)}/retry-conversion`,
    { method: 'POST', headers: await authHeaders() },
  );
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
}

export async function patchSlide(
  slideDeckId: string,
  slideId: string,
  patch: {
    title?: string | null;
    scriptMarkdown?: string | null;
    navigationGate?: SlideNavigationGate;
    orderingHint?: number;
  },
): Promise<SlideDto> {
  const res = await fetch(
    `${API_BASE}/admin/slide-decks/${encodeURIComponent(slideDeckId)}/slides/${encodeURIComponent(
      slideId,
    )}`,
    {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', ...(await authHeaders()) },
      body: JSON.stringify(patch),
    },
  );
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
  return (await res.json()) as SlideDto;
}

export async function reorderSlides(
  slideDeckId: string,
  orderings: Array<{ slideId: string; orderingHint: number }>,
): Promise<void> {
  const res = await fetch(
    `${API_BASE}/admin/slide-decks/${encodeURIComponent(slideDeckId)}/reorder`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(await authHeaders()) },
      body: JSON.stringify({ orderings }),
    },
  );
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
}

export interface SlideVoiceoverUploadResult {
  voiceoverStorageKey: string;
  voiceoverUrl: string;
  sizeBytes: number;
  contentType: string;
}

export async function uploadSlideVoiceover(
  slideDeckId: string,
  slideId: string,
  file: File,
): Promise<SlideVoiceoverUploadResult> {
  const form = new FormData();
  form.append('file', file);
  const res = await fetch(
    `${API_BASE}/admin/slide-decks/${encodeURIComponent(slideDeckId)}/slides/${encodeURIComponent(
      slideId,
    )}/voiceover`,
    { method: 'POST', headers: await authHeaders(), body: form },
  );
  if (!res.ok) throw new Error(`Upload ${res.status}: ${await res.text()}`);
  return (await res.json()) as SlideVoiceoverUploadResult;
}

export async function deleteSlideVoiceover(
  slideDeckId: string,
  slideId: string,
): Promise<void> {
  const res = await fetch(
    `${API_BASE}/admin/slide-decks/${encodeURIComponent(slideDeckId)}/slides/${encodeURIComponent(
      slideId,
    )}/voiceover`,
    { method: 'DELETE', headers: await authHeaders() },
  );
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
}

export async function patchSlideVoiceoverDuration(
  slideDeckId: string,
  slideId: string,
  voiceoverDurationSec: number,
): Promise<void> {
  const res = await fetch(
    `${API_BASE}/admin/slide-decks/${encodeURIComponent(slideDeckId)}/slides/${encodeURIComponent(
      slideId,
    )}/voiceover-duration`,
    {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', ...(await authHeaders()) },
      body: JSON.stringify({ voiceoverDurationSec }),
    },
  );
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
}

export async function createInteraction(
  slideDeckId: string,
  slideId: string,
  body: SlideInteractionConfig & {
    prompt: string;
    weight?: number;
    orderingHint?: number;
  },
): Promise<SlideInteractionDto> {
  const res = await fetch(
    `${API_BASE}/admin/slide-decks/${encodeURIComponent(slideDeckId)}/slides/${encodeURIComponent(
      slideId,
    )}/interactions`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(await authHeaders()) },
      body: JSON.stringify(body),
    },
  );
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
  return (await res.json()) as SlideInteractionDto;
}

export async function patchInteraction(
  interactionId: string,
  patch: {
    prompt?: string;
    config?: Record<string, unknown>;
    weight?: number;
    orderingHint?: number;
  },
): Promise<SlideInteractionDto> {
  const res = await fetch(
    `${API_BASE}/admin/slide-interactions/${encodeURIComponent(interactionId)}`,
    {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', ...(await authHeaders()) },
      body: JSON.stringify(patch),
    },
  );
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
  return (await res.json()) as SlideInteractionDto;
}

export async function deleteInteraction(interactionId: string): Promise<void> {
  const res = await fetch(
    `${API_BASE}/admin/slide-interactions/${encodeURIComponent(interactionId)}`,
    { method: 'DELETE', headers: await authHeaders() },
  );
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
}

export interface AvailableSlideDeck {
  slideDeckId: string;
  documentId: string;
  documentTitle: string;
  slideCount: number;
  conversionStatus: ConversionStatus;
}

export async function createSlideCourseActivity(
  trainingModuleId: string,
  body: {
    title: string;
    slideDeckId: string;
    weight?: number;
    orderingHint?: number;
  },
): Promise<{ id: string }> {
  const res = await fetch(
    `${API_BASE}/admin/training-modules/${encodeURIComponent(
      trainingModuleId,
    )}/slide-course-activities`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(await authHeaders()) },
      body: JSON.stringify(body),
    },
  );
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
  return (await res.json()) as { id: string };
}

export async function listAvailableSlideDecksForVersion(
  versionId: string,
): Promise<AvailableSlideDeck[]> {
  const res = await fetch(
    `${API_BASE}/admin/content-pack-versions/${encodeURIComponent(versionId)}/slide-decks`,
    { cache: 'no-store', headers: await authHeaders() },
  );
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
  return (await res.json()) as AvailableSlideDeck[];
}
