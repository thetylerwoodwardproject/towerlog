// Recording folder layout: <recordings>/<NAME>/YYYY/MM/DD/<NAME>_YYMMDD_HHMM.<ext>.
// The files themselves are written by ffmpeg (see inputs/record.ts).
import path from 'node:path';

export function recName(name: string): string {
  const safe = String(name).trim().replace(/ /g, '_').replace(/[^A-Za-z0-9._-]/g, '');
  return safe.replace(/^\.+|\.+$/g, '') || 'input';
}

export const recordingDir = (root: string, name: string) => path.join(root, recName(name));

const p2 = (n: number) => String(n).padStart(2, '0');

export function dayDir(root: string, name: string, when: number): string {
  const d = new Date(when * 1000);
  return path.join(recordingDir(root, name), String(d.getFullYear()), p2(d.getMonth() + 1), p2(d.getDate()));
}
