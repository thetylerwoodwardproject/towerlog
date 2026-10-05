import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseSame, encodeSame, demoHeader, Resampler22k, SameDecoder, type SameMessage } from '../src/engine/inputs/same.ts';
import { EasDetector } from '../src/engine/inputs/eas-tone.ts';
import { EasLog, chunkStart } from '../src/engine/eas-log.ts';
import { InputSchema } from '../src/engine/config.ts';
import { LogInput } from '../src/engine/inputs/input.ts';
import { FaultLog } from '../src/engine/inputs/faultlog.ts';
import { Engine } from '../src/engine/index.ts';
import { fakeSmtp, fakeTrapper, quietLogger, tmpdir } from './helpers.ts';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
// multimon-ng is found on PATH, or at MULTIMON_NG (the Pi-Tuner rig builds one).
const MULTIMON = process.env.MULTIMON_NG || 'multimon-ng';
const hasMultimon = spawnSync(MULTIMON, ['-h']).error === undefined;

describe('SAME headers', () => {
  it('parses event, areas, duration, issue time and sender', () => {
    const m = parseSame('EAS: ZCZC-WXR-TOR-029095-029165+0030-1051700-KEAX/NWS-', new Date('2026-04-15T12:00:00Z'))!;
    expect(m).toMatchObject({ originator: 'WXR', event: 'TOR', event_name: 'Tornado Warning', duration_min: 30, sender: 'KEAX/NWS' });
    expect(m.locations).toEqual([
      { code: '029095', part: 'all', state: 'MO', county: '095' },
      { code: '029165', part: 'all', state: 'MO', county: '165' },
    ]);
    expect(m.issued).toBe('2026-04-15T17:00:00.000Z');
  });
  it('handles statewide and partial-county codes, unknown events and garbage', () => {
    const m = parseSame('ZCZC-CIV-XYZ-148000-748123+0100-0011200-WXYZ/FM-')!;
    expect(m.locations[0]).toMatchObject({ part: 'NW', state: 'TX', county: '000' });
    expect(m.event_name).toContain('Unknown');
    expect(parseSame('garbage')).toBeNull();
  });
});

describe('decoder plumbing', () => {
  it('reports each repeated header once and EOM once', () => {
    const got: string[] = [];
    const d = new SameDecoder('multimon-ng', 22050, 1, quietLogger(), (m) => got.push(m.event), () => got.push('EOM'));
    const h = 'EAS: ' + demoHeader();
    d.onLine(h, 1000); d.onLine(h, 2000); d.onLine(h, 3000);
    d.onLine('EAS: NNNN', 9000); d.onLine('EAS: NNNN', 10000);
    expect(got).toEqual(['RWT', 'EOM']);
  });
  it('encodes and resamples 48 kHz stereo to 22050 Hz mono', () => {
    const mono = encodeSame(demoHeader(), 48000, { toneSecs: 1 });
    const stereo = new Int16Array(mono.length * 2);
    mono.forEach((v, i) => { stereo[i * 2] = v; stereo[i * 2 + 1] = v; });
    const out = new Resampler22k(48000, 2).process(stereo);
    expect(Math.abs(out.length / 2 - (mono.length * 22050) / 48000)).toBeLessThan(3);
  });
});

describe('attention tone', () => {
  const tone = (secs: number, rate = 48000, ch = 2) => {
    const pcm = new Int16Array(secs * rate * ch);
    for (let i = 0; i < secs * rate; i++) {
      const v = 0.25 * 32767 * (Math.sin((2 * Math.PI * 853 * i) / rate) + Math.sin((2 * Math.PI * 960 * i) / rate));
      for (let c = 0; c < ch; c++) pcm[i * ch + c] = v;
    }
    return pcm;
  };
  it('fires once for a long tone and clears after the hold time', () => {
    let t = 0;
    const log: string[] = [];
    const d = new EasDetector(48000, 2, () => log.push('tone'), () => log.push('clear'), () => t);
    const one = tone(1);
    for (let s = 0; s < 14; s++) { t = s; d.push(one); }
    expect(log).toEqual(['tone', 'clear']);
    expect(d.active).toBe(false);
  });
  it('ignores music-like audio and a 440 Hz tone', () => {
    const log: string[] = [];
    const d = new EasDetector(48000, 2, () => log.push('tone'), () => log.push('clear'));
    const a = new Int16Array(48000 * 2 * 3);
    for (let i = 0; i < 48000 * 3; i++) a[i * 2] = a[i * 2 + 1] = 12000 * Math.sin((2 * Math.PI * 440 * i) / 48000);
    d.push(a);
    expect(log).toEqual([]);
  });
  it('finish() ends an active tone so the alarm is not stuck when the feed drops', () => {
    const log: string[] = [];
    const d = new EasDetector(48000, 2, () => log.push('tone'), () => log.push('clear'));
    d.push(tone(1));
    expect(d.active).toBe(true);
    d.finish();
    expect(log).toEqual(['tone', 'clear']);
  });
});

