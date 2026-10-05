// Host network settings. With NetworkManager the app drives nmcli directly (polkit
// lets the towerlog user do that over D-Bus; IPv4 changes sit in an NM checkpoint
// that rolls back by itself). Headless hosts without NetworkManager (netplan,
// systemd-networkd, ifupdown, dhcpcd) go through the root helper towerlog-netapply:
// the app drops a validated request file, the helper re-validates it, writes the
// stack's config with a backup and arms the same 90 s rollback. Host name and time
// use hostnamectl / timedatectl in both cases. Everything runs via execFile with
// argument arrays (no shell) and every value is validated first.
import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Logger } from './logger.ts';
import {
  BACKEND_NAMES, ifupdownIfaces, isBackend, pickBackend, validateIpv4, validCidr, validIface, validIpv4, validHostname, validNtpServer, validTimezone,
  type Backend, type BackendFacts, type NetHelperStatus,
} from './net-config.ts';

export { validCidr, validHostname, validIface, validIpv4, validNtpServer, validTimezone } from './net-config.ts';
export type { Backend } from './net-config.ts';

export const ROLLBACK_SECS = 90;
/** chrony source file: chrony re-reads it when towerlog-chrony.path sees it change. */
export const NTP_DROPIN = '/etc/chrony/sources.d/towerlog.sources';

/** The `server`/`pool` lines chrony needs for these NTP servers. */
export function chronySources(servers: string[]): string {
  const lines = servers.map((s) => `${/(^|\.)pool\.ntp\.org$/i.test(s) ? 'pool' : 'server'} ${s} iburst`);
  return `# Written by Towerlog (Configuration -> Network -> Time). Edits here are overwritten.\n${lines.join('\n')}${lines.length ? '\n' : ''}`;
}

/** The servers named in a chrony source file. */
export function chronyServers(text: string): string[] {
  return [...text.matchAll(/^(?:server|pool)\s+(\S+)/gm)].map((m) => m[1]);
}

const bad = (msg: string) => Object.assign(new Error(msg), { status: 400 });

/** Split one line of `nmcli -t` output (':' separated, '\:' escaped). */
export function splitTerse(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '\\' && i + 1 < line.length) { cur += line[++i]; continue; }
    if (ch === ':') { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  out.push(cur);
  return out;
}

/** Parse `nmcli -t -f FIELD,FIELD … dev show` style "KEY:value" multi-line output into records. */
export function parseKeyValues(text: string): Record<string, string>[] {
  const recs: Record<string, string>[] = [];
  let cur: Record<string, string> = {};
  for (const line of text.split('\n')) {
    if (!line.trim()) { if (Object.keys(cur).length) recs.push(cur); cur = {}; continue; }
    const i = line.indexOf(':');
    if (i < 0) continue;
    const k = line.slice(0, i);
    if (k === 'GENERAL.DEVICE' && Object.keys(cur).length) { recs.push(cur); cur = {}; }
    cur[k] = line.slice(i + 1);
  }
  if (Object.keys(cur).length) recs.push(cur);
  return recs;
}

export interface NetIface {
  device: string; type: string; state: string; mac: string; connection: string;
  method: 'auto' | 'manual' | 'unknown';
  ipv4: string[]; ipv6: string[]; gateway: string; dns: string[];
}
export interface WifiNet { ssid: string; signal: number; security: string; active: boolean }
export interface NetStatus {
  /** Address changes are possible (NetworkManager running, or the helper installed for another stack). */
  available: boolean;
  reason: string;
  backend: Backend;
  backend_name: string;
  /** Wi-Fi scan / join (NetworkManager only). */
  wifi: boolean;
  hostname: string;
  interfaces: NetIface[];
  time: { timezone: string; ntp: boolean; synchronized: boolean; servers: string[] };
  pending: { until: number } | null;
}

type Run = (cmd: string, args: string[]) => Promise<string>;
const defaultRun: Run = (cmd, args) => new Promise((resolve, reject) => {
  execFile(cmd, args, { timeout: 30000, maxBuffer: 4 << 20, env: { ...process.env, LC_ALL: 'C' } }, (err, stdout, stderr) => {
    if (err) reject(Object.assign(new Error((stderr || err.message).toString().trim().split('\n').pop() || err.message), { status: 502 }));
    else resolve(stdout.toString());
  });
});

