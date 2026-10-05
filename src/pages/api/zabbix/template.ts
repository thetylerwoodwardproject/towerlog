import type { APIRoute } from 'astro';
import { getEngine } from '../../../lib/server/engine.ts';

export const GET: APIRoute = () => new Response(getEngine().zabbixTemplate(), {
  headers: {
    'Content-Type': 'application/xml; charset=utf-8',
    'Content-Disposition': 'attachment; filename="towerlog_zabbix_template.xml"',
  },
});
