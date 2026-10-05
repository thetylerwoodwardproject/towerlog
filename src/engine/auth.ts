// Web UI login: one admin password (scrypt), stateless signed session cookies.
import crypto from 'node:crypto';
import net from 'node:net';

export const SESSION_COOKIE = 'towerlog_session';

export function hashPassword(pw: string): string {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(pw, salt, 32, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

export function verifyPassword(pw: string, stored: string): boolean {
  const [kind, saltHex, hashHex] = String(stored).split('$');
  if (kind !== 'scrypt' || !saltHex || !hashHex) return false;
  const want = Buffer.from(hashHex, 'hex');
  const got = crypto.scryptSync(pw, Buffer.from(saltHex, 'hex'), want.length, { N: 16384, r: 8, p: 1 });
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}

function mac(secret: string, payload: string): string {
  return crypto.createHmac('sha256', secret).update(payload).digest('base64url');
}

/** Token "<expiry>.<nonce>.<hmac>", valid for ttlSecs. */
export function signSession(secret: string, ttlSecs: number, now = Date.now()): string {
  const payload = `${Math.floor(now / 1000) + ttlSecs}.${crypto.randomBytes(9).toString('base64url')}`;
  return `${payload}.${mac(secret, payload)}`;
}

export function verifySession(secret: string, token: string, now = Date.now()): boolean {
  const parts = token.split('.');
  if (parts.length !== 3 || !secret) return false;
  const payload = `${parts[0]}.${parts[1]}`;
  const want = Buffer.from(mac(secret, payload));
  const got = Buffer.from(parts[2]);
  if (want.length !== got.length || !crypto.timingSafeEqual(want, got)) return false;
  return Number(parts[0]) * 1000 > now;
}

/** Never throws: a malformed %-escape (sent by anyone, before login) keeps the raw value. */
export function parseCookies(header: string | undefined | null): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header || '').split(';')) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    const raw = part.slice(i + 1).trim();
    let value = raw;
    try { value = decodeURIComponent(raw); } catch { /* keep raw */ }
    out[part.slice(0, i).trim()] = value;
  }
  return out;
}

/** The nonce and expiry (epoch s) of a session token, for revoking it; null if malformed. */
export function sessionNonce(token: string): { nonce: string; exp: number } | null {
  const [exp, nonce] = token.split('.');
  return nonce && Number.isFinite(Number(exp)) ? { nonce, exp: Number(exp) } : null;
}

/**
 * True for a browser request sent by another page than ours. SameSite cookies don't
 * cover other ports on the same host (Icecast on :8000 is "same site"), so changes
 * also need Sec-Fetch-Site / Origin to say same-origin. Non-browser clients (curl,
 * scripts) send neither and are let through to the login check.
 */
export function crossSite(origin: string | null | undefined, fetchSite: string | null | undefined, host: string | null | undefined): boolean {
  if (fetchSite && fetchSite !== 'same-origin' && fetchSite !== 'none') return true;
  if (!origin) return false;
  try {
    // Host only: behind an HTTPS proxy the app sees http while the page is https.
    return new URL(origin).host !== host;
  } catch {
    return true; // "null" (sandboxed frames, file://)
  }
}

/** Rate-limit key: the address, or its /64 for IPv6 (one host can rotate through a whole /64). */
export function rateLimitKey(addr: string): string {
  const a = addr.startsWith('::ffff:') ? addr.slice(7) : addr;
  if (!net.isIPv6(a)) return a;
  const bare = a.split('%')[0];
  let groups = bare.split(':');
  if (bare.includes('::')) {
    const [head, tail] = bare.split('::').map((s) => (s ? s.split(':') : []));
    groups = [...head, ...Array(Math.max(0, 8 - head.length - tail.length)).fill('0'), ...tail];
  }
  return groups.slice(0, 4).map((g) => g.toLowerCase().replace(/^0+(?=.)/, '')).join(':') + '::/64';
}
