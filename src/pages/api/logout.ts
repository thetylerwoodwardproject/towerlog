import type { APIRoute } from 'astro';
import { getEngine } from '../../lib/server/engine.ts';
import { SESSION_COOKIE } from '../../lib/server/session.ts';

/** Ends this session on the server too: a copied cookie stops working. */
export const POST: APIRoute = ({ cookies }) => {
  getEngine().revokeSession(cookies.get(SESSION_COOKIE)?.value);
  cookies.delete(SESSION_COOKIE, { path: '/' });
  return new Response(null, { status: 204 });
};