export interface NetOptions {
  /** Root-owned stack choice written by the installer. */
  confFile?: string;
  /** Request/status directory shared with the helper (owned by towerlog). */
  netDir?: string;
  /** How long to wait for the helper to answer, ms. */
  helperTimeoutMs?: number;
}

/** Facts for pickBackend(), gathered without privileges. */
export async function detectBackend(run: Run = defaultRun): Promise<Backend> {
  const active = async (unit: string) => {
    try { return (await run('systemctl', ['is-active', unit])).trim() === 'active'; } catch { return false; }
  };
  let netplanFiles = 0;
  try { netplanFiles = fs.readdirSync('/etc/netplan').filter((f) => /\.ya?ml$/.test(f)).length; } catch { /* none */ }
  let ifaces = 0;
  try { ifaces = ifupdownIfaces(fs.readFileSync('/etc/network/interfaces', 'utf8')).length; } catch { /* none */ }
  const facts: BackendFacts = {
    nmActive: await active('NetworkManager.service'),
    netplanFiles,
    networkdActive: await active('systemd-networkd.service'),
    dhcpcdActive: await active('dhcpcd.service'),
    ifupdownIfaces: ifaces,
  };
  return pickBackend(facts);
}

/** Parse `ip -j addr` into interfaces (method from the kernel's "dynamic" flag = DHCP lease). */
export function parseIpAddr(json: string, routesJson = '[]', dns: string[] = []): NetIface[] {
  type Addr = { family: string; local: string; prefixlen: number; dynamic?: boolean; scope?: string };
  type Link = { ifname: string; link_type?: string; operstate?: string; address?: string; addr_info?: Addr[] };
  let links: Link[] = [];
  let routes: { dst?: string; gateway?: string; dev?: string }[] = [];
  try { links = JSON.parse(json); } catch { return []; }
  try { routes = JSON.parse(routesJson); } catch { /* no routes */ }
  return links.filter((l) => l.ifname !== 'lo' && l.link_type !== 'loopback').map((l) => {
    const v4 = (l.addr_info ?? []).filter((a) => a.family === 'inet');
    const v6 = (l.addr_info ?? []).filter((a) => a.family === 'inet6');
    const gw = routes.find((r) => r.dst === 'default' && r.dev === l.ifname)?.gateway ?? '';
    return {
      device: l.ifname, type: /^wl/.test(l.ifname) ? 'wifi' : 'ethernet', state: (l.operstate ?? 'unknown').toLowerCase(),
      mac: l.address ?? '', connection: '',
      method: v4.some((a) => a.dynamic) ? 'auto' as const : v4.length ? 'manual' as const : 'unknown' as const,
      ipv4: v4.map((a) => `${a.local}/${a.prefixlen}`), ipv6: v6.map((a) => `${a.local}/${a.prefixlen}`), gateway: gw, dns,
    };
  });
}

export class NetworkManagerCtl {
  private checkpoint: { path: string; until: number } | null = null;
  /** A change waiting for confirmation through the helper. */
  private helperPending: { id: string; until: number } | null = null;
  private backendCache: { b: Backend; at: number } | null = null;
  private readonly confFile: string;
  private readonly netDir: string;
  private readonly helperTimeoutMs: number;

  constructor(private log: Logger, private run: Run = defaultRun, opts: NetOptions = {}) {
    this.confFile = opts.confFile ?? process.env.TOWERLOG_NET_CONF ?? '/etc/towerlog/network.json';
    this.netDir = opts.netDir ?? process.env.TOWERLOG_NET_DIR ?? '/var/lib/towerlog/net';
    this.helperTimeoutMs = opts.helperTimeoutMs ?? 45000;
  }

