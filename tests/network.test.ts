import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { NetworkManagerCtl, parseIpAddr, parseKeyValues, splitTerse, validCidr, validHostname, validIpv4, validNtpServer, validTimezone } from '../src/engine/network.ts';
import {
  dhcpcdConf, ifupdownIfaces, ifupdownStanza, netplanYaml, networkdUnit, pickBackend, stripIfupdownStanza, validateNetRequest,
} from '../src/engine/net-config.ts';

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'towerlog-net-'));
/** A config file naming the stack, so tests don't depend on this machine's network. */
function confWith(backend: string) {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'network.json'), JSON.stringify({ backend }));
  return path.join(dir, 'network.json');
}

const log = { info() {}, warn() {}, error() {}, file() {} } as never;

describe('network validation', () => {
  it('rejects unsafe host names', () => {
    expect(validHostname('towerlog-1')).toBe(true);
    expect(validHostname('x; rm')).toBe(false);
    expect(validHostname('-bad')).toBe(false);
    expect(validHostname('a'.repeat(64))).toBe(false);
  });
  it('checks IPv4 and CIDR', () => {
    expect(validIpv4('192.168.1.5')).toBe(true);
    expect(validIpv4('300.1.1.1')).toBe(false);
    expect(validCidr('10.0.0.2/24')).toBe(true);
    expect(validCidr('10.0.0.2/33')).toBe(false);
    expect(validCidr('10.0.0.2')).toBe(false);
  });
  it('checks time zones and NTP servers', () => {
    expect(validTimezone('America/Chicago')).toBe(true);
    expect(validTimezone('../etc/passwd')).toBe(false);
    expect(validNtpServer('pool.ntp.org')).toBe(true);
    expect(validNtpServer('bad host')).toBe(false);
  });
  it('builds nmcli args and rejects bad input', () => {
    expect(NetworkManagerCtl.ipv4Args('Wired', { method: 'manual', address: '192.168.1.50/24', gateway: '192.168.1.1', dns: ['1.1.1.1'] }))
      .toEqual(['con', 'mod', 'Wired', 'ipv4.method', 'manual', 'ipv4.addresses', '192.168.1.50/24', 'ipv4.gateway', '192.168.1.1', 'ipv4.dns', '1.1.1.1']);
    expect(() => NetworkManagerCtl.ipv4Args('Wired', { method: 'manual', address: '1.2.3.4' })).toThrow();
    expect(() => NetworkManagerCtl.ipv4Args('Wired', { method: 'manual', address: '1.2.3.4/24', dns: ['x;y'] })).toThrow();
    expect(() => NetworkManagerCtl.ipv4Args('Wired', { method: 'evil' })).toThrow();
  });
});

describe('nmcli parsing', () => {
  it('splits terse lines with escaped colons', () => {
    expect(splitTerse('*:My\\:Net:80:WPA2')).toEqual(['*', 'My:Net', '80', 'WPA2']);
  });
  it('parses dev show records', () => {
    const recs = parseKeyValues('GENERAL.DEVICE:eth0\nGENERAL.TYPE:ethernet\nIP4.ADDRESS[1]:10.0.0.2/24\n\nGENERAL.DEVICE:lo\nGENERAL.TYPE:loopback\n');
    expect(recs).toHaveLength(2);
    expect(recs[0]['IP4.ADDRESS[1]']).toBe('10.0.0.2/24');
  });
  it('falls back to view-only without NetworkManager', async () => {
    const ctl = new NetworkManagerCtl(log, async () => { throw new Error('spawn nmcli ENOENT'); }, { confFile: confWith('nm') });
    const s = await ctl.status();
    expect(s.available).toBe(false);
    expect(s.reason).toMatch(/not installed/);
    await expect(ctl.wifiScan()).rejects.toThrow(/view-only/);
  });
  it('wraps IPv4 changes in a checkpoint', async () => {
    const calls: string[][] = [];
    const ctl = new NetworkManagerCtl(log, async (cmd, args) => {
      calls.push([cmd, ...args]);
      if (args.includes('RUNNING')) return 'running\n';
      if (args.includes('GENERAL.CONNECTION')) return 'Wired\n';
      if (cmd === 'busctl') return '{"type":"o","data":["/org/freedesktop/NetworkManager/Checkpoint/3"]}';
      return '';
    });
    const r = await ctl.applyIpv4('eth0', { method: 'auto' });
    expect(r.until).toBeGreaterThan(Date.now());
    const cp = calls.findIndex((c) => c.includes('CheckpointCreate'));
    const mod = calls.findIndex((c) => c[0] === 'nmcli' && c.includes('mod'));
    expect(cp).toBeGreaterThanOrEqual(0);
    expect(mod).toBeGreaterThan(cp);
    expect(calls[cp].at(-1)).toBe('0'); // never DESTROY_ALL
    await expect(ctl.applyIpv4('eth0', { method: 'auto' })).rejects.toThrow(/previous change/);
    await ctl.confirm(true);
    expect(calls.at(-1)).toContain('CheckpointDestroy');
    await expect(ctl.applyIpv4('eth0', { method: 'auto' })).resolves.toBeTruthy();
  });
});

