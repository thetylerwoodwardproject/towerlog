// Pure network-settings logic shared by the web app (src/engine/network.ts) and the
// root helper (src/engine/netapply.ts → dist/towerlog-netapply.mjs): input
// validation, network-stack detection, and the config text each stack needs.
// No I/O here, so the helper can re-validate everything the app sends it.
import net from 'node:net';

export type Backend = 'nm' | 'netplan' | 'networkd' | 'ifupdown' | 'dhcpcd' | 'none';

export const BACKEND_NAMES: Record<Backend, string> = {
  nm: 'NetworkManager',
  netplan: 'netplan',
  networkd: 'systemd-networkd',
  ifupdown: 'ifupdown (/etc/network/interfaces)',
  dhcpcd: 'dhcpcd',
  none: 'nothing Towerlog can manage',
};

const BACKENDS = Object.keys(BACKEND_NAMES) as Backend[];
export const isBackend = (b: unknown): b is Backend => typeof b === 'string' && (BACKENDS as string[]).includes(b);

export interface BackendFacts {
  nmActive: boolean;
  /** Files in /etc/netplan ending in .yaml / .yml. */
  netplanFiles: number;
  networkdActive: boolean;
  dhcpcdActive: boolean;
  /** `iface X inet …` stanzas in /etc/network/interfaces (other than lo). */
  ifupdownIfaces: number;
}

/** Same order as deploy/install.sh: the first stack that is really in charge wins. */
export function pickBackend(f: BackendFacts): Backend {
  if (f.nmActive) return 'nm';
  if (f.netplanFiles > 0) return 'netplan';
  if (f.networkdActive) return 'networkd';
  if (f.dhcpcdActive) return 'dhcpcd';
  if (f.ifupdownIfaces > 0) return 'ifupdown';
  return 'none';
}

/** Interfaces declared in /etc/network/interfaces (`iface eth0 inet dhcp`), loopback excluded. */
export function ifupdownIfaces(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split('\n')) {
    const m = /^\s*iface\s+(\S+)\s+inet6?\s+/.exec(line);
    if (m && m[1] !== 'lo' && !out.includes(m[1])) out.push(m[1]);
  }
  return out;
}

// ------------------------------------------------------------------ validation