  /** The stack in charge: the installer's choice, else detected now (cached 30 s). */
  async backend(): Promise<Backend> {
    if (this.backendCache && Date.now() - this.backendCache.at < 30000) return this.backendCache.b;
    let b: Backend | null = null;
    try {
      const v = JSON.parse(fs.readFileSync(this.confFile, 'utf8')).backend;
      if (isBackend(v)) b = v;
    } catch { /* not installed by the installer */ }
    // NetworkManager may have been installed since; it always wins when it runs.
    if (b !== 'nm' && (await this.available()).ok) b = 'nm';
    b ??= await detectBackend(this.run);
    this.backendCache = { b, at: Date.now() };
    return b;
  }

  /** The helper is installed (its path unit is enabled and the request directory exists). */
  async helperInstalled(): Promise<boolean> {
    try { if (!fs.statSync(this.netDir).isDirectory()) return false; } catch { return false; }
    try { return /^(enabled|static)/.test((await this.run('systemctl', ['is-enabled', 'towerlog-netapply.path'])).trim()); } catch { return false; }
  }

  async available(): Promise<{ ok: boolean; reason: string }> {
    try {
      const out = await this.run('nmcli', ['-t', '-f', 'RUNNING', 'general']);
      return out.trim() === 'running' ? { ok: true, reason: '' } : { ok: false, reason: 'NetworkManager is not running' };
    } catch (e) {
      return { ok: false, reason: /ENOENT/.test((e as Error).message) ? 'nmcli is not installed (NetworkManager missing)' : (e as Error).message };
    }
  }

  async status(): Promise<NetStatus> {
    const backend = await this.backend();
    const backend_name = BACKEND_NAMES[backend];
    let hostname = os.hostname();
    try { hostname = (await this.run('hostnamectl', ['--static'])).trim() || hostname; } catch { /* fall back */ }
    const time = await this.timeStatus();
    if (this.checkpoint && Date.now() > this.checkpoint.until) this.checkpoint = null;
    this.refreshHelperPending();
    const pending = this.checkpoint ? { until: this.checkpoint.until } : this.helperPending ? { until: this.helperPending.until } : null;
    if (backend !== 'nm') {
      const interfaces = await this.ipIfaces();
      if (backend === 'none') {
        return { available: false, reason: 'no supported network stack found (NetworkManager, netplan, systemd-networkd, ifupdown or dhcpcd)', backend, backend_name, wifi: false, hostname, interfaces, time, pending };
      }
      const helper = await this.helperInstalled();
      return { available: helper, reason: helper ? '' : 'the towerlog-netapply helper is not installed; re-run the installer', backend, backend_name, wifi: false, hostname, interfaces, time, pending };
    }
    const av = await this.available();
    if (!av.ok) return { available: false, reason: av.reason, backend, backend_name, wifi: false, hostname, interfaces: this.fallbackIfaces(), time, pending };
    const text = await this.run('nmcli', ['-t', '-f', 'GENERAL.DEVICE,GENERAL.TYPE,GENERAL.STATE,GENERAL.HWADDR,GENERAL.CONNECTION,IP4.ADDRESS,IP4.GATEWAY,IP4.DNS,IP6.ADDRESS', 'dev', 'show']);
    const interfaces: NetIface[] = [];
    for (const r of parseKeyValues(text)) {
      const type = r['GENERAL.TYPE'] ?? '';
      if (type === 'loopback' || !r['GENERAL.DEVICE']) continue;
      const vals = (prefix: string) => Object.entries(r).filter(([k, v]) => k.startsWith(prefix) && v).map(([, v]) => v);
      const connection = r['GENERAL.CONNECTION'] ?? '';
      let method: NetIface['method'] = 'unknown';
      if (connection) {
        try { method = (await this.run('nmcli', ['-g', 'ipv4.method', 'con', 'show', connection])).trim() === 'manual' ? 'manual' : 'auto'; } catch { /* leave unknown */ }
      }
      interfaces.push({
        device: r['GENERAL.DEVICE'], type, state: (r['GENERAL.STATE'] ?? '').replace(/^\d+ \(|\)$/g, ''), mac: r['GENERAL.HWADDR'] ?? '',
        connection, method, ipv4: vals('IP4.ADDRESS'), ipv6: vals('IP6.ADDRESS'), gateway: r['IP4.GATEWAY'] ?? '', dns: vals('IP4.DNS'),
      });
    }
    return { available: true, reason: '', backend, backend_name, wifi: true, hostname, interfaces, time, pending };
  }

