// The host clock: status from chrony (chronyc, read-only) and the NTP sources the
// user chooses. Towerlog cuts recordings and stamps faults by this computer's
// clock, so it has to be right. Sources are written to a chrony "sourcedir" file
// (/etc/chrony/sources.d/towerlog.sources) and a systemd path unit runs
// `chronyc reload sources` as root when it changes; Towerlog itself needs no root.
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { execFile } from 'node:child_process';

export const SOURCES_DIR = process.env.TOWERLOG_CHRONY_DIR || '/etc/chrony/sources.d';
export const SOURCES_FILE = 'towerlog.sources';

/** Host name or IP address (no spaces, no shell or chrony option characters). */
export function validNtpServer(s: string): boolean {
  if (net.isIP(s) > 0) return true;
  return /^(?=.{1,253}$)([A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)*[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(s);
}

/** Split free text ("a, b  c") into trimmed, de-duplicated names. */
export function parseServers(text: string | string[]): string[] {
  const parts = Array.isArray(text) ? text : text.split(/[\s,]+/);
  return [...new Set(parts.map((s) => s.trim()).filter(Boolean))];
}

/** A pool name gets chrony's `pool` (several servers behind one name), anything else `server`. */
export const isPool = (host: string) => /(^|\.)pool\.ntp\.org$/i.test(host);

export function sourcesText(servers: string[]): string {
  const lines = servers.map((s) => `${isPool(s) ? 'pool' : 'server'} ${s} iburst`);
  return `# Written by Towerlog (Configuration -> Clock). Edits here are overwritten.\n${lines.join('\n')}${lines.length ? '\n' : ''}`;
}

export interface ClockStatus {
  /** chronyc answered. */
  available: boolean;
  reason: string;
  synchronized: boolean;
  /** chrony's leap status ("Normal", "Not synchronised", ...). */
  leap: string;
  stratum: number | null;
  /** Current system clock error against the reference, milliseconds (positive = clock ahead). */
  offset_ms: number | null;
  /** Reference the clock follows: name or address. */
  reference: string;
  /** Seconds since the last successful update, or null. */
  last_update_s: number | null;
}

export interface ClockSource { state: 'selected' | 'combined' | 'candidate' | 'rejected' | 'falseticker' | 'unreachable' | 'other'; address: string; stratum: number; reach: number; offset_ms: number }

const STATE: Record<string, ClockSource['state']> = { '*': 'selected', '+': 'combined', '-': 'candidate', '?': 'unreachable', x: 'falseticker', '~': 'rejected' };

/** Parse `chronyc -c tracking`. */
export function parseTracking(csv: string, nowS = Date.now() / 1000): Omit<ClockStatus, 'available' | 'reason'> | null {
  const f = csv.trim().split(',');
  if (f.length < 14) return null;
  const refName = f[1];
  const stratum = Number(f[2]);
  const refTime = Number(f[3]);
  const offset = Number(f[4]);
  const leap = f[13];
  const synchronized = leap === 'Normal' && stratum > 0 && stratum < 16;
  return {
    synchronized,
    leap,
    stratum: Number.isFinite(stratum) ? stratum : null,
    offset_ms: Number.isFinite(offset) ? Math.round(offset * 1e6) / 1000 : null,
    reference: refName && refName !== '' ? refName : f[0],
    last_update_s: refTime > 0 ? Math.max(0, Math.round(nowS - refTime)) : null,
  };
}

/** Parse `chronyc -c sources`. */
export function parseSources(csv: string): ClockSource[] {
  const out: ClockSource[] = [];
  for (const line of csv.split('\n')) {
    const f = line.trim().split(',');
    if (f.length < 10) continue;
    out.push({
      state: STATE[f[1]] ?? 'other', address: f[2], stratum: Number(f[3]), reach: parseInt(f[5], 8) || 0,
      offset_ms: Math.round(Number(f[8]) * 1e6) / 1000,
    });
  }
  return out;
}

function run(bin: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout: 4000 }, (err, stdout) => (err ? reject(err) : resolve(String(stdout))));
  });
}

export type Runner = (bin: string, args: string[]) => Promise<string>;

export async function readClock(exec: Runner = run): Promise<{ status: ClockStatus; sources: ClockSource[] }> {
  const none = (reason: string): ClockStatus => ({ available: false, reason, synchronized: false, leap: '', stratum: null, offset_ms: null, reference: '', last_update_s: null });
  try {
    const t = parseTracking(await exec('chronyc', ['-c', 'tracking']));
    if (!t) return { status: none('chronyc gave an unexpected answer'), sources: [] };
    const sources = parseSources(await exec('chronyc', ['-c', 'sources']).catch(() => ''));
    return { status: { available: true, reason: '', ...t }, sources };
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    return { status: none(code === 'ENOENT' ? 'chrony is not installed on this host' : `chronyc failed: ${(e as Error).message.split('\n')[0]}`), sources: [] };
  }
}

/** Can the sources file be written here? Returns '' or the reason. */
export function sourcesWritable(dir = SOURCES_DIR): string {
  try {
    fs.accessSync(dir, fs.constants.W_OK);
    return '';
  } catch {
    return fs.existsSync(dir) ? `${dir} is not writable by Towerlog (re-run the installer)` : `${dir} does not exist (is chrony installed?)`;
  }
}

export function writeSources(servers: string[], dir = SOURCES_DIR): void {
  for (const s of servers) if (!validNtpServer(s)) throw Object.assign(new Error(`${s} is not a host name or IP address`), { status: 400 });
  fs.writeFileSync(path.join(dir, SOURCES_FILE), sourcesText(servers));
}
