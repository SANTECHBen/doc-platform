// Learner-facing API client for the slide-course player.
//
// Mirrors the auth pattern of @/lib/api.ts (DEV user/org headers in
// dev; production swaps in a session cookie). Only what the player
// needs — no admin authoring affordances.

const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? 'http://localhost:3001';

function authHeaders(devUserId: string, devOrgId: string): Record<string, string> {
  return { 'x-dev-user': `${devUserId}:${devOrgId}` };
}

export type PlayerInteractionKind =
  | 'mcq'
  | 'true_false'
  | 'drag_match'
  | 'short_answer_ai';

export type PlayerNavigationGate =
  | 'free'
  | 'require_voiceover'
  | 'require_interactions'
  | 'require_both';

export interface PlayerPriorAnswer {
  answer: unknown;
  isCorrect: boolean | null;
  score: number | null;
  rationale: string | null;
  answeredAt: string;
}

export interface PlayerInteraction {
  id: string;
  kind: PlayerInteractionKind;
  prompt: string;
  weight: number;
  orderingHint: number;
  // Sanitized config — never contains the correct answer.
  config: Record<string, unknown>;
  prior: PlayerPriorAnswer | null;
}

export interface PlayerSlide {
  id: string;
  index: number;
  title: string | null;
  scriptMarkdown: string | null;
  imageUrl: string | null;
  imageWidth: number | null;
  imageHeight: number | null;
  voiceoverUrl: string | null;
  voiceoverDurationSec: number | null;
  navigationGate: PlayerNavigationGate;
  interactions: PlayerInteraction[];
}

export interface PlayerDeck {
  deck: {
    id: string;
    slideCount: number;
    passThreshold: number;
    conversionStatus: 'pending' | 'processing' | 'ready' | 'failed';
  };
  attempt: {
    id: string;
    currentSlideIndex: number;
    status: 'in_progress' | 'submitted' | 'passed' | 'failed';
    totalScore: number | null;
  };
  slides: PlayerSlide[];
}

export async function getPlayerDeck(params: {
  enrollmentId: string;
  activityId: string;
  devUserId: string;
  devOrgId: string;
}): Promise<PlayerDeck> {
  const url = new URL(
    `${API_BASE}/enrollments/${encodeURIComponent(params.enrollmentId)}/slide-course`,
  );
  url.searchParams.set('activityId', params.activityId);
  const res = await fetch(url.toString(), {
    headers: authHeaders(params.devUserId, params.devOrgId),
    cache: 'no-store',
  });
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
  return (await res.json()) as PlayerDeck;
}

export async function postProgress(params: {
  enrollmentId: string;
  activityId: string;
  currentSlideIndex: number;
  devUserId: string;
  devOrgId: string;
}): Promise<void> {
  const res = await fetch(
    `${API_BASE}/enrollments/${encodeURIComponent(params.enrollmentId)}/slide-course/progress`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...authHeaders(params.devUserId, params.devOrgId),
      },
      body: JSON.stringify({
        activityId: params.activityId,
        currentSlideIndex: params.currentSlideIndex,
      }),
    },
  );
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
}

export interface AnswerResult {
  interactionId: string;
  isCorrect: boolean | null;
  score: number;
  passed: boolean;
  rationale: string | null;
  // What the server reveals after grading — kind-specific.
  reveal: Record<string, unknown>;
}

export async function postAnswer(params: {
  enrollmentId: string;
  activityId: string;
  interactionId: string;
  kind: PlayerInteractionKind;
  answer: unknown;
  devUserId: string;
  devOrgId: string;
}): Promise<AnswerResult> {
  const res = await fetch(
    `${API_BASE}/enrollments/${encodeURIComponent(params.enrollmentId)}/slide-course/answer`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...authHeaders(params.devUserId, params.devOrgId),
      },
      body: JSON.stringify({
        activityId: params.activityId,
        interactionId: params.interactionId,
        answer: { kind: params.kind, answer: params.answer },
      }),
    },
  );
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
  return (await res.json()) as AnswerResult;
}

export interface SubmitResult {
  attemptScore: number;
  passed: boolean;
  passThreshold: number;
  interactionsCount: number;
  answeredCount: number;
  enrollmentStatus: string;
  enrollmentScore: number;
}

export async function postSubmit(params: {
  enrollmentId: string;
  activityId: string;
  devUserId: string;
  devOrgId: string;
}): Promise<SubmitResult> {
  const res = await fetch(
    `${API_BASE}/enrollments/${encodeURIComponent(params.enrollmentId)}/slide-course/submit`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...authHeaders(params.devUserId, params.devOrgId),
      },
      body: JSON.stringify({ activityId: params.activityId }),
    },
  );
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
  return (await res.json()) as SubmitResult;
}
