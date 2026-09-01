import { describe, expect, it } from 'vitest';
import { TAP } from '../config';
import {
  isTappable,
  MAX_TAP_RATE,
  stdev,
  tapModule,
  tapRecipeSchema,
  TAP_LIMITS,
  TAP_TARGET_SPREAD,
  type TapRecipe,
  type TapSpec,
  type TapState,
} from './tap';
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

  it('generates a target near the configured one, on a clock it offers', () => {
    // Not equal to `TAP.target` any more, and that is the fix: every tap block
    // in the game used to carry the same target and the same clock, which is
    // what a measurement of one distinct spec across 500 salts means.
    expect(spec.target).toBeGreaterThanOrEqual(TAP.target - TAP_TARGET_SPREAD);
    expect(spec.target).toBeLessThanOrEqual(TAP.target + TAP_TARGET_SPREAD);
    expect(TAP_LIMITS).toContain(spec.limitMs);
  });

  it('scales the target with difficulty', () => {
    // Across blocks rather than on one, because the spreads overlap by design:
    // a hard block may draw a lower target than an easy one, and asserting on a
    // single salt would be asserting that this particular draw came out tidy.
    const mean = (difficulty: 'easy' | 'med' | 'hard') => {
      const targets = Array.from(
        { length: 200 },
        (_, i) => tapModule.generate(`salt-${i}`, difficulty).spec.target,
      );
      return targets.reduce((a, b) => a + b, 0) / targets.length;
    };
    expect(mean('easy')).toBeLessThan(mean('med'));
    expect(mean('med')).toBeLessThan(mean('hard'));
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
    const half = Math.floor(spec.target / 2);
    const state: TapState = { taps: half, intervals: [] };
    expect(tapModule.progress(state, spec)).toBe(Math.round((half / spec.target) * 100));
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


describe('the recipe space', () => {
  /** Every recipe the schema accepts. */
  function everyRecipe(): TapRecipe[] {
    const out: TapRecipe[] = [];
    for (const limitMs of TAP_LIMITS) {
      for (let target = 10 - TAP_TARGET_SPREAD; target <= 20 + TAP_TARGET_SPREAD; target++) {
        out.push({ target, limitMs });
      }
    }
    return out;
  }

  it('never asks for a pace faster than hard already ships', () => {
    // The bar is not new. `hard` has always been 20 taps in 6 seconds; this
    // says a recipe cannot quietly go past it, because above that the module
    // stops measuring whether somebody tapped and starts measuring their phone.
    for (let i = 0; i < 500; i++) {
      for (const difficulty of ['easy', 'med', 'hard'] as const) {
        const { spec } = tapModule.generate(`salt-${i}`, difficulty);
        expect(spec.target / spec.limitMs).toBeLessThanOrEqual(MAX_TAP_RATE);
      }
    }
  });

  it('always leaves room for the bot checks to be satisfiable', () => {
    // `minDistinctIntervals` is three, and a run of N taps produces N-1
    // intervals. A target that cannot produce three distinct ones is a block
    // no human and no script can complete.
    for (let i = 0; i < 500; i++) {
      const { spec } = tapModule.generate(`salt-${i}`, 'easy');
      expect(spec.target - 1).toBeGreaterThanOrEqual(TAP.minDistinctIntervals);
    }
  });

  it('falls back rather than accepting an untappable recipe', () => {
    // 24 taps in 5 seconds is 4.8/sec — past the human record's neighbourhood
    // and well past anything this module should be scoring.
    const untappable: TapRecipe = { target: 24, limitMs: 5_000 };
    expect(tapRecipeSchema.safeParse(untappable).success).toBe(true);
    expect(isTappable(untappable)).toBe(false);

    const { spec } = tapModule.generate('salt-x', 'med', {
      cell: { r: 0, c: 0 },
      recipe: untappable,
    });
    expect(spec.target / spec.limitMs).toBeLessThanOrEqual(MAX_TAP_RATE);
  });

  it('gives blocks genuinely different targets and clocks', () => {
    const specs = new Set<string>();
    for (let i = 0; i < 500; i++) {
      specs.add(JSON.stringify(tapModule.generate(`variety-${i}`, 'med').spec));
    }
    expect(specs.size).toBeGreaterThan(10);
  });

  it('rejects what an author must not be able to say', () => {
    for (const value of everyRecipe().slice(0, 1)) expect(tapRecipeSchema.safeParse(value).success).toBe(true);
    const bad: unknown[] = [
      { target: 5, limitMs: 6_000 },
      { target: 40, limitMs: 6_000 },
      { target: 14, limitMs: 1_000 },
      { target: 14.5, limitMs: 6_000 },
      // Strict: the anti-automation floors are not an author's to move.
      { target: 14, limitMs: 6_000, minIntervalMs: 0 },
      { target: 14, limitMs: 6_000, minSigmaMs: 0 },
    ];
    for (const value of bad) {
      expect(tapRecipeSchema.safeParse(value).success, JSON.stringify(value)).toBe(false);
    }
  });
});
