import type { APIRoute } from 'astro';
import { body, handle } from '../../../lib/server/engine.ts';
import { getNetwork } from '../../../lib/server/network.ts';

/** POST {keep: true} keeps a pending IPv4 change; {keep: false} rolls it back now. */
export const POST: APIRoute = ({ request }) => handle(async () => {
  const b = await body(request);
  await getNetwork().confirm(b.keep !== false);
});
