// One logged feed: supervises a single ffmpeg that records the original audio in
// clock-cut chunks and sends PCM back for metering, and turns what it sees into
// faults (link, silence, clipping, mono, phase) through FaultTracker.
import fs from 'node:fs';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';
import type { FaultRecord, InputSnapshot, InputStatus } from '../../lib/types.ts';
import { int16View } from './pcm.ts';
import { EasDetector } from './eas-tone.ts';
import { SameDecoder, type SameMessage } from './same.ts';
import type { InputConfig } from '../config.ts';
import { DEFAULT_FAULT_RULES, FaultTracker, type FaultEvent, type FaultKind } from '../faults.ts';
import type { Logger } from '../logger.ts';
import { FrameAligner, Proc } from '../proc.ts';
import { METER_CHANNELS, METER_RATE, buildSource } from './args.ts';
import { LevelStats, isClipping, isOutOfPhase, isSilent, type SecondStats } from './detect.ts';
import type { FaultLog } from './faultlog.ts';
import { ensureDayDirs, ffmpegArgs, pruneInput } from './record.ts';

export interface InputContext {
  recordRoot: string;
  /** Scratch folder for SDP files. */
  workDir: string;
  log: Logger;
  faults: FaultLog;
  /** Called for every fault raise and clear (alerts hook in here). */
  onFault?: (rec: FaultRecord) => void;
  /** ffmpeg binary, overridable for tests. */
  bin?: string;
  /** multimon-ng binary for SAME header decoding, or null: the attention tone is still detected. */
  multimonBin?: string | null;
  /** EAS attention tone started (active) or ended on this input. */
  onEasTone?: (input: LogInput, active: boolean) => void;
  /** A SAME header was decoded (msg), or its end-of-message was heard (null). */
  onSame?: (input: LogInput, msg: SameMessage | null) => void;
}

/** Most audio the meter queue may hold: 3 s of the metering format. */
const METER_MAX_QUEUE = METER_RATE * METER_CHANNELS * 3;
const RESTART_MIN = 2;
const RESTART_MAX = 30;
/** A feed is "live" only while audio arrived within this many seconds. */
const STALE_SECS = 3;
const PRUNE_EVERY = 3600;

export class LogInput {
  status: InputStatus = 'stopped';
  detail = '';
  proc: Proc | null = null;
  private wanted = false;
  private stats = new LevelStats();
  private aligner = new FrameAligner(4);
  private last: SecondStats | null = null;
  /** Short window for the on-screen meter (the 1 s `stats` window is for the fault detectors). */
  private fast = new LevelStats();
  private display: SecondStats | null = null;
  /**
   * Network feeds deliver audio in bursts (a stream server may send a second at a time), which would make
   * the meter move once per burst. Audio for the meter waits here and is played out at real-time speed.
   */
  private meterQueue: Int16Array[] = [];
  private meterQueued = 0;
  private lastMeterAt = 0;
  private lastDataAt: number | null = null;
  private upSince: number | null = null;
  private silentSince: number | null = null;
  private restartAt = 0;
  /** Why the recordings folder can't be used right now ('' when it can). Monitoring carries on without recording. */
  private recError = '';
  /** Whether the running ffmpeg was started with recording on. */
  private recStarted = false;
  private backoff = RESTART_MIN;
  private nextPrune = 0;
  private tracker: FaultTracker;
  private pushStream: Readable | null = null;
  /** Browser listeners: each gets its own MP3 encoder fed from the same PCM, only while it listens. */
  private listeners = new Set<ChildProcess>();
  private eas: EasDetector | null = null;
  private same: SameDecoder | null = null;

  constructor(public cfg: InputConfig, private ctx: InputContext) {
    this.tracker = new FaultTracker(cfg.id, {
      ...DEFAULT_FAULT_RULES,
      link: { delay: cfg.link_secs },
      silence: { delay: cfg.silence_secs },
      clip: { delay: cfg.clip_secs },
      mono: { delay: cfg.mono_secs },
      phase: { delay: cfg.mono_secs },
    }, (e) => this.onFault(e));
  }

