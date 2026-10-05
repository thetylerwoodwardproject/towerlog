import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { beforeAll, describe, expect, it } from 'vitest';
import { Engine } from '../src/engine/index.ts';
import { fakeSmtp, tmpdir } from './helpers.ts';
import { redactConfig } from '../src/engine/config.ts';

beforeAll(() => { process.env.TOWERLOG_LEGACY_DIR = path.join(tmpdir(), 'none'); });
const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;

function engine() {
  const d = tmpdir();
  return new Engine({ config: path.join(d, 'config.json'), data: path.join(d, 'data'), logs: path.join(d, 'logs') });
}
const http = (o: Record<string, unknown> = {}) => ({ name: 'Studio A', kind: 'http', url: 'http://127.0.0.1:1/x', ...o });
const push = (o: Record<string, unknown> = {}) => ({ name: 'Pi 1', kind: 'push', mount: '/fm1', source_password: 'pw', ...o });
const failure = (fn: () => unknown) => { try { fn(); } catch (e) { return (e as Error).message; } return ''; };

describe('inputs in the engine', () => {
  it('creates ids from names and keeps them unique', () => {
    const e = engine();
    const a = e.saveInput(http());
    expect(a.id).toBe('studio-a');
    expect(e.saveInput(http({ name: 'Studio B' })).id).toBe('studio-b');
    expect(e.config.inputs).toHaveLength(2);
  });
  it('refuses duplicate push mounts, clashing folder names and missing settings', () => {
    const e = engine();
    e.saveInput(push());
    expect(failure(() => e.saveInput(push({ name: 'Pi 2' })))).toMatch(/mount \/fm1 is already used/);
    expect(failure(() => e.saveInput(push({ name: 'pi_1', mount: '/other' })))).toMatch(/recordings folder/);
    expect(failure(() => e.saveInput(http({ url: '' })))).toMatch(/needs an http/);
    expect(failure(() => e.saveInput(push({ name: 'No pw', mount: '/n', source_password: '' })))).toMatch(/needs a source password/);
  });
  it('keeps the saved push password when the browser sends the placeholder', () => {
    const e = engine();
    const p = e.saveInput(push());
    const again = e.saveInput({ ...p, source_password: '********' }, p.id);
    expect(again.source_password).toBe('pw');
  });
  it('delete removes it; unknown ids are 404', () => {
    const e = engine();
    const a = e.saveInput(http());
    e.deleteInput(a.id);
    expect(e.config.inputs).toEqual([]);
    expect(failure(() => e.deleteInput('nope'))).toMatch(/no input/);
  });
  it('finds only enabled push inputs by mount', () => {
    const e = engine();
    e.saveInput(push());
    e.saveInput(push({ name: 'Off', mount: '/off', enabled: false }));
    // pushInput looks at running inputs, which exist after start()
    expect(e.pushInput('/fm1')).toBeUndefined();
  });
  it.skipIf(!hasFfmpeg)('start() runs inputs, reports them in the snapshot, and config changes restart them', async () => {
    const e = engine();
    e.saveInput(push());
    e.saveInput(http({ enabled: false }));
    await e.start();
    try {
      expect(e.pushInput('/fm1')?.cfg.name).toBe('Pi 1');
      const snap = e.buildSnapshot();
      expect(snap.inputs.map((i) => [i.id, i.status])).toEqual([['pi-1', 'down'], ['studio-a', 'stopped']]);
      e.saveInput({ ...e.config.inputs[0], chunk_minutes: 15 }, 'pi-1');
      expect(e.inputs.get('pi-1')?.cfg.chunk_minutes).toBe(15);
      e.deleteInput('pi-1');
      expect([...e.inputs.keys()]).toEqual(['studio-a']);
    } finally {
      await e.shutdown();
    }
  }, 30000);

  it('hides push passwords in the redacted config', () => {
    const e = engine();
    e.saveInput(push());
    expect(redactConfig(e.config).inputs[0].source_password).toBe('********');
  });

  it('emails when a fault is raised and when it clears', async () => {
    const srv = await fakeSmtp();
    try {
      const e = engine();
      e.saveSmtp({ enabled: true, host: '127.0.0.1', port: srv.port, security: 'none', to: 'ops@example.com' });
      (e as unknown as { applyServices: (c: unknown) => void }).applyServices(e.config); // normally done by the config watcher after start()
      const fire = (e as unknown as { onInputFault: (r: unknown) => void }).onInputFault.bind(e);
      fire({ input: 'a', name: 'Studio A', kind: 'silence', state: 'raised', at: 1_800_000_000 });
      fire({ input: 'a', name: 'Studio A', kind: 'silence', state: 'cleared', at: 1_800_000_090, duration: 90 });
      for (let i = 0; i < 50 && srv.messages.length < 2; i++) await new Promise((r) => setTimeout(r, 100));
      const subjects = srv.messages.map((m) => /Subject: (.*)/.exec(m.data)?.[1] ?? '');
      expect(subjects[0]).toMatch(/Studio A: SILENCE \(DEAD AIR\)/);
      expect(subjects[1]).toMatch(/Studio A: silence \(dead air\) cleared/);
      expect(srv.messages[1].data).toMatch(/Lasted: 1 min 30 s|Lasted: 1m 30s|Lasted: 90/);
    } finally {
      srv.close();
    }
  });
});
