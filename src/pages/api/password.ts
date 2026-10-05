import type { APIRoute } from 'astro';
import { body, getEngine, handle } from '../../lib/server/engine.ts';
import { setSessionCookie } from '../../lib/server/session.ts';

/** PUT {current, password}: change the web UI password (signs out other sessions). */
export const PUT: APIRoute = ({ request, cookies, url }) => handle(async () => {
  const engine = getEngine();
  const b = await body(request);
  if (!engine.checkPassword(String(b.current ?? ''))) throw Object.assign(new Error('current password is wrong'), { status: 403 });
  engine.setPassword(String(b.password ?? ''));
  setSessionCookie(engine, cookies, request, url);
  return { ok: true };
});