  get isRunning() { return this.wanted; }
  private get recording() { return this.cfg.record; }

  private onFault(e: FaultEvent) {
    const rec: FaultRecord = { input: this.cfg.id, name: this.cfg.name, kind: e.kind, state: e.state, at: e.at, ...(e.duration !== undefined ? { duration: e.duration } : {}) };
    this.ctx.faults.append(rec);
    this.ctx.log.file('faults.log', `${this.cfg.name}: ${e.kind} ${e.state}${e.duration !== undefined ? ` after ${e.duration}s` : ''}`);
    this.ctx.onFault?.(rec);
  }

  start(now = Date.now() / 1000) {
    if (this.wanted || !this.cfg.enabled) return;
    this.wanted = true;
    this.nextPrune = now + 60;
    if (this.cfg.kind === 'push') {
      this.setStatus('down', 'waiting for the source to connect');
      return;
    }
    this.spawn(now);
  }

  async stop() {
    this.wanted = false;
    const p = this.proc;
    this.proc = null;
    this.pushStream?.unpipe();
    this.pushStream = null;
    this.stopEas();
    if (p) await p.stop();
    for (const l of this.listeners) l.kill('SIGKILL');
    this.setStatus('stopped', '');
  }

  /** Push inputs: a source client connected; its audio bytes arrive on `stream`. */
  attach(stream: Readable, now = Date.now() / 1000) {
    if (this.cfg.kind !== 'push' || !this.wanted) { stream.destroy(); return; }
    if (this.pushStream) this.detachPush();
    this.spawn(now, stream);
  }

  private detachPush() {
    const s = this.pushStream;
    this.pushStream = null;
    s?.unpipe();
    s?.destroy();
    this.stopEas();
    void this.proc?.stop();
  }

