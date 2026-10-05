// Per-second audio statistics for fault detection. Feed interleaved stereo s16
// with push(); call take() once a second.
import { DB_FLOOR } from './pcm.ts';

export interface SecondStats {
  frames: number;
  rms_db: [number, number];
  peak_db: [number, number];
  /** Samples at or beyond clip level, both channels. */
  clipped: number;
  /** Left/right correlation, -1..1; null when either channel is silent. */
  corr: number | null;
  /** Left and right are the same signal (difference far below the signal). */
  identical: boolean;
}

export const CLIP_LEVEL = 32600;
/** Fewer clipped samples than this in a second is not reported as clipping. */
export const CLIP_MIN_SAMPLES = 10;

const db = (amp: number) => (amp > 0 ? Math.max(DB_FLOOR, 20 * Math.log10(amp / 32768)) : DB_FLOOR);
const r1 = (x: number) => Math.round(x * 10) / 10;

export class LevelStats {
  private sq = [0, 0];
  private peak = [0, 0];
  private cross = 0;
  private diffSq = 0;
  private clipped = 0;
  private frames = 0;

  push(samples: Int16Array) {
    const n = samples.length >> 1;
    let s0 = 0, s1 = 0, p0 = this.peak[0], p1 = this.peak[1], cross = 0, diff = 0, clip = 0;
    for (let i = 0; i < n; i++) {
      const l = samples[2 * i], r = samples[2 * i + 1];
      s0 += l * l; s1 += r * r; cross += l * r;
      const d = l - r; diff += d * d;
      const al = l < 0 ? -l : l, ar = r < 0 ? -r : r;
      if (al > p0) p0 = al;
      if (ar > p1) p1 = ar;
      if (al >= CLIP_LEVEL) clip++;
      if (ar >= CLIP_LEVEL) clip++;
    }
    this.sq[0] += s0; this.sq[1] += s1; this.peak = [p0, p1];
    this.cross += cross; this.diffSq += diff; this.clipped += clip; this.frames += n;
  }

  take(): SecondStats {
    const n = this.frames;
    const rms = (s: number) => (n > 0 && s > 0 ? Math.sqrt(s / n) : 0);
    const rl = rms(this.sq[0]), rr = rms(this.sq[1]);
    // Silent means a channel under about -80 dBFS: correlation is meaningless there.
    const live = rl > 3 && rr > 3;
    const out: SecondStats = {
      frames: n,
      rms_db: [r1(db(rl)), r1(db(rr))],
      peak_db: [r1(db(this.peak[0])), r1(db(this.peak[1]))],
      clipped: this.clipped,
      corr: live ? this.cross / (Math.sqrt(this.sq[0]) * Math.sqrt(this.sq[1])) : null,
      identical: live && this.diffSq <= (this.sq[0] + this.sq[1]) * 1e-4,
    };
    this.sq = [0, 0]; this.peak = [0, 0]; this.cross = 0; this.diffSq = 0; this.clipped = 0; this.frames = 0;
    return out;
  }
}

/** Dead air: both channels under the threshold (the louder one decides). */
export const isSilent = (s: SecondStats, thresholdDb: number) => Math.max(s.rms_db[0], s.rms_db[1]) < thresholdDb;
export const isClipping = (s: SecondStats) => s.clipped >= CLIP_MIN_SAMPLES;
/** Out of phase: channels mostly cancel when summed to mono. */
export const isOutOfPhase = (s: SecondStats) => s.corr !== null && s.corr < -0.5;
