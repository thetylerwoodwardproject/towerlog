// EAS / SAME (Specific Area Message Encoding, 47 CFR 11.31) support:
//   - parseSame(): decode a ZCZC header into originator, event, areas, duration…
//   - SameDecoder: feeds an input's audio (resampled to 22050 Hz mono) to
//     multimon-ng's EAS demodulator and reports each message once
//   - encodeSame(): AFSK generator, used by demo mode and the tests
import { spawn, type ChildProcess } from 'node:child_process';
import type { Logger } from '../logger.ts';

export const ORIGINATORS: Record<string, string> = {
  EAS: 'EAS Participant (broadcaster)',
  CIV: 'Civil authorities',
  WXR: 'National Weather Service',
  PEP: 'Primary Entry Point (national)',
  EAN: 'Emergency Action Notification network',
};

export const EVENTS: Record<string, string> = {
  EAN: 'Emergency Action Notification', NPT: 'Nationwide Test', NIC: 'National Information Center',
  RMT: 'Required Monthly Test', RWT: 'Required Weekly Test', DMO: 'Practice/Demo Warning', ADR: 'Administrative Message',
  AVW: 'Avalanche Warning', AVA: 'Avalanche Watch', BZW: 'Blizzard Warning', BLU: 'Blue Alert', CAE: 'Child Abduction Emergency',
  CDW: 'Civil Danger Warning', CEM: 'Civil Emergency Message', CFW: 'Coastal Flood Warning', CFA: 'Coastal Flood Watch',
  DSW: 'Dust Storm Warning', EQW: 'Earthquake Warning', EVI: 'Evacuation Immediate', EWW: 'Extreme Wind Warning',
  FRW: 'Fire Warning', FFW: 'Flash Flood Warning', FFA: 'Flash Flood Watch', FFS: 'Flash Flood Statement',
  FLW: 'Flood Warning', FLA: 'Flood Watch', FLS: 'Flood Statement', HMW: 'Hazardous Materials Warning',
  HWW: 'High Wind Warning', HWA: 'High Wind Watch', HUW: 'Hurricane Warning', HUA: 'Hurricane Watch', HLS: 'Hurricane Statement',
  LEW: 'Law Enforcement Warning', LAE: 'Local Area Emergency', NMN: 'Network Message Notification', TOE: '911 Telephone Outage Emergency',
  NUW: 'Nuclear Power Plant Warning', RHW: 'Radiological Hazard Warning', SVR: 'Severe Thunderstorm Warning',
  SVA: 'Severe Thunderstorm Watch', SVS: 'Severe Weather Statement', SPW: 'Shelter in Place Warning', SMW: 'Special Marine Warning',
  SPS: 'Special Weather Statement', SSA: 'Storm Surge Watch', SSW: 'Storm Surge Warning', TOR: 'Tornado Warning',
  TOA: 'Tornado Watch', TRW: 'Tropical Storm Warning', TRA: 'Tropical Storm Watch', TSW: 'Tsunami Warning', TSA: 'Tsunami Watch',
  VOW: 'Volcano Warning', WSW: 'Winter Storm Warning', WSA: 'Winter Storm Watch', EVA: 'Evacuation Watch', FSW: 'Flash Freeze Warning',
  FZW: 'Freeze Warning', ISW: 'Ice Storm Warning', SQW: 'Snow Squall Warning', NAT: 'National Audible Test', NST: 'National Silent Test',
  MEP: 'Missing and Endangered Persons',
};

