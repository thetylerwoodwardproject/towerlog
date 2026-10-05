import { afterEach, describe, expect, it } from 'vitest';
import { ZabbixSender, decodeResponse, encodePacket, inputKey, INPUT_METRICS } from '../src/engine/zabbix.ts';
import { buildTemplate, uuidFor } from '../src/engine/zabbix-template.ts';
import { fakeTrapper, quietLogger, zbxConf } from './helpers.ts';

describe('protocol', () => {
  it('encodes the ZBXD header', () => {
    const p = encodePacket('h', [['k', 1]]);
    expect(p.toString('ascii', 0, 4)).toBe('ZBXD');
    expect(p[4]).toBe(1);
    expect(Number(p.readBigUInt64LE(5))).toBe(p.length - 13);
    expect(JSON.parse(p.subarray(13).toString())).toEqual({ request: 'sender data', data: [{ host: 'h', key: 'k', value: '1' }] });
    expect(decodeResponse(p)).toMatchObject({ request: 'sender data' });
  });
  it('keys are towerlog keys', () => {
    expect(inputKey('level', 'studio-a')).toBe('towerlog.input.level[studio-a]');
    expect(Object.keys(INPUT_METRICS)).toEqual(expect.arrayContaining(['state', 'up', 'level', 'fault.link', 'fault.silence', 'fault.clip', 'fault.mono', 'fault.phase']));
  });
});

describe('sender', () => {
  const closers: (() => void)[] = [];
  afterEach(() => { closers.splice(0).forEach((c) => c()); });

  it('delivers and reports the server info', async () => {
    const srv = await fakeTrapper();
    closers.push(srv.close);
    const z = new ZabbixSender(zbxConf({ port: srv.port, hostname: 'pi1' }), quietLogger());
    const info = await z.send([['towerlog.heartbeat', 1], [inputKey('up', 'a'), 1]]);
    expect(info).toMatch(/processed: 2/);
    expect(srv.requests[0].data[0]).toEqual({ host: 'pi1', key: 'towerlog.heartbeat', value: '1' });
    expect(z.lastOk).not.toBeNull();
  });
  it('a hung server times out without throwing', async () => {
    const srv = await fakeTrapper({ hang: true });
    closers.push(srv.close);
    const z = new ZabbixSender(zbxConf({ port: srv.port }), quietLogger());
    const t0 = Date.now();
    await expect(z.send([['k', 1]])).resolves.toBe('');
    expect(Date.now() - t0).toBeLessThan(7000);
    expect(z.lastError).toMatch(/timeout/);
  }, 10000);
  it('disabled sender does nothing', async () => {
    const z = new ZabbixSender(zbxConf({ enabled: false }), quietLogger());
    await expect(z.send([['k', 1]])).resolves.toBe('');
  });
});

describe('template', () => {
  const xml = buildTemplate(new Date('2026-10-01T00:00:00Z'));
  it('has every input metric as an item prototype and a trigger per fault', () => {
    for (const m of Object.keys(INPUT_METRICS)) expect(xml).toContain(`<key>towerlog.input.${m}[{#INPUT}]</key>`);
    expect(xml).toContain('<key>towerlog.inputs.discovery</key>');
    for (const k of ['feed lost', 'silence (dead air)', 'clipping', 'out of phase']) expect(xml).toContain(`{#NAME}: ${k}`);
  });
  it('has unique UUIDs', () => {
    const ids = [...xml.matchAll(/<uuid>([0-9a-f]{32})<\/uuid>/g)].map((m) => m[1]);
    expect(new Set(ids).size).toBe(ids.length);
    expect(uuidFor('anything')[12]).toBe('4');
  });
  it('is balanced XML with escaped expressions', () => {
    const open = (xml.match(/<[a-z_]+>/g) ?? []).length;
    const close = (xml.match(/<\/[a-z_]+>/g) ?? []).length;
    expect(open).toBe(close);
    expect(xml).not.toMatch(/<expression>[^<]*[<>][^<]*<\/expression>/);
  });
});
