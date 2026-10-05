// SNMP agent (GET / GETNEXT / GETBULK, v2c and v3, read-only) and trap sender for
// the TOWERLOG-MIB (snmp-mib.ts). The MIB is refreshed from the live snapshot every
// 2 s, so a request never touches the recorders. Traps are fire-and-forget: a dead
// NMS never blocks recording.
import crypto from 'node:crypto';
import os from 'node:os';
import snmp from 'net-snmp';
import type { Agent, Mib, Session, User, Varbind } from 'net-snmp';
import type { SnmpConfig, TrapTarget } from './config.ts';
import type { Logger } from './logger.ts';
import type { Snapshot } from '../lib/types.ts';
import { makeAllow } from './allow.ts';
import {
  INPUT_COLUMNS, KIND, NO_VALUE, SEVERITY, STATUS, SYSTEM, TRAPS, TRAP_OBJECTS,
  inputTableOid, sysOid, trapObjOid, trapOid,
  type ColumnDef, type TrapCategory, type TrapName,
} from './snmp-mib.ts';

const REFRESH_MS = 2000;
const INPUT_TABLE = 'towerlogInputTable';

/** A stable SNMPv3 engine ID per host (receivers of v3 traps must know it). */
export function engineIdFor(hostname = os.hostname()): string {
  return '8000B98380' + crypto.createHash('sha1').update(`towerlog:${hostname}`).digest('hex').slice(0, 24).toUpperCase();
}

const tenths = (db: number | null | undefined) => (db == null || !Number.isFinite(db) || db <= -89.9 ? NO_VALUE : Math.round(db * 10));
const str = (s: unknown) => String(s ?? '').slice(0, 255);
const STATUS_ENUM: Record<string, number> = { stopped: STATUS.stopped, connecting: STATUS.connecting, live: STATUS.live, down: STATUS.down };

export interface SnmpStatus {
  enabled: boolean;
  listening: boolean;
  error: string;
  requests: number;
  rejected: number;
  traps_sent: number;
  last_trap: number | null;
  last_trap_error: string;
  last_trap_error_at: number | null;
  engine_id: string;
}

export interface TrapSubject { id: string; name: string }

export class SnmpService {
  readonly engineId = engineIdFor();
  private agent: Agent | null = null;
  private rows = new Map<string, Map<string, unknown[]>>([[INPUT_TABLE, new Map()]]);
  private timer: NodeJS.Timeout | null = null;
  private source: (() => { snap: Snapshot }) | null = null;
  private nextHeartbeat = 0;
  status: SnmpStatus;

  /** `muted`: answers GETs but sends no traps (demo mode). */
  constructor(readonly conf: SnmpConfig, private log: Logger, private muted = false) {
    this.status = { enabled: conf.enabled, listening: false, error: '', requests: 0, rejected: 0, traps_sent: 0, last_trap: null, last_trap_error: '', last_trap_error_at: null, engine_id: this.engineId };
  }

  get enabled() { return this.conf.enabled; }
  get trapsOn() { return this.conf.enabled && !this.muted && this.conf.traps.length > 0; }

  // ------------------------------------------------------------------ agent

  /** Start the agent; `source` supplies the data the MIB is refreshed from. */
  start(source: () => { snap: Snapshot }) {
    this.source = source;
    if (!this.conf.enabled) return;
    const c = this.conf;
    try {
      const allow = makeAllow(c.allow);
      const agent = snmp.createAgent({
        port: c.port, address: c.bind || null, engineID: this.engineId,
        accessControlModelType: snmp.AccessControlModelType.Simple,
      }, (err) => {
        if (err) {
          const msg = (err as Error).message;
          if (/EADDRINUSE|EACCES/.test(msg)) { this.status.error = msg; this.status.listening = false; }
          this.log.file('snmp.log', `agent: ${msg}`);
        }
      });
      const auth = agent.getAuthorizer();
      const acm = auth.getAccessControlModel();
      if (c.community) {
        auth.addCommunity(c.community);
        acm.setCommunityAccess(c.community, snmp.AccessLevel.ReadOnly);
      }
      if (c.v3_enabled && c.v3_user) {
        auth.addUser(this.v3User());
        acm.setUserAccess(c.v3_user, snmp.AccessLevel.ReadOnly);
      }
      // Source filter and request count, in front of the agent's own handler.
      for (const sock of Object.values(agent.listener.sockets)) {
        sock.removeAllListeners('message');
        sock.on('message', (buf: Buffer, rinfo: { address: string; port: number }) => {
          if (allow && !allow(rinfo.address)) { this.status.rejected++; return; }
          this.status.requests++;
          agent.onMsg(sock, buf, rinfo);
        });
        sock.once('listening', () => { this.status.listening = true; });
        sock.on('error', (e: Error) => { this.status.error = e.message; this.status.listening = false; this.log.warn(`snmp: ${e.message}`); });
      }
      this.agent = agent;
      this.register(agent.getMib());
      this.refresh();
      this.timer = setInterval(() => this.refresh(), REFRESH_MS);
      this.log.info(`snmp agent on ${c.bind || '0.0.0.0'}:${c.port} (${[c.community ? 'v2c' : '', c.v3_enabled ? 'v3' : ''].filter(Boolean).join(' + ') || 'no access configured'})`);
    } catch (e) {
      this.status.error = (e as Error).message;
      this.log.warn(`snmp: can't start the agent: ${this.status.error}`);
    }
  }

