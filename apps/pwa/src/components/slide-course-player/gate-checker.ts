// Pure gating logic — kept in its own file so it can be unit-tested
// without rendering React.
//
// The player tells us: which slide is the learner on, has the voiceover
// finished playing, what interaction answers we have so far. Given that,
// canAdvance returns whether the Next button should be enabled.
//
// "Required" semantics per gate kind:
//   free                  → always advance.
//   require_voiceover     → voiceover must have a duration AND have
//                           ended at least once during this attempt.
//   require_interactions  → every interaction on the slide must have
//                           passed at least once during this session.
//   require_both          → both of the above.

import type {
  PlayerNavigationGate,
  PlayerSlide,
} from '@/lib/slide-course-api';

export interface SlidePlayState {
  voiceoverEnded: boolean;
  interactionResults: Record<
    string, // interactionId
    { passed: boolean }
  >;
}

export function canAdvance(slide: PlayerSlide, state: SlidePlayState): boolean {
  if (slide.navigationGate === 'free') return true;
  const voiceOK =
    !slide.voiceoverUrl ||
    !slide.voiceoverDurationSec ||
    state.voiceoverEnded === true;
  const interactionsOK =
    slide.interactions.length === 0 ||
    slide.interactions.every((i) => state.interactionResults[i.id]?.passed === true);
  if (slide.navigationGate === 'require_voiceover') return voiceOK;
  if (slide.navigationGate === 'require_interactions') return interactionsOK;
  if (slide.navigationGate === 'require_both') return voiceOK && interactionsOK;
  return true;
}

export function buildInitialPlayState(_slide: PlayerSlide): SlidePlayState {
  // Anonymous scan-session = no persisted progress. Always start fresh.
  return {
    voiceoverEnded: false,
    interactionResults: {},
  };
}

// Suppress unused-param warning while keeping the parameter for future use.
export type { PlayerNavigationGate };
