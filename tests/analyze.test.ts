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
    const top = a.spectrum.avg_db.indexOf(Math.max(...a.spectrum.avg_db));
    expect(Math.abs(a.spectrum.freqs[top] - 1000)).toBeLessThan(150);
    expect(a.spectrum.avg_db[top]).toBeGreaterThan(-30);
    expect(a.spectrum.avg_db[a.spectrum.avg_db.length - 1]).toBeLessThan(-80);
    expect(Buffer.from(a.spectrogram.data, 'base64').length).toBe(a.spectrogram.cols * a.spectrogram.bands);
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
