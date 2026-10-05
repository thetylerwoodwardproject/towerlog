import net from 'node:net';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { Logger } from '../src/engine/logger.ts';
import { SmtpSchema, ZabbixSchema } from '../src/engine/config.ts';

export const tmpdir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'towerlog-test-'));
export const quietLogger = () => new Logger(tmpdir(), true);
export const smtpConf = (o: Record<string, unknown> = {}) => SmtpSchema.parse({ enabled: true, host: '127.0.0.1', to: 'ops@example.com', ...o });
export const zbxConf = (o: Record<string, unknown> = {}) => ZabbixSchema.parse({ enabled: true, server: '127.0.0.1', ...o });

/** Plain-text SMTP sink (no TLS) with optional AUTH PLAIN/LOGIN. */
export function fakeSmtp(opts: { user?: string; pass?: string; port?: number } = {}) {
  const messages: { from: string; to: string[]; data: string; auth: string | null }[] = [];
  const server = net.createServer((sock) => {
    let buf = '';
    let mode: 'cmd' | 'data' | 'login-user' | 'login-pass' = 'cmd';
    let cur = { from: '', to: [] as string[], data: '', auth: null as string | null };
    let loginUser = '';
    sock.write('220 fake ESMTP\r\n');
    sock.on('data', (d) => {
      buf += d.toString();
      let i: number;
      while ((i = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 2);
        if (mode === 'data') {
          if (line === '.') { messages.push(cur); cur = { from: '', to: [], data: '', auth: cur.auth }; mode = 'cmd'; sock.write('250 queued\r\n'); }
          else cur.data += line + '\n';
          continue;
        }
        if (mode === 'login-user') { loginUser = Buffer.from(line, 'base64').toString(); mode = 'login-pass'; sock.write('334 UGFzc3dvcmQ6\r\n'); continue; }
        if (mode === 'login-pass') {
          const p = Buffer.from(line, 'base64').toString();
          mode = 'cmd';
          if (loginUser === opts.user && p === opts.pass) { cur.auth = loginUser; sock.write('235 ok\r\n'); } else sock.write('535 bad credentials\r\n');
          continue;
        }
        const cmd = line.slice(0, 4).toUpperCase();
        if (cmd === 'EHLO' || cmd === 'HELO') sock.write(`250-fake\r\n${opts.user ? '250-AUTH PLAIN LOGIN\r\n' : ''}250 OK\r\n`);
        else if (cmd === 'AUTH') {
          const [, kind, arg] = line.split(' ');
          if (kind.toUpperCase() === 'PLAIN') {
            const [, u, p] = Buffer.from(arg, 'base64').toString().split('\0');
            if (u === opts.user && p === opts.pass) { cur.auth = u; sock.write('235 ok\r\n'); } else sock.write('535 bad credentials\r\n');
          } else { mode = 'login-user'; sock.write('334 VXNlcm5hbWU6\r\n'); }
        } else if (cmd === 'MAIL') { cur.from = line; sock.write('250 ok\r\n'); }
        else if (cmd === 'RCPT') { cur.to.push(line); sock.write('250 ok\r\n'); }
        else if (cmd === 'DATA') { mode = 'data'; sock.write('354 go\r\n'); }
        else if (cmd === 'QUIT') { sock.end('221 bye\r\n'); }
        else sock.write('250 ok\r\n');
      }
    });
    sock.on('error', () => undefined);
  });
  return new Promise<{ port: number; messages: typeof messages; close: () => void }>((resolve) => {
    server.listen(opts.port ?? 0, '127.0.0.1', () => resolve({ port: (server.address() as net.AddressInfo).port, messages, close: () => server.close() }));
  });
}

/** Zabbix trapper sink: records each request and answers like a real server. */
export function fakeTrapper(opts: { hang?: boolean; port?: number } = {}) {
  const requests: { request: string; data: { host: string; key: string; value: string }[] }[] = [];
  const server = net.createServer((sock) => {
    let buf = Buffer.alloc(0);
    sock.on('data', (d: Buffer) => {
      buf = Buffer.concat([buf, d]);
      if (buf.length < 13) return;
      const len = Number(buf.readBigUInt64LE(5));
      if (buf.length < 13 + len) return;
      requests.push(JSON.parse(buf.subarray(13, 13 + len).toString()));
      if (opts.hang) return;
      const body = Buffer.from(JSON.stringify({ response: 'success', info: `processed: ${requests.at(-1)!.data.length}; failed: 0; total: ${requests.at(-1)!.data.length}` }));
      const h = Buffer.alloc(13);
      h.write('ZBXD', 0); h[4] = 1; h.writeBigUInt64LE(BigInt(body.length), 5);
      sock.end(Buffer.concat([h, body]));
    });
    sock.on('error', () => undefined);
  });
  return new Promise<{ port: number; requests: typeof requests; close: () => void }>((resolve) => {
    server.listen(opts.port ?? 0, '127.0.0.1', () => resolve({ port: (server.address() as net.AddressInfo).port, requests, close: () => server.close() }));
  });
}
