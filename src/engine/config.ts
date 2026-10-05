// Configuration: one JSON file (default /etc/towerlog/config.json), validated with
// zod. Every field has a default so a partial or older file still loads, and the
// file is always rewritten atomically with mode 600 because it holds passwords.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { z } from 'zod';

export const MOUNT_RE = /^\/[A-Za-z0-9._\/-]*$/;

export function safeMount(text: string): string {
  let m = String(text).replace(/[^A-Za-z0-9/._-]/g, '');
  if (!m.startsWith('/')) m = '/' + m;
  return m;
}

const num = (def: number) => z.coerce.number().catch(def).default(def);
const int = (def: number, min = -Infinity, max = Infinity) =>
  z.coerce.number().int().min(min).max(max).catch(def).default(def);
const bool = (def: boolean) => z.boolean().catch(def).default(def);
const str = (def = '') => z.string().catch(def).default(def);

export { SILENCE_PRESETS } from '../lib/inputs.ts';

export const INPUT_KINDS = ['http', 'rtp', 'livewire', 'push'] as const;

/**
 * One logged audio feed. `http` pulls an Icecast/Shoutcast/HTTP stream (Barix,
 * Inovonics, anything with a URL), `rtp` listens for RTP on a unicast or
 * multicast address, `livewire` listens on the multicast group of a Livewire
 * channel number, `push` accepts an Icecast source client (for example an
 * encoder or ffmpeg) on `mount`.
 */
export const InputSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9._-]+$/),
  name: z.string().min(1).max(80),
  enabled: bool(true),
  kind: z.enum(INPUT_KINDS),
  /** http: stream URL. */
  url: str(),
  /** rtp: address to receive on (a multicast group joins it), port, payload. */
  address: str(),
  port: int(5004, 1, 65535),
  rtp_codec: z.enum(['l16', 'l24', 'pcmu', 'pcma', 'mp3']).catch('l24').default('l24'),
  /** http and push: what the feed carries, so recordings get the right file type ('other' = .mka). */
  stream_codec: z.enum(['mp3', 'aac', 'other']).catch('mp3').default('mp3'),
  /** RTP payload type for linear audio (a dynamic type; senders differ: 96, or 97 for Livewire-style). */
  rtp_payload: int(96, 96, 127),
  rtp_rate: int(48000, 8000, 192000),
  channels: int(2, 1, 2),
  /** livewire: channel number 1-32767. */
  livewire_channel: int(1, 1, 32767),
  /** push: Icecast mount the source client connects to, and its password. */
  mount: str(),
  source_password: str(),
  /** Minutes per recording file; files always start on the clock (:00, :15, :30, :45 for 15). */
  chunk_minutes: z.union([z.literal(15), z.literal(30), z.literal(60)]).catch(60).default(60),
  record: bool(true),
  /** 0 = keep until the disk fills. */
  keep_days: int(30, 0, 3650),
  /** Fault thresholds. Delays are seconds the condition must hold. */
  silence_db: num(-50),
  silence_secs: int(30, 1, 3600),
  link_secs: int(5, 1, 3600),
  clip_secs: int(10, 1, 3600),
  mono_secs: int(30, 1, 3600),
  detect_clip: bool(true),
  detect_mono: bool(false),
});
export type InputConfig = z.infer<typeof InputSchema>;

export const ZabbixSchema = z.object({
  enabled: bool(false),
  server: str(),
  port: int(10051, 1, 65535),
  hostname: str('towerlog'),
  key_event: str('towerlog.event'),
  key_active: str('towerlog.inputs_live'),
  key_heartbeat: str('towerlog.heartbeat'),
  interval: int(60, 10, 3600),
  level_monitor: bool(true),
});

