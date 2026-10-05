import { afterEach, describe, expect, it } from 'vitest';
import { AlertManager, fmtDuration } from '../src/engine/alerts.ts';
import { Mailer, type Message } from '../src/engine/mailer.ts';
import { fakeSmtp, quietLogger, smtpConf } from './helpers.ts';

function recordingMailer(o: Record<string, unknown> = {}) {
  const sent: Message[] = [];
  const m = new Mailer(smtpConf({ ...o }), quietLogger(), async (msg) => { sent.push(msg); });
  return { m, sent };
}
const flush = () => new Promise((r) => setTimeout(r, 20));

describe('Mailer over SMTP', () => {
  const closers: (() => void)[] = [];
  afterEach(() => { closers.splice(0).forEach((c) => c()); });

  it('delivers with AUTH to several recipients', async () => {
    const srv = await fakeSmtp({ user: 'u', pass: 'p' });
    closers.push(srv.close);
    const m = new Mailer(smtpConf({ port: srv.port, security: 'none', username: 'u', password: 'p', to: 'a@x.com, b@x.com' }), quietLogger());
    await m.sendNow('Test email', 'hello');
    expect(srv.messages).toHaveLength(1);
    expect(srv.messages[0].to).toHaveLength(2);
    expect(srv.messages[0].auth).toBe('u');
    expect(srv.messages[0].data).toMatch(/Subject: \[Towerlog\] Test email \(/);
  });
  it('a wrong password throws for the test button', async () => {
    const srv = await fakeSmtp({ user: 'u', pass: 'p' });
    closers.push(srv.close);
    const m = new Mailer(smtpConf({ port: srv.port, security: 'none', username: 'u', password: 'nope' }), quietLogger());
    await expect(m.sendNow('x', 'y')).rejects.toThrow();
  });
  it('async send never throws; failure is recorded', async () => {
    const m = new Mailer(smtpConf({ port: 1, security: 'none', timeout: 1 }), quietLogger(), undefined, async () => undefined);
    m.send('x', 'y');
    await m.flush(5000);
    expect(m.lastError).not.toBe('');
  });
  it('disabled or misconfigured sends nothing', () => {
    const { m, sent } = recordingMailer({ enabled: false });
    m.send('a', 'b');
    expect(sent).toHaveLength(0);
    expect(new Mailer(smtpConf({ to: '' }), quietLogger()).problem()).toMatch(/recipients/);
  });
});

describe('AlertManager', () => {
  it('low disk with hysteresis, rate limited', async () => {
    const { m, sent } = recordingMailer({ disk_min_gb: 2 });
    let free = 1.5 * 1024 ** 3;
    const a = new AlertManager(m, () => ({ free }));
    a.checkDisk(0, '/x', true);
    a.checkDisk(10, '/x', true); // rate limited
    free = 2.2 * 1024 ** 3;
    a.checkDisk(400, '/x', true); // not yet 1.25x
    free = 3 * 1024 ** 3;
    a.checkDisk(800, '/x', true);
    await flush();
    expect(sent.map((s) => s.subject)).toEqual([expect.stringContaining('Low disk space'), expect.stringContaining('Disk space recovered')]);
  });
  it('disk is only checked while recording', async () => {
    const { m, sent } = recordingMailer();
    new AlertManager(m, () => ({ free: 0 })).checkDisk(0, '/x', false);
    await flush();
    expect(sent).toHaveLength(0);
  });
  it('toggles switch alert kinds off', async () => {
    const { m, sent } = recordingMailer({ alert_disk: false, alert_service: false });
    const a = new AlertManager(m, () => ({ free: 0 }));
    a.checkDisk(0, '/x', true);
    a.serviceStarted({ K: 'down' });
    await flush();
    expect(sent).toHaveLength(0);
  });
  it('service started lists inputs', async () => {
    const { m, sent } = recordingMailer();
    const a = new AlertManager(m);
    a.serviceStarted({ A: 'live', B: 'down' });
    await flush();
    expect(sent[0].text).toContain('A: live');
    expect(sent[0].subject).toContain('Towerlog started');
  });
  it('formats durations', () => {
    expect(fmtDuration(5)).toBe('5s');
    expect(fmtDuration(125)).toBe('2m 5s');
    expect(fmtDuration(7322)).toBe('2h 2m');
  });
});
