import type { APIRoute } from 'astro';
import { body, getEngine, handle } from '../../../../lib/server/engine.ts';

/** PUT: replace the input's settings (restarts it). */
export const PUT: APIRoute = ({ params, request }) => handle(async () => getEngine().saveInput(await body(request), params.id!));

export const DELETE: APIRoute = ({ params }) => handle(() => {
  getEngine().deleteInput(params.id!);
  return { ok: true };
});