export const SmtpSchema = z.object({
  enabled: bool(false),
  host: str(),
  port: int(587, 1, 65535),
  security: z.enum(['starttls', 'ssl', 'none']).catch('starttls').default('starttls'),
  verify_tls: bool(true),
  username: str(),
  password: str(),
  from: str(),
  to: str(),
  subject_prefix: str('[Towerlog]'),
  timeout: int(10, 1, 120),
  /** Email for logged-input faults (feed lost, silence, clipping, mono, phase). */
  alert_input: bool(true),
  alert_disk: bool(true),
  alert_service: bool(true),
  disk_min_gb: num(2),
});

export const TrapTargetSchema = z.object({
  host: z.string().trim().min(1),
  port: int(162, 1, 65535),
  version: z.enum(['v2c', 'v3']).catch('v2c').default('v2c'),
  /** v2c community; v3 traps use the agent's v3 user. */
  community: str('public'),
});

export const SnmpSchema = z.object({
  enabled: bool(false),
  port: int(161, 1, 65535),
  bind: str('0.0.0.0'),
  /** v2c read-only community; blank turns v2c off (v3 only). */
  community: str('public'),
  /** Comma-separated addresses / CIDRs allowed to query; blank = anyone. */
  allow: str(),
  v3_enabled: bool(false),
  v3_user: str('towerlog'),
  v3_auth: z.enum(['sha', 'sha256', 'sha512']).catch('sha').default('sha'),
  v3_auth_key: str(),
  v3_priv: z.enum(['aes', 'none']).catch('aes').default('aes'),
  v3_priv_key: str(),
  traps: z.array(z.unknown()).catch([]).default([]).transform((a) =>
    a.flatMap((t) => { const r = TrapTargetSchema.safeParse(t); return r.success ? [r.data] : []; }).slice(0, 4)),
  trap_input: bool(true),
  trap_disk: bool(true),
  trap_service: bool(true),
  /** Heartbeat trap interval in seconds; 0 = off. */
  heartbeat_secs: int(0, 0, 86400),
});

export const WebSchema = z.object({
  port: int(8090, 1, 65535),
  bind: str('0.0.0.0'),
  /** scrypt hash "scrypt$<salt>$<hash>"; empty = first visit asks for a password. */
  password_hash: str(),
  session_secret: str(),
  session_hours: int(168, 1, 8760),
});

/** Where Icecast source clients connect to push streams to push-kind inputs. */
export const SourceSchema = z.object({
  enabled: bool(true),
  port: int(8000, 1, 65535),
  bind: str('0.0.0.0'),
});

/** NTP servers chrony should use (blank = the host's own chrony defaults). Written to chrony's sources.d by clock.ts. */
export const ClockSchema = z.object({
  servers: z.array(z.string()).catch([]).default([]),
});

export const ConfigSchema = z.object({
  inputs: z.array(z.unknown()).catch([]).default([]),
  zabbix: ZabbixSchema.catch(ZabbixSchema.parse({})).default(ZabbixSchema.parse({})),
  smtp: SmtpSchema.catch(SmtpSchema.parse({})).default(SmtpSchema.parse({})),
  snmp: SnmpSchema.catch(SnmpSchema.parse({})).default(SnmpSchema.parse({})),
  web: WebSchema.catch(WebSchema.parse({})).default(WebSchema.parse({})),
  source: SourceSchema.catch(SourceSchema.parse({})).default(SourceSchema.parse({})),
  clock: ClockSchema.catch(ClockSchema.parse({})).default(ClockSchema.parse({})),
  recordings_dir: str(),
  /** Disk watermark: when free space falls under this many GB the oldest recordings are deleted (0 = off). */
  purge_min_free_gb: num(0),
});

export type ZabbixConfig = z.infer<typeof ZabbixSchema>;
export type SmtpConfig = z.infer<typeof SmtpSchema>;
export type SnmpConfig = z.infer<typeof SnmpSchema>;
export type TrapTarget = z.infer<typeof TrapTargetSchema>;
export type WebConfig = z.infer<typeof WebSchema>;
export type SourceConfig = z.infer<typeof SourceSchema>;
export type ClockConfig = z.infer<typeof ClockSchema>;
export interface Config {
  inputs: InputConfig[];
  zabbix: ZabbixConfig;
  smtp: SmtpConfig;
  snmp: SnmpConfig;
  web: WebConfig;
  source: SourceConfig;
  clock: ClockConfig;
  recordings_dir: string;
  purge_min_free_gb: number;
}

