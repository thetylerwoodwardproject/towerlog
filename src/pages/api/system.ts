import type { APIRoute } from 'astro';
import { body, getEngine, handle } from '../../lib/server/engine.ts';

export const GET: APIRoute = () => handle(() => getEngine().system());

/** PUT {recordings_dir?, purge_min_free_gb?} */
export const PUT: APIRoute = ({ request }) => handle(async () => {
  const b = await body(request);
  if ('recordings_dir' in b) getEngine().saveRecordingsDir(String(b.recordings_dir ?? ''));
  if ('purge_min_free_gb' in b) getEngine().savePurge(Number(b.purge_min_free_gb));
  return getEngine().system();
});