  private resolvers(): string[] {
    try { return fs.readFileSync('/etc/resolv.conf', 'utf8').split('\n').map((l) => /^nameserver\s+(\S+)/.exec(l)?.[1]).filter((x): x is string => !!x); } catch { return []; }
  }

  /** Interfaces from `ip -j` (addresses, DHCP or static, default gateway); os.networkInterfaces() if ip is missing. */
  private async ipIfaces(): Promise<NetIface[]> {
    try {
      const [addr, route] = await Promise.all([this.run('ip', ['-j', 'addr']), this.run('ip', ['-j', '-4', 'route']).catch(() => '[]')]);
      const list = parseIpAddr(addr, route, this.resolvers());
      if (list.length) return list;
    } catch { /* fall back */ }
    return this.fallbackIfaces();
  }

  private fallbackIfaces(): NetIface[] {
    const dns = this.resolvers();
    return Object.entries(os.networkInterfaces()).filter(([name]) => name !== 'lo').map(([device, addrs]) => ({
      device, type: /^wl/.test(device) ? 'wifi' : 'ethernet', state: 'unmanaged', mac: addrs?.[0]?.mac ?? '', connection: '', method: 'unknown' as const,
      ipv4: (addrs ?? []).filter((a) => a.family === 'IPv4').map((a) => a.cidr ?? a.address),
      ipv6: (addrs ?? []).filter((a) => a.family === 'IPv6').map((a) => a.cidr ?? a.address), gateway: '', dns,
    }));
  }

