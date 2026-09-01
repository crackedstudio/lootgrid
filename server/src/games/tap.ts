import { z } from 'zod';
import { RACE, TAP } from '../config';
import { hashInt } from '../hash';
import type { Difficulty } from '../types';
import type { GameModule, StepResult } from './types';

export interface TapSpec {
  target: number;
  limitMs: number;
}

/** Nothing is secret — the client has to know the target to render the bar. */
export type TapSecret = null;

export interface TapState {
  taps: number;
  intervals: number[];
}

export interface TapInput {
  kind: 'tap';
}

export function stdev(xs: number[]): number {
  if (xs.length < 2) return 0;
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  const variance = xs.reduce((a, b) => a + (b - mean) ** 2, 0) / (xs.length - 1);
  return Math.sqrt(variance);
}

const TARGETS: Record<Difficulty, number> = {
  easy: 10,
  med: TAP.target,
  hard: 20,
};

/** Clocks a block may run on. */
export const TAP_LIMITS = [5_000, 6_000, 7_000, 8_000] as const;

/** How far a block's target may sit from its difficulty's. */
export const TAP_TARGET_SPREAD = 4;

/**
 * The fastest a block may ever demand, in taps per second.
 *
 * `hard` already ships 20 taps in 6 seconds, so this is not a new bar — it is
 * the existing one, written down so a recipe cannot quietly exceed it. Above it
 * the module stops measuring whether somebody tapped and starts measuring their
 * phone, and `TAP.minIntervalMs` is only a generous floor while the pace it is
 * bounding is reachable.
 */
export const MAX_TAP_RATE = TARGETS.hard / TAP.limitMs;

/**
 * The target and the clock, for one block.
 *
 * `generate` used to hand back `TARGETS[difficulty]` and `TAP.limitMs` with no
 * seed involved at all, which is why `tap` measured at ONE distinct spec across
 * 500 salts. Every tap block in the game was the same block.
 */
export interface TapRecipe {
  target: number;
  limitMs: number;
}

export const tapRecipeSchema = z
  .object({
    target: z.number().int().min(TARGETS.easy - TAP_TARGET_SPREAD).max(TARGETS.hard + TAP_TARGET_SPREAD),
    limitMs: z.number().int().refine(v => (TAP_LIMITS as readonly number[]).includes(v)),
  })
  .strict();

/** Whether a block is tappable by a human rather than only by a script. */
export function isTappable(recipe: TapRecipe): boolean {
  return recipe.target / recipe.limitMs <= MAX_TAP_RATE;
}

/**
 * The block's own target and clock, drawn from its salt.
 *
 * The clock is picked first and the target drawn from what that clock can
 * actually carry, rather than drawn freely and clamped. Clamping would pile
 * every fast block onto the same maximum target and the space would be
 * narrower than it reads.
 */
export function tapRecipeFromSalt(salt: string, difficulty: Difficulty): TapRecipe {
  const limitMs = TAP_LIMITS[hashInt(salt, 'tap:limit') % TAP_LIMITS.length]!;
  const base = TARGETS[difficulty] ?? TAP.target;

  const options: number[] = [];
  for (let t = base - TAP_TARGET_SPREAD; t <= base + TAP_TARGET_SPREAD; t++) {
    // Never below the distinct-interval floor: a target of two cannot produce
    // the three distinct intervals the bot check requires, so the block would
    // be unwinnable by anybody, human or otherwise.
    if (t <= TAP.minDistinctIntervals) continue;
    if (isTappable({ target: t, limitMs })) options.push(t);
  }
  const target = options[hashInt(salt, 'tap:target') % options.length] ?? base;
  return { target, limitMs };
}

export const tapModule: GameModule<TapSpec, TapSecret, TapState, TapInput> = {
  type: 'tap',

  recipe: { schema: tapRecipeSchema, fromSalt: tapRecipeFromSalt },

  generate(seed, difficulty, ctx) {
    // Tap still has no randomised CONTENT — every player racing this block gets
    // the same target and the same clock, which is what makes it a fair race.
    // What differs now is one block from another, which that fairness never had
    // anything to say about: it is a statement about the racers on a block, and
    // every tap block in the game having the same target was a separate fact
    // that nothing required.
    const parsed = tapRecipeSchema.safeParse(ctx?.recipe);
    const recipe =
      parsed.success && isTappable(parsed.data)
        ? parsed.data
        : tapRecipeFromSalt(seed, difficulty);

    return {
      spec: { target: recipe.target, limitMs: recipe.limitMs },
      secret: null,
      limitMs: recipe.limitMs,
    };
  },

  publicSpec(spec) {
    // Nothing is hidden — the client needs the target to render the progress bar.
    return { target: spec.target, limitMs: spec.limitMs };
  },

  init() {
    return { taps: 0, intervals: [] };
  },

  step({ spec, state, timing }, _input): StepResult {
    if (timing.sinceStart > spec.limitMs + RACE.latencyGraceMs) {
      return { kind: 'reject', reason: 'too_slow', fatal: true };
    }

    // Per-tap floor. CALIBRATION TARGET: if real devices produce sub-25ms
    // double-fires from touch-event jitter this will cause false failures —
    // that is one of the specific things the slice exists to find out.
    if (timing.sinceLast !== null && timing.sinceLast < TAP.minIntervalMs) {
      return { kind: 'reject', reason: 'interval_floor', fatal: true };
    }

    state.taps += 1;
    if (timing.sinceLast !== null) state.intervals.push(timing.sinceLast);

    if (state.taps < spec.target) return { kind: 'progress' };

    // ---- completion checks: only meaningful over the full sample ----
    const sigma = stdev(state.intervals);
    if (sigma < TAP.minSigmaMs) {
      // A bot on setInterval produces σ≈0. Humans are inherently jittery.
      return { kind: 'reject', reason: 'timing_too_regular', fatal: true };
    }

    const distinct = new Set(state.intervals).size;
    if (distinct < TAP.minDistinctIntervals) {
      return { kind: 'reject', reason: 'insufficient_variance', fatal: true };
    }

    return { kind: 'complete' };
  },

  progress(state, spec) {
    return Math.min(100, Math.round((state.taps / spec.target) * 100));
  },
};
