// Child process wrapper: spawn without a shell, collect stderr lines for the log
// and an input's status detail, and stop with SIGTERM → SIGKILL.
import { spawn, type ChildProcess, type StdioOptions } from 'node:child_process';
import type { Logger } from './logger.ts';

export class Proc {
  readonly child: ChildProcess;
  exitCode: number | null = null;
  exitSignal: NodeJS.Signals | null = null;
  exited = false;
  spawnError: Error | null = null;
  /** Last few stderr lines, for "why did it stop" details. */
  lastLines: string[] = [];
  private exitWaiters: (() => void)[] = [];
  private partial = '';
  private logged = 0;

  constructor(
    readonly label: string,
    readonly bin: string,
    readonly args: string[],
    stdio: StdioOptions,
    private log: Logger,
    private onExit?: (p: Proc) => void,
    /** Sees every stderr line; return false to keep it out of the log file. */
    private onStderrLine?: (line: string) => boolean | void,
  ) {
    this.child = spawn(bin, args, { stdio, detached: false });
    this.child.on('error', (e) => {
      this.spawnError = e;
      this.lastLines.push(`${bin}: ${e.message}`);
      this.markExit();
    });
    this.child.on('exit', (code, signal) => {
      this.exitCode = code;
      this.exitSignal = signal;
      this.markExit();
    });
    this.child.stderr?.on('data', (d: Buffer) => this.stderr(d));
    // Writes after the child dies raise EPIPE on the stream; the exit handler
    // already reports it.
    for (const s of this.child.stdio) {
      if (s && 'on' in s) s.on('error', () => { /* handled via exit */ });
    }
  }

  private stderr(d: Buffer) {
    this.partial += d.toString('utf8');
    let nl: number;
    while ((nl = this.partial.indexOf('\n')) >= 0) {
      const line = this.partial.slice(0, nl).replace(/\r/g, '').trim();
      this.partial = this.partial.slice(nl + 1);
      if (!line) continue;
      if (this.onStderrLine && this.onStderrLine(line) === false) continue;
      this.lastLines.push(line);
      if (this.lastLines.length > 8) this.lastLines.shift();
      // Keep chatty tools from flooding the log: first 40 lines, then 1 in 100.
      if (this.logged < 40 || this.logged % 100 === 0) this.log.file('towerlog.log', `${this.label}: ${line}`);
      this.logged++;
    }
    if (this.partial.length > 4096) this.partial = this.partial.slice(-1024);
  }

  private markExit() {
    if (this.exited) return;
    this.exited = true;
    for (const w of this.exitWaiters.splice(0)) w();
    this.onExit?.(this);
  }

  /** Short human reason for the exit, e.g. "ffmpeg:studio-a exited (code 1): Connection refused". */
  describe(): string {
    const how = this.spawnError
      ? `could not start (${this.spawnError.message})`
      : this.exitSignal ? `killed by ${this.exitSignal}` : `exited (code ${this.exitCode})`;
    // Prefer the line that names the problem over ffmpeg's generic last words.
    const lines = this.lastLines.filter((l) => l.trim() && !/^Conversion failed!?$/.test(l.trim()));
    const last = [...lines].reverse().find((l) => /error|refused|denied|unauthori|forbidden|not found|failed|usb/i.test(l)) ?? lines.at(-1);
    return `${this.label} ${how}${last && !this.spawnError ? `: ${last}` : ''}`;
  }

  waitExit(): Promise<void> {
    if (this.exited) return Promise.resolve();
    return new Promise((r) => this.exitWaiters.push(r));
  }

  async stop(graceMs = 3000): Promise<void> {
    if (this.exited) return;
    this.onExit = undefined;
    try { this.child.kill('SIGTERM'); } catch { /* gone */ }
    const t = setTimeout(() => { try { this.child.kill('SIGKILL'); } catch { /* gone */ } }, graceMs);
    await this.waitExit();
    clearTimeout(t);
  }
}

/** Splits a byte stream into newline-terminated text lines. */
export class LineSplitter {
  private buf = '';
  constructor(private onLine: (line: string) => void) {}
  push(d: Buffer | string) {
    this.buf += typeof d === 'string' ? d : d.toString('utf8');
    let nl: number;
    while ((nl = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, nl);
      this.buf = this.buf.slice(nl + 1);
      if (line.trim()) this.onLine(line);
    }
    if (this.buf.length > 1 << 20) this.buf = '';
  }
}

/** Re-chunks a byte stream into whole frames (bytesPerFrame) so samples never split. */
export class FrameAligner {
  private rest: Buffer = Buffer.alloc(0);
  constructor(readonly bytesPerFrame: number) {}
  push(d: Buffer): Buffer | null {
    const buf = this.rest.length ? Buffer.concat([this.rest, d]) : d;
    const whole = buf.length - (buf.length % this.bytesPerFrame);
    this.rest = whole < buf.length ? Buffer.from(buf.subarray(whole)) : Buffer.alloc(0);
    return whole > 0 ? buf.subarray(0, whole) : null;
  }
}