  close() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    try { this.agent?.close(); } catch { /* already closed */ }
    this.agent = null;
    this.status.listening = false;
  }

  private v3User(): User {
    const c = this.conf;
    const priv = c.v3_priv === 'aes' && c.v3_priv_key;
    return {
      name: c.v3_user,
      level: priv ? snmp.SecurityLevel.authPriv : snmp.SecurityLevel.authNoPriv,
      authProtocol: snmp.AuthProtocols[c.v3_auth],
      authKey: c.v3_auth_key,
      ...(priv ? { privProtocol: snmp.PrivProtocols.aes, privKey: c.v3_priv_key } : {}),
    };
  }

  private register(mib: Mib) {
    const RO = snmp.MaxAccess['read-only'];
    const scalar = (oid: string, c: ColumnDef) => mib.registerProvider({ name: c.name, type: snmp.MibProviderType.Scalar, oid, scalarType: snmp.ObjectType[c.type], maxAccess: RO });
    SYSTEM.forEach((c) => scalar(sysOid(c.n), c));
    // Index columns are readable so plain snmpwalk shows them; the MIB marks them not-accessible.
    const cols = (list: ColumnDef[]) => list.map((c) => ({ number: c.n, name: c.name, type: snmp.ObjectType[c.type], maxAccess: RO }));
    mib.registerProvider({ name: INPUT_TABLE, type: snmp.MibProviderType.Table, oid: `${inputTableOid}.1`, maxAccess: snmp.MaxAccess['not-accessible'],
      tableColumns: cols(INPUT_COLUMNS), tableIndex: [{ columnName: 'towerlogInputIndex' }] });
  }

  /** Copy the live snapshot into the MIB. */
  refresh() {
    const mib = this.agent?.getMib();
    if (!mib || !this.source) return;
    const { snap } = this.source();
    const inputs = snap.inputs;
    const sys: unknown[] = [
      `Towerlog ${snap.version}`, Math.round(snap.uptime_s * 100), inputs.length, inputs.filter((i) => i.status === 'live').length,
      inputs.filter((i) => i.faults.length).length, str(snap.hostname),
    ];
    SYSTEM.forEach((c, i) => mib.setScalarValue(c.name, sys[i]));
    const rows = new Map<string, unknown[]>();
    inputs.forEach((inp, i) => {
      const idx = i + 1;
      const live = inp.status === 'live';
      const f = (k: string) => (inp.faults.includes(k) ? 1 : 0);
      rows.set(String(idx), [
        idx, inp.id, str(inp.name), KIND[inp.kind], STATUS_ENUM[inp.status] ?? STATUS.stopped, live ? 1 : 0,
        live ? tenths(inp.meter.rms_db[0]) : NO_VALUE, live ? tenths(inp.meter.rms_db[1]) : NO_VALUE, Math.max(0, inp.silent_s),
        f('link'), f('silence'), f('clip'), f('mono'), f('phase'), inp.recording ? 1 : 0, inp.chunk_minutes, str(inp.detail),
      ]);
    });
    this.sync(mib, INPUT_TABLE, INPUT_COLUMNS, rows);
  }

  /** Bring a table in line with `next`: delete gone rows, add new ones, update changed cells. */
  private sync(mib: Mib, table: string, cols: ColumnDef[], next: Map<string, unknown[]>) {
    const cur = this.rows.get(table)!;
    const index = (key: string) => key.split('.').map(Number);
    for (const key of [...cur.keys()]) {
      if (!next.has(key)) { mib.deleteTableRow(table, index(key)); cur.delete(key); }
    }
    for (const [key, row] of next) {
      const old = cur.get(key);
      if (!old) { mib.addTableRow(table, row); cur.set(key, row); continue; }
      cols.forEach((c, i) => {
        if (!c.index && old[i] !== row[i]) {
          try { mib.setTableSingleCell(table, c.n, index(key), row[i]); } catch (e) { this.log.file('snmp.log', `${c.name}: ${(e as Error).message}`); }
        }
      });
      cur.set(key, row);
    }
  }

  // ------------------------------------------------------------------ traps

  private enabledFor(cat: TrapCategory): boolean {
    if (!this.trapsOn) return false;
    const c = this.conf;
    switch (cat) {
      case 'input': return c.trap_input;
      case 'disk': return c.trap_disk;
      case 'service': return c.trap_service;
      default: return true;
    }
  }

  private varbinds(name: TrapName, subject: TrapSubject | null, text: string): Varbind[] {
    const t = snmp.ObjectType;
    const vb: Varbind[] = [
      { oid: trapObjOid(TRAP_OBJECTS[0].n), type: t.OctetString, value: subject?.id ?? '' },
      { oid: trapObjOid(TRAP_OBJECTS[1].n), type: t.OctetString, value: str(subject?.name) },
      { oid: trapObjOid(TRAP_OBJECTS[2].n), type: t.OctetString, value: str(text) },
      { oid: trapObjOid(TRAP_OBJECTS[3].n), type: t.Integer, value: SEVERITY[TRAPS[name].severity] },
    ];
    return vb;
  }

  /** Send a notification to every destination (if its category is on). */
  trap(name: TrapName, subject: TrapSubject | null, text: string) {
    if (!this.enabledFor(TRAPS[name].category)) return;
    const vb = this.varbinds(name, subject, text);
    for (const target of this.conf.traps) void this.send(target, name, vb).catch(() => { /* recorded in status */ });
  }

  /** Send a test notification to every destination; resolves with one result line per destination. */
  async test(): Promise<string[]> {
    if (!this.conf.traps.length) throw Object.assign(new Error('add a trap destination first'), { status: 400 });
    const vb = this.varbinds('test', null, `Towerlog test notification from ${os.hostname()}`);
    return Promise.all(this.conf.traps.map((t) => this.send(t, 'test', vb).then(() => `${t.host}:${t.port} sent`, (e) => `${t.host}:${t.port} failed: ${(e as Error).message}`)));
  }

  private send(target: TrapTarget, name: TrapName, vb: Varbind[]): Promise<void> {
    return new Promise((resolve, reject) => {
      let session: Session;
      try {
        session = target.version === 'v3'
          ? snmp.createV3Session(target.host, this.v3User(), { trapPort: target.port, version: snmp.Version3, engineID: this.engineId })
          : snmp.createSession(target.host, target.community || 'public', { trapPort: target.port, version: snmp.Version2c });
      } catch (e) { this.trapFailed(target, e as Error); reject(e); return; }
      session.on('error', (e) => this.trapFailed(target, e));
      session.trap(trapOid(name), vb, {}, (err) => {
        session.close();
        if (err) { this.trapFailed(target, err); reject(err); return; }
        this.status.traps_sent++;
        this.status.last_trap = Date.now();
        this.log.file('snmp.log', `trap ${TRAPS[name].name} -> ${target.host}:${target.port}`);
        resolve();
      });
    });
  }

  private trapFailed(target: TrapTarget, e: Error) {
    const msg = `${target.host}:${target.port}: ${e.message}`;
    if (msg !== this.status.last_trap_error) this.log.warn(`snmp trap failed: ${msg}`);
    this.status.last_trap_error = msg;
    this.status.last_trap_error_at = Date.now();
  }

  /** Called once a second: heartbeat trap. */
  tick(nowS: number) {
    const hb = this.conf.heartbeat_secs;
    if (!hb || !this.trapsOn) return;
    if (nowS < this.nextHeartbeat) return;
    if (this.nextHeartbeat) this.trap('heartbeat', null, 'Towerlog heartbeat');
    this.nextHeartbeat = nowS + hb;
  }
}
