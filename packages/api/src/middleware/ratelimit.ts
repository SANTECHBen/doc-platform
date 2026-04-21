// Lightweight per-user rate limiter. Kept in-process because the API runs
// on a single Fly.io machine today — when we scale horizontally, swap this
// for Redis-backed counters (the interface stays the same).
//
// Hourly sliding window: each userId maps to a window-start timestamp and
// a running count. When a caller hits the limit inside the current window,
// we return the wait time in seconds so the handler can send a 429 with
// Retry-After. Once the window closes, the next call resets it.

type WindowEntry = { windowStart: number; count: number };

/**
 * Create a rate-limit bucket with a given limit per rolling window of
 * `windowMs` milliseconds. Scoped per-key (typically userId).
 *
 * Call `check(key)` before the work. If it returns { allowed: false, ... },
 * reject the request; if { allowed: true }, increment has already happened.
 */
export function createRateLimiter(options: { limit: number; windowMs: number }) {
  const { limit, windowMs } = options;
  const windows = new Map<string, WindowEntry>();

  return {
    check(key: string): { allowed: true } | { allowed: false; retryAfterSec: number } {
      const now = Date.now();
      const entry = windows.get(key);
      if (!entry || now - entry.windowStart >= windowMs) {
        // New window — reset.
        windows.set(key, { windowStart: now, count: 1 });
        return { allowed: true };
      }
      if (entry.count >= limit) {
        const retryAfterMs = entry.windowStart + windowMs - now;
        return {
          allowed: false,
          retryAfterSec: Math.max(1, Math.ceil(retryAfterMs / 1000)),
        };
      }
      entry.count += 1;
      return { allowed: true };
    },

    // Periodic cleanup so dormant keys don't leak. Called opportunistically —
    // the Map grows linearly in unique callers, which is bounded.
    sweep() {
      const now = Date.now();
      for (const [k, v] of windows) {
        if (now - v.windowStart >= windowMs) windows.delete(k);
      }
    },
  };
}

export type RateLimiter = ReturnType<typeof createRateLimiter>;
