import type { APIRoute } from 'astro';
import { getEngine, handle } from '../../../lib/server/engine.ts';

export const POST: APIRoute = () => handle(async () => ({ ok: true, results: await getEngine().testSnmp() }));
