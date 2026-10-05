import type { APIRoute } from 'astro';
import { body, getEngine, handle } from '../../../lib/server/engine.ts';

export const GET: APIRoute = () => handle(() => getEngine().redactedConfig().inputs);

/** POST: add an input. */
export const POST: APIRoute = ({ request }) => handle(async () => getEngine().saveInput(await body(request)));
