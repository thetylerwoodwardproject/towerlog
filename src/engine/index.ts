// The Towerlog engine: supervises every logged input, talks to Zabbix, SNMP and
// SMTP, and produces the live snapshot the web UI renders. One instance per
// process; the HTTP server (server/index.ts, or the dev integration) creates it
// and the Astro API routes reach it through getEngine().
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import type { Analysis, FaultRecord, InputSnapshot, LogLine, Snapshot } from '../lib/types.ts';
import {
  ConfigStore, InputSchema, ZabbixSchema, SmtpSchema, SnmpSchema, defaultPaths, keepSecret,
  inputProblem, redactConfig, safeMount, writeFileAtomic, secretGiven,
  type Config, type Paths, type InputConfig,
} from './config.ts';
import { Logger } from './logger.ts';
import { Mailer } from './mailer.ts';
import { AlertManager, defaultDiskUsage, fmtDuration, fmtTime } from './alerts.ts';
import { ZabbixSender, inputKey, KEY_INPUT_DISCOVERY, type Item } from './zabbix.ts';
import { buildTemplate } from './zabbix-template.ts';
import { SnmpService } from './snmp.ts';
import { buildMib, type TrapName } from './snmp-mib.ts';
import { LogInput } from './inputs/input.ts';
import { FaultLog } from './inputs/faultlog.ts';
import { EasLog, chunkStart, type EasEntry } from './eas-log.ts';
import type { SameMessage } from './inputs/same.ts';
import { listChunks, purgeForSpace } from './inputs/record.ts';
import { analyzeFile, readCached, writeCached } from './inputs/analyze.ts';
import { FAULT_LABEL } from './faults.ts';
import { parseServers, readClock, sourcesWritable, writeSources, validNtpServer, type ClockSource, type ClockStatus } from './clock.ts';
import { recName, recordingDir } from './recorder.ts';
import { hashPassword, verifyPassword, signSession, verifySession, sessionNonce } from './auth.ts';

/** Release version, by date (git tag v2026.10.04); package.json carries the semver form 2026.10.4. */
export const VERSION = '2026.10.04';
const SNAPSHOT_MS = 200;
const LEVEL_SECS = 10;
const PURGE_SECS = 300;
const DISK_CACHE_SECS = 30;

function which(bin: string): string | null {
  const dirs = [...(process.env.PATH || '').split(':'), '/usr/local/bin', '/usr/bin', '/bin'];
  for (const d of dirs) {
    if (!d) continue;
    const p = path.join(d, bin);
    try {
      fs.accessSync(p, fs.constants.X_OK);
      return p;
    } catch { /* next */ }
  }
  return null;
}

export class Engine {
  readonly paths: Paths;
  readonly log: Logger;
  readonly store: ConfigStore;
  readonly started = Date.now();
  inputs = new Map<string, LogInput>();
  faultLog!: FaultLog;
  easLog!: EasLog;
  /** Last EAS tone or message heard (text, epoch ms) for the dashboard banner. */
  easLast = { text: '', at: null as number | null };
  zbx!: ZabbixSender;
  mailer!: Mailer;
  snmp!: SnmpService;
  private snmpKey = '';
  private nextSnmpDisk = 0;
  private snmpDiskLow = false;
  alerts!: AlertManager;
  toolPaths: Record<string, string | null> = {};
  latest: Snapshot | null = null;
  private clockCache: { at: number; status: ClockStatus | null } = { at: 0, status: null };
  private disk: { at: number; value: { free_gb: number; total_gb: number } | null } = { at: 0, value: null };
  private timers: NodeJS.Timeout[] = [];
  private subscribers = new Set<(s: Snapshot) => void>();
  /** revoked: logged-out session nonces -> expiry (epoch s). */
  private state: { revoked: Record<string, number> } = { revoked: {} };
  private nextHeartbeat = 0;
  private nextLevel = 0;
  private nextPurge = 0;
  private running = false;

  constructor(paths: Paths = defaultPaths()) {
    this.paths = paths;
    this.log = new Logger(paths.logs);
    try { fs.mkdirSync(paths.data, { recursive: true }); } catch { /* reported when used */ }
    this.store = new ConfigStore(paths.config);
    if (this.store.needsSave) {
      try { this.store.save(this.store.config); } catch (e) { this.log.warn(`cannot write ${paths.config}: ${(e as Error).message}`); }
    }
    for (const p of this.store.problems) this.log.warn(`config: ${p}`);
    this.loadState();
    this.faultLog = new FaultLog(paths.data);
    this.easLog = new EasLog(paths.data);
    this.toolPaths = { ffmpeg: which('ffmpeg'), multimon: which('multimon-ng') };
    this.applyServices(this.store.config);
  }