export function validHostname(h: string): boolean {
  return typeof h === 'string' && h.length <= 63 && /^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?$/.test(h);
}
export function validIpv4(ip: string): boolean { return net.isIPv4(String(ip)); }
export function validCidr(c: string): boolean {
  const [ip, p, ...rest] = String(c).split('/');
  return !rest.length && validIpv4(ip) && /^\d{1,2}$/.test(p ?? '') && Number(p) >= 1 && Number(p) <= 32;
}
/** Linux interface names: 1–15 chars, no '/', whitespace or shell/quote characters. */
export function validIface(d: string): boolean { return /^[A-Za-z0-9][A-Za-z0-9._-]{0,14}$/.test(String(d)); }
export function validTimezone(tz: string): boolean { return /^[A-Za-z0-9_+-]+(\/[A-Za-z0-9_+-]+){0,2}$/.test(String(tz)) && !tz.includes('..'); }
export function validNtpServer(s: string): boolean { return net.isIP(s) > 0 || /^(?=.{1,253}$)([A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)*[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(s); }

export class NetRequestError extends Error {
  readonly status = 400;
}
const bad = (msg: string): never => { throw new NetRequestError(msg); };

export interface Ipv4Settings { method: 'auto' | 'manual'; address?: string; gateway?: string; dns: string[] }
export type NetRequest =
  | ({ op: 'apply'; id: string; iface: string } & Ipv4Settings)
  | { op: 'confirm' | 'rollback'; id: string };

/** Validate IPv4 settings from the browser (or a request file); returns a clean copy. */
export function validateIpv4(input: { method?: unknown; address?: unknown; gateway?: unknown; dns?: unknown }): Ipv4Settings {
  const method = input.method === 'auto' || input.method === 'manual' ? input.method : bad('method must be auto or manual');
  const dnsIn = Array.isArray(input.dns) ? input.dns : [];
  if (dnsIn.length > 4) bad('at most 4 DNS servers');
  const dns = dnsIn.map((d) => String(d).trim()).filter(Boolean);
  for (const d of dns) if (!validIpv4(d)) bad(`DNS server ${d} is not an IPv4 address`);
  if (method === 'auto') return { method, dns: [] };
  const address = String(input.address ?? '');
  if (!validCidr(address)) bad('address must look like 192.168.1.50/24');
  const gateway = input.gateway ? String(input.gateway) : '';
  if (gateway && !validIpv4(gateway)) bad(`gateway ${gateway} is not an IPv4 address`);
  return { method, address, ...(gateway ? { gateway } : {}), dns };
}

/** Strictly validate a request file. Unknown fields are dropped; anything odd throws. */
export function validateNetRequest(raw: unknown): NetRequest {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) bad('request must be a JSON object');
  const r = raw as Record<string, unknown>;
  const id = typeof r.id === 'string' && /^[a-f0-9]{8,32}$/.test(r.id) ? r.id : bad('bad request id');
  if (r.op === 'confirm' || r.op === 'rollback') return { op: r.op, id };
  if (r.op !== 'apply') bad('op must be apply, confirm or rollback');
  const iface = typeof r.iface === 'string' && validIface(r.iface) ? r.iface : bad('bad interface name');
  return { op: 'apply', id, iface, ...validateIpv4(r) };
}

// ------------------------------------------------------------------ config text per stack

const MARK = '# Written by Towerlog (Configuration → Network). Changes here are overwritten.';
const prefixToMask = (p: number) => [24, 16, 8, 0].map((s) => ((p >= 32 ? 0xffffffff : ~(0xffffffff >>> p)) >>> s) & 255).join('.');

/** /etc/netplan/90-towerlog.yaml (a later file overrides the same keys of earlier ones). */
export function netplanYaml(iface: string, s: Ipv4Settings): string {
  const lines = [MARK, 'network:', '  version: 2', '  ethernets:', `    ${iface}:`];
  if (s.method === 'auto') {
    lines.push('      dhcp4: true');
  } else {
    lines.push('      dhcp4: false', `      addresses: [${s.address}]`);
    if (s.gateway) lines.push('      routes:', '        - to: default', `          via: ${s.gateway}`);
    if (s.dns.length) lines.push('      nameservers:', `        addresses: [${s.dns.join(', ')}]`);
  }
  return lines.join('\n') + '\n';
}

/** /etc/systemd/network/05-towerlog-<iface>.network (lowest name matches first). */
export function networkdUnit(iface: string, s: Ipv4Settings): string {
  const lines = [MARK, '[Match]', `Name=${iface}`, '', '[Network]'];
  if (s.method === 'auto') lines.push('DHCP=ipv4');
  else {
    lines.push(`Address=${s.address}`);
    if (s.gateway) lines.push(`Gateway=${s.gateway}`);
    for (const d of s.dns) lines.push(`DNS=${d}`);
  }
  return lines.join('\n') + '\n';
}

/** /etc/network/interfaces.d/towerlog-<iface>. */
export function ifupdownStanza(iface: string, s: Ipv4Settings): string {
  const lines = [MARK, `auto ${iface}`, `allow-hotplug ${iface}`];
  if (s.method === 'auto') lines.push(`iface ${iface} inet dhcp`);
  else {
    const [ip, p] = s.address!.split('/');
    lines.push(`iface ${iface} inet static`, `    address ${ip}`, `    netmask ${prefixToMask(Number(p))}`);
    if (s.gateway) lines.push(`    gateway ${s.gateway}`);
    if (s.dns.length) lines.push(`    dns-nameservers ${s.dns.join(' ')}`);
  }
  return lines.join('\n') + '\n';
}

/**
 * Remove the `iface <iface> inet …` stanza (and its indented options) from
 * /etc/network/interfaces so the interfaces.d file is the only definition.
 * `auto`/`allow-hotplug` lines for it are dropped too (the stanza file has them).
 * Also makes sure interfaces.d is sourced.
 */
export function stripIfupdownStanza(text: string, iface: string): string {
  const out: string[] = [];
  let skipping = false;
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (/^(iface|mapping|auto|allow-|source|source-directory)\b/.test(t)) skipping = false;
    if (new RegExp(`^iface\\s+${iface.replace(/[.]/g, '\\.')}\\s+inet\\s`).test(t)) { skipping = true; continue; }
    if (skipping) continue;
    const m = /^(auto|allow-hotplug)\s+(.*)$/.exec(t);
    if (m) {
      const rest = m[2].split(/\s+/).filter((x) => x !== iface);
      if (!rest.length) continue;
      out.push(`${m[1]} ${rest.join(' ')}`);
      continue;
    }
    out.push(line);
  }
  let res = out.join('\n');
  if (!/^\s*source(-directory)?\s+\/etc\/network\/interfaces\.d/m.test(res)) res = res.replace(/\n*$/, '\n') + 'source /etc/network/interfaces.d/*\n';
  return res;
}

export const DHCPCD_BEGIN = '# towerlog begin';
export const DHCPCD_END = '# towerlog end';

/**
 * /etc/dhcpcd.conf with our block (between markers) replaced. dhcpcd's `interface`
 * section runs to the next `interface` line or EOF, so the block goes at the end.
 * DHCP needs no block (dhcpcd's default), so `auto` just removes ours.
 */
export function dhcpcdConf(text: string, iface: string, s: Ipv4Settings): string {
  const re = new RegExp(`\\n?${DHCPCD_BEGIN} ${iface.replace(/[.]/g, '\\.')}\\n[\\s\\S]*?${DHCPCD_END} ${iface.replace(/[.]/g, '\\.')}\\n?`, 'g');
  let res = text.replace(re, '\n').replace(/\n{3,}/g, '\n\n');
  if (s.method === 'manual') {
    const lines = [`${DHCPCD_BEGIN} ${iface}`, `interface ${iface}`, `static ip_address=${s.address}`];
    if (s.gateway) lines.push(`static routers=${s.gateway}`);
    if (s.dns.length) lines.push(`static domain_name_servers=${s.dns.join(' ')}`);
    lines.push(`${DHCPCD_END} ${iface}`);
    res = res.replace(/\n*$/, '\n\n') + lines.join('\n') + '\n';
  }
  return res;
}

/** Status the helper writes for the app (net/status.json). */
export interface NetHelperStatus {
  id: string;
  state: 'applied' | 'confirmed' | 'rolled_back' | 'failed';
  error?: string;
  backend: Backend;
  /** Epoch ms when the automatic rollback fires (state 'applied'). */
  until?: number;
  at: number;
}