describe('EAS log', () => {
  const base = { input: 'studio-a', input_name: 'Studio A', chunk_start: 0, chunk_minutes: 0 };
  it('stores messages, marks EOM and survives a reload', () => {
    const dir = tmpdir();
    const log = new EasLog(dir);
    log.add({ kind: 'message', ...parseSame(demoHeader())!, ...base });
    expect(log.endOfMessage('studio-a')?.eom).toBeTruthy();
    expect(log.endOfMessage('studio-a')).toBeNull();
    const again = new EasLog(dir).list();
    expect(again).toHaveLength(1);
    expect(again[0].eom).toBeTruthy();
  });
  it('hides a tone that belongs to a decoded header, keeps a bare one, and filters by input', () => {
    const log = new EasLog(tmpdir());
    log.add({ kind: 'message', ...parseSame(demoHeader())!, ...base });
    log.add({ kind: 'tone', ...base });
    log.add({ kind: 'tone', input: 'b', input_name: 'B', chunk_start: 0, chunk_minutes: 0 });
    expect(log.list().map((e) => `${e.input}:${e.kind}`).sort()).toEqual(['b:tone', 'studio-a:message']);
    expect(log.list({ input: 'studio-a' })).toHaveLength(1);
  });
  it('finds the clock-cut chunk that holds a moment', () => {
    const t = Date.UTC(2026, 9, 5, 9, 47, 12) / 1000;
    expect(chunkStart(t, 15)).toBe(Date.UTC(2026, 9, 5, 9, 45) / 1000);
    expect(chunkStart(t, 60)).toBe(Date.UTC(2026, 9, 5, 9) / 1000);
  });
});

describe('EAS in the engine', () => {
  beforeAll(() => { process.env.TOWERLOG_LEGACY_DIR = path.join(tmpdir(), 'none'); });
  const mk = () => {
    const d = tmpdir();
    return new Engine({ config: path.join(d, 'config.json'), data: path.join(d, 'data'), logs: path.join(d, 'logs') });
  };
  // The engine's handlers only read the input's config.
  const fake = (o: Record<string, unknown> = {}) => ({ cfg: InputSchema.parse({ id: 'studio-a', name: 'Studio A', kind: 'http', url: 'http://x/y', ...o }) }) as unknown as LogInput;
  /** Config saved before start() is not applied to the services yet. */
  const apply = (e: Engine) => (e as unknown as { applyServices(c: unknown): void }).applyServices(e.config);
  type Hooks = { onEasTone(i: LogInput, a: boolean): void; onSame(i: LogInput, m: SameMessage | null): void };

  it('logs, emails and reports a tone and the decoded message', async () => {
    const smtp = await fakeSmtp();
    const e = mk();
    e.store.save({ ...e.config, smtp: { ...e.config.smtp, enabled: true, host: '127.0.0.1', port: smtp.port, security: 'none', to: 'ops@example.com', from: 'tl@example.com' } });
    apply(e);
    const h = e as unknown as Hooks;
    const inp = fake();
    // On air the header comes first, then the tone, then the end-of-message burst.
    h.onSame(inp, parseSame(demoHeader())!);
    h.onEasTone(inp, true);
    h.onSame(inp, null);
    const list = e.easLog.list();
    expect(list.map((x) => x.kind)).toEqual(['message']); // the tone came with the header
    expect(list[0]).toMatchObject({ event: 'RWT', input: 'studio-a', input_name: 'Studio A' });
    expect(list[0].eom).toBeTruthy();
    expect(list[0].chunk_start).toBeGreaterThan(0);
    expect(e.snapshot().eas.last).toContain('Required Weekly Test');
    for (let i = 0; i < 30 && smtp.messages.length < 2; i++) await sleep(100);
    const subjects = smtp.messages.map((m) => m.data.match(/^Subject: (.*)$/m)?.[1] ?? '').join('|');
    expect(subjects).toMatch(/EAS attention tone heard on Studio A/);
    expect(subjects).toMatch(/EAS Required Weekly Test heard on Studio A/);
    smtp.close();
  });

  it('does not email when EAS alerts are off, and records no chunk for an input that is not recording', () => {
    const e = mk();
    e.store.save({ ...e.config, smtp: { ...e.config.smtp, alert_eas: false } });
    apply(e);
    (e as unknown as Hooks).onSame(fake({ record: false }), parseSame(demoHeader())!);
    expect(e.easLog.list()[0].chunk_start).toBe(0);
  });

  it('pushes the EAS items to Zabbix', async () => {
    const zbx = await fakeTrapper();
    const e = mk();
    e.store.save({ ...e.config, zabbix: { ...e.config.zabbix, enabled: true, server: '127.0.0.1', port: zbx.port, hostname: 'tl' } });
    apply(e);
    const h = e as unknown as Hooks;
    h.onSame(fake(), parseSame(demoHeader())!);
    h.onEasTone(fake(), true);
    for (let i = 0; i < 30 && zbx.requests.length < 2; i++) await sleep(100);
    const keys = zbx.requests.flatMap((r) => r.data.map((d) => d.key));
    expect(keys).toEqual(expect.arrayContaining(['towerlog.eas', 'towerlog.input.eas[studio-a]', 'towerlog.event', 'towerlog.input.eas.message[studio-a]']));
    zbx.close();
  });
});

