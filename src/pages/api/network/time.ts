import type { APIRoute } from 'astro';
import { body, handle } from '../../../lib/server/engine.ts';
import { getNetwork } from '../../../lib/server/network.ts';

export const GET: APIRoute = () => handle(async () => ({ timezones: await getNetwork().timezones(), time: await getNetwork().timeStatus() }));
export const PUT: APIRoute = ({ request }) => handle(async () => {
  const b = await body(request);
  await getNetwork().setTime({
    timezone: b.timezone !== undefined ? String(b.timezone) : undefined,
    ntp: b.ntp !== undefined ? !!b.ntp : undefined,
  });
});
