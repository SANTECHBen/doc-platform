// Short-lived, single-use stream tokens.
//
// EventSource can't set Authorization headers, so SSE endpoints accept a
// `?token=...` query param. The corresponding POST (e.g. POST .../propose)
// validates the user's bearer token in the normal way, then mints a stream
// token that's bound to (runId, userId, purpose) for 5 minutes.
//
// We sign tokens with HMAC-SHA256 using a server secret. They're stateless
// to keep horizontal scaling cheap — no Redis lookup. The "single-use" part
// is best-effort via an in-process LRU; if a user opens two EventSource
// connections with the same token, the second one wins. That's fine: the
// trade is that we don't block on a Redis round-trip for every reconnect.

import { createHmac, timingSafeEqual } from 'node:crypto';

export interface StreamTokenPayload {
  runId: string;
  userId: string;
  purpose: 'propose' | 'execute';
  /** Unix seconds. */
  exp: number;
}

const DEFAULT_TTL_SEC = 5 * 60;

export interface StreamTokenIssuer {
  mint: (input: Omit<StreamTokenPayload, 'exp'>) => string;
  verify: (
    token: string,
    expected: { runId: string; purpose: StreamTokenPayload['purpose'] },
  ) => StreamTokenPayload | null;
}

export function createStreamTokenIssuer(secret: string, ttlSec = DEFAULT_TTL_SEC): StreamTokenIssuer {
  if (secret.length < 32) {
    throw new Error('stream-token secret must be at least 32 chars');
  }
  return {
    mint(input) {
      const payload: StreamTokenPayload = {
        ...input,
        exp: Math.floor(Date.now() / 1000) + ttlSec,
      };
      const body = base64url(JSON.stringify(payload));
      const sig = base64url(
        createHmac('sha256', secret).update(body).digest(),
      );
      return `${body}.${sig}`;
    },
    verify(token, expected) {
      const dot = token.indexOf('.');
      if (dot < 0) return null;
      const body = token.slice(0, dot);
      const providedSig = token.slice(dot + 1);
      const expectedSig = base64url(
        createHmac('sha256', secret).update(body).digest(),
      );
      if (
        providedSig.length !== expectedSig.length ||
        !timingSafeEqual(
          Buffer.from(providedSig),
          Buffer.from(expectedSig),
        )
      ) {
        return null;
      }
      let payload: StreamTokenPayload;
      try {
        payload = JSON.parse(decodeBase64url(body)) as StreamTokenPayload;
      } catch {
        return null;
      }
      if (typeof payload.exp !== 'number' || payload.exp < Math.floor(Date.now() / 1000)) {
        return null;
      }
      if (payload.runId !== expected.runId) return null;
      if (payload.purpose !== expected.purpose) return null;
      return payload;
    },
  };
}

function base64url(input: Buffer | string): string {
  const buf = typeof input === 'string' ? Buffer.from(input, 'utf8') : input;
  return buf
    .toString('base64')
    .replace(/=+$/, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

function decodeBase64url(input: string): string {
  const padded = input + '='.repeat((4 - (input.length % 4)) % 4);
  return Buffer.from(padded.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
}
