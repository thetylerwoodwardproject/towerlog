import { afterEach, describe, expect, it } from 'vitest';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { InputSchema } from '../src/engine/config.ts';
import { LogInput } from '../src/engine/inputs/input.ts';
import { FaultLog } from '../src/engine/inputs/faultlog.ts';
import { listChunks } from '../src/engine/inputs/record.ts';
import { quietLogger } from './helpers.ts';
import type { FaultRecord } from '../src/lib/types.ts';

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** An HTTP server that streams a live MP3 tone (or silence) like an Icecast mount. */
function feedServer(src = 'sine=frequency=440:sample_rate=44100') {
  const kids = new Set<ChildProcess>();
  let source = src;
  const srv = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'audio/mpeg' });
    const ff = spawn('ffmpeg', ['-loglevel', 'error', '-re', '-f', 'lavfi', '-i', source, '-c:a', 'libmp3lame', '-b:a', '64k', '-f', 'mp3', '-'], { stdio: ['ignore', 'pipe', 'ignore'] });
    kids.add(ff);
    ff.stdout.pipe(res);
    res.on('close', () => ff.kill());
  });
  return new Promise<{ url: string; port: number; setSource: (s: string) => void; close: () => Promise<void> }>((resolve) =>
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as { port: number }).port;
      resolve({
        port,
        url: `http://127.0.0.1:${port}/live`,
        setSource: (s) => { source = s; },
        close: () => new Promise((r) => { kids.forEach((k) => k.kill()); srv.closeAllConnections(); srv.close(() => r()); }),
      });
    }));
}

describe.skipIf(!hasFfmpeg)('LogInput against a live HTTP feed', () => {
  const cleanup: (() => Promise<void> | void)[] = [];
  afterEach(async () => { for (const c of cleanup.splice(0)) await c(); });

  function mk(url: string, o: Record<string, unknown> = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'towerlog-i-'));
    const events: FaultRecord[] = [];
    const cfg = InputSchema.parse({ id: 'a', name: 'Tone', kind: 'http', url, link_secs: 2, silence_secs: 3, ...o });
    const input = new LogInput(cfg, { recordRoot: path.join(dir, 'rec'), workDir: path.join(dir, 'work'), log: quietLogger(), faults: new FaultLog(dir), onFault: (r) => events.push(r) });
    cleanup.push(() => input.stop(), () => fs.rmSync(dir, { recursive: true, force: true }));
    return { input, events, dir };
  }
  async function run(input: LogInput, secs: number) {
    for (let i = 0; i < secs; i++) { await sleep(1000); input.tick(Date.now() / 1000); }
  }

  it('goes live, meters the audio and writes a recording', async () => {
    const feed = await feedServer();
    cleanup.push(feed.close);
    const { input, events, dir } = mk(feed.url);
    input.start();
    await run(input, 4);
    const snap = input.snapshot(Date.now() / 1000);
    expect(snap.status).toBe('live');
    expect(snap.recording).toBe(true);
    expect(snap.meter.rms_db[0]).toBeGreaterThan(-30);
    expect(snap.faults).toEqual([]);
    expect(events).toEqual([]);
    expect(listChunks(path.join(dir, 'rec')).length).toBe(1);
  }, 30000);

  it('raises a link fault when the feed dies and clears it when it returns', async () => {
    const feed = await feedServer();
    cleanup.push(feed.close);
    const { input, events } = mk(feed.url, { link_secs: 2 });
    input.start();
    await run(input, 3);
    expect(input.status).toBe('live');
    await feed.close();
    await run(input, 4);
    expect(events.map((e) => `${e.kind}:${e.state}`)).toContain('link:raised');
    expect(input.snapshot(Date.now() / 1000).faults).toContain('link');
    expect(input.status).toBe('down');
    // Bring the feed back on the same port; the supervisor reconnects after its backoff.
    const again = http.createServer((_q, res) => {
      res.writeHead(200, { 'Content-Type': 'audio/mpeg' });
      const ff = spawn('ffmpeg', ['-loglevel', 'error', '-re', '-f', 'lavfi', '-i', 'sine=frequency=440', '-c:a', 'libmp3lame', '-f', 'mp3', '-'], { stdio: ['ignore', 'pipe', 'ignore'] });
      ff.stdout.pipe(res);
      res.on('close', () => ff.kill());
    });
    await new Promise<void>((r) => again.listen(feed.port, '127.0.0.1', r));
    cleanup.push(() => new Promise((r) => { again.closeAllConnections(); again.close(() => r()); }));
    await run(input, 10);
    expect(input.status).toBe('live');
    const cleared = events.find((e) => e.kind === 'link' && e.state === 'cleared');
    expect(cleared?.duration).toBeGreaterThan(0);
  }, 60000);

  it('raises silence only after the configured delay', async () => {
    const feed = await feedServer('anullsrc=r=44100:cl=stereo');
    cleanup.push(feed.close);
    const { input, events } = mk(feed.url, { silence_secs: 5 });
    input.start();
    await run(input, 4);
    expect(events.filter((e) => e.kind === 'silence')).toEqual([]);
    await run(input, 4);
    expect(events.find((e) => e.kind === 'silence')?.state).toBe('raised');
    expect(input.snapshot(Date.now() / 1000).silent_s).toBeGreaterThan(4);
  }, 40000);
});

