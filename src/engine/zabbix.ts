// Zabbix trapper client (zabbix_sender protocol over TCP 10051). Fire-and-forget:
// sends are queued and serialised, failures are logged and never block recording.
import net from 'node:net';
import os from 'node:os';
import type { ZabbixConfig } from './config.ts';
import type { Logger } from './logger.ts';

export type Item = [key: string, value: string | number];

/** Per logged input. `fault.<kind>` items are 1 while that fault is raised. One source for the sender and the template. */
export const INPUT_METRICS: Record<string, [kind: 'char' | 'text' | 'uint' | 'float', desc: string]> = {
  state: ['char', 'Input state: live, connecting, down or stopped'],
  up: ['uint', '1 while the feed is delivering audio, otherwise 0'],
  name: ['char', 'Input name'],
  kind: ['char', 'http, rtp, livewire or push'],
  recording: ['uint', '1 while the input is recording to disk'],
  level: ['float', 'Audio level in dBFS (RMS) of the loudest channel'],
  'fault.link': ['uint', '1 while the feed is lost'],
  'fault.silence': ['uint', '1 while the feed is silent (dead air)'],
  'fault.clip': ['uint', '1 while the audio is clipping'],
  'fault.mono': ['uint', '1 while left and right are identical'],
  'fault.phase': ['uint', '1 while left and right are out of phase'],
};

export const KEY_INPUT_DISCOVERY = 'towerlog.inputs.discovery';
export const inputKey = (metric: string, id: string) => `towerlog.input.${metric}[${id}]`;

export function encodePacket(host: string, items: Item[]): Buffer {
  const payload = Buffer.from(JSON.stringify({
    request: 'sender data',
    data: items.map(([key, value]) => ({ host, key, value: String(value) })),
  }), 'utf8');
  const header = Buffer.alloc(13);
  header.write('ZBXD', 0, 'ascii');
  header[4] = 1;
  header.writeBigUInt64LE(BigInt(payload.length), 5);
  return Buffer.concat([header, payload]);
}

export function decodeResponse(buf: Buffer): Record<string, unknown> | null {
  if (buf.length < 13 || buf.toString('ascii', 0, 4) !== 'ZBXD') return null;
  const len = Number(buf.readBigUInt64LE(5));
  try {
    return JSON.parse(buf.subarray(13, 13 + len).toString('utf8'));
  } catch {
    return null;
  }
}

export class ZabbixSender {
  readonly hostname: string;
  lastOk: number | null = null;
  lastError = '';
  lastErrorAt: number | null = null;
  private queue: { items: Item[]; resolve: (r: string) => void }[] = [];
  private busy = false;

  constructor(readonly conf: ZabbixConfig, private log: Logger) {
    this.hostname = conf.hostname || os.hostname();
  }

  get enabled() { return this.conf.enabled && !!this.conf.server; }

  /** Queue a send. Resolves with the server's info string ('' if disabled/failed). */
  send(items: Item[], mirror = false): Promise<string> {
    if (mirror) this.log.file('zabbix.log', JSON.stringify(Object.fromEntries(items)));
    if (!this.enabled || !items.length) return Promise.resolve('');
    if (this.queue.length >= 200) return Promise.resolve('');
    return new Promise((resolve) => {
      this.queue.push({ items, resolve });
      void this.pump();
    });
  }

  event(message: string) {
    return this.send([[this.conf.key_event, message]], true);
  }

  private async pump() {
    if (this.busy) return;
    this.busy = true;
    try {
      while (this.queue.length) {
        const job = this.queue.shift()!;
        try {
          const info = await this.deliver(job.items);
          this.lastOk = Date.now();
          job.resolve(info);
        } catch (e) {
          const msg = (e as Error).message;
          if (msg !== this.lastError) this.log.warn(`zabbix send failed: ${msg}`);
          this.lastError = msg;
          this.lastErrorAt = Date.now();
          job.resolve('');
        }
      }
    } finally {
      this.busy = false;
    }
  }

  /** Send now and return the server's response info; throws on network errors. */
  deliver(items: Item[]): Promise<string> {
    const packet = encodePacket(this.hostname, items);
    return new Promise((resolve, reject) => {
      const sock = net.createConnection({ host: this.conf.server, port: this.conf.port });
      const chunks: Buffer[] = [];
      let done = false;
      const finish = (err: Error | null, info = '') => {
        if (done) return;
        done = true;
        sock.destroy();
        if (err) reject(err);
        else resolve(info);
      };
      sock.setTimeout(5000, () => finish(new Error(`timeout talking to ${this.conf.server}:${this.conf.port}`)));
      sock.on('connect', () => sock.write(packet));
      sock.on('data', (d: Buffer) => {
        chunks.push(d);
        const buf = Buffer.concat(chunks);
        if (buf.length >= 13) {
          const len = Number(buf.readBigUInt64LE(5));
          if (buf.length >= 13 + len) {
            const resp = decodeResponse(buf);
            const info = typeof resp?.info === 'string' ? resp.info : '';
            if (resp && resp.response !== 'success') finish(new Error(`server replied: ${JSON.stringify(resp)}`));
            else finish(null, info);
          }
        }
      });
      sock.on('end', () => finish(null, ''));
      sock.on('error', (e) => finish(e));
    });
  }
}
