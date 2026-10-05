import type { APIRoute } from 'astro';
import { body, getEngine, handle } from '../../lib/server/engine.ts';

export const GET: APIRoute = () => handle(() => getEngine().clock());

/** PUT {servers: string[] | string}: the NTP servers chrony should use (empty = its defaults). */
export const PUT: APIRoute = ({ request }) => handle(async () => {
  getEngine().saveClock(await body(request));
  return getEngine().clock();
});
