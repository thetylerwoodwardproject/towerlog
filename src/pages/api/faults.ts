import type { APIRoute } from 'astro';
import { getEngine, handle } from '../../lib/server/engine.ts';

/** GET /api/faults?input=<id>&limit=<n>: fault raises and clears, newest first. */
export const GET: APIRoute = ({ url }) => handle(() => {
  const limit = Math.min(1000, Math.max(1, Number(url.searchParams.get('limit')) || 200));
  return getEngine().faultLog.read({ input: url.searchParams.get('input') || undefined, limit });
});
