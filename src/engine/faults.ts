// Upstream fault tracking for logged inputs. A fault is raised after it has held
// for its delay, cleared once the condition is gone, and every raise/clear is
// reported through `onEvent` (alerts, fault log, recording timeline).
export type FaultKind = 'link' | 'silence' | 'clip' | 'mono' | 'phase';

export interface FaultEvent {
  input: string;
  kind: FaultKind;
  state: 'raised' | 'cleared';
  at: number;
  /** Seconds the fault lasted (cleared events only). */
  duration?: number;
}

export interface FaultRule {
  /** Seconds the condition must hold before the fault is raised. */
  delay: number;
}

export type FaultRules = Record<FaultKind, FaultRule>;

export const DEFAULT_FAULT_RULES: FaultRules = {
  link: { delay: 5 },
  silence: { delay: 30 },
  clip: { delay: 10 },
  mono: { delay: 30 },
  phase: { delay: 30 },
};

export class FaultTracker {
  private since = new Map<FaultKind, number>();
  private raisedAt = new Map<FaultKind, number>();

  constructor(
    private input: string,
    private rules: FaultRules,
    private onEvent: (e: FaultEvent) => void,
  ) {}

  /** Report whether `kind` is currently bad. Call at least once a second. */
  observe(kind: FaultKind, bad: boolean, now: number): void {
    if (bad) {
      const start = this.since.get(kind) ?? now;
      this.since.set(kind, start);
      if (!this.raisedAt.has(kind) && now - start >= this.rules[kind].delay) {
        this.raisedAt.set(kind, start);
        this.onEvent({ input: this.input, kind, state: 'raised', at: start });
      }
      return;
    }
    this.since.delete(kind);
    const at = this.raisedAt.get(kind);
    if (at !== undefined) {
      this.raisedAt.delete(kind);
      this.onEvent({ input: this.input, kind, state: 'cleared', at: now, duration: now - at });
    }
  }

  active(): FaultKind[] {
    return [...this.raisedAt.keys()];
  }
}

export const FAULT_LABEL: Record<FaultKind, string> = {
  link: 'feed lost',
  silence: 'silence (dead air)',
  clip: 'clipping',
  mono: 'mono (left and right identical)',
  phase: 'channels out of phase',
};