export const STATES: Record<string, string> = {
  '00': 'All of the US', '01': 'AL', '02': 'AK', '04': 'AZ', '05': 'AR', '06': 'CA', '08': 'CO', '09': 'CT', '10': 'DE', '11': 'DC',
  '12': 'FL', '13': 'GA', '15': 'HI', '16': 'ID', '17': 'IL', '18': 'IN', '19': 'IA', '20': 'KS', '21': 'KY', '22': 'LA', '23': 'ME',
  '24': 'MD', '25': 'MA', '26': 'MI', '27': 'MN', '28': 'MS', '29': 'MO', '30': 'MT', '31': 'NE', '32': 'NV', '33': 'NH', '34': 'NJ',
  '35': 'NM', '36': 'NY', '37': 'NC', '38': 'ND', '39': 'OH', '40': 'OK', '41': 'OR', '42': 'PA', '44': 'RI', '45': 'SC', '46': 'SD',
  '47': 'TN', '48': 'TX', '49': 'UT', '50': 'VT', '51': 'VA', '53': 'WA', '54': 'WV', '55': 'WI', '56': 'WY', '60': 'AS', '66': 'GU',
  '69': 'MP', '72': 'PR', '78': 'VI',
  // Marine areas (NWR)
  '57': 'Pacific coast (marine)', '58': 'Alaska (marine)', '59': 'Hawaii (marine)', '61': 'American Samoa (marine)', '65': 'Mariana Is. (marine)',
  '73': 'Atlantic (marine)', '74': 'Gulf of Mexico (marine)', '75': 'Atlantic (marine)', '77': 'Gulf of Mexico (marine)',
  '91': 'Lake Superior', '92': 'Lake Michigan', '93': 'Lake Huron', '94': 'Lake St. Clair', '96': 'Lake Erie', '97': 'Lake Ontario', '98': 'St. Lawrence River',
};

const PARTS = ['all', 'NW', 'N', 'NE', 'W', 'central', 'E', 'SW', 'S', 'SE'];

export interface SameLocation { code: string; part: string; state: string; county: string }

export interface SameMessage {
  raw: string;
  originator: string;
  originator_name: string;
  event: string;
  event_name: string;
  locations: SameLocation[];
  /** Purge time (valid for), minutes. */
  duration_min: number;
  /** Issue time from the header (UTC, ISO), or '' if unparseable. */
  issued: string;
  /** Station/office that sent it, e.g. KEAX/NWS. */
  sender: string;
  /** "Tornado Warning for … — National Weather Service (KEAX/NWS)" */
  summary: string;
}

const HEADER_RE = /ZCZC-([A-Z]{3})-([A-Z0-9]{3})-((?:\d{6}-?){1,31})\+(\d{4})-(\d{7})-([^-]{1,8})-?/;

/** Parse a SAME header ("ZCZC-WXR-TOR-029095+0030-1051700-KEAX/NWS-"). */
export function parseSame(text: string, now = new Date()): SameMessage | null {
  const m = HEADER_RE.exec(text.toUpperCase());
  if (!m) return null;
  const [, org, ev, locs, purge, jjjhhmm, sender] = m;
  const locations = locs.split('-').filter(Boolean).map((code) => ({
    code,
    part: PARTS[Number(code[0])] ?? '',
    state: STATES[code.slice(1, 3)] ?? code.slice(1, 3),
    county: code.slice(3),
  }));
  const duration_min = Number(purge.slice(0, 2)) * 60 + Number(purge.slice(2));
  // JJJHHMM: day of year + UTC time; pick the year that puts it nearest to now.
  let issued = '';
  const day = Number(jjjhhmm.slice(0, 3)), hh = Number(jjjhhmm.slice(3, 5)), mm = Number(jjjhhmm.slice(5, 7));
  if (day >= 1 && day <= 366 && hh < 24 && mm < 60) {
    const best = [now.getUTCFullYear() - 1, now.getUTCFullYear(), now.getUTCFullYear() + 1]
      .map((y) => Date.UTC(y, 0, day, hh, mm))
      .sort((a, b) => Math.abs(a - now.getTime()) - Math.abs(b - now.getTime()))[0];
    issued = new Date(best).toISOString();
  }
  const event_name = EVENTS[ev] ?? `Unknown event ${ev}`;
  const originator_name = ORIGINATORS[org] ?? org;
  const area = locations.map((l) => (l.county === '000' ? `all of ${l.state}` : `${l.part !== 'all' ? l.part + ' ' : ''}${l.state} county ${l.county}`)).join(', ');
  return {
    raw: m[0],
    originator: org, originator_name, event: ev, event_name, locations, duration_min, issued, sender: sender.trim(),
    summary: `${event_name} for ${area} — ${originator_name} (${sender.trim()}), valid ${Math.floor(duration_min / 60)}h${String(duration_min % 60).padStart(2, '0')}`,
  };
}

