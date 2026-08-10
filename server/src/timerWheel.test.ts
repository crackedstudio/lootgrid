import { describe, expect, it } from 'vitest';
import { TimerWheel } from './timerWheel';

describe('TimerWheel', () => {
  it('drains only what is due', () => {
    const w = new TimerWheel();
    w.push('a', 100);
    w.push('b', 200);
    w.push('c', 300);

    expect(w.drain(150)).toEqual(['a']);
    expect(w.drain(250)).toEqual(['b']);
    expect(w.drain(1000)).toEqual(['c']);
    expect(w.drain(2000)).toEqual([]);
  });

  it('drains in deadline order regardless of insertion order', () => {
    const w = new TimerWheel();
    w.push('late', 900);
    w.push('early', 100);
    w.push('mid', 500);
    expect(w.drain(1000)).toEqual(['early', 'mid', 'late']);
  });

  it('treats a deadline exactly at now as due', () => {
    const w = new TimerWheel();
    w.push('a', 100);
    expect(w.drain(100)).toEqual(['a']);
  });

  it('skips cancelled entries', () => {
    const w = new TimerWheel();
    w.push('a', 100);
    w.push('b', 200);
    w.cancel('a');
    expect(w.drain(1000)).toEqual(['b']);
  });

  it('does not resurrect a cancelled id that is re-pushed', () => {
    const w = new TimerWheel();
    w.push('a', 100);
    w.cancel('a');
    w.push('a', 200);
    expect(w.drain(1000)).toEqual(['a']);
  });

  it('reports size excluding cancellations', () => {
    const w = new TimerWheel();
    w.push('a', 100);
    w.push('b', 200);
    expect(w.size).toBe(2);
    w.cancel('a');
    expect(w.size).toBe(1);
  });

  it('handles many entries in order', () => {
    const w = new TimerWheel();
    const deadlines = Array.from({ length: 500 }, (_, i) => (i * 7919) % 500);
    deadlines.forEach((at, i) => w.push(`id${i}`, at));

    const drained = w.drain(10_000);
    expect(drained).toHaveLength(500);

    const order = drained.map(id => deadlines[Number(id.slice(2))]!);
    for (let i = 1; i < order.length; i++) {
      expect(order[i]!).toBeGreaterThanOrEqual(order[i - 1]!);
    }
  });

  it('is empty-safe', () => {
    expect(new TimerWheel().drain(Date.now())).toEqual([]);
  });
});
