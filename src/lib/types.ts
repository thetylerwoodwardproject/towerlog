// Shapes shared by the engine (server) and the UI (browser). Keep this file free
// of Node imports so Svelte components can use it.

/** Live meter values: RMS and peak in dBFS per channel. */
export interface OutputMeter {
  peak_db: [number, number];
  rms_db: [number, number];
}

export interface ServiceStatus {
  /** Icecast source endpoint that source clients (encoders, ffmpeg) push to. */
  source: { enabled: boolean; port: number; push_inputs: number };
  zabbix: { enabled: boolean; server: string; last_ok: number | null; last_error: string; last_error_at: number | null };
  smtp: { enabled: boolean; problem: string; last_sent: number | null; last_error: string; last_error_at: number | null };
  snmp: {
    enabled: boolean; listening: boolean; error: string; requests: number; rejected: number; traps_sent: number;
    last_trap: number | null; last_trap_error: string; last_trap_error_at: number | null; engine_id: string;
  };
}

export interface Snapshot {
  type: 'snapshot';
  version: string;
  hostname: string;
  uptime_s: number;
  time: number;
  inputs: InputSnapshot[];
  services: ServiceStatus;
  /** Recordings disk, null when unknown. */
  disk: { free_gb: number; total_gb: number } | null;
  /** Configuration and disk warnings for the dashboard. */
  warnings: string[];
}

export interface LogLine {
  t: number;
  level: 'info' | 'warn' | 'error';
  file: string;
  msg: string;
}

export type InputStatus = 'stopped' | 'connecting' | 'live' | 'down';

export interface InputSnapshot {
  id: string;
  name: string;
  kind: 'http' | 'rtp' | 'livewire' | 'push';
  status: InputStatus;
  detail: string;
  /** Last second of audio, dBFS per channel. */
  meter: OutputMeter;
  /** Fault kinds currently raised (link, silence, clip, mono, phase). */
  faults: string[];
  /** Seconds below the silence threshold, 0 when not silent. */
  silent_s: number;
  recording: boolean;
  chunk_minutes: number;
  /** Seconds since the feed last delivered audio, null if it never has. */
  idle_s: number | null;
  /** Epoch seconds the current connection came up, null when down. */
  up_since: number | null;
}

export interface FaultRecord {
  input: string;
  name: string;
  kind: 'link' | 'silence' | 'clip' | 'mono' | 'phase';
  state: 'raised' | 'cleared';
  /** Epoch seconds. For `raised`, when the condition began; for `cleared`, when it ended. */
  at: number;
  /** Cleared records carry how long the fault lasted, in seconds. */
  duration?: number;
}
