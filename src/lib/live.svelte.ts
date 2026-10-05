// Live snapshot over /ws with automatic reconnect. One shared instance per page.
import type { Snapshot } from './types.ts';

class Live {
  snapshot = $state<Snapshot | null>(null);
  connected = $state(false);
  private ws: WebSocket | null = null;
  private started = false;

  start() {
    if (this.started || typeof window === 'undefined') return;
    this.started = true;
    this.connect();
  }

  private connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/ws`);
    this.ws = ws;
    ws.onopen = () => { this.connected = true; };
    ws.onmessage = (ev) => {
      try {
        const data = JSON.parse(ev.data);
        if (data?.type === 'snapshot') this.snapshot = data;
      } catch { /* ignore */ }
    };
    ws.onclose = () => {
      this.connected = false;
      this.ws = null;
      setTimeout(() => this.connect(), 1500);
    };
  }
}

export const live = new Live();
