import type { APIRoute } from 'astro';
import { body, handle } from '../../../../lib/server/engine.ts';
import { getNetwork } from '../../../../lib/server/network.ts';

export const PUT: APIRoute = ({ params, request }) => handle(async () => {
  const b = await body(request);
  return getNetwork().applyIpv4(String(params.dev), {
    method: String(b.method ?? ''), address: b.address ? String(b.address) : undefined,
    gateway: b.gateway ? String(b.gateway) : undefined, dns: Array.isArray(b.dns) ? b.dns.map(String) : [],
  });
});
