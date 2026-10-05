// Browser-safe helpers for logged inputs (no Node imports).
import type { InputSnapshot } from './types.ts';
import type { Tone } from './health.ts';

/** Offered in the UI for how long silence must last before alerting; any 1-3600 s value is accepted. */
export const SILENCE_PRESETS = [5, 10, 30, 60, 120, 300, 600] as const;

export const FAULT_TEXT: Record<string, string> = {
  link: 'Feed lost',
  silence: 'Silence',
  clip: 'Clipping',
  mono: 'Mono',
  phase: 'Out of phase',
};

export const KIND_TEXT: Record<string, string> = {
  http: 'Stream URL',
  rtp: 'RTP',
  livewire: 'Livewire',
  push: 'Encoder → Towerlog',
};

export const INPUT_STATUS_TEXT: Record<string, string> = {
  live: 'live',
  connecting: 'connecting',
  down: 'down',
  stopped: 'stopped',
};

export function inputTone(i: InputSnapshot): Tone {
  if (i.status === 'stopped') return 'muted';
  if (i.status === 'down' || i.faults.includes('link')) return 'bad';
  if (i.faults.length) return 'warn';
  return i.status === 'live' ? 'ok' : 'info';
}

export function fmtSecs(s: number): string {
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

export const silenceLabel = (s: number) => (s < 60 ? `${s} seconds` : s % 60 === 0 ? `${s / 60} minute${s === 60 ? '' : 's'}` : `${s} seconds`);
