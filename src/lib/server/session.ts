// The session cookie, shared by log-in and password change.
import type { AstroCookies } from 'astro';
import type { Engine } from '../../engine/index.ts';

export const SESSION_COOKIE = 'towerlog_session';

/** Set a fresh session cookie. */
export function setSessionCookie(engine: Engine, cookies: AstroCookies, request: Request, url: URL) {
  // Behind an HTTPS proxy the app itself sees plain http; the proxy says so in
  // X-Forwarded-Proto. Believing it can only add Secure, never remove it.
  const https = url.protocol === 'https:' || /^\s*https\b/i.test(request.headers.get('x-forwarded-proto') ?? '');
  cookies.set(SESSION_COOKIE, engine.newSession(), {
    path: '/', httpOnly: true, sameSite: 'strict', secure: https, maxAge: engine.config.web.session_hours * 3600,
  });
}
