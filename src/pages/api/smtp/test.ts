import type { APIRoute } from 'astro';
import { body, getEngine, handle } from '../../../lib/server/engine.ts';

/** POST {to?}: send a test email now and report the SMTP error, if any. */
export const POST: APIRoute = ({ request }) => handle(async () => {
  const b = await body(request);
  const to = typeof b.to === 'string' && b.to.trim() ? b.to.trim() : undefined;
  return { ok: true, sent_to: await getEngine().testEmail(to) };
});
