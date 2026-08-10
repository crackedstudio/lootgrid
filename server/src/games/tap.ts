import { RACE, TAP } from '../config';
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

export const tapModule: GameModule<TapSpec, TapSecret, TapState, TapInput> = {
  type: 'tap',

  generate(_seed, difficulty) {
    // Tap has no randomised content — every player racing the block gets the same
    // target and the same clock, which is exactly what makes it a fair race.
    const target = TARGETS[difficulty] ?? TAP.target;
    return { spec: { target, limitMs: TAP.limitMs }, secret: null, limitMs: TAP.limitMs };
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
