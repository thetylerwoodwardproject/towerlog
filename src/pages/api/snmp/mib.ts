import type { APIRoute } from 'astro';
import { getEngine, handle } from '../../../lib/server/engine.ts';

export const GET: APIRoute = () => handle(() => new Response(getEngine().snmpMib(), {
  headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Disposition': 'attachment; filename="PI-TUNER-MIB.txt"' },
}));
