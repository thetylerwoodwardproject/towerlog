// API routes reach the running engine through this accessor. The engine is
// created by the HTTP server (server/index.ts or the dev integration); routes
// must not import its implementation, or the bundle would get a second copy.
import type { Engine } from '../../engine/index.ts';

export function getEngine(): Engine {
  const e = globalThis.__towerlogEngine;
  if (!e) throw new Error('Towerlog engine is not running');
  return e;
}

export function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers },
  });
}

/** Run an API handler, turning thrown errors (HttpError has .status) into JSON replies. */
export async function handle(fn: () => unknown | Promise<unknown>): Promise<Response> {
  try {
    const out = await fn();
    if (out instanceof Response) return out;
    return json(out ?? { ok: true });
  } catch (e) {
    const err = e as Error & { status?: number };
    const status = typeof err.status === 'number' ? err.status : 500;
    if (status >= 500) getEngineSafe()?.log.error(`api: ${err.stack || err.message}`);
    return json({ error: err.message || String(e) }, status);
  }
}

function getEngineSafe(): Engine | undefined {
  return globalThis.__towerlogEngine;
}

export async function body(request: Request): Promise<Record<string, unknown>> {
  try {
    const b = await request.json();
    return b && typeof b === 'object' && !Array.isArray(b) ? (b as Record<string, unknown>) : {};
  } catch {
    const e = new Error('request body must be JSON') as Error & { status: number };
    e.status = 400;
    throw e;
  }
}
