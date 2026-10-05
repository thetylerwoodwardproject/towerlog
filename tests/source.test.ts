import { afterEach, describe, expect, it } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { InputSchema } from '../src/engine/config.ts';
import { LogInput } from '../src/engine/inputs/input.ts';
import { FaultLog } from '../src/engine/inputs/faultlog.ts';
import { listChunks } from '../src/engine/inputs/record.ts';
import { createSourceServer } from '../server/source.ts';
import { quietLogger } from './helpers.ts';

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe.skipIf(!hasFfmpeg)('Icecast source endpoint', () => {
  const cleanup: (() => Promise<void> | void)[] = [];
  afterEach(async () => { for (const c of cleanup.splice(0)) await c(); });

  async function setup() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'towerlog-s-'));
    const cfg = InputSchema.parse({ id: 'pt', name: 'Pi Tuner 1', kind: 'push', mount: '/fm1', source_password: 'sekret' });
    const input = new LogInput(cfg, { recordRoot: path.join(dir, 'rec'), workDir: path.join(dir, 'work'), log: quietLogger(), faults: new FaultLog(dir) });
    input.start();
    const srv = createSourceServer({ find: (m) => (m === '/fm1' ? input : undefined), log: quietLogger() });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    const port = (srv.address() as net.AddressInfo).port;
    cleanup.push(() => input.stop(), () => new Promise<void>((r) => { srv.close(() => r()); (srv as unknown as { closeAllConnections?: () => void }).closeAllConnections?.(); }), () => fs.rmSync(dir, { recursive: true, force: true }));
    return { input, port, dir };
  }
  const head = (method: string, p: string, auth?: string) =>
    `${method} ${p} HTTP/1.0\r\n${auth ? `Authorization: Basic ${Buffer.from(auth).toString('base64')}\r\n` : ''}\r\n`;
  function raw(port: number, text: string): Promise<string> {
    return new Promise((resolve) => {
      const s = net.connect(port, '127.0.0.1', () => s.write(text));
      let out = '';
      s.on('data', (d) => { out += d; });
      s.on('close', () => resolve(out));
      s.on('error', () => resolve(out));
    });
  }

  it('rejects a wrong password, an unknown mount and other methods', async () => {
    const { port, input } = await setup();
    expect(await raw(port, head('SOURCE', '/fm1', 'source:nope'))).toMatch(/^HTTP\/1.0 401/);
    expect(await raw(port, head('SOURCE', '/fm1'))).toMatch(/^HTTP\/1.0 401/);
    expect(await raw(port, head('SOURCE', '/other', 'source:sekret'))).toMatch(/^HTTP\/1.0 404/);
    expect(await raw(port, head('DELETE', '/fm1', 'source:sekret'))).toMatch(/^HTTP\/1.0 404/);
    expect(input.status).toBe('down');
  });

  it('answers metadata updates with the right password only', async () => {
    const { port } = await setup();
    expect(await raw(port, head('GET', '/admin/metadata?mode=updinfo&mount=/fm1&song=x', 'admin:sekret'))).toMatch(/200 OK[\s\S]*successful/);
    expect(await raw(port, head('GET', '/admin/metadata?mode=updinfo&mount=/fm1&song=x', 'admin:bad'))).toMatch(/^HTTP\/1.0 401/);
  });

  it('takes a real ffmpeg Icecast source and logs it', async () => {
    const { port, input, dir } = await setup();
    const ff = spawn('ffmpeg', ['-loglevel', 'error', '-re', '-f', 'lavfi', '-t', '8', '-i', 'sine=frequency=440:sample_rate=44100',
      '-c:a', 'libmp3lame', '-b:a', '64k', '-f', 'mp3', '-content_type', 'audio/mpeg', '-password', 'sekret', `icecast://127.0.0.1:${port}/fm1`], { stdio: 'ignore' });
    cleanup.push(() => { ff.kill(); });
    for (let i = 0; i < 5; i++) { await sleep(1000); input.tick(Date.now() / 1000); }
    const snap = input.snapshot(Date.now() / 1000);
    expect(snap.status).toBe('live');
    expect(snap.meter.rms_db[0]).toBeGreaterThan(-30);
    expect(listChunks(path.join(dir, 'rec')).length).toBe(1);
    // Source goes away: the input drops and waits for it to come back.
    ff.kill();
    await sleep(1500);
    expect(input.status).toBe('down');
    expect(input.isRunning).toBe(true);
  }, 40000);
});