/** Mono, low-passed and resampled to 22050 Hz s16le, for multimon-ng. */
export class Resampler22k {
  static OUT = 22050;
  private taps: Float64Array;
  private hist: Float64Array;
  private hpos = 0;
  private t = 0;
  private prev = 0;
  private step: number;

  constructor(readonly inRate: number, readonly channels: number) {
    const n = 31;
    const fc = Math.min(0.45 * Resampler22k.OUT, 0.45 * inRate) / inRate;
    this.taps = new Float64Array(n);
    let sum = 0;
    for (let i = 0; i < n; i++) {
      const m = i - (n - 1) / 2;
      const sinc = m === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * m) / (Math.PI * m);
      const w = 0.54 - 0.46 * Math.cos((2 * Math.PI * i) / (n - 1));
      this.taps[i] = sinc * w;
      sum += this.taps[i];
    }
    for (let i = 0; i < n; i++) this.taps[i] /= sum;
    this.hist = new Float64Array(n);
    this.step = inRate / Resampler22k.OUT;
  }

  process(samples: Int16Array): Buffer {
    const ch = this.channels, frames = Math.floor(samples.length / ch);
    const out = Buffer.allocUnsafe(Math.ceil(frames / this.step + 2) * 2);
    let o = 0;
    const n = this.taps.length;
    for (let i = 0; i < frames; i++) {
      let x = samples[i * ch];
      if (ch > 1) x = (x + samples[i * ch + 1]) / 2;
      this.hist[this.hpos] = x;
      this.hpos = (this.hpos + 1) % n;
      let y = 0;
      for (let k = 0; k < n; k++) y += this.taps[k] * this.hist[(this.hpos + k) % n];
      // Linear interpolation between the previous and this filtered sample.
      while (this.t <= 1) {
        const v = this.prev + (y - this.prev) * this.t;
        out.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(v))), o);
        o += 2;
        this.t += this.step;
      }
      this.t -= 1;
      this.prev = y;
    }
    return out.subarray(0, o);
  }
}

/**
 * One multimon-ng per input. Messages are repeated three times on air; each
 * distinct header is reported once (within 60 s), and an end-of-message NNNN
 * once per alert.
 */
export class SameDecoder {
  private proc: ChildProcess | null = null;
  private resampler: Resampler22k;
  private partial = '';
  private recent = new Map<string, number>();
  private lastEom = -Infinity;
  private dead = false;
  private stopped = false;
  private restart: NodeJS.Timeout | null = null;

  constructor(
    private bin: string,
    inRate: number,
    channels: number,
    private log: Logger,
    private onMessage: (msg: SameMessage) => void,
    private onEom: () => void,
  ) {
    this.resampler = new Resampler22k(inRate, channels);
  }

  start() {
    if (this.stopped) return;
    try {
      this.proc = spawn(this.bin, ['-q', '-t', 'raw', '-a', 'EAS', '-'], { stdio: ['pipe', 'pipe', 'ignore'] });
    } catch {
      this.dead = true;
      return;
    }
    const proc = this.proc;
    this.dead = false;
    proc.on('error', (e) => { this.dead = true; this.log.warn(`multimon-ng: ${e.message}`); });
    // A feed that stays up must not silently lose EAS decoding: start it again.
    proc.on('exit', (code) => {
      if (this.proc !== proc) return;
      this.dead = true;
      this.proc = null;
      if (this.stopped) return;
      this.log.warn(`multimon-ng exited (${code}); restarting in 5 s`);
      this.restart = setTimeout(() => { this.restart = null; this.start(); }, 5000);
    });
    proc.stdin?.on('error', () => { this.dead = true; });
    proc.stdout?.on('data', (d: Buffer) => this.onData(d));
  }