/** An HTTP feed that streams a complete SAME transmission (header x3, tone, EOM x3) as live MP3, once. */
function samePcmFeed(dir: string) {
  const alert = encodeSame(demoHeader(), 48000, { toneSecs: 4 });
  // Quiet lead-in so the input is live before the alert starts, and quiet after it.
  const mono = new Int16Array(48000 * 3 + alert.length + 48000 * 40);
  mono.set(alert, 48000 * 3);
  const raw = path.join(dir, 'same.raw');
  fs.writeFileSync(raw, Buffer.from(mono.buffer, mono.byteOffset, mono.byteLength));
  const kids = new Set<ChildProcess>();
  const state = { requests: 0 };
  const srv = http.createServer((_req, res) => {
    state.requests++;
    res.writeHead(200, { 'Content-Type': 'audio/mpeg' });
    const ff = spawn('ffmpeg', ['-loglevel', 'error', '-re', '-f', 's16le', '-ar', '48000', '-ac', '1', '-i', raw, '-ac', '2', '-c:a', 'libmp3lame', '-b:a', '128k', '-f', 'mp3', '-'], { stdio: ['ignore', 'pipe', 'ignore'] });
    kids.add(ff);
    ff.stdout.pipe(res);
    res.on('close', () => ff.kill());
  });
  return new Promise<{ url: string; state: { requests: number }; close: () => Promise<void> }>((resolve) =>
    srv.listen(0, '127.0.0.1', () => resolve({
      url: `http://127.0.0.1:${(srv.address() as { port: number }).port}/live`,
      state,
      close: () => new Promise((r) => { kids.forEach((k) => k.kill()); srv.closeAllConnections(); srv.close(() => r()); }),
    })));
}

describe.skipIf(!hasFfmpeg || !hasMultimon)('LogInput hears an EAS alert on a live feed', () => {
  const cleanup: (() => Promise<void> | void)[] = [];
  afterEach(async () => { for (const c of cleanup.splice(0)) await c(); });

  it('detects the tone, decodes the header once and sees the end of message', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'towerlog-eas-'));
    const feed = await samePcmFeed(dir);
    const events: string[] = [];
    const msgs: SameMessage[] = [];
    const cfg = InputSchema.parse({ id: 'a', name: 'Air', kind: 'http', url: feed.url, record: false });
    const input = new LogInput(cfg, {
      recordRoot: path.join(dir, 'rec'), workDir: path.join(dir, 'work'), log: quietLogger(), faults: new FaultLog(dir),
      multimonBin: MULTIMON,
      onEasTone: (_i, active) => events.push(active ? 'tone' : 'clear'),
      onSame: (_i, m) => { if (m) { msgs.push(m); events.push('header'); } else events.push('eom'); },
    });
    cleanup.push(() => input.stop(), feed.close, () => fs.rmSync(dir, { recursive: true, force: true }));
    input.start();
    for (let i = 0; i < 38; i++) { await sleep(1000); input.tick(Date.now() / 1000); }
    expect(feed.state.requests).toBe(1);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toMatchObject({ event: 'RWT', sender: 'KEAX/NWS' });
    expect(events).toContain('tone');
    expect(events).toContain('eom');
    expect(events.indexOf('header')).toBeLessThan(events.indexOf('tone'));
  }, 60000);

  it('does nothing when EAS detection is off for the input', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'towerlog-eas-'));
    const feed = await samePcmFeed(dir);
    const events: string[] = [];
    const cfg = InputSchema.parse({ id: 'a', name: 'Air', kind: 'http', url: feed.url, record: false, detect_eas: false });
    const input = new LogInput(cfg, {
      recordRoot: path.join(dir, 'rec'), workDir: path.join(dir, 'work'), log: quietLogger(), faults: new FaultLog(dir), multimonBin: MULTIMON,
      onEasTone: () => events.push('tone'), onSame: () => events.push('same'),
    });
    cleanup.push(() => input.stop(), feed.close, () => fs.rmSync(dir, { recursive: true, force: true }));
    input.start();
    for (let i = 0; i < 24; i++) { await sleep(1000); input.tick(Date.now() / 1000); }
    expect(events).toEqual([]);
  }, 60000);
});