  /** Stream this input's audio to `out` as MP3 until `out` closes. Returns false if ffmpeg won't start. */
  listen(out: Writable): boolean {
    const enc = spawn(this.ctx.bin ?? 'ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin',
      // Raw PCM would otherwise be probed for seconds before the first byte comes out.
      '-fflags', 'nobuffer', '-probesize', '32', '-analyzeduration', '0',
      '-f', 's16le', '-ar', '48000', '-ac', '2', '-i', 'pipe:0', '-c:a', 'libmp3lame', '-b:a', '96k', '-flush_packets', '1', '-f', 'mp3', 'pipe:1'], { stdio: ['pipe', 'pipe', 'ignore'] });
    this.listeners.add(enc);
    enc.stdin?.on('error', () => { /* encoder gone */ });
    enc.stdout?.pipe(out);
    const done = () => { this.listeners.delete(enc); enc.kill('SIGKILL'); };
    out.once('close', done);
    enc.once('exit', () => { this.listeners.delete(enc); out.end(); });
    enc.once('error', () => { this.listeners.delete(enc); out.end(); });
    return true;
  }

  get listenerCount() { return this.listeners.size; }

  /** EAS listening lasts as long as one ffmpeg run: a tone cannot span a reconnect. */
  private startEas() {
    this.stopEas();
    if (!this.cfg.detect_eas) return;
    this.eas = new EasDetector(METER_RATE, METER_CHANNELS, () => this.ctx.onEasTone?.(this, true), () => this.ctx.onEasTone?.(this, false));
    if (this.ctx.multimonBin) {
      this.same = new SameDecoder(this.ctx.multimonBin, METER_RATE, METER_CHANNELS, this.ctx.log, (m) => this.ctx.onSame?.(this, m), () => this.ctx.onSame?.(this, null));
      this.same.start();
    }
  }

  private stopEas() {
    this.eas?.finish();
    this.eas = null;
    this.same?.stop();
    this.same = null;
  }

  /** True while the attention tone is being heard. */
  get easActive() { return !!this.eas?.active; }

  private setStatus(s: InputStatus, detail: string) {
    this.status = s;
    this.detail = detail;
  }

  private spawn(now: number, source?: Readable) {
    const cfg = this.cfg;
    const sdpPath = path.join(this.ctx.workDir, `${cfg.id}.sdp`);
    const src = buildSource(cfg, sdpPath);
    if (src.sdp) {
      try {
        fs.mkdirSync(this.ctx.workDir, { recursive: true });
        fs.writeFileSync(sdpPath, src.sdp);
      } catch (e) {
        this.setStatus('down', `cannot write ${sdpPath}: ${(e as Error).message}`);
        this.scheduleRestart(now);
        return;
      }
    }
    const rec = this.recording && this.recFolderReady(now);
    this.recStarted = rec;
    const args = ffmpegArgs(cfg, src, rec ? this.ctx.recordRoot : null);
    this.aligner = new FrameAligner(4);
    this.setStatus('connecting', cfg.kind === 'push' ? 'source connected' : 'connecting');
    const proc = new Proc(
      `ffmpeg:${cfg.id}`, this.ctx.bin ?? 'ffmpeg', args,
      [src.stdin ? 'pipe' : 'ignore', 'pipe', 'pipe'], this.ctx.log,
      (p) => this.onExit(p),
    );
    this.proc = proc;
    this.startEas();
    proc.child.stdout?.on('data', (d: Buffer) => {
      if (this.proc !== proc) return;
      const whole = this.aligner.push(d);
      if (!whole) return;
      const pcm = int16View(whole);
      this.stats.push(pcm);
      this.eas?.push(pcm);
      this.same?.push(pcm);
      this.meterQueue.push(pcm.slice());
      this.meterQueued += pcm.length;
      // Never fall more than 3 s behind the feed: drop the oldest.
      while (this.meterQueued > METER_MAX_QUEUE && this.meterQueue.length > 1) this.meterQueued -= this.meterQueue.shift()!.length;
      for (const l of this.listeners) if (l.stdin && l.stdin.writableLength < 1 << 20) l.stdin.write(whole);
      this.lastDataAt = Date.now() / 1000;
      if (this.status !== 'live') {
        this.upSince = this.lastDataAt;
        this.backoff = RESTART_MIN;
        this.setStatus('live', '');
      }
    });
    if (source && proc.child.stdin) {
      this.pushStream = source;
      source.pipe(proc.child.stdin);
      source.once('close', () => {
        if (this.pushStream !== source) return;
        this.pushStream = null;
        void proc.stop();
        if (this.proc === proc) {
          this.proc = null;
          this.upSince = null;
          this.stopEas();
          this.setStatus('down', 'source disconnected');
        }
      });
    }
  }

  private onExit(p: Proc) {
    if (this.proc !== p) return;
    this.proc = null;
    this.upSince = null;
    this.stopEas();
    this.setStatus('down', p.describe());
    this.pushStream?.unpipe();
    this.pushStream = null;
    if (this.wanted && this.cfg.kind !== 'push') this.scheduleRestart(Date.now() / 1000);
  }

  /** Make today's and tomorrow's folders; on failure remember why (and log it once) instead of throwing. */
  private recFolderReady(now: number): boolean {
    try {
      ensureDayDirs(this.ctx.recordRoot, this.cfg.name, now);
      if (this.recError) this.ctx.log.warn(`${this.cfg.name}: recordings folder is usable again`);
      this.recError = '';
      return true;
    } catch (e) {
      const msg = (e as Error).message;
      if (msg !== this.recError) this.ctx.log.error(`${this.cfg.name}: not recording: ${msg}`);
      this.recError = msg;
      return false;
    }
  }

  private scheduleRestart(now: number) {
    this.restartAt = now + this.backoff;
    this.backoff = Math.min(RESTART_MAX, this.backoff * 2);
  }

  /** Once a second, with epoch seconds. */
  tick(now: number) {
    if (!this.wanted) return;
    if (this.recording) {
      const ready = this.recFolderReady(now);
      // The folder came back (drive remounted) while ffmpeg runs without recording: restart it with recording.
      if (ready && this.proc && !this.recStarted) {
        if (this.cfg.kind === 'push') this.detachPush(); else void this.proc.stop();
      }
    }
    if (!this.proc && this.cfg.kind !== 'push' && now >= this.restartAt) this.spawn(now);
    if (this.recording && this.cfg.keep_days > 0 && now >= this.nextPrune) {
      this.nextPrune = now + PRUNE_EVERY;
      pruneInput(this.ctx.recordRoot, this.cfg.name, this.cfg.keep_days, now);
    }
    const s = this.stats.take();
    if (s.frames > 0) this.last = s;
    const live = this.status === 'live' && this.lastDataAt !== null && now - this.lastDataAt <= STALE_SECS;
    this.tracker.observe('link', !live, Math.floor(now));
    const k = (kind: FaultKind, bad: boolean) => this.tracker.observe(kind, bad, Math.floor(now));
    if (!live) {
      // Without a feed the audio faults cannot be judged; the link fault covers it.
      for (const kind of ['silence', 'clip', 'mono', 'phase'] as const) k(kind, false);
      this.silentSince = null;
      return;
    }
    if (s.frames === 0) return;
    const silent = isSilent(s, this.cfg.silence_db);
    this.silentSince = silent ? (this.silentSince ?? now) : null;
    k('silence', silent);
    k('clip', this.cfg.detect_clip && isClipping(s));
    k('mono', this.cfg.detect_mono && !silent && s.identical);
    k('phase', this.cfg.detect_mono && !silent && isOutOfPhase(s));
  }

  /** Refresh the on-screen meter from the audio since the last call; the engine calls this every 200 ms. */
  sampleMeter(nowMs = Date.now()) {
    if (this.status !== 'live') {
      this.display = null;
      this.meterQueue = [];
      this.meterQueued = 0;
      this.lastMeterAt = nowMs;
      return;
    }
    // Play out the queued audio at real-time speed: the samples that fit in the time since the last call.
    const elapsed = this.lastMeterAt ? Math.min(nowMs - this.lastMeterAt, 1000) : 200;
    this.lastMeterAt = nowMs;
    let want = Math.round((elapsed / 1000) * METER_RATE) * METER_CHANNELS;
    // A growing backlog is played slightly faster so the meter never lags by more than about a second.
    if (this.meterQueued > METER_RATE * METER_CHANNELS) want *= 2;
    while (want > 0 && this.meterQueue.length) {
      const head = this.meterQueue[0];
      if (head.length <= want) { this.fast.push(head); want -= head.length; this.meterQueued -= head.length; this.meterQueue.shift(); }
      else { this.fast.push(head.subarray(0, want)); this.meterQueue[0] = head.subarray(want); this.meterQueued -= want; want = 0; }
    }
    const s = this.fast.take();
    if (s.frames > 0) this.display = s;
  }

  /** Loudest channel RMS over the last full second (for Zabbix), -90 when there is no audio. */
  levelDb(): number {
    return this.status === 'live' && this.last ? Math.max(this.last.rms_db[0], this.last.rms_db[1]) : -90;
  }

  snapshot(now: number): InputSnapshot {
    return {
      id: this.cfg.id,
      name: this.cfg.name,
      kind: this.cfg.kind,
      status: this.status,
      detail: this.detail,
      meter: this.status === 'live' && (this.display ?? this.last)
        ? { peak_db: (this.display ?? this.last)!.peak_db, rms_db: (this.display ?? this.last)!.rms_db }
        : { peak_db: [-90, -90], rms_db: [-90, -90] },
      faults: this.tracker.active(),
      eas_active: this.easActive,
      silent_s: this.silentSince === null ? 0 : Math.max(0, Math.floor(now - this.silentSince)),
      recording: this.recording && this.status === 'live' && !this.recError,
      record_error: this.recording ? this.recError : '',
      chunk_minutes: this.cfg.chunk_minutes,
      idle_s: this.lastDataAt === null ? null : Math.max(0, Math.floor(now - this.lastDataAt)),
      up_since: this.upSince,
    };
  }
}