describe('network stack detection', () => {
  const none = { nmActive: false, netplanFiles: 0, networkdActive: false, dhcpcdActive: false, ifupdownIfaces: 0 };
  it('prefers the stack really in charge, in installer order', () => {
    expect(pickBackend({ ...none, nmActive: true, netplanFiles: 2 })).toBe('nm');
    expect(pickBackend({ ...none, netplanFiles: 1, networkdActive: true })).toBe('netplan');
    expect(pickBackend({ ...none, networkdActive: true, ifupdownIfaces: 1 })).toBe('networkd');
    expect(pickBackend({ ...none, dhcpcdActive: true, ifupdownIfaces: 1 })).toBe('dhcpcd');
    expect(pickBackend({ ...none, ifupdownIfaces: 1 })).toBe('ifupdown');
    expect(pickBackend(none)).toBe('none');
  });
  it('finds ifupdown interfaces, not loopback', () => {
    expect(ifupdownIfaces('auto lo\niface lo inet loopback\nallow-hotplug eth0\niface eth0 inet dhcp\niface eth0 inet6 auto\n')).toEqual(['eth0']);
  });
  it('reads addresses, DHCP and the gateway from ip -j', () => {
    const addr = JSON.stringify([
      { ifname: 'lo', link_type: 'loopback', addr_info: [{ family: 'inet', local: '127.0.0.1', prefixlen: 8 }] },
      { ifname: 'eth0', operstate: 'UP', address: 'aa:bb', addr_info: [{ family: 'inet', local: '10.0.0.5', prefixlen: 24, dynamic: true }] },
      { ifname: 'eth1', operstate: 'UP', addr_info: [{ family: 'inet', local: '192.168.9.2', prefixlen: 24 }] },
    ]);
    const list = parseIpAddr(addr, JSON.stringify([{ dst: 'default', gateway: '10.0.0.1', dev: 'eth0' }]), ['1.1.1.1']);
    expect(list.map((i) => [i.device, i.method, i.ipv4[0], i.gateway])).toEqual([['eth0', 'auto', '10.0.0.5/24', '10.0.0.1'], ['eth1', 'manual', '192.168.9.2/24', '']]);
  });
});

