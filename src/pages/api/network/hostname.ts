import type { APIRoute } from 'astro';
import { body, handle } from '../../../lib/server/engine.ts';
import { getNetwork } from '../../../lib/server/network.ts';

export const PUT: APIRoute = ({ request }) => handle(async () => {
  await getNetwork().setHostname(String((await body(request)).hostname ?? ''));
});
