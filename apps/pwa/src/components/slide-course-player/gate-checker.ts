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
//   require_interactions  → every interaction on the slide must have a
//                           non-null prior answer with passed === true.
//                           Drag-match / short-answer use score >=
//                           threshold; mcq / true_false use isCorrect.
//   require_both          → both of the above.

import type {
  PlayerInteraction,
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

export function buildInitialPlayState(
  slide: PlayerSlide,
): SlidePlayState {
  // Seed from any prior server-side answers so a reload mid-course
  // keeps the gate satisfied without re-answering.
  const interactionResults: SlidePlayState['interactionResults'] = {};
  for (const i of slide.interactions) {
    if (i.prior) {
      const passed = inferPassed(i, i.prior);
      interactionResults[i.id] = { passed };
    }
  }
  return {
    voiceoverEnded: false,
    interactionResults,
  };
}

function inferPassed(
  interaction: PlayerInteraction,
  prior: NonNullable<PlayerInteraction['prior']>,
): boolean {
  if (prior.isCorrect === true) return true;
  // For short_answer_ai the server stores score & sets isCorrect based
  // on the kind-specific threshold; isCorrect=true means passed. For
  // deterministic kinds, score===1 ⇔ isCorrect===true so we don't
  // need a fallback. Anything else: not passed.
  return false;
}
