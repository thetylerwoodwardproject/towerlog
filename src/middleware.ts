// Login gate: every page and API route needs a valid session cookie, except the
// login page itself and built assets. With no password set yet, everything leads
// to /login, which says to set one with `towerlog password` on the host.
// Changes (POST/PUT/PATCH/DELETE) must also come from our own pages.
import { defineMiddleware } from 'astro:middleware';
import { getEngine } from './lib/server/engine.ts';
import { crossSite } from './engine/auth.ts';

const SESSION_COOKIE = 'towerlog_session';
const PUBLIC = [/^\/login\/?$/, /^\/api\/login\/?$/, /^\/_astro\//, /^\/favicon/];
const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);

const jsonError = (error: string, status: number) =>
  new Response(JSON.stringify({ error }), { status, headers: { 'Content-Type': 'application/json' } });

export const onRequest = defineMiddleware(async (ctx, next) => {
  const path = ctx.url.pathname;
  const h = ctx.request.headers;
  if (!SAFE.has(ctx.request.method) && crossSite(h.get('origin'), h.get('sec-fetch-site'), ctx.url.host)) {
    return jsonError('cross-site request refused', 403);
  }
  if (PUBLIC.some((re) => re.test(path))) return next();
  const engine = getEngine();
  if (engine.validSession(ctx.cookies.get(SESSION_COOKIE)?.value)) return next();
  if (path.startsWith('/api/')) return jsonError('login required', 401);
  return ctx.redirect(`/login?next=${encodeURIComponent(path + ctx.url.search)}`);
});
