// Optional client IP allowlist (TOWERLOG_ALLOW="203.0.113.7,10.0.0.0/8,::1").
// Checked on the TCP peer address only — X-Forwarded-For is ignored, so it can't
// be spoofed; put a proxy in front only if you also filter there.
import net from 'node:net';

export function makeAllow(spec: string | undefined): ((addr: string | undefined) => boolean) | null {
  const items = (spec || '').split(/[\s,]+/).filter(Boolean);
  if (!items.length) return null;
  const list = new net.BlockList();
  for (const it of items) {
    const [ip, bits] = it.split('/');
    const type = net.isIPv6(ip) ? 'ipv6' : 'ipv4';
    if (!net.isIP(ip)) throw new Error(`TOWERLOG_ALLOW: not an IP address: ${it}`);
    if (bits) list.addSubnet(ip, Number(bits), type);
    else list.addAddress(ip, type);
  }
  return (addr) => {
    if (!addr) return false;
    const a = addr.startsWith('::ffff:') ? addr.slice(7) : addr;
    return list.check(a, net.isIPv6(a) ? 'ipv6' : 'ipv4');
  };
}
