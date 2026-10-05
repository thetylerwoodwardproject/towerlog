import type { APIRoute } from 'astro';
import { getEngine, handle } from '../../lib/server/engine.ts';

export const GET: APIRoute = () => handle(() => getEngine().redactedConfig());
