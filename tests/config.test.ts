import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigStore, ConfigUnreadableError, parseConfig, redactConfig, keepSecret, safeMount } from '../src/engine/config.ts';
import { tmpdir } from './helpers.ts';

describe('config', () => {
  it('fills defaults and drops invalid / duplicate inputs', () => {
    const { config, problems } = parseConfig({
      inputs: [
        { id: 'a', name: 'A', kind: 'http', url: 'http://x/a' },
        { id: 'b', name: 'B', kind: 'push', mount: '/m', source_password: 'p' },
        { id: 'c', name: 'C', kind: 'push', mount: '/m', source_password: 'p' },
        { id: 'd', name: 'D', kind: 'bogus' },
      ],
    });
    expect(config.inputs.map((s) => s.id)).toEqual(['a', 'b']);
    expect(config.inputs[0]).toMatchObject({ chunk_minutes: 60, record: true, keep_days: 30, silence_secs: 30 });
    expect(problems).toHaveLength(2);
    expect(config.source.port).toBe(8000);
    expect(config.web.port).toBe(8090);
    expect(config.purge_min_free_gb).toBe(0);
  });
  it('saves atomically with mode 600 and reloads', () => {
    const f = path.join(tmpdir(), 'c', 'config.json');
    const s = new ConfigStore(f);
    s.update((c) => { c.smtp.password = 'secret'; });
    expect(fs.statSync(f).mode & 0o777).toBe(0o600);
    expect(new ConfigStore(f).config.smtp.password).toBe('secret');
  });
  it('refuses an unreadable file instead of replacing it with defaults', () => {
    const f = path.join(tmpdir(), 'config.json');
    const good = new ConfigStore(f);
    good.update((c) => { c.web.password_hash = 'scrypt$aa$bb'; });
    const broken = fs.readFileSync(f, 'utf8').replace('"inputs": []', '"inputs": [],,');
    for (const text of [broken, '[]', 'null', '{"web": "x"}', '{"inputs": {}}']) {
      fs.writeFileSync(f, text);
      expect(() => new ConfigStore(f)).toThrow(ConfigUnreadableError);
      expect(fs.readFileSync(f, 'utf8')).toBe(text);
    }
  });
  it('keeps the previous version as config.json.bak', () => {
    const f = path.join(tmpdir(), 'config.json');
    const s = new ConfigStore(f);
    s.update((c) => { c.smtp.host = 'one'; });
    s.update((c) => { c.smtp.host = 'two'; });
    expect(JSON.parse(fs.readFileSync(f + '.bak', 'utf8')).smtp.host).toBe('one');
    expect(fs.statSync(f + '.bak').mode & 0o777).toBe(0o600);
  });
  it('writes inputs that did not load back unchanged', () => {
    const f = path.join(tmpdir(), 'config.json');
    const bad = { id: 'b', name: 'Broken', kind: 'http' };
    fs.writeFileSync(f, JSON.stringify({ inputs: [{ id: 'a', name: 'A', kind: 'http', url: 'http://x/a' }, bad] }));
    const s = new ConfigStore(f);
    expect(s.config.inputs.map((x) => x.id)).toEqual(['a']);
    expect(s.problems[0]).toMatch(/Broken.*left in the file/);
    s.update((c) => { c.smtp.host = 'x'; });
    expect(JSON.parse(fs.readFileSync(f, 'utf8')).inputs).toEqual([expect.objectContaining({ id: 'a' }), bad]);
  });
  it('redacts secrets and keeps them on round-trip', () => {
    const { config } = parseConfig({ smtp: { password: 'x' }, web: { password_hash: 'h' }, inputs: [{ id: 'p', name: 'P', kind: 'push', mount: '/p', source_password: 'zzz' }] });
    const r = redactConfig(config);
    expect(r.smtp.password).toBe('********');
    expect(JSON.stringify(r)).not.toContain('"h"');
    expect(JSON.stringify(r)).not.toContain('zzz');
    expect(keepSecret('********', 'x')).toBe('x');
    expect(keepSecret('new', 'x')).toBe('new');
  });
  it('mount helper', () => {
    expect(safeMount('fm 1;rm')).toBe('/fm1rm');
    expect(safeMount('/ok/x')).toBe('/ok/x');
  });
});
