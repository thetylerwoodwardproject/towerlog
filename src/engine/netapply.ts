// towerlog-netapply: the root half of network settings on hosts without
// NetworkManager (netplan, systemd-networkd, ifupdown, dhcpcd).
//
// Started by towerlog-netapply.path whenever the (unprivileged) app drops
// <net dir>/request.json. It never trusts that file: it is opened without
// following symlinks, size-limited and re-validated with the same rules as the app
// (net-config.ts). The network stack comes from root-owned /etc/towerlog/network.json,
// never from the request. Before changing anything it backs the affected files up
// into a root-only directory and arms a systemd timer that restores them after
// ROLLBACK_SECS unless the app sends a "confirm" request.
//
//   towerlog-netapply             process a pending request (the path unit runs this)
//   towerlog-netapply --rollback  restore the backup now (the rollback timer runs this)
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  BACKEND_NAMES, dhcpcdConf, ifupdownStanza, isBackend, netplanYaml, networkdUnit, stripIfupdownStanza, validateNetRequest,
  type Backend, type Ipv4Settings, type NetHelperStatus,
} from './net-config.ts';

export const ROLLBACK_SECS = 90;
const NET_DIR = process.env.TOWERLOG_NET_DIR || '/var/lib/towerlog/net';
const STATE_DIR = process.env.TOWERLOG_NETAPPLY_STATE || '/var/lib/towerlog-netapply';
const CONF = '/etc/towerlog/network.json';
const TIMER_UNIT = 'towerlog-net-rollback';
const MAX_REQUEST = 4096;

interface FileBackup { path: string; existed: boolean; content: string; mode: number }
interface Pending { id: string; backend: Backend; iface: string; until: number; files: FileBackup[] }

function run(cmd: string, args: string[], allowFail = false) {
  try {
    execFileSync(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], timeout: 60000 });
  } catch (e) {
    const err = e as { stderr?: Buffer; message: string };
    const msg = `${cmd} ${args.join(' ')}: ${(err.stderr?.toString() || err.message).trim().split('\n').pop()}`;
    if (!allowFail) throw new Error(msg);
    console.error(msg);
  }
}

/** The request directory must be a real directory (not a symlink planted by the app user). */
function checkNetDir() {
  const st = fs.lstatSync(NET_DIR);
  if (!st.isDirectory() || st.isSymbolicLink()) throw new Error(`${NET_DIR} is not a directory`);
}

/** Write a file in the app-owned directory without following anything planted there. */
function writeInNetDir(name: string, text: string) {
  const tmp = path.join(NET_DIR, `.${name}.${crypto.randomBytes(6).toString('hex')}`);
  const fd = fs.openSync(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o644);
  try { fs.writeSync(fd, text); } finally { fs.closeSync(fd); }
  fs.renameSync(tmp, path.join(NET_DIR, name));
}

function status(s: Omit<NetHelperStatus, 'at'>) {
  writeInNetDir('status.json', JSON.stringify({ ...s, at: Date.now() }) + '\n');
}

function readRequest(): unknown | null {
  const file = path.join(NET_DIR, 'request.json');
  let fd: number;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    fs.rmSync(file, { force: true });
    throw new Error('request.json must be a regular file');
  }
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.size > MAX_REQUEST) throw new Error('request.json must be a small regular file');
    const buf = Buffer.alloc(st.size);
    fs.readSync(fd, buf, 0, st.size, 0);
    try { return JSON.parse(buf.toString('utf8')); } catch { throw new Error('request.json is not valid JSON'); }
  } finally {
    fs.closeSync(fd);
    fs.rmSync(file, { force: true });
  }
}

function readBackend(): Backend {
  // /etc/towerlog belongs to the app user, so only trust a root-owned regular file.
  const st = fs.lstatSync(CONF, { throwIfNoEntry: false });
  if (!st || !st.isFile() || st.uid !== 0) throw new Error(`${CONF} must be a root-owned file; re-run the installer`);
  try {
    const b = JSON.parse(fs.readFileSync(CONF, 'utf8')).backend;
    if (isBackend(b)) return b;
  } catch { /* fall through */ }
  throw new Error(`${CONF} is missing or invalid; re-run the installer`);
}

// ------------------------------------------------------------------ pending change (root-only)

const pendingFile = () => path.join(STATE_DIR, 'pending.json');
function loadPending(): Pending | null {
  try { return JSON.parse(fs.readFileSync(pendingFile(), 'utf8')) as Pending; } catch { return null; }
}
function savePending(p: Pending | null) {
  fs.mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  fs.chmodSync(STATE_DIR, 0o700);
  if (p) fs.writeFileSync(pendingFile(), JSON.stringify(p), { mode: 0o600 });
  else fs.rmSync(pendingFile(), { force: true });
}

function backup(paths: string[]): FileBackup[] {
  return paths.map((p) => {
    try {
      const st = fs.statSync(p);
      return { path: p, existed: true, content: fs.readFileSync(p, 'utf8'), mode: st.mode & 0o777 };
    } catch { return { path: p, existed: false, content: '', mode: 0o644 }; }
  });
}

function restoreFiles(files: FileBackup[]) {
  for (const f of files) {
    if (f.existed) { fs.writeFileSync(f.path, f.content, { mode: f.mode }); fs.chmodSync(f.path, f.mode); }
    else fs.rmSync(f.path, { force: true });
  }
}

// ------------------------------------------------------------------ per-stack apply

/** The files a change to `iface` touches, per stack. */
function filesFor(backend: Backend, iface: string): string[] {
  switch (backend) {
    case 'netplan': return [`/etc/netplan/90-towerlog-${iface}.yaml`];
    case 'networkd': return [`/etc/systemd/network/05-towerlog-${iface}.network`];
    case 'ifupdown': return ['/etc/network/interfaces', `/etc/network/interfaces.d/towerlog-${iface}`];
    case 'dhcpcd': return ['/etc/dhcpcd.conf'];
    default: throw new Error(`can't change the network through ${BACKEND_NAMES[backend]}`);
  }
}