describe('helper requests', () => {
  const ok = { op: 'apply', id: 'abcdef0123456789', iface: 'eth0', method: 'manual', address: '192.168.1.50/24', gateway: '192.168.1.1', dns: ['1.1.1.1'] };
  it('accepts a clean request and drops unknown fields', () => {
    expect(validateNetRequest({ ...ok, extra: 'x' })).toEqual(ok);
    expect(validateNetRequest({ op: 'confirm', id: 'abcdef0123456789' })).toEqual({ op: 'confirm', id: 'abcdef0123456789' });
  });
  it('rejects anything that could reach a config file or a shell', () => {
    for (const bad of [
      { ...ok, iface: 'eth0; reboot' }, { ...ok, iface: '../etc' }, { ...ok, iface: 'eth0\npost-up x' },
      { ...ok, address: '192.168.1.50/24\n    post-up rm -rf /' }, { ...ok, address: '1.2.3.4' }, { ...ok, address: '1.2.3.4/0' },
      { ...ok, gateway: '1.2.3.4 x' }, { ...ok, dns: ['1.1.1.1', 'evil'] }, { ...ok, method: 'static' }, { ...ok, id: 'x' }, { ...ok, op: 'exec' }, null, [], 'x',
    ]) expect(() => validateNetRequest(bad), JSON.stringify(bad)).toThrow();
  });
  it('renders each stack', () => {
    const st = { method: 'manual' as const, address: '192.168.1.50/24', gateway: '192.168.1.1', dns: ['1.1.1.1', '9.9.9.9'] };
    expect(netplanYaml('eth0', st)).toContain('addresses: [192.168.1.50/24]');
    expect(netplanYaml('eth0', st)).toContain('via: 192.168.1.1');
    expect(networkdUnit('eth0', st)).toMatch(/Name=eth0[\s\S]*Address=192\.168\.1\.50\/24\nGateway=192\.168\.1\.1\nDNS=1\.1\.1\.1/);
    expect(ifupdownStanza('eth0', st)).toContain('netmask 255.255.255.0');
    expect(ifupdownStanza('eth0', { method: 'auto', dns: [] })).toContain('iface eth0 inet dhcp');
  });
  it('moves an ifupdown stanza out of /etc/network/interfaces', () => {
    const before = 'source /etc/network/interfaces.d/*\nauto lo\niface lo inet loopback\n\nallow-hotplug eth0\niface eth0 inet static\n    address 1.2.3.4\n    netmask 255.0.0.0\n\nauto eth1\niface eth1 inet dhcp\n';
    const after = stripIfupdownStanza(before, 'eth0');
    expect(after).not.toMatch(/eth0/);
    expect(after).toContain('iface eth1 inet dhcp');
    expect(after).toContain('iface lo inet loopback');
    expect(stripIfupdownStanza('auto eth0\niface eth0 inet dhcp\n', 'eth0')).toContain('source /etc/network/interfaces.d/*');
  });
  it('keeps one dhcpcd block per interface, at the end', () => {
    const st = { method: 'manual' as const, address: '10.1.1.9/24', gateway: '10.1.1.1', dns: [] };
    const once = dhcpcdConf('hostname\nclientid\n', 'eth0', st);
    const twice = dhcpcdConf(once, 'eth0', { ...st, address: '10.1.1.10/24' });
    expect(twice.match(/# towerlog begin eth0/g)).toHaveLength(1);
    expect(twice).toContain('static ip_address=10.1.1.10/24');
    expect(dhcpcdConf(twice, 'eth0', { method: 'auto', dns: [] })).not.toContain('towerlog');
  });
});

describe('changes through the helper (no NetworkManager)', () => {
  it('drops a validated request and waits for the helper', async () => {
    const netDir = tmpDir();
    const run = async (cmd: string, args: string[]) => {
      if (cmd === 'systemctl' && args[0] === 'is-enabled') return 'enabled\n';
      throw new Error('spawn nmcli ENOENT');
    };
    const ctl = new NetworkManagerCtl(log, run, { confFile: confWith('networkd'), netDir, helperTimeoutMs: 3000 });
    // Fake helper: answer each request like towerlog-netapply would.
    const seen: Record<string, unknown>[] = [];
    const timer = setInterval(() => {
      const f = path.join(netDir, 'request.json');
      if (!fs.existsSync(f)) return;
      const req = JSON.parse(fs.readFileSync(f, 'utf8'));
      fs.rmSync(f);
      seen.push(req);
      const state = req.op === 'apply' ? 'applied' : req.op === 'confirm' ? 'confirmed' : 'rolled_back';
      fs.writeFileSync(path.join(netDir, 'status.json'), JSON.stringify({ id: req.id, state, backend: 'networkd', until: Date.now() + 90000, at: Date.now() }));
    }, 50);
    try {
      const s = await ctl.status();
      expect(s.backend).toBe('networkd');
      expect(s.available).toBe(true);
      expect(s.wifi).toBe(false);
      await expect(ctl.applyIpv4('eth0', { method: 'manual', address: 'nope' })).rejects.toThrow(/address/);
      const r = await ctl.applyIpv4('eth0', { method: 'manual', address: '10.0.0.9/24', gateway: '10.0.0.1', dns: ['1.1.1.1'] });
      expect(r.until).toBeGreaterThan(Date.now());
      expect(seen[0]).toMatchObject({ op: 'apply', iface: 'eth0', method: 'manual', address: '10.0.0.9/24' });
      expect((await ctl.status()).pending).not.toBeNull();
      await ctl.confirm(true);
      expect(seen[1]).toMatchObject({ op: 'confirm', id: (seen[0] as { id: string }).id });
      await expect(ctl.wifiScan()).rejects.toThrow();
    } finally {
      clearInterval(timer);
    }
  });
  it('is view-only when the helper is not installed', async () => {
    const ctl = new NetworkManagerCtl(log, async () => { throw new Error('nope'); }, { confFile: confWith('ifupdown'), netDir: '/nonexistent/net' });
    const s = await ctl.status();
    expect(s.available).toBe(false);
    expect(s.reason).toMatch(/helper/);
  });
});