  get config(): Config { return this.store.config; }

  private loadState() {
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(this.paths.data, 'state.json'), 'utf8'));
      if (raw && raw.revoked && typeof raw.revoked === 'object') this.state.revoked = raw.revoked;
    } catch { /* first run */ }
  }

  private saveState() {
    try {
      writeFileAtomic(path.join(this.paths.data, 'state.json'), JSON.stringify(this.state, null, 2), 0o644);
    } catch (e) {
      this.log.warn(`cannot save state: ${(e as Error).message}`);
    }
  }

  /** (Re)create the Zabbix sender and mailer from the current config. */
  private applyServices(c: Config) {
    this.zbx = new ZabbixSender(c.zabbix, this.log);
    this.mailer = new Mailer(c.smtp, this.log);
    if (this.alerts) this.alerts.mailer = this.mailer;
    else this.alerts = new AlertManager(this.mailer);
    // The SNMP agent owns a UDP port: only rebuild it when its settings change.
    const key = JSON.stringify(c.snmp);
    if (key !== this.snmpKey) {
      this.snmpKey = key;
      this.snmp?.close();
      this.snmp = new SnmpService(c.snmp, this.log);
      if (this.running) this.snmp.start(this.snmpSource);
    }
  }

  private snmpSource = () => ({ snap: this.latest ?? this.buildSnapshot(), eas: this.easLog.entries.findLast((e) => e.kind === 'message') });

  recordingsRoot = () => this.config.recordings_dir || path.join(this.paths.data, 'recordings');

  // ------------------------------------------------------------ lifecycle

  async start() {
    if (this.running) return;
    this.running = true;
    this.log.info(`Towerlog ${VERSION} starting (config ${this.paths.config})`);
    if (!this.toolPaths.ffmpeg) this.log.warn('ffmpeg not found on this system: no input can run');
    this.store.onChange((c) => this.onConfigChange(c));
    this.syncInputs(this.config);
    this.writeClockSources();
    void this.refreshClock();
    this.alerts.serviceStarted(Object.fromEntries([...this.inputs.values()].map((i) => [i.cfg.name, i.status])));
    this.snmp.start(this.snmpSource);
    this.snmp.trap('serviceStarted', null, `Towerlog ${VERSION} started on ${os.hostname()} with ${this.inputs.size} input(s)`);
    const now = Date.now() / 1000;
    this.nextHeartbeat = now + this.config.zabbix.interval;
    this.nextLevel = now + LEVEL_SECS;
    this.nextPurge = now + 60;
    this.timers.push(setInterval(() => this.supervise(), 1000));
    this.timers.push(setInterval(() => this.publish(), SNAPSHOT_MS));
  }

  async shutdown() {
    if (!this.running) return;
    this.running = false;
    this.log.info('shutting down');
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    this.snmp.trap('serviceStopped', null, `Towerlog is stopping on ${os.hostname()}`);
    await this.alerts.serviceStopped();
    this.snmp.close();
    await Promise.all([...this.inputs.values()].map((i) => i.stop()));
    await this.zbx.send([[this.config.zabbix.key_event, 'Towerlog stopped']]);
    this.log.info('stopped');
  }

  private onConfigChange(c: Config) {
    this.applyServices(c);
    this.syncInputs(c);
  }

  /** Create, restart or remove LogInput objects to match the config. */
  private syncInputs(c: Config) {
    const wanted = new Map<string, InputConfig>(c.inputs.map((i) => [i.id, i]));
    for (const [id, inp] of this.inputs) {
      if (wanted.has(id) && JSON.stringify(inp.cfg) === JSON.stringify(wanted.get(id))) continue;
      this.inputs.delete(id);
      void inp.stop();
      this.log.info(`input ${inp.cfg.name}: ${wanted.has(id) ? 'settings changed, restarting' : 'removed'}`);
    }
    for (const cfg of c.inputs) {
      if (this.inputs.has(cfg.id)) continue;
      const inp = new LogInput(structuredClone(cfg), {
        recordRoot: this.recordingsRoot(),
        workDir: path.join(this.paths.data, 'sdp'),
        log: this.log,
        faults: this.faultLog,
        bin: this.toolPaths.ffmpeg ?? 'ffmpeg',
        onFault: (rec) => this.onInputFault(rec),
        multimonBin: this.toolPaths.multimon,
        onEasTone: (i, active) => this.onEasTone(i, active),
        onSame: (i, msg) => this.onSame(i, msg),
      });
      this.inputs.set(cfg.id, inp);
      if (this.running) inp.start();
    }
    this.inputs = new Map(c.inputs.map((i) => [i.id, this.inputs.get(i.id)!]));
  }

  /** SIGHUP: restart every input (re-reads nothing but reconnects every feed). */
  async restartInputs() {
    await Promise.all([...this.inputs.values()].map(async (i) => { await i.stop(); i.start(); }));
  }

  /** The running push input for an Icecast mount (used by the source endpoint). */
  pushInput(mount: string): LogInput | undefined {
    for (const i of this.inputs.values()) if (i.cfg.kind === 'push' && i.cfg.enabled && i.cfg.mount === mount) return i;
    return undefined;
  }

  private trap(name: TrapName, id: string | null, subjectName: string, text: string, eas?: EasEntry) {
    this.snmp.trap(name, id ? { id, name: subjectName } : null, text, eas);
  }

  /** The attention tone started or ended on an input: log it, mail it, trap it, and pulse the Zabbix items. */
  private onEasTone(inp: LogInput, active: boolean) {
    const { id, name } = inp.cfg;
    const items: Item[] = [[this.config.zabbix.key_eas, active ? 1 : 0], [inputKey('eas', id), active ? 1 : 0]];
    if (active) {
      const msg = `EAS attention tone heard on ${name}`;
      this.log.warn(msg, 'eas.log');
      // The header is heard before the tone; keep its description (event, areas) on the dashboard.
      if (!this.easLog.recentMessage(id)) this.easLast = { text: msg, at: Date.now() };
      const now = Date.now() / 1000;
      this.easLog.add({ kind: 'tone', input: id, input_name: name, ...this.chunkOf(inp, now) });
      items.push([this.config.zabbix.key_event, msg]);
      this.alerts.eas(name, now);
      this.trap('easTone', id, name, msg);
    }
    void this.zbx.send(items, active);
  }

  /** A decoded SAME header (msg), or its end-of-message (null). */
  private onSame(inp: LogInput, msg: SameMessage | null) {
    const { id, name } = inp.cfg;
    if (!msg) {
      const e = this.easLog.endOfMessage(id);
      if (e) this.log.info(`EAS end of message on ${name} (${e.event_name})`, 'eas.log');
      return;
    }
    const entry = this.easLog.add({ kind: 'message', ...msg, input: id, input_name: name, ...this.chunkOf(inp, Date.now() / 1000) });
    const text = `EAS ${msg.event_name} on ${name}: ${msg.summary}`;
    this.log.warn(`${text} [${msg.raw}]`, 'eas.log');
    this.easLast = { text, at: Date.now() };
    void this.zbx.send([[this.config.zabbix.key_event, text], [inputKey('eas.message', id), `${msg.event_name}: ${msg.summary}`]], true);
    this.alerts.easMessage(name, entry);
    this.trap('easMessage', id, name, text, entry);
  }

  /** Which recording chunk holds audio heard now (0 when the input is not recording). */
  private chunkOf(inp: LogInput, now: number) {
    const rec = inp.cfg.record;
    return { chunk_start: rec ? chunkStart(now, inp.cfg.chunk_minutes) : 0, chunk_minutes: rec ? inp.cfg.chunk_minutes : 0 };
  }

  private onInputFault(rec: FaultRecord) {
    const raised = rec.state === 'raised';
    const what = FAULT_LABEL[rec.kind];
    const text = raised
      ? `${rec.name}: ${what} since ${fmtTime(rec.at)}`
      : `${rec.name}: ${what} cleared after ${fmtDuration(rec.duration ?? 0)}`;
    this.log.warn(text);
    void this.zbx.send([[this.config.zabbix.key_event, text], [inputKey(`fault.${rec.kind}`, rec.input), raised ? 1 : 0]], true);
    this.trap(raised ? 'inputFault' : 'inputCleared', rec.input, rec.name, text);
    if (this.mailer.enabled && this.config.smtp.alert_input) {
      this.mailer.send(`${rec.name}: ${raised ? what.toUpperCase() : `${what} cleared`}`,
        `${text}\n\nInput: ${rec.name} (${rec.input})\nFault: ${what}\n` +
        (raised ? `Began: ${fmtTime(rec.at)}\n` : `Ended: ${fmtTime(rec.at)}\nLasted: ${fmtDuration(rec.duration ?? 0)}\n`));
    }
  }

  private supervise() {
    try {
      const now = Date.now() / 1000;
      for (const inp of this.inputs.values()) inp.tick(now);
      const recording = this.config.inputs.some((i) => i.record && i.enabled);
      this.alerts.checkDisk(now, this.recordingsRoot(), recording);
      this.snmp.tick(now);
      this.checkSnmpDisk(now, recording);
      if (now >= this.nextLevel) {
        this.nextLevel = now + LEVEL_SECS;
        this.sendLevels();
      }
      if (now >= this.nextHeartbeat) {
        this.nextHeartbeat = now + this.config.zabbix.interval;
        void this.sendHeartbeat();
      }
      if (now >= this.nextPurge) {
        this.nextPurge = now + PURGE_SECS;
        this.purgeDisk(now);
      }
      if (now - this.clockCache.at > 30) void this.refreshClock();
    } catch (e) {
      this.log.error(`supervisor: ${(e as Error).stack || e}`);
    }
  }

  /** Disk watermark: delete the oldest recordings while free space is under purge_min_free_gb. */
  private purgeDisk(now: number) {
    const gb = this.config.purge_min_free_gb;
    if (gb <= 0) return;
    const root = this.recordingsRoot();
    try {
      const freed = purgeForSpace(root, gb * 1024 ** 3, (p) => defaultDiskUsage(p).free, now);
      if (freed) this.log.warn(`disk watermark: deleted the oldest recordings (${(freed / 1024 ** 3).toFixed(1)} GB) to keep ${gb} GB free`);
    } catch (e) {
      this.log.warn(`disk watermark purge failed: ${(e as Error).message}`);
    }
  }

  /** Low-disk trap: same level as the email alert (smtp.disk_min_gb), checked every 5 minutes while recording. */
  private checkSnmpDisk(now: number, recording: boolean) {
    if (now < this.nextSnmpDisk || !this.snmp.trapsOn || !recording) return;
    this.nextSnmpDisk = now + 300;
    let freeGb: number;
    try { freeGb = defaultDiskUsage(this.recordingsRoot()).free / 1024 ** 3; } catch { return; }
    const min = this.config.smtp.disk_min_gb;
    if (!this.snmpDiskLow && freeGb < min) {
      this.snmpDiskLow = true;
      this.trap('diskLow', null, '', `Only ${freeGb.toFixed(1)} GB free for recordings (alert level ${min} GB)`);
    } else if (this.snmpDiskLow && freeGb >= min * 1.25) {
      this.snmpDiskLow = false;
      this.trap('diskOk', null, '', `${freeGb.toFixed(1)} GB free for recordings again`);
    }
  }

  private sendLevels() {
    const items: Item[] = [];
    for (const inp of this.inputs.values()) {
      items.push([inputKey('level', inp.cfg.id), inp.levelDb()]);
    }
    if (this.config.zabbix.level_monitor) void this.zbx.send(items);
  }

  async sendHeartbeat() {
    if (!this.zbx.enabled) return;
    const now = Date.now() / 1000;
    const snaps = [...this.inputs.values()].map((i) => i.snapshot(now));
    const items: Item[] = [[KEY_INPUT_DISCOVERY, JSON.stringify({ data: snaps.map((i) => ({ '{#INPUT}': i.id, '{#NAME}': i.name, '{#KIND}': i.kind })) })]];
    for (const i of snaps) {
      items.push([inputKey('state', i.id), i.status], [inputKey('up', i.id), i.status === 'live' ? 1 : 0], [inputKey('name', i.id), i.name],
        [inputKey('kind', i.id), i.kind], [inputKey('recording', i.id), i.recording ? 1 : 0]);
      for (const kind of ['link', 'silence', 'clip', 'mono', 'phase']) items.push([inputKey(`fault.${kind}`, i.id), i.faults.includes(kind) ? 1 : 0]);
      items.push([inputKey('eas', i.id), i.eas_active ? 1 : 0]);
    }
    items.push([this.config.zabbix.key_active, snaps.filter((s) => s.status === 'live').length], [this.config.zabbix.key_heartbeat, 1]);
    await this.zbx.send(items);
  }

  // ------------------------------------------------------------ snapshot

  private publish() {
    for (const inp of this.inputs.values()) inp.sampleMeter();
    const snap = this.buildSnapshot();
    this.latest = snap;
    for (const fn of this.subscribers) {
      try { fn(snap); } catch { /* subscriber gone */ }
    }
  }

  private diskInfo() {
    const now = Date.now() / 1000;
    if (now - this.disk.at < DISK_CACHE_SECS) return this.disk.value;
    let value: { free_gb: number; total_gb: number } | null = null;
    try {
      const root = fs.existsSync(this.recordingsRoot()) ? this.recordingsRoot() : this.paths.data;
      const s = fs.statfsSync(root);
      value = { free_gb: Math.round((s.bavail * s.bsize) / 1e8) / 10, total_gb: Math.round((s.blocks * s.bsize) / 1e8) / 10 };
    } catch { /* unknown */ }
    this.disk = { at: now, value };
    return value;
  }

  buildSnapshot(): Snapshot {
    const now = Date.now() / 1000;
    const c = this.config;
    const inputs: InputSnapshot[] = [...this.inputs.values()].map((i) => i.snapshot(now));
    return {
      type: 'snapshot',
      version: VERSION,
      hostname: os.hostname(),
      uptime_s: Math.round((Date.now() - this.started) / 1000),
      time: Date.now(),
      inputs,
      disk: this.diskInfo(),
      eas: { active: inputs.some((i) => i.eas_active), last: this.easLast.text, last_at: this.easLast.at, decoder: !!this.toolPaths.multimon },
      warnings: this.warnings(),
      services: {
        source: { enabled: c.source.enabled, port: c.source.port, push_inputs: c.inputs.filter((i) => i.kind === 'push' && i.enabled).length },
        zabbix: { enabled: this.zbx.enabled, server: c.zabbix.server, last_ok: this.zbx.lastOk, last_error: this.zbx.lastError, last_error_at: this.zbx.lastErrorAt },
        smtp: { enabled: this.mailer.enabled, problem: this.mailer.problem(), last_sent: this.mailer.lastSent, last_error: this.mailer.lastError, last_error_at: this.mailer.lastErrorAt },
        snmp: this.snmp.status,
      },
    };
  }

  snapshot(): Snapshot { return this.latest ?? this.buildSnapshot(); }

  /** Configuration warnings shown on the dashboard. */
  warnings(): string[] {
    const w: string[] = [];
    if (!this.toolPaths.ffmpeg) w.push('ffmpeg is not installed: no input can record or play.');
    if (!this.toolPaths.multimon && this.config.inputs.some((i) => i.enabled && i.detect_eas)) w.push('multimon-ng is not installed: EAS attention tones are detected but SAME messages (event, areas, sender) are not decoded.');
    const c = this.clockCache.status;
    if (c?.available && !c.synchronized) w.push('The clock is not synchronised (chrony): recording times and fault times may be wrong. See Configuration → Clock.');
    else if (c?.available && c.offset_ms !== null && Math.abs(c.offset_ms) > 500) w.push(`The clock is ${Math.round(c.offset_ms)} ms off its time source; recording times may be wrong. See Configuration → Clock.`);
    const d = this.diskInfo();
    const min = this.config.smtp.disk_min_gb;
    if (d && this.config.inputs.some((i) => i.record && i.enabled) && d.free_gb < min) w.push(`Only ${d.free_gb} GB free for recordings (alert level ${min} GB).`);
    return w;
  }

  subscribe(fn: (s: Snapshot) => void): () => void {
    this.subscribers.add(fn);
    return () => this.subscribers.delete(fn);
  }

  redactedConfig() { return redactConfig(this.config); }

  // ------------------------------------------------------------ API helpers

  /** Create (no id) or replace a logged input from browser input. */
  saveInput(input: Record<string, unknown>, id?: string): InputConfig {
    const inputs = this.config.inputs;
    const existing = id ? inputs.find((i) => i.id === id) : undefined;
    if (id && !existing) throw new HttpError(404, `no input ${id}`);
    const name = String(input.name ?? existing?.name ?? '').trim();
    const base = recName(name).toLowerCase().replace(/_/g, '-') || 'input';
    let newId = existing?.id ?? base;
    for (let n = 2; !existing && inputs.some((i) => i.id === newId); n++) newId = `${base}-${n}`;
    const candidate = {
      ...(existing ?? {}),
      ...input,
      name,
      id: newId,
      source_password: input.kind === 'push' || existing?.kind === 'push' ? keepSecret(input.source_password, existing?.source_password ?? '') : '',
    };
    const parsed = InputSchema.safeParse(candidate);
    if (!parsed.success) throw new HttpError(400, parsed.error.issues.map((i) => `${i.path.join('.') || 'input'}: ${i.message}`).join('; '));
    const inp = parsed.data;
    const why = inputProblem(inp);
    if (why) throw new HttpError(400, `${inp.name} ${why}`);
    if (inp.kind === 'push') inp.mount = safeMount(inp.mount);
    for (const o of inputs.filter((i) => i.id !== inp.id)) {
      if (inp.kind === 'push' && o.kind === 'push' && o.mount === inp.mount) throw new HttpError(400, `mount ${inp.mount} is already used by ${o.name}`);
      if (folderKey(o.name) === folderKey(inp.name)) throw new HttpError(400, `name "${inp.name}" is too close to "${o.name}": they would share a recordings folder`);
    }
    this.store.update((c) => {
      const i = c.inputs.findIndex((x) => x.id === inp.id);
      if (i >= 0) c.inputs[i] = inp; else c.inputs.push(inp);
    });
    if (existing && recName(existing.name) !== recName(inp.name)) {
      const from = recordingDir(this.recordingsRoot(), existing.name);
      const to = recordingDir(this.recordingsRoot(), inp.name);
      try { if (fs.existsSync(from) && !fs.existsSync(to)) fs.renameSync(from, to); } catch (e) { this.log.warn(`cannot move recordings of ${existing.name}: ${(e as Error).message}`); }
    }
    return inp;
  }

  deleteInput(id: string) {
    if (!this.config.inputs.some((i) => i.id === id)) throw new HttpError(404, `no input ${id}`);
    this.store.update((c) => { c.inputs = c.inputs.filter((i) => i.id !== id); });
  }

  saveZabbix(input: Record<string, unknown>) {
    const next = ZabbixSchema.parse({ ...this.config.zabbix, ...input });
    this.store.update((c) => { c.zabbix = next; });
    this.nextHeartbeat = 0;
  }

  saveSmtp(input: Record<string, unknown>) {
    const cur = this.config.smtp;
    const next = SmtpSchema.parse({ ...cur, ...input, password: keepSecret(input.password, cur.password) });
    // Also on a weaker connection (no TLS / no certificate check): the password would go out readable.
    const moved = next.host !== cur.host || next.port !== cur.port || next.username !== cur.username
      || next.security !== cur.security || next.verify_tls !== cur.verify_tls;
    if (moved && cur.password && !secretGiven(input.password)) {
      throw new HttpError(400, 'type the SMTP password again when changing the server, user name or security');
    }
    this.store.update((c) => { c.smtp = next; });
  }

  /**
   * Where a recordings folder may be: below the data folder, or on an extra disk
   * (/mnt, /media, /srv), or TOWERLOG_RECORDINGS_ROOTS (colon-separated).
   * Recordings are served to the browser and pruned, so never a system folder.
   */
  recordingRoots(): { path: string; self: boolean }[] {
    const extra = (process.env.TOWERLOG_RECORDINGS_ROOTS || '').split(':').filter((p) => path.isAbsolute(p));
    return [
      { path: this.paths.data, self: false },
      ...['/mnt', '/media', '/srv', ...extra].map((p) => ({ path: p, self: true })),
    ].map((r) => ({ ...r, path: realOr(r.path) }));
  }

  saveRecordingsDir(dir: string) {
    const d = dir.trim();
    if (d) {
      if (!path.isAbsolute(d)) throw new HttpError(400, 'recordings folder must be an absolute path');
      let real: string;
      try {
        real = fs.realpathSync(d);
      } catch {
        throw new HttpError(400, `${d} does not exist`);
      }
      if (!fs.statSync(real).isDirectory()) throw new HttpError(400, `${d} is not a folder`);
      const roots = this.recordingRoots();
      const ok = roots.some((r) => (r.self && real === r.path) || isInside(r.path, real));
      if (!ok) {
        throw new HttpError(400, `recordings folder must be inside ${roots.map((r) => r.path).join(', ')} (more with TOWERLOG_RECORDINGS_ROOTS)`);
      }
    }
    this.store.update((c) => { c.recordings_dir = d; });
  }

  async testEmail(to?: string) {
    const m = this.mailer;
    if (!m.conf.host) throw new HttpError(400, 'set the SMTP server first');
    const rcpt = to ? [to] : m.to;
    if (!rcpt.length) throw new HttpError(400, 'no recipient: fill in "To" or give an address');
    try {
      await m.sendNow('Test email',
        `This is a test message from Towerlog on ${os.hostname()}.\n\nSent ${new Date().toLocaleString()} via ${m.conf.host}:${m.conf.port} (${m.conf.security}).`,
        rcpt);
    } catch (e) {
      throw new HttpError(502, `${(e as Error).name}: ${(e as Error).message}`);
    }
    return rcpt;
  }

  async testZabbix() {
    if (!this.config.zabbix.server) throw new HttpError(400, 'set the Zabbix server first');
    const sender = new ZabbixSender({ ...this.config.zabbix, enabled: true }, this.log);
    try {
      const info = await sender.deliver([[this.config.zabbix.key_event, `Towerlog test event from ${os.hostname()}`], [this.config.zabbix.key_heartbeat, 1]]);
      return info || 'sent';
    } catch (e) {
      throw new HttpError(502, (e as Error).message);
    }
  }

  zabbixTemplate(): string { return buildTemplate(); }

  saveSnmp(input: Record<string, unknown>) {
    const cur = this.config.snmp;
    const next = SnmpSchema.parse({ ...cur, ...input,
      v3_auth_key: keepSecret(input.v3_auth_key, cur.v3_auth_key), v3_priv_key: keepSecret(input.v3_priv_key, cur.v3_priv_key) });
    if (next.v3_enabled && next.v3_auth_key.length < 8) throw new HttpError(400, 'SNMPv3 auth key must be at least 8 characters');
    if (next.v3_enabled && next.v3_priv === 'aes' && next.v3_priv_key.length < 8) throw new HttpError(400, 'SNMPv3 privacy key must be at least 8 characters');
    if (next.enabled && !next.community && !next.v3_enabled) throw new HttpError(400, 'set a v2c community or turn on SNMPv3');
    if (next.traps.some((t) => t.version === 'v3') && !next.v3_enabled) throw new HttpError(400, 'v3 trap destinations need SNMPv3 turned on');
    this.store.update((c) => { c.snmp = next; });
  }

  async testSnmp(): Promise<string[]> {
    if (!this.config.snmp.enabled) throw new HttpError(400, 'turn SNMP on and save first');
    return this.snmp.test();
  }

  snmpMib(): string { return buildMib(); }

  logs(file?: string, limit = 300): { files: string[]; lines: LogLine[]; disk: string[] } {
    return {
      files: this.log.files(),
      lines: this.log.recent(limit, file),
      disk: file ? this.log.tail(file, limit) : [],
    };
  }

  /** Recordings of a logged input, newest first. */
  inputRecordings(id: string) {
    const inp = this.config.inputs.find((i) => i.id === id);
    if (!inp) throw new HttpError(404, `no input ${id}`);
    const root = this.recordingsRoot();
    return listChunks(recordingDir(root, inp.name)).reverse().slice(0, 500)
      .map((c) => ({ path: path.relative(root, c.path), name: path.basename(c.path), size: c.size, mtime: c.mtime * 1000 }));
  }

  /** Absolute path of a recording, only if it is inside the recordings folder. */
  recordingFile(rel: string): string | null {
    const root = realOr(this.recordingsRoot());
    let full: string;
    try {
      // Resolved, so a symlink inside the folder can't point outside it.
      full = fs.realpathSync(path.resolve(root, rel));
    } catch {
      return null;
    }
    if (!isInside(root, full) || !/\.(mp3|aac|flac|mka)$/.test(full)) return null;
    try { return fs.statSync(full).isFile() ? full : null; } catch { return null; }
  }

  private analyses = new Map<string, Promise<Analysis>>();
  private analysisQueue: Promise<unknown> = Promise.resolve();

  /** Waveform and spectrum of a recording; cached beside it, one analysis at a time. */
  recordingAnalysis(rel: string): Promise<Analysis> {
    const file = this.recordingFile(rel);
    if (!file) throw new HttpError(404, 'no such recording');
    const cached = readCached(file);
    if (cached) return Promise.resolve(cached);
    let job = this.analyses.get(file);
    if (!job) {
      const run = async () => {
        const st = fs.statSync(file);
        const a = { ...(await analyzeFile(file)), size: st.size, mtime: st.mtimeMs };
        writeCached(file, a);
        return a;
      };
      job = this.analysisQueue.then(run, run).catch((e: Error) => { throw new HttpError(500, `cannot analyse: ${e.message}`); });
      this.analysisQueue = job.catch(() => undefined);
      this.analyses.set(file, job);
      const forget = () => this.analyses.delete(file);
      job.then(forget, forget);
    }
    return job;
  }

  recordingDirFor(name: string) { return recordingDir(this.recordingsRoot(), name); }

  system() {
    let kernel = '';
    try { kernel = execFileSync('uname', ['-sr']).toString().trim(); } catch { /* ignore */ }
    return {
      version: VERSION,
      hostname: os.hostname(),
      uptime_s: Math.round((Date.now() - this.started) / 1000),
      host_uptime_s: Math.round(os.uptime()),
      load: os.loadavg().map((x) => Math.round(x * 100) / 100),
      mem: { total_mb: Math.round(os.totalmem() / 1048576), free_mb: Math.round(os.freemem() / 1048576) },
      node: process.version,
      kernel,
      arch: process.arch,
      tools: { ...this.toolPaths },
      paths: { ...this.paths, recordings: this.recordingsRoot() },
      disk: this.diskInfo(),
      config_problems: this.store.problems,
      purge_min_free_gb: this.config.purge_min_free_gb,
    };
  }

  /** Re-write chrony's sources file from the saved list (a fresh host or a replaced file is repaired at start). */
  private writeClockSources() {
    const servers = this.config.clock.servers;
    if (!servers.length || sourcesWritable()) return;
    try { writeSources(servers); } catch (e) { this.log.warn(`clock: cannot write the chrony sources file: ${(e as Error).message}`); }
  }

  private async refreshClock() {
    this.clockCache = { at: Date.now() / 1000, status: (await readClock()).status };
  }

  /** Clock page data: chrony's status and sources, the saved servers, and whether they can be changed here. */
  async clock(): Promise<{ status: ClockStatus; sources: ClockSource[]; servers: string[]; writable: boolean; reason: string; time_zone: string }> {
    const { status, sources } = await readClock();
    this.clockCache = { at: Date.now() / 1000, status };
    const reason = sourcesWritable();
    return { status, sources, servers: this.config.clock.servers, writable: !reason, reason, time_zone: Intl.DateTimeFormat().resolvedOptions().timeZone };
  }

  /** Save the NTP servers (blank list = chrony's own defaults) and tell chrony. */
  saveClock(input: { servers?: unknown }) {
    const servers = parseServers(Array.isArray(input.servers) ? input.servers.map(String) : String(input.servers ?? ''));
    for (const s of servers) if (!validNtpServer(s)) throw new HttpError(400, `${s} is not a host name or IP address`);
    if (servers.length > 8) throw new HttpError(400, 'at most 8 NTP servers');
    const why = sourcesWritable();
    if (why) throw new HttpError(400, `the clock sources cannot be changed from here: ${why}`);
    try { writeSources(servers); } catch (e) { throw new HttpError(500, (e as Error).message); }
    this.store.update((c) => { c.clock.servers = servers; });
    void this.refreshClock();
  }

  /** Disk watermark setting (GB that must stay free; 0 = off). */
  savePurge(gb: number) {
    if (!Number.isFinite(gb) || gb < 0 || gb > 100000) throw new HttpError(400, 'free space must be a number of GB, 0 or more');
    this.store.update((c) => { c.purge_min_free_gb = gb; });
    this.nextPurge = 0;
  }

  // ------------------------------------------------------------ auth

  get hasPassword() { return !!this.config.web.password_hash; }

  checkPassword(pw: string): boolean {
    return verifyPassword(pw, this.config.web.password_hash);
  }

  setPassword(pw: string) {
    if (pw.length < 8) throw new HttpError(400, 'use at least 8 characters');
    const hash = hashPassword(pw);
    this.store.update((c) => {
      c.web.password_hash = hash;
      // Rotating the secret signs out every other session.
      c.web.session_secret = crypto.randomBytes(32).toString('hex');
    });
  }

  newSession(): string {
    return signSession(this.config.web.session_secret, this.config.web.session_hours * 3600);
  }

  /** No password set means nobody can be logged in (the first one is set on the host). */
  validSession(token: string | undefined): boolean {
    if (!token || !this.hasPassword || !verifySession(this.config.web.session_secret, token)) return false;
    const id = sessionNonce(token);
    return !!id && !Object.hasOwn(this.state.revoked, id.nonce);
  }

  /** Log a session out for good (until its expiry, after which it is dead anyway). */
  revokeSession(token: string | undefined) {
    if (!token || !this.validSession(token)) return;
    const id = sessionNonce(token)!;
    const now = Date.now() / 1000;
    for (const [n, exp] of Object.entries(this.state.revoked)) if (exp < now) delete this.state.revoked[n];
    this.state.revoked[id.nonce] = id.exp;
    this.saveState();
  }
}

/** Folder name an input would use, compared case-insensitively (FAT/exFAT USB disks). */
const folderKey = (name: string) => recName(name).toLowerCase();

/** Real path if it exists, else the resolved path. */
function realOr(p: string): string {
  try { return fs.realpathSync(p); } catch { return path.resolve(p); }
}

/** `child` is strictly below `dir` (works for '/' too). */
function isInside(dir: string, child: string): boolean {
  const r = path.relative(dir, child);
  return !!r && r !== '..' && !r.startsWith('..' + path.sep) && !path.isAbsolute(r);
}

export class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

declare global {
  // eslint-disable-next-line no-var
  var __towerlogEngine: Engine | undefined;
}

export function createEngine(paths?: Paths): Engine {
  if (!globalThis.__towerlogEngine) globalThis.__towerlogEngine = new Engine(paths);
  return globalThis.__towerlogEngine;
}
