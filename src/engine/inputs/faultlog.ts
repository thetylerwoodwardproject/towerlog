// Persistent fault log: one JSON object per line in <data>/faults.jsonl. Append
// only; the newest records are read back for the UI and the recording timeline.
import fs from 'node:fs';
import path from 'node:path';
import type { FaultRecord } from '../../lib/types.ts';

export class FaultLog {
  readonly file: string;
  constructor(dir: string) {
    this.file = path.join(dir, 'faults.jsonl');
    try { fs.mkdirSync(dir, { recursive: true }); } catch { /* append will fail quietly */ }
  }

  append(rec: FaultRecord): void {
    try { fs.appendFileSync(this.file, JSON.stringify(rec) + '\n'); } catch { /* best effort */ }
  }

  /** Newest first. Filters by input id when given. */
  read(opts: { input?: string; limit?: number; since?: number } = {}): FaultRecord[] {
    let text = '';
    try { text = fs.readFileSync(this.file, 'utf8'); } catch { return []; }
    const out: FaultRecord[] = [];
    const lines = text.split('\n');
    for (let i = lines.length - 1; i >= 0 && out.length < (opts.limit ?? 200); i--) {
      if (!lines[i]) continue;
      let r: FaultRecord;
      try { r = JSON.parse(lines[i]); } catch { continue; }
      if (opts.input && r.input !== opts.input) continue;
      if (opts.since !== undefined && r.at < opts.since) break;
      out.push(r);
    }
    return out;
  }
}
