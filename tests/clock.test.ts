import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isPool, parseServers, parseSources, parseTracking, readClock, sourcesText, sourcesWritable, validNtpServer, writeSources, SOURCES_FILE } from '../src/engine/clock.ts';

const TRACKING = '32CD3926,50.205.57.38,2,1791164447.036346975,-0.000042066,0.000050977,0.000080624,-14.956,0.003,0.048,0.022516737,0.000444125,1043.5,Normal';
const SOURCES = '^,-,23.157.160.168,2,8,377,56,0.000245241,0.000245241,0.047613692\n^,*,50.205.57.38,1,10,377,310,-0.000002489,0.000048488,0.011366812\n^,?,10.0.0.9,0,6,0,-,0,0,0';

describe('chrony output', () => {
  it('parses tracking: synchronised, offset in ms, reference and age', () => {
    const t = parseTracking(TRACKING, 1791164507)!;
    expect(t).toMatchObject({ synchronized: true, leap: 'Normal', stratum: 2, offset_ms: -0.042, reference: '50.205.57.38', last_update_s: 60 });
  });
  it('not synchronised when the leap status says so or stratum is 0', () => {
    expect(parseTracking('00000000,,0,0,0.0,0.0,0.0,0.0,0.0,0.0,0.0,0.0,0.0,Not synchronised')!.synchronized).toBe(false);
    expect(parseTracking('garbage')).toBeNull();
  });
  it('parses sources and their state', () => {
    const s = parseSources(SOURCES);
    expect(s.map((x) => [x.address, x.state, x.stratum])).toEqual([['23.157.160.168', 'candidate', 2], ['50.205.57.38', 'selected', 1], ['10.0.0.9', 'unreachable', 0]]);
    expect(s[0].reach).toBe(0o377);
  });
  it('readClock explains a missing chronyc and a failing one', async () => {
    const missing = await readClock(async () => { throw Object.assign(new Error('x'), { code: 'ENOENT' }); });
    expect(missing.status).toMatchObject({ available: false });
    expect(missing.status.reason).toMatch(/not installed/);
    const ok = await readClock(async (_b, a) => (a.includes('tracking') ? TRACKING : SOURCES));
    expect(ok.status.available).toBe(true);
    expect(ok.sources).toHaveLength(3);
  });
});

describe('NTP servers', () => {
  it('validates host names and addresses, refusing option or shell characters', () => {
    for (const ok of ['pool.ntp.org', '10.0.0.1', 'time-a.example.com', '2001:db8::1', 'ntp']) expect(validNtpServer(ok)).toBe(true);
    for (const bad of ['', 'a b', 'x;rm -rf /', 'pool.ntp.org iburst', 'a..b', '-bad.example', 'http://x', 'x\nserver evil']) expect(validNtpServer(bad)).toBe(false);
  });
  it('splits free text and removes duplicates', () => {
    expect(parseServers('a.example.com, b.example.com  a.example.com\n')).toEqual(['a.example.com', 'b.example.com']);
  });
  it('writes pool or server lines with iburst', () => {
    expect(isPool('2.debian.pool.ntp.org')).toBe(true);
    expect(isPool('time.example.com')).toBe(false);
    const t = sourcesText(['pool.ntp.org', '10.0.0.5']);
    expect(t).toContain('pool pool.ntp.org iburst\nserver 10.0.0.5 iburst\n');
    expect(sourcesText([])).not.toMatch(/^(pool|server)/m);
  });
  it('writes the sources file, and refuses a bad name without writing', () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'towerlog-clock-'));
    expect(sourcesWritable(d)).toBe('');
    writeSources(['time.example.com'], d);
    expect(fs.readFileSync(path.join(d, SOURCES_FILE), 'utf8')).toContain('server time.example.com iburst');
    expect(() => writeSources(['bad name'], d)).toThrow(/not a host name/);
    expect(fs.readFileSync(path.join(d, SOURCES_FILE), 'utf8')).toContain('time.example.com');
    expect(sourcesWritable(path.join(d, 'nope'))).toMatch(/does not exist/);
  });
});
