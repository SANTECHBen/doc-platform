import { describe, expect, it } from 'vitest';
import { trimOverrunningClips } from './loop.js';

// Minimal step shape — the helper only touches the three time fields.
function makeStep(
  clipStartMs: number,
  clipEndMs: number,
  keyframeTimestampMs?: number,
) {
  return {
    clipStartMs,
    clipEndMs,
    keyframeTimestampMs: keyframeTimestampMs ?? Math.floor((clipStartMs + clipEndMs) / 2),
  };
}

describe('trimOverrunningClips', () => {
  it('caps step N when it overruns step N+1 start (the observed prod bug)', () => {
    // Step 0 [0..12000] runs past step 1's 10000 start by 2 seconds —
    // tech would hear step 1's narration starting while step 0 loops.
    const steps = [makeStep(0, 12_000), makeStep(10_000, 15_000)];
    trimOverrunningClips(steps);
    expect(steps[0]!.clipEndMs).toBe(10_000 - 250);
    expect(steps[1]!.clipEndMs).toBe(15_000); // last step untouched
  });

  it('keeps a clean cut alone (no overlap, no overrun)', () => {
    const steps = [makeStep(0, 5_000), makeStep(8_000, 13_000)];
    trimOverrunningClips(steps);
    expect(steps[0]!.clipEndMs).toBe(5_000);
    expect(steps[1]!.clipEndMs).toBe(13_000);
  });

  it('respects STEP_CLIP_MIN_MS when next step starts within the guard', () => {
    // Next step starts only 1s after this step's start — applying the
    // 250ms guard would leave step 0 below the 2s minimum. Let the
    // clips kiss instead.
    const steps = [makeStep(0, 4_000), makeStep(1_000, 4_000)];
    trimOverrunningClips(steps);
    // Trim went to start + min (2000ms), not the cap (750ms).
    expect(steps[0]!.clipEndMs).toBe(2_000);
  });

  it('re-centers the keyframe when the trim moves it out of range', () => {
    // Keyframe was at 9000, inside the original [0..12000] window. After
    // trimming end to 9750 the keyframe is still inside; pick a case
    // where the keyframe lands AT the new end so we exercise the
    // recentering branch.
    const steps = [makeStep(0, 12_000, 11_000), makeStep(8_000, 12_000)];
    trimOverrunningClips(steps);
    expect(steps[0]!.clipEndMs).toBe(7_750);
    // 11000 was past the new 7750 end; helper recentered to the mid.
    expect(steps[0]!.keyframeTimestampMs).toBe(Math.floor((0 + 7_750) / 2));
  });

  it('handles a chain of overlapping clips', () => {
    const steps = [
      makeStep(0, 10_000),
      makeStep(7_000, 13_000),
      makeStep(11_000, 17_000),
      makeStep(15_000, 20_000),
    ];
    trimOverrunningClips(steps);
    expect(steps[0]!.clipEndMs).toBe(7_000 - 250);
    expect(steps[1]!.clipEndMs).toBe(11_000 - 250);
    expect(steps[2]!.clipEndMs).toBe(15_000 - 250);
    expect(steps[3]!.clipEndMs).toBe(20_000); // last step untouched
  });

  it('is a no-op on a single step', () => {
    const steps = [makeStep(0, 5_000)];
    trimOverrunningClips(steps);
    expect(steps[0]!.clipEndMs).toBe(5_000);
  });

  it('is a no-op on an empty list', () => {
    const steps: ReturnType<typeof makeStep>[] = [];
    expect(() => trimOverrunningClips(steps)).not.toThrow();
  });

  it('honors a custom guard', () => {
    const steps = [makeStep(0, 12_000), makeStep(10_000, 15_000)];
    trimOverrunningClips(steps, 1_000);
    expect(steps[0]!.clipEndMs).toBe(10_000 - 1_000);
  });
});
