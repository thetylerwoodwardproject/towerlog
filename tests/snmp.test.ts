import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import snmp from 'net-snmp';
import type { Session, Varbind } from 'net-snmp';
import { SnmpSchema } from '../src/engine/config.ts';
import { SnmpService } from '../src/engine/snmp.ts';
import { ROOT, buildMib, trapOid } from '../src/engine/snmp-mib.ts';
import type { Snapshot } from '../src/lib/types.ts';

const log = { info() {}, warn() {}, error() {}, file() {} } as never;
const PORT = 26161, TRAP_PORT = 26162; // away from the test rig's agent on 16161

const meter = (l: number, r: number) => ({ rms_db: [l, r], peak_db: [l + 12, r + 12] });
const snap = {
  type: 'snapshot', version: '2026.10.04', hostname: 'test', uptime_s: 12, time: 0, warnings: [], disk: null,
  services: {},
  inputs: [
    { id: 'studio-a', name: 'Studio A', kind: 'http', status: 'live', detail: '', meter: meter(-20, -21), faults: [], silent_s: 0, recording: true, chunk_minutes: 15, idle_s: 0, up_since: 1 },
    { id: 'barix', name: 'Barix', kind: 'push', status: 'down', detail: 'source disconnected', meter: meter(-90, -90), faults: ['link'], silent_s: 0, recording: false, chunk_minutes: 60, idle_s: 30, up_since: null },
  ],
} as unknown as Snapshot;

const conf = SnmpSchema.parse({
  enabled: true, port: PORT, bind: '127.0.0.1', community: 'secret',
  v3_enabled: true, v3_user: 'nms', v3_auth: 'sha', v3_auth_key: 'authkey123', v3_priv: 'aes', v3_priv_key: 'privkey123',
  traps: [{ host: '127.0.0.1', port: TRAP_PORT, version: 'v2c', community: 'traps' }],
});

const get = (s: Session, oids: string[]) => new Promise<Varbind[]>((res, rej) => s.get(oids, (e, vb) => (e ? rej(e) : res(vb!))));

describe('SNMP agent', () => {
  let svc: SnmpService;
  beforeAll(async () => {
    svc = new SnmpService(conf, log);
    svc.start(() => ({ snap }));
    await new Promise((r) => setTimeout(r, 200));
  });
  afterAll(() => svc.close());

  it('answers v2c GETs for scalars and table cells', async () => {
    const s = snmp.createSession('127.0.0.1', 'secret', { port: PORT, version: snmp.Version2c });
    // system: version, live, faulted; input table: name, kind, status, level left, fault link, chunk minutes
    const vb = await get(s, [`${ROOT}.1.1.1.0`, `${ROOT}.1.1.4.0`, `${ROOT}.1.1.5.0`, `${ROOT}.1.2.1.3.1`, `${ROOT}.1.2.1.4.2`, `${ROOT}.1.2.1.5.2`, `${ROOT}.1.2.1.7.1`, `${ROOT}.1.2.1.10.2`, `${ROOT}.1.2.1.16.1`]);
    s.close();
    expect(String(vb[0].value)).toBe('Towerlog 2026.10.04');
    expect(vb[1].value).toBe(1);
    expect(vb[2].value).toBe(1);
    expect(String(vb[3].value)).toBe('Studio A');
    expect(vb[4].value).toBe(4); // push
    expect(vb[5].value).toBe(4); // down
    expect(vb[6].value).toBe(-200);
    expect(vb[7].value).toBe(1);
    expect(vb[8].value).toBe(15);
  });

  it('answers v3 authPriv GETs', async () => {
    const s = snmp.createV3Session('127.0.0.1', { name: 'nms', level: snmp.SecurityLevel.authPriv, authProtocol: snmp.AuthProtocols.sha, authKey: 'authkey123', privProtocol: snmp.PrivProtocols.aes, privKey: 'privkey123' }, { port: PORT });
    const vb = await get(s, [`${ROOT}.1.1.6.0`]);
    s.close();
    expect(String(vb[0].value)).toBe('test');
  });

  it('refuses a wrong community and SETs', async () => {
    const bad = snmp.createSession('127.0.0.1', 'public', { port: PORT, version: snmp.Version2c, timeout: 300, retries: 0 });
    await expect(get(bad, [`${ROOT}.1.1.1.0`])).rejects.toThrow();
    bad.close();
    const s = snmp.createSession('127.0.0.1', 'secret', { port: PORT, version: snmp.Version2c, timeout: 500, retries: 0 });
    const err = await new Promise((res) => s.set([{ oid: `${ROOT}.1.1.6.0`, type: snmp.ObjectType.OctetString, value: 'x' }], (e, vb) => res(e || (vb && snmp.isVarbindError(vb[0])))));
    s.close();
    expect(err).toBeTruthy();
  });

  it('sends traps with the Towerlog trap OID and varbinds', async () => {
    const got = new Promise<Varbind[]>((resolve) => {
      const r = snmp.createReceiver({ port: TRAP_PORT, address: '127.0.0.1', disableAuthorization: true }, (e, n) => { if (!e && n) { resolve(n.pdu.varbinds); r.close(); } });
    });
    await new Promise((r) => setTimeout(r, 100));
    svc.trap('inputFault', { id: 'studio-a', name: 'Studio A' }, 'Studio A: silence since now');
    const vb = await got;
    expect(vb.find((v) => v.oid === '1.3.6.1.6.3.1.1.4.1.0')?.value).toBe(trapOid('inputFault'));
    expect(vb.some((v) => String(v.value) === 'Studio A')).toBe(true);
  });

  it('can be muted', () => {
    const muted = new SnmpService(conf, log, true);
    expect(muted.trapsOn).toBe(false);
  });
});

describe('TOWERLOG-MIB', () => {
  it('declares the module under enterprise 99999', () => {
    const mib = buildMib();
    expect(mib).toMatch(/::= \{ enterprises 99999 \}/);
    expect(mib).toContain('towerlogInputFault NOTIFICATION-TYPE');
    expect(mib).toContain('towerlogInputTable OBJECT-TYPE');
    expect(mib.trim().endsWith('END')).toBe(true);
  });
});