  push(samples: Int16Array) {
    const p = this.proc;
    if (this.dead || !p?.stdin || p.stdin.writableLength > 1 << 20) return;
    p.stdin.write(this.resampler.process(samples));
  }

  /** multimon-ng prints "EAS: ZCZC-…" for headers and "EAS: NNNN" for end of message. */
  onLine(line: string, now = Date.now()) {
    if (!/^EAS/.test(line)) return;
    if (/NNNN/.test(line)) {
      if (now - this.lastEom > 10000) { this.lastEom = now; this.onEom(); }
      return;
    }
    const msg = parseSame(line, new Date(now));
    if (!msg) return;
    for (const [k, t] of this.recent) if (now - t > 60000) this.recent.delete(k);
    if (this.recent.has(msg.raw)) return;
    this.recent.set(msg.raw, now);
    this.onMessage(msg);
  }

  private onData(d: Buffer) {
    this.partial += d.toString();
    let nl: number;
    while ((nl = this.partial.indexOf('\n')) >= 0) {
      this.onLine(this.partial.slice(0, nl).trim());
      this.partial = this.partial.slice(nl + 1);
    }
  }

  stop() {
    this.stopped = true;
    this.dead = true;
    if (this.restart) clearTimeout(this.restart);
    this.restart = null;
    const p = this.proc;
    this.proc = null;
    try { p?.stdin?.end(); p?.kill('SIGTERM'); } catch { /* gone */ }
  }
}

// ------------------------------------------------------------------ encoder

const BAUD = 520 + 5 / 6;
const MARK = 2083 + 1 / 3;
const SPACE = 1562.5;

/** AFSK-encode bytes (LSB first) at `rate`, continuing phase. */
function afsk(bytes: number[], rate: number, amp: number, out: number[], phase: { v: number }) {
  const spb = rate / BAUD;
  let acc = 0;
  for (const byte of bytes) {
    for (let b = 0; b < 8; b++) {
      const f = (byte >> b) & 1 ? MARK : SPACE;
      acc += spb;
      const n = Math.round(acc);
      acc -= n;
      for (let i = 0; i < n; i++) {
        phase.v += (2 * Math.PI * f) / rate;
        out.push(amp * Math.sin(phase.v));
      }
    }
  }
}

/**
 * A complete SAME transmission: header ×3, the 853+960 Hz attention tone,
 * then the end-of-message burst ×3 (1 s gaps). Returns int16 PCM at `rate`.
 */
export function encodeSame(header: string, rate: number, opts: { toneSecs?: number; amp?: number } = {}): Int16Array {
  const amp = (opts.amp ?? 0.5) * 32767;
  const out: number[] = [];
  const phase = { v: 0 };
  const gap = () => { for (let i = 0; i < rate; i++) out.push(0); };
  const burst = (text: string) => {
    for (let r = 0; r < 3; r++) {
      afsk([...Array(16).fill(0xab), ...[...text].map((c) => c.charCodeAt(0))], rate, amp, out, phase);
      gap();
    }
  };
  burst(header);
  const tone = (opts.toneSecs ?? 8) * rate;
  for (let i = 0; i < tone; i++) out.push(0.5 * amp * (Math.sin((2 * Math.PI * 853 * i) / rate) + Math.sin((2 * Math.PI * 960 * i) / rate)));
  gap();
  burst('NNNN');
  return Int16Array.from(out, (v) => Math.round(v));
}

/** A plausible demo header issued "now" (Required Weekly Test from the NWS). */
export function demoHeader(now = new Date()): string {
  const start = Date.UTC(now.getUTCFullYear(), 0, 0);
  const day = Math.floor((now.getTime() - start) / 86400000);
  const p = (n: number, w: number) => String(n).padStart(w, '0');
  return `ZCZC-WXR-RWT-020103-020209+0015-${p(day, 3)}${p(now.getUTCHours(), 2)}${p(now.getUTCMinutes(), 2)}-KEAX/NWS-`;
}