function writeConfig(backend: Backend, iface: string, s: Ipv4Settings) {
  switch (backend) {
    case 'netplan': {
      if (/^wl/.test(iface)) throw new Error('Wi-Fi interfaces under netplan need access-point settings; edit /etc/netplan by hand');
      const f = `/etc/netplan/90-towerlog-${iface}.yaml`;
      fs.writeFileSync(f, netplanYaml(iface, s), { mode: 0o600 });
      fs.chmodSync(f, 0o600);
      break;
    }
    case 'networkd':
      fs.mkdirSync('/etc/systemd/network', { recursive: true });
      fs.writeFileSync(`/etc/systemd/network/05-towerlog-${iface}.network`, networkdUnit(iface, s), { mode: 0o644 });
      break;
    case 'ifupdown': {
      const main = '/etc/network/interfaces';
      fs.writeFileSync(main, stripIfupdownStanza(fs.existsSync(main) ? fs.readFileSync(main, 'utf8') : '', iface));
      fs.mkdirSync('/etc/network/interfaces.d', { recursive: true });
      fs.writeFileSync(`/etc/network/interfaces.d/towerlog-${iface}`, ifupdownStanza(iface, s), { mode: 0o644 });
      break;
    }
    case 'dhcpcd': {
      const f = '/etc/dhcpcd.conf';
      fs.writeFileSync(f, dhcpcdConf(fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '', iface, s));
      break;
    }
    default: throw new Error(`can't change the network through ${BACKEND_NAMES[backend]}`);
  }
}

/** Make the stack pick up the files as they are now. `down` runs before files change (ifupdown). */
function activate(backend: Backend, iface: string, phase: 'down' | 'up') {
  switch (backend) {
    case 'netplan': if (phase === 'up') { run('netplan', ['generate']); run('netplan', ['apply']); } break;
    case 'networkd': if (phase === 'up') { run('networkctl', ['reload']); run('networkctl', ['reconfigure', iface], true); } break;
    case 'ifupdown': if (phase === 'down') run('ifdown', ['--force', iface], true); else run('ifup', [iface]); break;
    case 'dhcpcd': if (phase === 'up') run('systemctl', ['restart', 'dhcpcd.service']); break;
    default: break;
  }
}

function disarmTimer() {
  run('systemctl', ['stop', `${TIMER_UNIT}.timer`], true);
  run('systemctl', ['reset-failed', `${TIMER_UNIT}.service`, `${TIMER_UNIT}.timer`], true);
}

function rollback(p: Pending) {
  activate(p.backend, p.iface, 'down');
  restoreFiles(p.files);
  try { activate(p.backend, p.iface, 'up'); } finally { savePending(null); }
}

// ------------------------------------------------------------------ main

function main() {
  if (process.argv.includes('--rollback')) {
    const p = loadPending();
    if (!p) return;
    rollback(p);
    disarmTimer();
    try { checkNetDir(); status({ id: p.id, state: 'rolled_back', backend: p.backend, error: `not confirmed within ${ROLLBACK_SECS} s` }); } catch { /* app dir gone */ }
    console.log(`rolled back the change to ${p.iface}`);
    return;
  }

  checkNetDir();
  let raw: unknown;
  try { raw = readRequest(); } catch (e) { status({ id: '', state: 'failed', backend: 'none', error: (e as Error).message }); return; }
  if (raw === null) return;
  let backend: Backend = 'none';
  // Echo a well-formed id even when the request is rejected, so the app gets the error at once.
  const rawId = (raw as { id?: unknown } | null)?.id;
  let id = typeof rawId === 'string' && /^[a-f0-9]{8,32}$/.test(rawId) ? rawId : '';
  try {
    const req = validateNetRequest(raw);
    id = req.id;
    backend = readBackend();
    const pending = loadPending();

    if (req.op === 'confirm' || req.op === 'rollback') {
      if (!pending || pending.id !== req.id) throw new Error('no change is waiting for confirmation');
      disarmTimer();
      if (req.op === 'confirm') { savePending(null); status({ id, state: 'confirmed', backend }); console.log(`kept the change to ${pending.iface}`); }
      else { rollback(pending); status({ id, state: 'rolled_back', backend }); console.log(`rolled back the change to ${pending.iface}`); }
      return;
    }

    if (req.op !== 'apply') return;
    if (pending) throw new Error('another network change is still waiting for confirmation');
    const files = backup(filesFor(backend, req.iface));
    const until = Date.now() + ROLLBACK_SECS * 1000;
    const p: Pending = { id, backend, iface: req.iface, until, files };
    savePending(p);
    try {
      activate(backend, req.iface, 'down');
      writeConfig(backend, req.iface, req);
      activate(backend, req.iface, 'up');
      run('systemd-run', [`--unit=${TIMER_UNIT}`, `--on-active=${ROLLBACK_SECS}`, '--timer-property=AccuracySec=1s',
        '--description=Towerlog network rollback', process.execPath, process.argv[1], '--rollback']);
    } catch (e) {
      rollback(p);
      throw e;
    }
    status({ id, state: 'applied', backend, until });
    console.log(`${req.iface}: ${req.method === 'auto' ? 'DHCP' : req.address} via ${BACKEND_NAMES[backend]}; rolls back in ${ROLLBACK_SECS} s unless confirmed`);
  } catch (e) {
    console.error((e as Error).message);
    status({ id, state: 'failed', backend, error: (e as Error).message });
  }
}

main();
