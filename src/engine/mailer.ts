// SMTP alert emails (nodemailer). Messages are queued and delivered in the
// background with retries, so a slow or dead mail server never stalls tuning.
import os from 'node:os';
import nodemailer from 'nodemailer';
import type { SmtpConfig } from './config.ts';
import type { Logger } from './logger.ts';

export const ATTEMPT_DELAYS_MS = [2000, 5000];

export function recipients(to: string): string[] {
  return to.split(/[,;\s]+/).filter(Boolean);
}

export interface Message {
  from: string;
  to: string[];
  subject: string;
  text: string;
}

export type Transport = (msg: Message, conf: SmtpConfig) => Promise<void>;

export const smtpTransport: Transport = async (msg, conf) => {
  const transporter = nodemailer.createTransport({
    host: conf.host,
    port: conf.port,
    secure: conf.security === 'ssl',
    requireTLS: conf.security === 'starttls',
    ignoreTLS: conf.security === 'none',
    name: os.hostname(),
    auth: conf.username ? { user: conf.username, pass: conf.password } : undefined,
    tls: { rejectUnauthorized: conf.verify_tls },
    connectionTimeout: conf.timeout * 1000,
    greetingTimeout: conf.timeout * 1000,
    socketTimeout: conf.timeout * 1000,
  });
  try {
    await transporter.sendMail({ from: msg.from, to: msg.to, subject: msg.subject, text: msg.text });
  } finally {
    transporter.close();
  }
};

export class Mailer {
  readonly hostname = os.hostname();
  lastSent: number | null = null;
  lastError = '';
  lastErrorAt: number | null = null;
  private queue: Message[] = [];
  private busy = false;

  constructor(
    readonly conf: SmtpConfig,
    private log: Logger,
    private transport: Transport = smtpTransport,
    private sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  ) {}

  get to() { return recipients(this.conf.to); }
  get fromAddr() { return this.conf.from.trim() || `towerlog@${this.hostname}`; }
  get enabled() { return this.conf.enabled && !!this.conf.host && this.to.length > 0; }

  /** Why email isn't active, or '' if it is. */
  problem(): string {
    if (!this.conf.enabled) return 'email is turned off';
    if (!this.conf.host) return 'no SMTP server set';
    if (!this.to.length) return 'no recipients set';
    return '';
  }

  build(subject: string, body: string, to = this.to): Message {
    return {
      from: this.fromAddr,
      to,
      subject: `${this.conf.subject_prefix} ${subject} (${this.hostname})`.trim(),
      text: body.trimEnd() + '\n',
    };
  }

  /** Deliver now; throws on failure (for the "send test email" button). */
  async sendNow(subject: string, body: string, to?: string[]): Promise<void> {
    const msg = this.build(subject, body, to?.length ? to : this.to);
    await this.transport(msg, this.conf);
    this.lastSent = Date.now();
    this.log.file('email.log', `sent: ${msg.subject}`);
  }

  /** Queue an email without blocking. No-op when email isn't enabled. */
  send(subject: string, body: string): void {
    if (!this.enabled) return;
    const msg = this.build(subject, body);
    if (this.queue.length >= 50) {
      this.log.file('email.log', `queue full, dropped: ${msg.subject}`);
      return;
    }
    this.queue.push(msg);
    void this.pump();
  }

  get pending() { return this.queue.length + (this.busy ? 1 : 0); }

  private async pump() {
    if (this.busy) return;
    this.busy = true;
    try {
      while (this.queue.length) {
        const msg = this.queue.shift()!;
        for (let attempt = 0; ; attempt++) {
          try {
            await this.transport(msg, this.conf);
            this.lastSent = Date.now();
            this.log.file('email.log', `sent: ${msg.subject}`);
            break;
          } catch (e) {
            const err = `${(e as Error).name}: ${(e as Error).message}`;
            if (attempt < ATTEMPT_DELAYS_MS.length) {
              await this.sleep(ATTEMPT_DELAYS_MS[attempt]);
            } else {
              this.lastError = err;
              this.lastErrorAt = Date.now();
              this.log.file('email.log', `FAILED (${err}): ${msg.subject}`);
              this.log.warn(`email send failed: ${err}`);
              break;
            }
          }
        }
      }
    } finally {
      this.busy = false;
    }
  }

  /** Wait up to `ms` for queued mail to go out. */
  async flush(ms = 10000): Promise<void> {
    const end = Date.now() + ms;
    while (this.pending && Date.now() < end) await new Promise((r) => setTimeout(r, 100));
  }
}