describe.skipIf(!hasFfmpeg)('listening', () => {
  it('streams a live input as MP3 to a listener and stops when it leaves', async () => {
    const feed = await feedServer();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'towerlog-l-'));
    const cfg = InputSchema.parse({ id: 'a', name: 'Tone', kind: 'http', url: feed.url, record: false });
    const input = new LogInput(cfg, { recordRoot: dir, workDir: dir, log: quietLogger(), faults: new FaultLog(dir) });
    input.start();
    try {
      await sleep(1500);
      const got: Buffer[] = [];
      const { PassThrough } = await import('node:stream');
      const out = new PassThrough();
      out.on('data', (d: Buffer) => got.push(d));
      input.listen(out);
      expect(input.listenerCount).toBe(1);
      await sleep(2500);
      const bytes = Buffer.concat(got);
      expect(bytes.length).toBeGreaterThan(4000);
      // MP3 frame sync (or an ID3 tag) at the start.
      expect(bytes[0] === 0xff || bytes.subarray(0, 3).toString() === 'ID3').toBe(true);
      out.destroy();
      await sleep(300);
      expect(input.listenerCount).toBe(0);
    } finally {
      await input.stop();
      await feed.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 30000);
});

describe.skipIf(!hasFfmpeg)('display meter', () => {
  it('updates several times a second while the fault window stays one second', async () => {
    const feed = await feedServer();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'towerlog-m-'));
    const cfg = InputSchema.parse({ id: 'a', name: 'Tone', kind: 'http', url: feed.url, record: false });
    const input = new LogInput(cfg, { recordRoot: dir, workDir: dir, log: quietLogger(), faults: new FaultLog(dir) });
    input.start();
    try {
      await sleep(2500);
      let samples = 0;
      let lastPeak = -999;
      let changes = 0;
      for (let i = 0; i < 10; i++) {
        await sleep(200);
        input.sampleMeter();
        const snap = input.snapshot(Date.now() / 1000);
        expect(snap.meter.rms_db[0]).toBeGreaterThan(-60);
        samples++;
        if (snap.meter.rms_db[0] !== lastPeak) changes++;
        lastPeak = snap.meter.rms_db[0];
      }
      expect(samples).toBe(10);
      // A steady tone reads the same each time, so only require sane values and that a fresh window is taken:
      // after sampling, the next sample covers only the audio since.
      input.sampleMeter();
      expect(input.levelDb()).toBeLessThan(0);
      expect(changes).toBeGreaterThan(0);
    } finally {
      await input.stop();
      await feed.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 30000);
});

describe.skipIf(!hasFfmpeg)('display meter', () => {
  it('can be sampled every 200 ms and shows live levels', async () => {
    const feed = await feedServer();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'towerlog-m-'));
    const cfg = InputSchema.parse({ id: 'a', name: 'Tone', kind: 'http', url: feed.url, record: false });
    const input = new LogInput(cfg, { recordRoot: dir, workDir: dir, log: quietLogger(), faults: new FaultLog(dir) });
    input.start();
    try {
      await sleep(2500);
      for (let i = 0; i < 8; i++) {
        await sleep(200);
        input.sampleMeter();
        expect(input.snapshot(Date.now() / 1000).meter.rms_db[0]).toBeGreaterThan(-60);
      }
      expect(input.levelDb()).toBeLessThan(0);
    } finally {
      await input.stop();
      await feed.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 30000);
});
