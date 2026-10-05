// GET /listen/input/<id>: listen to a logged input through Towerlog's own port.
// The input's audio is encoded to MP3 for this listener only (see LogInput.listen).
// Needs a logged-in session.
import type http from 'node:http';
import type { Engine } from '../src/engine/index.ts';
import { parseCookies, SESSION_COOKIE } from '../src/engine/auth.ts';

/** Returns true if it handled the request. */
export function handleListen(engine: Engine, req: http.IncomingMessage, res: http.ServerResponse): boolean {
  const url = new URL(req.url || '/', 'http://x');
  if (!url.pathname.startsWith('/listen/')) return false;
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405).end();
    return true;
  }
  const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  if (!engine.validSession(token)) {
    res.writeHead(401, { 'Content-Type': 'text/plain' }).end('login required\n');
    return true;
  }
  if (url.pathname.startsWith('/listen/input/')) {
    const id = decodeURIComponent(url.pathname.slice('/listen/input/'.length));
    const input = engine.inputs.get(id);
    if (!input) { res.writeHead(404, { 'Content-Type': 'text/plain' }).end('no such input\n'); return true; }
    res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Cache-Control': 'no-store', 'icy-name': input.cfg.name });
    if (req.method === 'HEAD') { res.end(); return true; }
    input.listen(res);
    return true;
  }
  res.writeHead(404, { 'Content-Type': 'text/plain' }).end('no such stream\n');
  return true;
}
