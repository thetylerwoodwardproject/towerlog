// Recording arguments: one ffmpeg per input writes the original audio in files
// cut on the clock (segment muxer, no re-encode) and, from the same process,
// raw PCM on stdout for the level meter and fault detectors.
import fs from 'node:fs';
import path from 'node:path';
import type { InputConfig } from '../config.ts';
import { dayDir, recName } from '../recorder.ts';
import { ANALYSIS_SUFFIX } from './analyze.ts';
import { METER_CHANNELS, METER_RATE, type Source } from './args.ts';

/** strftime pattern for a chunk: <root>/<NAME>/YYYY/MM/DD/<NAME>_YYMMDD_HHMM.<ext> */
export function segmentPattern(root: string, name: string, ext: string): string {
  const n = recName(name);
  const esc = (s: string) => s.replace(/%/g, '%%');
  return path.join(esc(root), esc(n), '%Y', '%m', '%d', `${esc(n)}_%y%m%d_%H%M.${ext}`);
}

export function ffmpegArgs(cfg: InputConfig, src: Source, recordRoot: string | null): string[] {
  const args = ['-hide_banner', '-loglevel', 'warning', '-nostdin', ...src.args];
  if (src.stdin) args.splice(args.indexOf('-nostdin'), 1);
  if (cfg.record && recordRoot) {
    args.push(
      '-map', '0:a:0', '-c:a', src.record.codec === 'flac' ? 'flac' : 'copy',
      '-f', 'segment', '-segment_format', src.record.format,
      '-segment_atclocktime', '1', '-segment_time', String(cfg.chunk_minutes * 60),
      '-reset_timestamps', '1', '-strftime', '1',
      segmentPattern(recordRoot, cfg.name, src.record.ext),
    );
  }
  args.push('-map', '0:a:0', '-ac', String(METER_CHANNELS), '-ar', String(METER_RATE), '-f', 's16le', 'pipe:1');
  return args;
}

/**
 * The segment muxer cannot create folders, so today's and tomorrow's must exist
 * before a cut needs them. Call at start and from the once-a-second tick. Throws when the
 * recordings folder is missing or unwritable.
 */
export function ensureDayDirs(root: string, name: string, now: number): void {
  // Never create the recordings folder itself: a missing one means an unplugged or unmounted
  // drive, and recreating it would quietly fill the system disk instead.
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    throw new Error(`recordings folder ${root} is missing (is the drive mounted?)`);
  }
  for (const when of [now, now + 86400]) fs.mkdirSync(dayDir(root, name, when), { recursive: true });
}

/** Delete a recording and its cached analysis. */
function unlinkChunk(p: string) {
  fs.unlinkSync(p);
  try { fs.unlinkSync(p + ANALYSIS_SUFFIX); } catch { /* none */ }
}

export const AUDIO_EXT = /\.(mp3|aac|flac|mka)$/;

export interface Chunk { path: string; mtime: number; size: number }

/** Every recording file under one input's folder (or the whole root), oldest first. */
export function listChunks(base: string): Chunk[] {
  const out: Chunk[] = [];
  const walk = (dir: string) => {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (AUDIO_EXT.test(e.name)) {
        try { const st = fs.statSync(p); out.push({ path: p, mtime: st.mtimeMs / 1000, size: st.size }); } catch { /* gone */ }
      }
    }
  };
  walk(base);
  return out.sort((a, b) => a.mtime - b.mtime);
}

function removeEmptyDirs(base: string) {
  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) if (e.isDirectory()) walk(path.join(dir, e.name));
    if (dir !== base) { try { fs.rmdirSync(dir); } catch { /* not empty */ } }
  };
  walk(base);
}

/** Delete one input's files older than keepDays (0 = keep). Returns how many went. */
export function pruneInput(root: string, name: string, keepDays: number, now = Date.now() / 1000): number {
  if (keepDays <= 0) return 0;
  const base = path.join(root, recName(name));
  let removed = 0;
  for (const c of listChunks(base)) {
    if (c.mtime >= now - keepDays * 86400) break;
    try { unlinkChunk(c.path); removed++; } catch { /* ignore */ }
  }
  if (removed) removeEmptyDirs(base);
  return removed;
}

/**
 * Disk watermark: while free space is under `minFreeBytes`, delete the oldest
 * recording across all inputs, but never one younger than `protectSecs` (so a
 * full disk cannot eat the file being written). Returns bytes freed.
 */
export function purgeForSpace(
  root: string,
  minFreeBytes: number,
  free: (p: string) => number,
  now = Date.now() / 1000,
  protectSecs = 2 * 3600,
): number {
  if (free(root) >= minFreeBytes) return 0;
  let freed = 0;
  for (const c of listChunks(root)) {
    if (free(root) >= minFreeBytes) break;
    if (c.mtime > now - protectSecs) break;
    try { unlinkChunk(c.path); freed += c.size; } catch { continue; }
  }
  if (freed) removeEmptyDirs(root);
  return freed;
}
