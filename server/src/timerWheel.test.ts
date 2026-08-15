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

/**
 * The long horizon.
 *
 * The implementation plan flags this as a risk — "timerWheel is tuned for
 * 6-second attempts; hour-long hunts change its bucketing assumptions". It is
 * worth stating what the check found: **there are no bucketing assumptions.**
 * This is a binary heap keyed on an absolute timestamp, so a deadline three
 * days out costs exactly what one six seconds out costs, and the two interleave
 * correctly by construction rather than by tuning.
 *
 * What could still go wrong is ordering and precision at that range, so that is
 * what these cover.
 */
describe('deadlines minutes and days out', () => {
  const MINUTE = 60_000;
  const HOUR = 60 * MINUTE;
  const DAY = 24 * HOUR;

  it('interleaves short and long deadlines in the right order', () => {
    const w = new TimerWheel();
    const now = 1_700_000_000_000;
    // An agent zone and a human zone share one wheel: ten-minute attempts and
    // six-second ones, due in whatever order their deadlines fall.
    w.push('agent-slow', now + 10 * MINUTE);
    w.push('human-fast', now + 6_000);
    w.push('agent-hunt', now + 3 * DAY);
    w.push('human-other', now + 6_400);

    expect(w.drain(now + 6_200)).toEqual(['human-fast']);
    expect(w.drain(now + 10 * MINUTE)).toEqual(['human-other', 'agent-slow']);
    expect(w.drain(now + 2 * DAY)).toEqual([]);
    expect(w.drain(now + 3 * DAY)).toEqual(['agent-hunt']);
  });

  it('keeps millisecond precision three days out', () => {
    // Timestamps at this range are ~1.7e12, comfortably inside the safe integer
    // range but far enough out that a float-based wheel would start rounding.
    const w = new TimerWheel();
    const now = 1_700_000_000_000;
    w.push('a', now + 3 * DAY);
    w.push('b', now + 3 * DAY + 1);

    expect(w.drain(now + 3 * DAY)).toEqual(['a']);
    expect(w.drain(now + 3 * DAY + 1)).toEqual(['b']);
  });

  it('fires a deadline that passed while the process was down', () => {
    // Resumed attempts carry absolute deadlines, so one that expired during a
    // restart must come out on the very first sweep rather than waiting for its
    // original delay to elapse again.
    const w = new TimerWheel();
    const bootedAt = 1_700_000_000_000;
    w.push('resumed', bootedAt - HOUR);
    expect(w.drain(bootedAt)).toEqual(['resumed']);
  });

  it('costs nothing extra to hold long deadlines', () => {
    // O(log n) per push regardless of horizon — the property the plan was
    // worried about, and the reason a heap was the right structure to begin
    // with. A thousand three-day deadlines do not slow down the six-second one.
    const w = new TimerWheel();
    const now = 1_700_000_000_000;
    for (let i = 0; i < 1_000; i++) w.push(`slow-${i}`, now + 3 * DAY + i);
    w.push('fast', now + 6_000);

    expect(w.size).toBe(1_001);
    expect(w.drain(now + 6_000)).toEqual(['fast']);
    expect(w.size).toBe(1_000);
  });
});
