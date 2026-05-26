// PWA slide-course player API.
//
// Authenticated via the same scan-session cookie that powers the rest of
// the asset hub — no Microsoft sign-in required. Grading happens server-
// side (the correct answers never leave the API) but answers are not
// persisted. The player tracks the learner's progress client-side and
// shows a summary at the end.

// Same-origin proxy path. The Next.js route at apps/pwa/src/app/api/[...path]
// reads the HttpOnly scan cookie server-side and forwards it to the upstream
// API as X-Scan-Session. Cross-origin cookie forwarding is brittle and we
// can't read HttpOnly cookies from JS, so the proxy is the only path that
// works for scan-session-authenticated calls.
const CLIENT_API_BASE = '/api';

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

export interface PlayerInteraction {
  id: string;
  kind: PlayerInteractionKind;
  prompt: string;
  weight: number;
  orderingHint: number;
  /** Sanitized — never contains the correct answer. */
  config: Record<string, unknown>;
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
    activityTitle: string;
    moduleTitle: string;
  };
  slides: PlayerSlide[];
}

export interface AnswerResult {
  interactionId: string;
  isCorrect: boolean | null;
  score: number;
  passed: boolean;
  rationale: string | null;
  reveal: Record<string, unknown>;
}

export async function getPlayerDeck(params: {
  activityId: string;
}): Promise<PlayerDeck> {
  const res = await fetch(
    `${CLIENT_API_BASE}/scan/activities/${encodeURIComponent(params.activityId)}/slide-course`,
    {
      credentials: 'include',
      cache: 'no-store',
    },
  );
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
  return (await res.json()) as PlayerDeck;
}

export async function postAnswer(params: {
  activityId: string;
  interactionId: string;
  kind: PlayerInteractionKind;
  answer: unknown;
}): Promise<AnswerResult> {
  const res = await fetch(
    `${CLIENT_API_BASE}/scan/activities/${encodeURIComponent(params.activityId)}/slide-course/grade`,
    {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        interactionId: params.interactionId,
        answer: { kind: params.kind, answer: params.answer },
      }),
    },
  );
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
  return (await res.json()) as AnswerResult;
}
