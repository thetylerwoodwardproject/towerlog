import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LevelStats, isClipping, isOutOfPhase, isSilent } from '../src/engine/inputs/detect.ts';
import { FaultLog } from '../src/engine/inputs/faultlog.ts';
import { InputSchema, SILENCE_PRESETS } from '../src/engine/config.ts';

function tone(frames: number, f: (i: number) => [number, number]): Int16Array {
  const a = new Int16Array(frames * 2);
  for (let i = 0; i < frames; i++) { const [l, r] = f(i); a[2 * i] = l; a[2 * i + 1] = r; }
  return a;
}
const sine = (amp: number, ph = 1) => (i: number): [number, number] => {
  const v = Math.sin((2 * Math.PI * 440 * i) / 48000) * amp;
  return [v, v * ph];
};

describe('detectors', () => {
  it('reads levels in dBFS', () => {
    const s = new LevelStats();
    s.push(tone(48000, sine(16384)));
    const r = s.take();
    expect(r.peak_db[0]).toBeCloseTo(-6, 0);
    expect(r.rms_db[0]).toBeCloseTo(-9, 0);
    expect(isSilent(r, -50)).toBe(false);
    expect(isClipping(r)).toBe(false);
    expect(r.identical).toBe(true);
  });
  it('digital silence and quiet hiss are silent at -50 dB', () => {
    const s = new LevelStats();
    s.push(tone(48000, () => [0, 0]));
    expect(isSilent(s.take(), -50)).toBe(true);
    s.push(tone(48000, (i) => [(i % 7) - 3, (i % 5) - 2]));
    expect(isSilent(s.take(), -50)).toBe(true);
  });
  it('a take resets the window', () => {
    const s = new LevelStats();
    s.push(tone(1000, sine(30000)));
    s.take();
    expect(s.take().frames).toBe(0);
  });
  it('flags clipping only with enough full-scale samples', () => {
    const s = new LevelStats();
    s.push(tone(48000, (i) => (i % 10 === 0 ? [32767, -32768] : [1000, 1000])));
    expect(isClipping(s.take())).toBe(true);
    s.push(tone(48000, (i) => (i === 5 ? [32767, 0] : [1000, 1000])));
    expect(isClipping(s.take())).toBe(false);
  });
  it('flags inverted channels but not normal stereo', () => {
    const s = new LevelStats();
    s.push(tone(48000, sine(10000, -1)));
    const r = s.take();
    expect(isOutOfPhase(r)).toBe(true);
    expect(r.identical).toBe(false);
    s.push(tone(48000, (i) => [Math.sin(i / 7) * 9000, Math.sin(i / 11) * 9000]));
    expect(isOutOfPhase(s.take())).toBe(false);
  });
  it('one dead channel is not reported as mono or phase', () => {
    const s = new LevelStats();
    s.push(tone(48000, (i) => [Math.sin(i / 7) * 9000, 0]));
    const r = s.take();
    expect(r.identical).toBe(false);
    expect(r.corr).toBeNull();
  });
});

describe('silence presets', () => {
  it('every preset is accepted, plus custom values in range', () => {
    for (const secs of [...SILENCE_PRESETS, 45, 3600]) {
      expect(InputSchema.parse({ id: 'a', name: 'A', kind: 'http', url: 'http://x/y', silence_secs: secs }).silence_secs).toBe(secs);
    }
    expect(SILENCE_PRESETS).toEqual([5, 10, 30, 60, 120, 300, 600]);
  });
});

describe('fault log', () => {
  it('appends, reads newest first, filters by input', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'towerlog-f-'));
    const log = new FaultLog(dir);
    expect(log.read()).toEqual([]);
    log.append({ input: 'a', name: 'A', kind: 'link', state: 'raised', at: 1 });
    log.append({ input: 'b', name: 'B', kind: 'silence', state: 'raised', at: 2 });
    log.append({ input: 'a', name: 'A', kind: 'link', state: 'cleared', at: 3, duration: 2 });
    expect(log.read().map((r) => r.at)).toEqual([3, 2, 1]);
    expect(log.read({ input: 'a' }).map((r) => r.at)).toEqual([3, 1]);
    expect(log.read({ limit: 1 })).toHaveLength(1);
    fs.appendFileSync(log.file, 'not json\n');
    expect(log.read()).toHaveLength(3);
  });
});
