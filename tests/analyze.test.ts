import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { analyzeFile, readCached, writeCached, ANALYSIS_SUFFIX } from '../src/engine/inputs/analyze.ts';
import { pruneInput } from '../src/engine/inputs/record.ts';
import { tmpdir } from './helpers.ts';

function tone(dir: string, name: string, hz: number, secs: number) {
  const f = path.join(dir, name);
  execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', `sine=frequency=${hz}:duration=${secs}:sample_rate=48000`, '-ac', '2', '-c:a', 'flac', '-y', f]);
  return f;
}

describe('recording analysis', () => {
  it('puts a 1 kHz tone in the right band at about full scale', async () => {
    const f = tone(tmpdir(), 't.flac', 1000, 5);
    const a = await analyzeFile(f);
    expect(a.duration).toBeGreaterThan(4.9);
    expect(a.wave.max.length).toBeGreaterThan(50);
    expect(Math.max(...a.wave.max)).toBeGreaterThan(0.05);
    const { freqs, cols, bands, data } = a.spectrogram;
    const top0 = a.spectrum.avg_db.indexOf(Math.max(...a.spectrum.avg_db));
    expect(Math.abs(freqs[top0] - 1000)).toBeLessThan(150);
    expect(a.spectrum.peak_db[top0]).toBeGreaterThanOrEqual(a.spectrum.avg_db[top0]);
    const bytes = Buffer.from(data, 'base64');
    // Loudest band in the middle column is the tone; the top band is silent.
    const col = bytes.subarray(Math.floor(cols / 2) * bands, Math.floor(cols / 2) * bands + bands);
    const top = col.indexOf(Math.max(...col));
    expect(Math.abs(freqs[top] - 1000)).toBeLessThan(150);
    expect(col[top]).toBeGreaterThan(180);
    expect(col[bands - 1]).toBeLessThan(20);
    expect(bytes.length).toBe(cols * bands);
    // The test tone is steady, so short-term and integrated loudness agree and the series follow the clock.
    const l = a.loudness!;
    expect(l.short.length).toBeGreaterThanOrEqual(4);
    expect(l.integrated).toBeGreaterThan(-40);
    expect(Math.abs(l.integrated - l.max_short)).toBeLessThan(1);
    expect(l.true_peak).toBeLessThan(0);
  });

  it('gives a short recording a full-width spectrogram, waveform and loudness trace', async () => {
    const a = await analyzeFile(tone(tmpdir(), 'short.flac', 1000, 4));
    expect(a.spectrogram.cols).toBeGreaterThan(400);
    expect(a.wave.max.length).toBeGreaterThan(400);
    const l = a.loudness!;
    expect(l.step).toBe(0.1);
    expect(l.momentary.length).toBeGreaterThan(30);
    expect(l.short.slice(0, 20).every((v) => v === -70)).toBe(true);
    expect(l.max_short).toBeGreaterThan(-40);
  });

  it('shows no short-term reading under 3 seconds', async () => {
    const a = await analyzeFile(tone(tmpdir(), 'tiny.flac', 1000, 2));
    expect(a.loudness!.max_short).toBe(-70);
    expect(a.loudness!.max_momentary).toBeGreaterThan(-40);
  });

  it('rejects a file with no audio', async () => {
    const d = tmpdir();
    const f = path.join(d, 'bad.mp3');
    fs.writeFileSync(f, 'not audio');
    await expect(analyzeFile(f)).rejects.toThrow();
  });

  it('caches by size and mtime, and retention removes the cache with the audio', async () => {
    const root = tmpdir();
    const dir = path.join(root, 'A');
    fs.mkdirSync(dir);
    const f = tone(dir, 'a.flac', 440, 3);
    const t = Date.now() / 1000 - 40 * 86400;
    const a = await analyzeFile(f);
    const st = fs.statSync(f);
    writeCached(f, { ...a, size: st.size, mtime: st.mtimeMs });
    expect(readCached(f)?.duration).toBe(a.duration);
    fs.appendFileSync(f, 'x');
    expect(readCached(f)).toBeNull();
    fs.utimesSync(f, t, t);
    expect(pruneInput(root, 'A', 30)).toBe(1);
    expect(fs.existsSync(f + ANALYSIS_SUFFIX)).toBe(false);
  });
});
