import { describe, expect, it } from 'vitest';
import { FaultTracker, DEFAULT_FAULT_RULES, type FaultEvent } from '../src/engine/faults.ts';

function tracker() {
  const events: FaultEvent[] = [];
  return { events, t: new FaultTracker('wxyz', DEFAULT_FAULT_RULES, (e) => events.push(e)) };
}

describe('FaultTracker', () => {
  it('raises only after the delay, stamped at the start of the condition', () => {
    const { t, events } = tracker();
    for (let s = 100; s < 105; s++) t.observe('link', true, s);
    expect(events).toHaveLength(0);
    t.observe('link', true, 105);
    expect(events).toEqual([{ input: 'wxyz', kind: 'link', state: 'raised', at: 100 }]);
    t.observe('link', true, 106);
    expect(events).toHaveLength(1);
  });
  it('a short blip never raises', () => {
    const { t, events } = tracker();
    t.observe('silence', true, 0);
    t.observe('silence', false, 10);
    t.observe('silence', true, 11);
    t.observe('silence', true, 40);
    expect(events).toHaveLength(0);
  });
  it('clears with the fault duration and tracks kinds separately', () => {
    const { t, events } = tracker();
    t.observe('link', true, 0);
    t.observe('link', true, 5);
    t.observe('mono', true, 5);
    expect(t.active()).toEqual(['link']);
    t.observe('link', false, 20);
    expect(events.at(-1)).toMatchObject({ kind: 'link', state: 'cleared', at: 20, duration: 20 });
    expect(t.active()).toEqual([]);
  });
});
