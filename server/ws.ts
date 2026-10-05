// /ws: pushes the engine snapshot to logged-in browsers (shared by prod and dev).
import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import type { Engine } from '../src/engine/index.ts';
import { crossSite, parseCookies, SESSION_COOKIE } from '../src/engine/auth.ts';

export function attachWebSocket(server: Server, engine: Engine, allow: ((addr: string | undefined) => boolean) | null = null) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    // A throw here would be uncaught and take every station down with it.
    try {
      upgrade(req, socket, head);
    } catch (e) {
      engine.log.error(`ws: ${(e as Error).stack || e}`);
      socket.destroy();
    }
  });
  function upgrade(req: IncomingMessage, socket: Duplex, head: Buffer) {
    const url = new URL(req.url || '/', 'http://x');
    if (url.pathname !== '/ws') return; // e.g. Vite HMR in dev
    if (allow && !allow(req.socket.remoteAddress)) {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    // Another page (e.g. one served by Icecast on this host) must not read the feed with our cookie.
    const site = req.headers['sec-fetch-site'];
    if (crossSite(req.headers.origin, Array.isArray(site) ? site[0] : site, req.headers.host)) {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    if (!engine.validSession(token)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  }
  wss.on('connection', (ws: WebSocket) => {
    ws.send(JSON.stringify(engine.snapshot()));
    const off = engine.subscribe((snap) => {
      if (ws.readyState !== ws.OPEN) return;
      // Skip a frame rather than queue up behind a slow client.
      if (ws.bufferedAmount > 512 * 1024) return;
      ws.send(JSON.stringify(snap));
    });
    ws.on('close', off);
    ws.on('error', off);
  });
  return wss;
}
