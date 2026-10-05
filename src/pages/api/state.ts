import type { APIRoute } from 'astro';
import { getEngine, json } from '../../lib/server/engine.ts';

export const GET: APIRoute = () => json(getEngine().snapshot());
