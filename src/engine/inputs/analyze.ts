// Picture of one recording for the Analysis tab: a waveform envelope, the average and
// peak spectrum, and a spectrogram. ffmpeg decodes the file to mono PCM; the
// numbers are computed here in one pass. Results are cached next to the recording
// as <file>.analysis.json (pruneInput and purgeForSpace delete them with the audio).
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import type { Analysis, Loudness } from '../../lib/types.ts';

export const ANALYSIS_SUFFIX = '.analysis.json';
export const ANALYSIS_RATE = 48000;
const FFT = 2048;
const WAVE_POINTS = 900;
const BANDS = 160;
const COLS = 600;
const F_LOW = 30;
const DB_FLOOR = -100;
const TIMEOUT_MS = 180_000;

/** In-place radix-2 FFT. */
function fft(re: Float64Array, im: Float64Array) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k, b = a + len / 2;
        const tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr; im[b] = im[a] - ti;
        re[a] += tr; im[a] += ti;
        const nr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr; cr = nr;
      }
    }
  }
}

const db = (p: number) => (p > 1e-12 ? Math.max(DB_FLOOR, 10 * Math.log10(p)) : DB_FLOOR);

/** FFT bin ranges of the log-spaced bands, lowest to Nyquist. */
function bandEdges(rate: number): { edges: number[]; freqs: number[] } {
  const nyq = rate / 2;
  const bins = FFT / 2;
  const hz = nyq / bins;
  const edges: number[] = [];
  const freqs: number[] = [];
  let prev = Math.max(1, Math.floor(F_LOW / hz));
  for (let b = 0; b < BANDS; b++) {
    const f = F_LOW * Math.pow(nyq / F_LOW, (b + 1) / BANDS);
    const e = Math.min(bins, Math.max(prev + 1, Math.round(f / hz)));
    edges.push(prev);
    freqs.push(Math.round(((prev + e) / 2) * hz));
    prev = e;
  }
  edges.push(prev);
  return { edges, freqs };
}

/** Pure analysis of mono float-free PCM, fed in chunks. */
export class Analyzer {
  private tail = new Float64Array(FFT);
  private fill = 0;
  private re = new Float64Array(FFT);
  private im = new Float64Array(FFT);
  private win = Float64Array.from({ length: FFT }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (FFT - 1)));
  private band = bandEdges(ANALYSIS_RATE);
  private sum = new Float64Array(BANDS);
  private peak = new Float64Array(BANDS).fill(DB_FLOOR);
  private frames: Float32Array[] = [];
  /** Waveform min/max per FFT-sized block. */
  private blockMin: number[] = [];
  private blockMax: number[] = [];
  private bMin = 1; private bMax = -1; private bN = 0;
  samples = 0;

  push(pcm: Int16Array) {
    for (let i = 0; i < pcm.length; i++) {
      const v = pcm[i] / 32768;
      if (v < this.bMin) this.bMin = v;
      if (v > this.bMax) this.bMax = v;
      if (++this.bN === FFT) { this.blockMin.push(this.bMin); this.blockMax.push(this.bMax); this.bMin = 1; this.bMax = -1; this.bN = 0; }
      this.tail[this.fill++] = v;
      if (this.fill === FFT) { this.frame(); this.fill = 0; }
    }
    this.samples += pcm.length;
  }

  private frame() {
    for (let i = 0; i < FFT; i++) { this.re[i] = this.tail[i] * this.win[i]; this.im[i] = 0; }
    fft(this.re, this.im);
    const { edges } = this.band;
    const row = new Float32Array(BANDS);
    // A full-scale sine peaks at (N/4)^2 in one Hann bin; scale that to 0 dB.
    const norm = 16 / (FFT * FFT);
    for (let b = 0; b < BANDS; b++) {
      let p = 0;
      for (let k = edges[b]; k < edges[b + 1]; k++) p += this.re[k] * this.re[k] + this.im[k] * this.im[k];
      const d = db((p * norm) / (edges[b + 1] - edges[b]));
      row[b] = d;
      this.sum[b] += Math.pow(10, d / 10);
      if (d > this.peak[b]) this.peak[b] = d;
    }
    this.frames.push(row);
  }

  result(): Omit<Analysis, "loudness"> {
    const n = this.frames.length;
    const blocks = this.blockMin.length;
    const wave = { min: [] as number[], max: [] as number[] };
    const points = Math.min(WAVE_POINTS, blocks);
    for (let p = 0; p < points; p++) {
      let lo = 1, hi = -1;
      for (let b = Math.floor((p * blocks) / points); b < Math.floor(((p + 1) * blocks) / points); b++) {
        lo = Math.min(lo, this.blockMin[b]); hi = Math.max(hi, this.blockMax[b]);
      }
      wave.min.push(+lo.toFixed(4)); wave.max.push(+hi.toFixed(4));
    }
    const cols = Math.min(COLS, n);
    const grid = new Uint8Array(cols * BANDS);
    for (let c = 0; c < cols; c++) {
      const from = Math.floor((c * n) / cols), to = Math.max(from + 1, Math.floor(((c + 1) * n) / cols));
      for (let b = 0; b < BANDS; b++) {
        let p = 0;
        for (let f = from; f < to; f++) p += Math.pow(10, this.frames[f][b] / 10);
        grid[c * BANDS + b] = Math.round(((db(p / (to - from)) - DB_FLOOR) / -DB_FLOOR) * 255);
      }
    }
    return {
      version: 4,
      size: 0,
      mtime: 0,
      duration: this.samples / ANALYSIS_RATE,
      wave,
      spectrum: {
        avg_db: Array.from(this.sum, (s) => +db(n ? s / n : 0).toFixed(1)),
        peak_db: Array.from(this.peak, (p) => +p.toFixed(1)),
      },
      spectrogram: { freqs: this.band.freqs, cols, bands: BANDS, floor_db: DB_FLOOR, data: Buffer.from(grid).toString('base64') },
    };
  }
}

