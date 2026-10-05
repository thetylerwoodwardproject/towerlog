// Icecast source endpoint: lets any Icecast source client (such as
// ffmpeg, BUTT, Liquidsoap) push a stream to Towerlog, which logs it like any
// other input. Raw TCP on purpose: a source request has no Content-Length, so
// Node's HTTP parser would treat the audio that follows as garbage.
import net from 'node:net';
import crypto from 'node:crypto';
import { PassThrough } from 'node:stream';
import type { LogInput } from '../src/engine/inputs/input.ts';
import type { Logger } from '../src/engine/logger.ts';

const MAX_HEAD = 8192;
const HEAD_TIMEOUT_MS = 10000;

export interface SourceHooks {
  /** The enabled push input for this mount, if any. */
  find: (mount: string) => LogInput | undefined;
  log: Logger;
}

function sameSecret(given: string, expected: string): boolean {
  const a = crypto.createHash('sha256').update(given).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

function basicPassword(header: string | undefined): string | null {
  const m = /^Basic\s+(\S+)/i.exec(header ?? '');
  if (!m) return null;
  const text = Buffer.from(m[1], 'base64').toString('utf8');
  const i = text.indexOf(':');
  return i < 0 ? null : text.slice(i + 1);
}

export function createSourceServer(hooks: SourceHooks): net.Server {
  return net.createServer((sock) => {
    sock.on('error', () => { /* client vanished */ });
    let buf = Buffer.alloc(0);
    const timer = setTimeout(() => sock.destroy(), HEAD_TIMEOUT_MS);
    const reply = (line: string, body = '') =>
      sock.end(`${line}\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`);

    const onData = (d: Buffer) => {
      buf = Buffer.concat([buf, d]);
      const end = buf.indexOf('\r\n\r\n');
      if (end < 0) {
        if (buf.length > MAX_HEAD) { clearTimeout(timer); sock.destroy(); }
        return;
      }
      sock.removeListener('data', onData);
      clearTimeout(timer);
      const rest = buf.subarray(end + 4);
      const [line, ...hdrs] = buf.subarray(0, end).toString('latin1').split('\r\n');
      const [method, target] = line.split(' ');
      const h: Record<string, string> = {};
      for (const x of hdrs) { const i = x.indexOf(':'); if (i > 0) h[x.slice(0, i).toLowerCase()] = x.slice(i + 1).trim(); }
      let url: URL;
      try { url = new URL(target ?? '/', 'http://x'); } catch { reply('HTTP/1.0 400 Bad Request'); return; }
      let mount: string;
      try { mount = decodeURIComponent(url.pathname); } catch { reply('HTTP/1.0 400 Bad Request'); return; }
      const isMeta = method === 'GET' && url.pathname === '/admin/metadata';
      if (!(method === 'PUT' || method === 'SOURCE' || isMeta)) { reply('HTTP/1.0 404 Not Found'); return; }

      const mountOfRequest = isMeta ? (url.searchParams.get('mount') ?? '') : mount;
      const input = hooks.find(mountOfRequest);
      if (!input) { reply('HTTP/1.0 404 Not Found', 'no such mount\n'); return; }
      const pw = basicPassword(h.authorization);
      if (pw === null || !sameSecret(pw, input.cfg.source_password)) {
        hooks.log.warn(`source: bad password for ${mountOfRequest} from ${sock.remoteAddress}`);
        sock.end('HTTP/1.0 401 Unauthorized\r\nWWW-Authenticate: Basic realm="Icecast"\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
        return;
      }
      if (isMeta) {
        // Now-playing (metadata) updates from the source: accepted, nothing to do with them yet.
        reply('HTTP/1.0 200 OK', '<?xml version="1.0"?><iceresponse><message>Metadata update successful</message><return>1</return></iceresponse>');
        return;
      }
      sock.write(h.expect ? 'HTTP/1.1 100 Continue\r\n\r\n' : 'HTTP/1.0 200 OK\r\n\r\n');
      hooks.log.info(`source: ${input.cfg.name} connected on ${mountOfRequest} from ${sock.remoteAddress}`);
      const audio = new PassThrough();
      if (rest.length) audio.write(rest);
      sock.pipe(audio);
      sock.on('close', () => { hooks.log.info(`source: ${input.cfg.name} disconnected`); audio.end(); audio.destroy(); });
      input.attach(audio);
    };
    sock.on('data', onData);
    sock.on('close', () => clearTimeout(timer));
  });
}
