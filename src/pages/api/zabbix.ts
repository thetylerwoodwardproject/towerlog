import type { APIRoute } from 'astro';
import { body, getEngine, handle } from '../../lib/server/engine.ts';

export const GET: APIRoute = () => handle(() => getEngine().redactedConfig().zabbix);

export const PUT: APIRoute = ({ request }) => handle(async () => {
  getEngine().saveZabbix(await body(request));
  return getEngine().redactedConfig().zabbix;
});
