// Logging: every line goes to stdout/stderr (journald) and, 
// to a named file under the log directory (towerlog.log, faults.log, email.log, ...).
// The newest lines are also kept in memory for the web UI.
import fs from 'node:fs';
import path from 'node:path';
import type { LogLine } from '../lib/types.ts';

const RING = 1000;

function stamp(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export class Logger {
  private ring: LogLine[] = [];
  private dirOk = false;

  constructor(readonly dir: string, private quiet = false) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      this.dirOk = true;
    } catch {
      this.dirOk = false;
    }
  }

  /** Append to a log file only (no console line). */
  file(name: string, msg: string): void {
    if (!this.dirOk) return;
    try {
      fs.appendFileSync(path.join(this.dir, name), `[${stamp()}] ${msg}\n`);
    } catch { /* best effort */ }
  }

  private emit(level: LogLine['level'], msg: string, file: string) {
    const line: LogLine = { t: Date.now(), level, file, msg };
    this.ring.push(line);
    if (this.ring.length > RING) this.ring.splice(0, this.ring.length - RING);
    if (!this.quiet) {
      const out = `[${stamp()}] ${msg}`;
      if (level === 'info') console.log(out);
      else console.error(out);
    }
    this.file(file, msg);
  }

  info(msg: string, file = 'towerlog.log') { this.emit('info', msg, file); }
  warn(msg: string, file = 'towerlog.log') { this.emit('warn', msg, file); }
  error(msg: string, file = 'towerlog.log') { this.emit('error', msg, file); }

  recent(limit = 300, file?: string): LogLine[] {
    const lines = file ? this.ring.filter((l) => l.file === file) : this.ring;
    return lines.slice(-limit);
  }

  /** Last lines of a log file on disk (for files written before this process started). */
  tail(name: string, maxLines = 300): string[] {
    if (!/^[a-z0-9._-]+\.log$/i.test(name)) return [];
    try {
      const fd = fs.openSync(path.join(this.dir, name), 'r');
      try {
        const size = fs.fstatSync(fd).size;
        const len = Math.min(size, 256 * 1024);
        const buf = Buffer.alloc(len);
        fs.readSync(fd, buf, 0, len, size - len);
        return buf.toString('utf8').split('\n').filter(Boolean).slice(-maxLines);
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      return [];
    }
  }

  files(): string[] {
    try {
      return fs.readdirSync(this.dir).filter((f) => f.endsWith('.log')).sort();
    } catch {
      return [];
    }
  }
}