  private async timeStatus(): Promise<NetStatus['time']> {
    const t = { timezone: '', ntp: false, synchronized: false, servers: [] as string[] };
    try {
      const out = await this.run('timedatectl', ['show']);
      for (const l of out.split('\n')) {
        const [k, v] = [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)];
        if (k === 'Timezone') t.timezone = v;
        if (k === 'NTP') t.ntp = v === 'yes';
        if (k === 'NTPSynchronized') t.synchronized = v === 'yes';
      }
    } catch { t.timezone = Intl.DateTimeFormat().resolvedOptions().timeZone; }
    try {
      t.servers = chronyServers(fs.readFileSync(NTP_DROPIN, 'utf8'));
    } catch { /* no drop-in */ }
    return t;
  }

  private async requireNm() {
    const av = await this.available();
    if (!av.ok) throw bad(`network settings are view-only: ${av.reason}`);
  }

  /** Build the nmcli arguments for an IPv4 change (exported for tests). */
  static ipv4Args(connection: string, input: { method: string; address?: string; gateway?: string; dns?: string[] }): string[] {
    if (input.method === 'auto') return ['con', 'mod', connection, 'ipv4.method', 'auto', 'ipv4.addresses', '', 'ipv4.gateway', '', 'ipv4.dns', ''];
    if (input.method !== 'manual') throw bad('method must be auto or manual');
    if (!validCidr(input.address ?? '')) throw bad('address must look like 192.168.1.50/24');
    if (input.gateway && !validIpv4(input.gateway)) throw bad(`gateway ${input.gateway} is not an IPv4 address`);
    const dns = (input.dns ?? []).map((d) => d.trim()).filter(Boolean);
    for (const d of dns) if (!validIpv4(d)) throw bad(`DNS server ${d} is not an IPv4 address`);
    return ['con', 'mod', connection, 'ipv4.method', 'manual', 'ipv4.addresses', input.address!, 'ipv4.gateway', input.gateway ?? '', 'ipv4.dns', dns.join(',')];
  }

  async applyIpv4(device: string, input: { method: string; address?: string; gateway?: string; dns?: string[] }): Promise<{ until: number }> {
    if (!validIface(device)) throw bad('bad interface name');
    const backend = await this.backend();
    if (backend !== 'nm') return this.helperApply(backend, device, input);
    await this.requireNm();
    // A second checkpoint would capture the unconfirmed state, making the first change
    // permanent if this one is rolled back.
    if (this.checkpoint && Date.now() < this.checkpoint.until) throw bad('confirm or revert the previous change first');
    const connection = (await this.run('nmcli', ['-g', 'GENERAL.CONNECTION', 'dev', 'show', device])).trim();
    if (!connection) throw bad(`${device} has no NetworkManager connection`);
    const args = NetworkManagerCtl.ipv4Args(connection, input);
    // Checkpoint covering every device; NetworkManager rolls back by itself after ROLLBACK_SECS.
    // Flags 0: never DESTROY_ALL, which would silently drop a checkpoint still pending
    // (e.g. from before an app restart); NetworkManager refuses instead, and that's right.
    const out = await this.run('busctl', ['call', '--json=short', 'org.freedesktop.NetworkManager', '/org/freedesktop/NetworkManager',
      'org.freedesktop.NetworkManager', 'CheckpointCreate', 'aouu', '0', String(ROLLBACK_SECS), '0']);
    const path = /"(\/org\/freedesktop\/NetworkManager\/Checkpoint\/\d+)"/.exec(out)?.[1];
    if (!path) throw new Error('could not create a NetworkManager checkpoint; not changing the network');
    this.checkpoint = { path, until: Date.now() + ROLLBACK_SECS * 1000 };
    this.log.warn(`network: ${device} ipv4 ${input.method}${input.address ? ' ' + input.address : ''} (rolls back in ${ROLLBACK_SECS}s unless confirmed)`);
    await this.run('nmcli', args);
    void this.run('nmcli', ['con', 'up', connection]).catch((e) => this.log.warn(`network: con up ${connection}: ${(e as Error).message}`));
    return { until: this.checkpoint.until };
  }

  async confirm(keep: boolean): Promise<void> {
    this.refreshHelperPending();
    if (this.helperPending) {
      const { id } = this.helperPending;
      const st = await this.helperCall({ op: keep ? 'confirm' : 'rollback', id });
      this.helperPending = null;
      if (st.state === 'failed') throw bad(st.error || 'the network helper failed');
      this.log.info(`network: change ${keep ? 'kept' : 'rolled back'}`);
      return;
    }
    const cp = this.checkpoint;
    if (!cp) throw bad('no network change is waiting for confirmation');
    this.checkpoint = null;
    await this.run('busctl', ['call', 'org.freedesktop.NetworkManager', '/org/freedesktop/NetworkManager', 'org.freedesktop.NetworkManager',
      keep ? 'CheckpointDestroy' : 'CheckpointRollback', 'o', cp.path]);
    this.log.info(`network: change ${keep ? 'kept' : 'rolled back'}`);
  }

  // ---------------------------------------------------------------- root helper (non-NetworkManager stacks)

  private async helperApply(backend: Backend, device: string, input: { method: string; address?: string; gateway?: string; dns?: string[] }): Promise<{ until: number }> {
    if (backend === 'none') throw bad('no supported network stack on this host: Configuration → Network is view-only');
    if (!(await this.helperInstalled())) throw bad('the towerlog-netapply helper is not installed; re-run the installer');
    this.refreshHelperPending();
    if (this.helperPending) throw bad('confirm or revert the previous change first');
    const settings = validateIpv4(input);
    const id = crypto.randomBytes(8).toString('hex');
    this.log.warn(`network: ${device} ipv4 ${settings.method}${settings.address ? ' ' + settings.address : ''} via ${BACKEND_NAMES[backend]} (rolls back in ${ROLLBACK_SECS}s unless confirmed)`);
    const st = await this.helperCall({ op: 'apply', id, iface: device, ...settings });
    if (st.state !== 'applied') throw bad(st.error || 'the network helper did not apply the change');
    this.helperPending = { id, until: st.until ?? Date.now() + ROLLBACK_SECS * 1000 };
    return { until: this.helperPending.until };
  }

  /** Drop a request for the helper and wait for its status with the same id. */
  private async helperCall(req: Record<string, unknown> & { id: string }): Promise<NetHelperStatus> {
    const tmp = path.join(this.netDir, `.request.${req.id}.tmp`);
    fs.writeFileSync(tmp, JSON.stringify(req) + '\n', { mode: 0o600 });
    fs.renameSync(tmp, path.join(this.netDir, 'request.json'));
    const deadline = Date.now() + this.helperTimeoutMs;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 250));
      const st = this.readHelperStatus();
      if (st && st.id === req.id) return st;
    }
    throw Object.assign(new Error('the network helper did not answer (is towerlog-netapply.path enabled?)'), { status: 504 });
  }

  private readHelperStatus(): NetHelperStatus | null {
    try { return JSON.parse(fs.readFileSync(path.join(this.netDir, 'status.json'), 'utf8')) as NetHelperStatus; } catch { return null; }
  }

  /** Forget a pending helper change once it has timed out (the helper rolled it back). */
  private refreshHelperPending() {
    if (!this.helperPending) return;
    const st = this.readHelperStatus();
    if (Date.now() > this.helperPending.until || (st?.id === this.helperPending.id && st.state !== 'applied')) this.helperPending = null;
  }

  async wifiScan(): Promise<WifiNet[]> {
    await this.requireNm();
    const out = await this.run('nmcli', ['-t', '-f', 'IN-USE,SSID,SIGNAL,SECURITY', 'dev', 'wifi', 'list', '--rescan', 'yes']);
    const seen = new Map<string, WifiNet>();
    for (const line of out.split('\n').filter(Boolean)) {
      const [inUse, ssid, signal, security] = splitTerse(line);
      if (!ssid) continue;
      const n = { ssid, signal: Number(signal) || 0, security: security || '', active: inUse === '*' };
      const prev = seen.get(ssid);
      if (!prev || n.signal > prev.signal || n.active) seen.set(ssid, { ...n, active: n.active || !!prev?.active });
    }
    return [...seen.values()].sort((a, b) => Number(b.active) - Number(a.active) || b.signal - a.signal);
  }

  async wifiConnect(ssid: string, password: string, hidden = false) {
    if (!ssid || Buffer.byteLength(ssid) > 32) throw bad('SSID must be 1–32 bytes');
    if (password && (password.length < 8 || password.length > 63)) throw bad('Wi-Fi password must be 8–63 characters');
    await this.requireNm();
    const args = ['dev', 'wifi', 'connect', ssid];
    if (password) args.push('password', password);
    if (hidden) args.push('hidden', 'yes');
    await this.run('nmcli', args);
    this.log.info(`network: joined Wi-Fi ${ssid}`);
  }

  async wifiForget(connection: string) {
    if (!connection || connection.length > 64 || /[\0\n]/.test(connection)) throw bad('bad connection name');
    await this.requireNm();
    await this.run('nmcli', ['con', 'delete', 'id', connection]);
  }

  async setHostname(name: string) {
    if (!validHostname(name)) throw bad('host name: letters, digits and hyphens, up to 63, not starting or ending with a hyphen');
    await this.run('hostnamectl', ['set-hostname', name]);
    this.log.info(`network: host name set to ${name}`);
  }

  async setTime(input: { timezone?: string; ntp?: boolean; servers?: string[] }) {
    if (input.timezone !== undefined) {
      if (!validTimezone(input.timezone)) throw bad('bad time zone');
      await this.run('timedatectl', ['set-timezone', input.timezone]);
    }
    if (input.servers !== undefined) {
      const servers = input.servers.map((s) => s.trim()).filter(Boolean);
      for (const s of servers) if (!validNtpServer(s)) throw bad(`NTP server ${s} is not a host name or IP address`);
      try {
        fs.writeFileSync(NTP_DROPIN, chronySources(servers));
      } catch (e) {
        throw bad(`can't write ${NTP_DROPIN} (${(e as Error).message}); re-run the installer`);
      }
      // chrony re-reads the file by itself: towerlog-chrony.path runs `chronyc reload sources` as root.
    }
    if (input.ntp !== undefined) await this.run('timedatectl', ['set-ntp', input.ntp ? 'true' : 'false']);
  }

  async timezones(): Promise<string[]> {
    try { return (await this.run('timedatectl', ['list-timezones'])).split('\n').filter(Boolean); } catch { return []; }
  }
}
