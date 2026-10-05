import type { APIRoute } from 'astro';
import { body, getEngine, handle } from '../../lib/server/engine.ts';

export const GET: APIRoute = () => handle(() => getEngine().redactedConfig().snmp);

export const PUT: APIRoute = ({ request }) => handle(async () => {
  getEngine().saveSnmp(await body(request));
  return getEngine().redactedConfig().snmp;
});
