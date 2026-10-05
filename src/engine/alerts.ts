// Emails that are not input faults: low recording disk space and service start/stop.
// (Input faults are debounced by FaultTracker and mailed straight from the engine.)
import fs from 'node:fs';
import type { Mailer } from './mailer.ts';

export function fmtDuration(seconds: number): string {
  const s = Math.max(0, Math.trunc(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m ${sec}s`;
  return `${sec}s`;
}

export function fmtTime(epochSecs: number): string {
  const d = new Date(epochSecs * 1000);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export type DiskUsage = (path: string) => { free: number };

export const defaultDiskUsage: DiskUsage = (p) => {
  const st = fs.statfsSync(p);
  return { free: st.bavail * st.bsize };
};

export class AlertManager {
  static DISK_CHECK_SECS = 300;
  static DISK_RECOVER_FACTOR = 1.25;

  diskLow = false;
  private nextDisk = 0;

  constructor(public mailer: Mailer, private diskUsage: DiskUsage = defaultDiskUsage) {}

  private get m() { return this.mailer; }

  checkDisk(now: number, path: string, recording: boolean) {
    const m = this.m;
    if (!(m.enabled && m.conf.alert_disk && recording) || now < this.nextDisk) return;
    this.nextDisk = now + AlertManager.DISK_CHECK_SECS;
    let freeGb: number;
    try {
      freeGb = this.diskUsage(path).free / 1024 ** 3;
    } catch {
      return;
    }
    if (!this.diskLow && freeGb < m.conf.disk_min_gb) {
      this.diskLow = true;
      m.send('Low disk space',
        `Only ${freeGb.toFixed(1)} GB is free where Towerlog stores recordings (${path}).\n` +
        `The alert level is ${m.conf.disk_min_gb} GB. Recording will fail when the disk is full; ` +
        'delete old recordings, set "keep days" on the inputs or turn on the disk watermark purge.');
    } else if (this.diskLow && freeGb >= m.conf.disk_min_gb * AlertManager.DISK_RECOVER_FACTOR) {
      this.diskLow = false;
      m.send('Disk space recovered', `${freeGb.toFixed(1)} GB is free again where Towerlog stores recordings (${path}).`);
    }
  }

  serviceStarted(statuses: Record<string, string>) {
    if (!(this.m.enabled && this.m.conf.alert_service)) return;
    const names = Object.keys(statuses);
    const lines = names.map((n) => `  ${n}: ${statuses[n]}`).join('\n') || '  (no inputs configured)';
    this.m.send('Towerlog started', `Towerlog started with ${names.length} input(s):\n${lines}`);
  }

  async serviceStopped() {
    if (!(this.m.enabled && this.m.conf.alert_service)) return;
    this.m.send('Towerlog stopped', 'Towerlog is shutting down (service stop, restart or reboot).');
    await this.m.flush(6000);
  }
}
