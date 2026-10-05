import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { InputSchema } from '../src/engine/config.ts';
import { ensureDayDirs, ffmpegArgs } from '../src/engine/inputs/record.ts';
import type { Source } from '../src/engine/inputs/args.ts';

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;

function files(dir: string): string[] {
  return fs.readdirSync(dir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => e.name).sort();
}

describe.skipIf(!hasFfmpeg)('real ffmpeg', () => {
  it('cuts files on the wall clock and into dated folders', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'towerlog-'));
    const cfg = InputSchema.parse({ id: 'a', name: 'Tone', kind: 'http', url: 'http://x/y', chunk_minutes: 15 });
    const src: Source = {
      args: ['-re', '-f', 'lavfi', '-t', '7', '-i', 'sine=frequency=440:sample_rate=44100'],
      sdp: null,
      stdin: false,
      record: { codec: 'flac', ext: 'flac', format: 'flac' },
    };
    // Same arguments the app uses, with the chunk shortened to 2 s and seconds in the name.
    const a = ffmpegArgs(cfg, src, root).map((x) => x.replace('%H%M.flac', '%H%M%S.flac'));
    a[a.indexOf('-segment_time') + 1] = '2';
    ensureDayDirs(root, 'Tone', Date.now() / 1000);
    const r = spawnSync('ffmpeg', ['-y', ...a], { maxBuffer: 1 << 28 });
    expect(r.status).toBe(0);
    expect(r.stdout.length).toBeGreaterThan(48000 * 4 * 5); // about 7 s of 48 kHz stereo s16 on pipe:1
    const names = files(path.join(root, 'Tone'));
    expect(names.length).toBeGreaterThanOrEqual(3);
    const secs = names.map((n) => Number(/(\d{2})\.flac$/.exec(n)![1]));
    // Every file after the first starts on an even second: the cut is on the clock.
    for (const s of secs.slice(1)) expect(s % 2).toBe(0);
    fs.rmSync(root, { recursive: true });
  }, 30000);
});
