import type { APIRoute } from 'astro';
import { body, getEngine, handle } from '../../../lib/server/engine.ts';
import { getNetwork } from '../../../lib/server/network.ts';

export const GET: APIRoute = () => handle(async () => ({ timezones: await getNetwork().timezones() }));
export const PUT: APIRoute = ({ request }) => handle(async () => {
  const b = await body(request);
  await getNetwork().setTime({
    timezone: b.timezone !== undefined ? String(b.timezone) : undefined,
    ntp: b.ntp !== undefined ? !!b.ntp : undefined,
  });
  // The NTP servers are kept in Towerlog's own config (the Clock page edits the same list).
  if (Array.isArray(b.servers)) getEngine().saveClock({ servers: b.servers.map(String) });
});