export interface Paths {
  config: string;
  data: string;
  logs: string;
}

export function defaultPaths(env: NodeJS.ProcessEnv = process.env): Paths {
  return {
    config: env.TOWERLOG_CONFIG || '/etc/towerlog/config.json',
    data: env.TOWERLOG_DATA || '/var/lib/towerlog',
    logs: env.TOWERLOG_LOG_DIR || '/var/log/towerlog',
  };
}

/** Validate inputs: bad ones are dropped with a reason; ids and push mounts must be unique. */
export function parseInputs(raw: unknown[], problems: string[], dropped: unknown[]): InputConfig[] {
  const out: InputConfig[] = [];
  const ids = new Set<string>();
  const mounts = new Set<string>();
  for (const s of raw) {
    const name = (s as { name?: string })?.name ?? '(unnamed)';
    const r = InputSchema.safeParse(s);
    if (!r.success) {
      problems.push(`input ${name}: ${r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
      dropped.push(s);
      continue;
    }
    const inp = r.data;
    const why = inputProblem(inp);
    if (why) { problems.push(`input ${name}: ${why}`); dropped.push(s); continue; }
    if (ids.has(inp.id)) { problems.push(`input ${name}: duplicate id ${inp.id}, skipped`); dropped.push(s); continue; }
    if (inp.kind === 'push') {
      inp.mount = safeMount(inp.mount);
      if (mounts.has(inp.mount)) { problems.push(`input ${name}: duplicate mount ${inp.mount}, skipped`); dropped.push(s); continue; }
      mounts.add(inp.mount);
    }
    ids.add(inp.id);
    out.push(inp);
  }
  return out;
}

/** What is missing for the input's kind, or '' when it is usable. */
export function inputProblem(i: InputConfig): string {
  if (i.kind === 'http' && !/^https?:\/\/[^\s]+$/i.test(i.url)) return 'needs an http(s) URL';
  if (i.kind === 'rtp' && !i.address) return 'needs an address to receive on';
  if (i.kind === 'push' && (!i.mount || i.mount === '/')) return 'needs a mount';
  if (i.kind === 'push' && !i.source_password) return 'needs a source password';
  return '';
}

/** Parse a raw object into a Config; invalid inputs are dropped (returned as-is in `dropped`) with a reason. */
export function parseConfig(raw: unknown): { config: Config; problems: string[]; dropped: unknown[] } {
  const problems: string[] = [];
  const dropped: unknown[] = [];
  const base = ConfigSchema.parse(raw ?? {});
  const inputs = parseInputs(base.inputs, problems, dropped);
  return { config: { ...base, inputs } as Config, problems, dropped };
}

export function writeFileAtomic(file: string, text: string, mode = 0o600): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.tmp`);
  let uid: number | undefined;
  let gid: number | undefined;
  try {
    const st = fs.statSync(file);
    uid = st.uid;
    gid = st.gid;
  } catch { /* new file */ }
  try {
    fs.writeFileSync(tmp, text, { mode });
    fs.chmodSync(tmp, mode);
    if (uid !== undefined && gid !== undefined) {
      try { fs.chownSync(tmp, uid, gid); } catch { /* not root: keep our owner */ }
    }
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    throw e;
  }
}

/** The config file exists but can't be used as it is; nothing is loaded or written. */
export class ConfigUnreadableError extends Error {
  constructor(readonly file: string, reason: string) {
    super(`cannot use ${file}: ${reason}. Nothing was changed. Fix the file (the previous version is ${file}.bak, if present) and start again.`);
  }
}

const SECTIONS = ['zabbix', 'smtp', 'snmp', 'web', 'source', 'clock'] as const;
const isObject = (v: unknown) => !!v && typeof v === 'object' && !Array.isArray(v);

/** Why a parsed file can't be loaded without losing a whole section, or null. */
function wrongShape(raw: unknown): string | null {
  if (!isObject(raw)) return 'not a JSON object';
  const r = raw as Record<string, unknown>;
  if ('inputs' in r && !Array.isArray(r.inputs)) return '"inputs" is not a list';
  for (const k of SECTIONS) if (k in r && !isObject(r[k])) return `"${k}" is not an object`;
  return null;
}

export class ConfigStore {
  config: Config;
  problems: string[] = [];
  /** True when load() had to invent the session secret (the file should be saved). */
  needsSave = false;
  /**
   * Inputs in the file that didn't load (invalid or duplicate). They are written
   * back unchanged on every save, so fixing one setting in the UI never deletes them.
   */
  private kept: unknown[] = [];
  private listeners = new Set<(c: Config) => void>();

  constructor(readonly file: string) {
    this.config = this.load();
  }

  load(): Config {
    // Only a missing file means "first run". Anything else that can't be read must
    // stop us: loading defaults would save them over the real file (stations,
    // credentials, password hash) and leave the web UI open to the first visitor.
    let raw: unknown = {};
    let text: string | null = null;
    try {
      text = fs.readFileSync(this.file, 'utf8');
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      if (err.code !== 'ENOENT') throw new ConfigUnreadableError(this.file, err.message);
    }
    if (text !== null) {
      try {
        raw = JSON.parse(text);
      } catch (e) {
        throw new ConfigUnreadableError(this.file, (e as Error).message);
      }
      const bad = wrongShape(raw);
      if (bad) throw new ConfigUnreadableError(this.file, bad);
    }
    const { config, problems, dropped } = parseConfig(raw);
    this.problems.push(...problems.map((p) => `${p} (left in the file, not loaded)`));
    this.kept = dropped;
    if (!config.web.session_secret) {
      config.web.session_secret = crypto.randomBytes(32).toString('hex');
      this.needsSave = true;
    }
    this.config = config;
    return config;
  }

  save(next: Config): void {
    const { config, problems } = parseConfig(next);
    if (problems.length) throw new Error(problems.join('\n'));
    // The previous version, for recovering from a bad edit (same mode: it holds passwords).
    try {
      fs.copyFileSync(this.file, this.file + '.bak');
      fs.chmodSync(this.file + '.bak', 0o600);
    } catch { /* first save, or not writable: the save itself reports that */ }
    writeFileAtomic(this.file, JSON.stringify({ ...config, inputs: [...config.inputs, ...this.kept] }, null, 2) + '\n');
    this.config = config;
    for (const fn of this.listeners) fn(config);
  }

  /** Apply a change to a deep copy of the config and save it. */
  update(fn: (c: Config) => void): Config {
    const copy = structuredClone(this.config);
    fn(copy);
    this.save(copy);
    return this.config;
  }

  onChange(fn: (c: Config) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}

const REDACTED = '********';
export const SECRET_PLACEHOLDER = REDACTED;

/** Config safe to send to the browser: passwords replaced by a placeholder. */
export function redactConfig(c: Config) {
  const copy = structuredClone(c) as Config;
  if (copy.smtp.password) copy.smtp.password = REDACTED;
  for (const i of copy.inputs) if (i.source_password) i.source_password = REDACTED;
  if (copy.snmp.v3_auth_key) copy.snmp.v3_auth_key = REDACTED;
  if (copy.snmp.v3_priv_key) copy.snmp.v3_priv_key = REDACTED;
  const { password_hash: _h, session_secret: _s, ...web } = copy.web;
  return { ...copy, web: { ...web, has_password: !!c.web.password_hash } };
}

/** The browser sent a secret (not the placeholder, not left out). */
export function secretGiven(incoming: unknown): boolean {
  return incoming !== REDACTED && incoming !== undefined && incoming !== null;
}

/** Keep the stored secret when the browser sends back the placeholder. */
export function keepSecret(incoming: unknown, current: string): string {
  if (incoming === REDACTED || incoming === undefined || incoming === null) return current;
  return String(incoming);
}
