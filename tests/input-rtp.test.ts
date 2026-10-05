import { afterEach, describe, expect, it } from 'vitest';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { InputSchema } from '../src/engine/config.ts';
import { LogInput } from '../src/engine/inputs/input.ts';
import { FaultLog } from '../src/engine/inputs/faultlog.ts';
import { listChunks } from '../src/engine/inputs/record.ts';
import { quietLogger } from './helpers.ts';

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe.skipIf(!hasFfmpeg)('RTP and Livewire inputs', () => {
  const cleanup: (() => Promise<void> | void)[] = [];
  afterEach(async () => { for (const c of cleanup.splice(0)) await c(); });

  /** Send a 500 Hz L24 stereo tone as RTP (the Livewire payload format) to `url`. */
  function sender(url: string, extra: string[] = []): ChildProcess {
    const ff = spawn('ffmpeg', ['-loglevel', 'error', '-re', '-f', 'lavfi', '-i', 'sine=frequency=500:sample_rate=48000', '-ac', '2',
      '-c:a', 'pcm_s24be', '-payload_type', '97', '-f', 'rtp', ...extra, url], { stdio: 'ignore' });
    cleanup.push(() => { ff.kill('SIGKILL'); });
    return ff;
  }

  async function run(cfgExtra: Record<string, unknown>, send: () => ChildProcess) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'towerlog-rtp-'));
    fs.mkdirSync(path.join(dir, 'rec'));
    const cfg = InputSchema.parse({ id: 'r', name: 'RTP Test', ...cfgExtra });
    const input = new LogInput(cfg, { recordRoot: path.join(dir, 'rec'), workDir: path.join(dir, 'work'), log: quietLogger(), faults: new FaultLog(dir) });
    cleanup.push(() => input.stop(), () => fs.rmSync(dir, { recursive: true, force: true }));
    input.start();
    await sleep(800); // the receiver is up before the sender starts
    send();
    for (let i = 0; i < 5; i++) { await sleep(1000); input.tick(Date.now() / 1000); }
    return { input, dir };
  }

  it('receives unicast L24 RTP, meters it and records FLAC', async () => {
    const { input, dir } = await run({ kind: 'rtp', address: '127.0.0.1', port: 26000, rtp_codec: 'l24', rtp_payload: 97, rtp_rate: 48000, channels: 2 },
      () => sender('rtp://127.0.0.1:26000?pkt_size=1200'));
    const snap = input.snapshot(Date.now() / 1000);
    expect(snap.status).toBe('live');
    expect(snap.meter.rms_db[0]).toBeGreaterThan(-30);
    expect(snap.meter.rms_db[0]).toBeLessThan(-15);
    const files = listChunks(path.join(dir, 'rec'));
    expect(files).toHaveLength(1);
    expect(files[0].path.endsWith('.flac')).toBe(true);
  }, 30000);

  // Multicast over loopback needs the lo interface to carry multicast; skip where it does not.
  // Set TL_MC_ADDR to a local interface address (e.g. eth0's) to run it anyway.
  const loMulticast = /MULTICAST/.test(spawnSync('ip', ['link', 'show', 'lo']).stdout?.toString() ?? '') || !!process.env.TL_MC_ADDR;
  it.skipIf(!loMulticast)('joins the multicast group of a Livewire channel', async () => {
    const { input } = await run({ kind: 'livewire', livewire_channel: 5 },
      () => sender(`rtp://239.192.0.5:5004?ttl=1&localaddr=${process.env.TL_MC_ADDR ?? '127.0.0.1'}&pkt_size=1200`));
    const snap = input.snapshot(Date.now() / 1000);
    expect(snap.status).toBe('live');
    expect(snap.meter.rms_db[0]).toBeGreaterThan(-30);
  }, 30000);
});
