// Scan-session cookies — HMAC-signed, short-lived, bound to a specific QR
// code. Used when an organization opts into require_scan_access: the cookie
// is minted when a visitor lands on /q/<code> (where QR codes point) and
// verified when rendering /a/<code>. Anyone with just a shared URL won't
// have a cookie; they hit the scan-wall instead.
//
// The cookie's integrity is anchored in PWA_SESSION_SECRET — a server-only
// env var. Compromising the cookie requires either the secret or a valid
// signed cookie; both are tightly scoped.

import crypto from 'node:crypto';

const COOKIE_NAME = 'eh_scan';
// 8 hours matches an average shift. Short enough that a shared URL goes
// stale by next day; long enough that a tech doesn't rescan mid-task.
const TTL_SECONDS = 8 * 60 * 60;

function getSecret(): string {
  const s = process.env.PWA_SESSION_SECRET;
  if (!s || s.length < 32) {
    throw new Error(
      'PWA_SESSION_SECRET must be set to at least 32 chars for scan-session signing',
    );
  }
  return s;
}

function base64url(buf: Buffer): string {
  return buf.toString('base64url');
}

function hmac(payload: string, secret: string): string {
  return base64url(crypto.createHmac('sha256', secret).update(payload).digest());
}

/**
 * Build a signed session value for the given QR code. Shape:
 *   <code>.<expUnixSeconds>.<hmac>
 * The HMAC covers `<code>.<expUnixSeconds>` so tampering with either part
 * invalidates the signature.
 */
export function mintScanSessionValue(qrCode: string): string {
  const exp = Math.floor(Date.now() / 1000) + TTL_SECONDS;
  const payload = `${qrCode}.${exp}`;
  const sig = hmac(payload, getSecret());
  return `${payload}.${sig}`;
}

/**
 * Verify a session value against a QR code. Returns true only if the
 * signature matches, it hasn't expired, and the code binding matches.
 * Returns false for any tampering, mismatch, or missing secret.
 */
export function verifyScanSessionValue(value: string, qrCode: string): boolean {
  try {
    const parts = value.split('.');
    if (parts.length !== 3) return false;
    const [code, expStr, sig] = parts;
    if (!code || !expStr || !sig) return false;
    if (code !== qrCode) return false;
    const exp = Number(expStr);
    if (!Number.isFinite(exp) || exp * 1000 < Date.now()) return false;
    const expected = hmac(`${code}.${exp}`, getSecret());
    // Constant-time compare to resist timing attacks on the signature.
    const a = Buffer.from(sig, 'base64url');
    const b = Buffer.from(expected, 'base64url');
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

export const SCAN_COOKIE_NAME = COOKIE_NAME;
export const SCAN_COOKIE_MAX_AGE = TTL_SECONDS;
