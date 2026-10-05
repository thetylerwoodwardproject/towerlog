// EAS history: decoded SAME messages and attention tones, kept in memory for the
// UI and appended to <data>/eas/messages.jsonl (one JSON object per line) so the
// history survives restarts. Each entry notes which recording file holds the audio.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { SameMessage } from './inputs/same.ts';

export interface EasEntry extends Partial<SameMessage> {
  id: string;
  /** 'message': a SAME header was decoded. 'tone': only the attention tone was heard (no header decoded). */
  kind: 'message' | 'tone';
  /** When Towerlog heard it (ISO). */
  received: string;
  input: string;
  input_name: string;
  /** Start (epoch s) of the clock-cut recording chunk that holds the audio, and its length; 0 when the input does not record. */
  chunk_start: number;
  chunk_minutes: number;
  /** When the end-of-message (NNNN) was heard, if it was. */
  eom?: string;
}

const KEEP = 2000;
/** A tone this soon after a decoded header on the same input is that message's tone, not a separate event. */
const TONE_AFTER_HEADER_MS = 120_000;

/** Start of the recording chunk containing `epochSecs` (chunks are cut on the clock). */
export function chunkStart(epochSecs: number, chunkMinutes: number): number {
  const len = chunkMinutes * 60;
  return Math.floor(epochSecs / len) * len;
}

export class EasLog {
  entries: EasEntry[] = [];
  readonly file: string;

  constructor(dataDir: string) {
    this.file = path.join(dataDir, 'eas', 'messages.jsonl');
    try {
      const lines = fs.readFileSync(this.file, 'utf8').split('\n').filter(Boolean).slice(-KEEP);
      for (const l of lines) {
        try { this.entries.push(JSON.parse(l)); } catch { /* skip bad line */ }
      }
    } catch { /* first run */ }
  }

  add(e: Omit<EasEntry, 'id' | 'received'>): EasEntry {
    const entry: EasEntry = { id: crypto.randomBytes(6).toString('hex'), received: new Date().toISOString(), ...e };
    this.entries.push(entry);
    if (this.entries.length > KEEP) this.entries.splice(0, this.entries.length - KEEP);
    this.append(entry);
    return entry;
  }

  /** Mark the newest open message on this input as ended. */
  endOfMessage(input: string): EasEntry | null {
    for (let i = this.entries.length - 1; i >= 0; i--) {
      const e = this.entries[i];
      if (e.input !== input || e.kind !== 'message') continue;
      if (e.eom || Date.now() - Date.parse(e.received) > 30 * 60000) return null;
      e.eom = new Date().toISOString();
      this.append({ ...e });
      return e;
    }
    return null;
  }

  /** True when a header was decoded on this input in the last two minutes. */
  recentMessage(input: string, now = Date.now()): boolean {
    return this.entries.some((e) => e.input === input && e.kind === 'message' && now - Date.parse(e.received) < TONE_AFTER_HEADER_MS);
  }

  private append(e: EasEntry) {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.appendFileSync(this.file, JSON.stringify(e) + '\n');
    } catch { /* best effort */ }
  }

  /** Newest first; EOM updates collapse into their message, and a tone that came with a decoded header is dropped. */
  list(opts: { input?: string; limit?: number } = {}): EasEntry[] {
    const byId = new Map<string, EasEntry>();
    for (const e of this.entries) byId.set(e.id, e);
    const all = [...byId.values()];
    const headers = all.filter((e) => e.kind === 'message');
    const withHeader = (t: EasEntry) => headers.some((h) => {
      const dt = Date.parse(t.received) - Date.parse(h.received);
      return h.input === t.input && dt >= 0 && dt < TONE_AFTER_HEADER_MS;
    });
    return all
      .filter((e) => !opts.input || e.input === opts.input)
      .filter((e) => e.kind === 'message' || !withHeader(e))
      .sort((a, b) => b.received.localeCompare(a.received))
      .slice(0, opts.limit ?? 500);
  }
}