/** Decode `file` with ffmpeg and analyse it. Rejects if ffmpeg fails or yields no audio. */
export function analyzeFile(file: string, bin = 'ffmpeg'): Promise<Analysis> {
  return new Promise((resolve, reject) => {
    const a = new Analyzer();
    const p = spawn(bin, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-i', file, '-vn', '-map', '0:a:0', '-ac', '1', '-ar', String(ANALYSIS_RATE), '-f', 's16le', 'pipe:1'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '';
    let carry: Buffer = Buffer.alloc(0);
    const timer = setTimeout(() => p.kill('SIGKILL'), TIMEOUT_MS);
    p.stderr.on('data', (d: Buffer) => { if (err.length < 400) err += d.toString(); });
    p.stdout.on('data', (d: Buffer) => {
      const buf = carry.length ? Buffer.concat([carry, d]) : d;
      const whole = buf.length & ~1;
      carry = buf.subarray(whole);
      if (!whole) return;
      // Copy: a Buffer slice from the stream pool may not be 2-byte aligned.
      const copy = Buffer.from(buf.subarray(0, whole));
      a.push(new Int16Array(copy.buffer, copy.byteOffset, whole >> 1));
    });
    p.on('error', (e) => { clearTimeout(timer); reject(new Error(`cannot run ${bin}: ${e.message}`)); });
    p.on('close', (code) => {
      clearTimeout(timer);
      if (a.samples < FFT * 2) reject(new Error(err.trim().split('\n').pop() || (code ? `ffmpeg exited ${code}` : 'no audio in this file')));
      else loudness(file, bin).then((l) => resolve({ ...a.result(), loudness: l }));
    });
  });
}

const LUFS_FLOOR = -70;
const LUFS_POINTS = 900;

/**
 * BS.1770 / EBU R128 loudness via ffmpeg's ebur128 filter, which reports momentary (400 ms) and
 * short-term (3 s) loudness every 100 ms and the running integrated value. Null if it fails:
 * the rest of the analysis does not depend on it.
 */
export function loudness(file: string, bin = 'ffmpeg'): Promise<Loudness | null> {
  return new Promise((resolve) => {
    const p = spawn(bin, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-i', file, '-vn', '-map', '0:a:0', '-af', 'ebur128=metadata=1:peak=true,ametadata=mode=print:file=-', '-f', 'null', '-'], { stdio: ['ignore', 'pipe', 'ignore'] });
    const timer = setTimeout(() => p.kill('SIGKILL'), TIMEOUT_MS);
    let buf = '';
    let t = 0;
    const sec = { s: [] as number[], m: [] as number[], i: [] as number[] };
    let cur: Record<string, number> = {};
    let maxM = LUFS_FLOOR, maxS = LUFS_FLOOR, tp = 0, lra = 0, integ = LUFS_FLOOR, next = 1;
    const clamp = (v: number) => (Number.isFinite(v) ? Math.max(LUFS_FLOOR, v) : LUFS_FLOOR);
    const flush = () => {
      if (cur.M === undefined) return;
      const m = clamp(cur.M), s = clamp(cur.S), i = clamp(cur.I);
      maxM = Math.max(maxM, m);
      // Short-term loudness needs 3 s of audio before it means anything.
      if (t >= 3) maxS = Math.max(maxS, s);
      tp = Math.max(tp, cur.true_peak ?? 0);
      lra = cur.LRA ?? lra;
      integ = i;
      if (t >= next) { sec.s.push(t >= 3 ? s : LUFS_FLOOR); sec.m.push(m); sec.i.push(i); next = Math.floor(t) + 1; }
    };
    p.stdout.on('data', (d: Buffer) => {
      buf += d.toString();
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) {
        const fr = /^frame:\d+\s+pts:\d+\s+pts_time:([\d.]+)/.exec(line);
        if (fr) { flush(); cur = {}; t = Number(fr[1]); continue; }
        const kv = /^lavfi\.r128\.(M|S|I|LRA|true_peak)=(-?[\d.]+|-?inf|nan)/.exec(line);
        if (kv) cur[kv[1]] = Number(kv[2]);
      }
    });
    p.on('error', () => { clearTimeout(timer); resolve(null); });
    p.on('close', () => {
      clearTimeout(timer);
      flush();
      if (sec.s.length < 2) return resolve(null);
      const stride = Math.ceil(sec.s.length / LUFS_POINTS);
      const pick = (a: number[]) => a.filter((_, k) => k % stride === 0).map((v) => +v.toFixed(1));
      resolve({
        step: stride,
        short: pick(sec.s),
        momentary: pick(sec.m),
        integrated_run: pick(sec.i),
        integrated: +integ.toFixed(1),
        lra: +lra.toFixed(1),
        max_short: +maxS.toFixed(1),
        max_momentary: +maxM.toFixed(1),
        true_peak: tp > 0 ? +(20 * Math.log10(tp)).toFixed(1) : LUFS_FLOOR,
      });
    });
  });
}

/** The cached analysis if it still matches the file (same size and mtime). */
export function readCached(file: string): Analysis | null {
  try {
    const st = fs.statSync(file);
    const c = JSON.parse(fs.readFileSync(file + ANALYSIS_SUFFIX, 'utf8')) as Analysis;
    return c.version === 4 && c.size === st.size && c.mtime === st.mtimeMs ? c : null;
  } catch { return null; }
}

export function writeCached(file: string, a: Analysis): void {
  try { fs.writeFileSync(file + ANALYSIS_SUFFIX, JSON.stringify(a)); } catch { /* read-only folder: just not cached */ }
}
