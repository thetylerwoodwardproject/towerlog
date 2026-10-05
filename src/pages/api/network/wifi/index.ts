import type { APIRoute } from 'astro';
import { body, handle } from '../../../../lib/server/engine.ts';
import { getNetwork } from '../../../../lib/server/network.ts';

export const GET: APIRoute = () => handle(() => getNetwork().wifiScan());
export const POST: APIRoute = ({ request }) => handle(async () => {
  const b = await body(request);
  await getNetwork().wifiConnect(String(b.ssid ?? ''), String(b.password ?? ''), !!b.hidden);
});
