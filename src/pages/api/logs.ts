import type { APIRoute } from 'astro';
import { getEngine, handle } from '../../lib/server/engine.ts';

export const GET: APIRoute = ({ url }) => handle(() => {
  const file = url.searchParams.get('file') || undefined;
  const limit = Math.min(1000, Number(url.searchParams.get('limit')) || 300);
  return getEngine().logs(file, limit);
});
