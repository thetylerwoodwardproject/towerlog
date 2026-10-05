// One shared <audio> element: listen to any input from the dashboard.
import { toast } from 'svelte-sonner';

class Player {
  current = $state<string | null>(null);
  label = $state('');
  /** Input id of what is playing (from /listen/input/<id>), so the player bar can show its name and status. */
  input = $state('');
  volume = $state(0.8);
  error = $state('');
  private audio: HTMLAudioElement | null = null;

  toggle(url: string, label: string, input = '') {
    if (this.current === url) return this.stop();
    this.stop();
    const a = new Audio();
    a.preload = 'none';
    a.volume = this.volume;
    a.src = `${url}${url.includes('?') ? '&' : '?'}t=${Date.now()}`;
    a.onerror = () => this.fail(`Can't play ${label}: the input isn't live.`);
    this.audio = a;
    this.current = url;
    this.label = label;
    this.input = input;
    this.error = '';
    a.play().catch((e) => { if (this.audio === a) this.fail(`Can't play ${label}: ${e.message || e}`); });
  }

  private fail(msg: string) {
    this.error = msg;
    toast.error(msg);
    this.stop();
  }

  setVolume(v: number) {
    this.volume = v;
    if (this.audio) this.audio.volume = v;
  }

  stop() {
    if (this.audio) {
      this.audio.pause();
      this.audio.removeAttribute('src');
      this.audio.load();
    }
    this.audio = null;
    this.current = null;
    this.label = '';
    this.input = '';
  }
}

export const player = new Player();
