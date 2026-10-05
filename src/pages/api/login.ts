import type { APIRoute } from 'astro';
import { body, getEngine, handle } from '../../lib/server/engine.ts';
import { setSessionCookie } from '../../lib/server/session.ts';
import { rateLimitKey } from '../../engine/auth.ts';

const WINDOW_MS = 60000;
const MAX_FAILURES = 10;
const MAX_CLIENTS = 10000;
/** Recent failed attempts per client, so one noisy client can't lock everyone else out. */
const failures = new Map<string, number[]>();

/** POST {password}: log in. The first password is set on the host (`towerlog password`), never here. */
export const POST: APIRoute = ({ request, cookies, url, clientAddress }) => handle(async () => {
  const engine = getEngine();
  const b = await body(request);
  const pw = String(b.password ?? '');
  let addr = '?';
  try { addr = clientAddress; } catch { /* adapter without it */ }
  const key = rateLimitKey(addr);
  const now = Date.now();
  for (const [k, list] of failures) {
    const recent = list.filter((t) => now - t < WINDOW_MS);
    if (recent.length) failures.set(k, recent); else failures.delete(k);
  }
  if ((failures.get(key)?.length ?? 0) >= MAX_FAILURES) throw Object.assign(new Error('too many attempts, wait a minute'), { status: 429 });
  if (!engine.hasPassword) {
    throw Object.assign(new Error('no password is set yet: run "sudo towerlog password" on the Towerlog host'), { status: 403 });
  }
  if (!engine.checkPassword(pw)) {
    if (failures.size < MAX_CLIENTS || failures.has(key)) failures.set(key, [...(failures.get(key) ?? []), now]);
    engine.log.warn(`web UI: wrong password from ${addr}`);
    await new Promise((r) => setTimeout(r, 500));
    throw Object.assign(new Error('wrong password'), { status: 401 });
  }
  setSessionCookie(engine, cookies, request, url);
  return { ok: true };
});
