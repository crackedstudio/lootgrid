import { describe, expect, it } from 'vitest';
import { TAP } from '../config';
import { stdev, tapModule, type TapSpec, type TapState } from './tap';
import type { Timing } from './types';

function ctx(spec: TapSpec, state: TapState, sinceStart: number, sinceLast: number | null) {
  const timing: Timing = { sinceStart, sinceLast, intervals: state.intervals };
  return { spec, secret: null, state, timing, directive: null };
}

/** Plays a full run with the given intervals and returns the final result. */
function play(intervals: number[], spec: TapSpec) {
  const state = tapModule.init(spec);
  let elapsed = 0;
  let last: ReturnType<typeof tapModule.step> = { kind: 'progress' };

  for (let i = 0; i < spec.target; i++) {
    const gap = i === 0 ? null : intervals[(i - 1) % intervals.length]!;
    if (gap !== null) elapsed += gap;
    last = tapModule.step(ctx(spec, state, elapsed, gap), { kind: 'tap' });
    if (last.kind === 'reject') break;
    if (gap !== null) state.intervals.push(gap);
  }
  return { result: last, state };
}

describe('stdev', () => {
  it('is zero for a constant series', () => {
    expect(stdev([50, 50, 50, 50])).toBe(0);
  });

  it('needs at least two samples', () => {
    expect(stdev([])).toBe(0);
    expect(stdev([42])).toBe(0);
  });

  it('grows with spread', () => {
    expect(stdev([10, 90])).toBeGreaterThan(stdev([49, 51]));
  });
});

describe('tap module', () => {
  const { spec } = tapModule.generate('seed', 'med');

  it('generates the configured target', () => {
    expect(spec.target).toBe(TAP.target);
    expect(spec.limitMs).toBe(TAP.limitMs);
  });

  it('scales the target with difficulty', () => {
    expect(tapModule.generate('s', 'easy').spec.target).toBeLessThan(spec.target);
    expect(tapModule.generate('s', 'hard').spec.target).toBeGreaterThan(spec.target);
  });

  it('is deterministic for a given block', () => {
    expect(tapModule.generate('salt-a', 'med').spec).toEqual(
      tapModule.generate('salt-a', 'med').spec,
    );
  });

  it('completes on a jittered human-like run', () => {
    const { result } = play([180, 145, 210, 165, 195, 132, 175], spec);
    expect(result.kind).toBe('complete');
  });

  it('reports progress proportional to taps', () => {
    const state: TapState = { taps: 7, intervals: [] };
    expect(tapModule.progress(state, spec)).toBe(50);
  });

  // --- the anti-cheat checks, which are the point of the module ---

  it('rejects a fixed-interval bot for regularity', () => {
    const { result } = play([120], spec);
    expect(result).toMatchObject({ kind: 'reject', reason: 'timing_too_regular', fatal: true });
  });

  it('rejects sub-floor intervals fatally, not by dropping the input', () => {
    const state = tapModule.init(spec);
    state.intervals.push(200);
    const result = tapModule.step(ctx(spec, state, 210, 10), { kind: 'tap' });
    // Dropping it would let a bot spam and keep whichever taps clear the floor.
    expect(result).toMatchObject({ kind: 'reject', reason: 'interval_floor', fatal: true });
  });

  it('rejects a run that exceeds the limit plus grace', () => {
    const state = tapModule.init(spec);
    const result = tapModule.step(ctx(spec, state, TAP.limitMs + 1000, 300), { kind: 'tap' });
    expect(result).toMatchObject({ kind: 'reject', reason: 'too_slow' });
  });

  it('rejects a run with too few distinct intervals even when sigma passes', () => {
    // Two alternating values: σ is large, but a human never produces exactly
    // two distinct gaps across thirteen taps.
    const { result } = play([100, 400], spec);
    expect(result).toMatchObject({ kind: 'reject' });
    if (result.kind === 'reject') {
      expect(['insufficient_variance', 'timing_too_regular']).toContain(result.reason);
    }
  });

  it('accepts intervals right at the floor when they vary', () => {
    const { result } = play([TAP.minIntervalMs, 60, 45, 80, 33, 70, 51], spec);
    expect(result.kind).toBe('complete');
  });
});
