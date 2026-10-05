// EAS attention-tone detection: the 853 Hz + 960 Hz dual tone, found with two
// Goertzel filters over 250 ms windows. This works on any audio and needs no
// external tool; SAME header decoding (same.ts) needs multimon-ng.

/** Raw power of `freq` in `samples`. */
export function goertzel(samples: ArrayLike<number>, n: number, freq: number, rate: number): number {
  const k = Math.round((n * freq) / rate);
  if (k <= 0 || k >= n) return 0;
  const coeff = 2 * Math.cos((2 * Math.PI * k) / n);
  let s1 = 0, s2 = 0;
  for (let i = 0; i < n; i++) {
    const s = samples[i] + coeff * s1 - s2;
    s2 = s1;
    s1 = s;
  }
  return s2 * s2 + s1 * s1 - coeff * s1 * s2;
}

export const EAS = {
  FREQ1: 853,
  FREQ2: 960,
  WINDOW_SECS: 0.25,
  CONFIRM_WINDOWS: 2,
  HOLD_SECS: 10,
  COOLDOWN_SECS: 60,
  /** Each tone must carry this fraction of the window energy (clean dual tone ≈ 0.25 each). */
  TONE_RATIO: 0.1,
};

export function easTonePresent(samples: ArrayLike<number>, n: number, rate: number): boolean {
  let total = 0;
  for (let i = 0; i < n; i++) total += samples[i] * samples[i];
  if (total <= 0) return false;
  const p1 = goertzel(samples, n, EAS.FREQ1, rate) / (n * total);
  const p2 = goertzel(samples, n, EAS.FREQ2, rate) / (n * total);
  return p1 > EAS.TONE_RATIO && p2 > EAS.TONE_RATIO;
}

/**
 * Streaming attention-tone detector: feed interleaved int16 PCM; `onTone` fires
 * once per alert (two consecutive 250 ms windows), `onClear` after the hold
 * time. A cooldown keeps a long tone from re-triggering.
 */
export class EasDetector {
  private buf: Float32Array;
  private fill = 0;
  private hits = 0;
  private pulsing = false;
  private pulseStart = 0;
  private cooldownUntil = 0;

  constructor(
    readonly rate: number,
    readonly channels: number,
    private onTone: () => void,
    private onClear: () => void,
    private clock: () => number = () => Date.now() / 1000,
  ) {
    this.buf = new Float32Array(Math.round(rate * EAS.WINDOW_SECS));
  }

  get active() { return this.pulsing; }

  push(samples: Int16Array) {
    const ch = this.channels;
    const frames = Math.floor(samples.length / ch);
    for (let i = 0; i < frames; i++) {
      // Left channel only: the tone is mono, and summing would cancel it on an out-of-phase feed.
      this.buf[this.fill++] = samples[i * ch];
      if (this.fill === this.buf.length) {
        this.fill = 0;
        this.window();
      }
    }
  }

  private window() {
    const now = this.clock();
    if (this.pulsing && now - this.pulseStart >= EAS.HOLD_SECS) {
      this.pulsing = false;
      this.cooldownUntil = now + EAS.COOLDOWN_SECS;
      this.onClear();
    }
    if (this.pulsing || now < this.cooldownUntil) {
      this.hits = 0;
      return;
    }
    this.hits = easTonePresent(this.buf, this.buf.length, this.rate) ? this.hits + 1 : 0;
    if (this.hits >= EAS.CONFIRM_WINDOWS) {
      this.hits = 0;
      this.pulsing = true;
      this.pulseStart = now;
      this.onTone();
    }
  }

  /** The feed dropped: don't leave the alarm stuck on. */
  finish() {
    if (this.pulsing) {
      this.pulsing = false;
      this.onClear();
    }
    this.fill = 0;
    this.hits = 0;
  }
}
