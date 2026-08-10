import { MEMORY, RACE } from '../config';
import { hash, seededStream } from '../hash';
import type { Difficulty } from '../types';
import type { GameModule, StepResult } from './types';

export interface MemSpec {
  sequence: number[];
  padCount: number;
  /** ms from attempt start until playback finishes — no input accepted before this. */
  playbackMs: number;
  stepMs: number;
  leadMs: number;
  limitMs: number;
}

export type MemSecret = null;

export interface MemState {
  index: number;
}

export interface MemInput {
  kind: string;
  value?: unknown;
}

const LENGTH: Record<Difficulty, number> = { easy: 3, med: MEMORY.length, hard: 6 };

/**
 * Simon. The sequence has to be sent for the client to play it back, so this is
 * the weakest of the four against automation — which is exactly why
 * `gameTypeForBlock` only ever assigns it to puzzle hunts, never to cash.
 * Keep it that way.
 */
export const memoryModule: GameModule<MemSpec, MemSecret, MemState, MemInput> = {
  type: 'memory',

  generate(seed, difficulty) {
    const rnd = seededStream(hash(seed, 'memory'));
    const length = LENGTH[difficulty] ?? MEMORY.length;
    const sequence = Array.from({ length }, () => Math.floor(rnd() * MEMORY.padCount));

    const playbackMs = length * MEMORY.stepMs + MEMORY.leadMs + MEMORY.tailMs;
    const limitMs = playbackMs + MEMORY.inputBudgetMs;

    return {
      spec: {
        sequence,
        padCount: MEMORY.padCount,
        playbackMs,
        stepMs: MEMORY.stepMs,
        leadMs: MEMORY.leadMs,
        limitMs,
      },
      secret: null,
      limitMs,
    };
  },

  publicSpec(spec) {
    return spec;
  },

  init() {
    return { index: 0 };
  },

  step({ spec, state, timing }, input): StepResult {
    if (timing.sinceStart > spec.limitMs + RACE.latencyGraceMs) {
      return { kind: 'reject', reason: 'too_slow', fatal: true };
    }
    if (input.kind !== 'pad') return { kind: 'reject', reason: 'bad_input', fatal: true };

    // Pressing before the sequence has finished playing is not fast reflexes,
    // it is a client that read the spec instead of watching.
    if (timing.sinceStart < spec.playbackMs) {
      return { kind: 'reject', reason: 'input_before_playback_end', fatal: true };
    }

    if (timing.sinceLast !== null && timing.sinceLast < MEMORY.minIntervalMs) {
      return { kind: 'reject', reason: 'interval_floor', fatal: true };
    }

    if (typeof input.value !== 'number' || !Number.isInteger(input.value)) {
      return { kind: 'reject', reason: 'bad_pad', fatal: true };
    }
    if (input.value < 0 || input.value >= spec.padCount) {
      return { kind: 'reject', reason: 'pad_out_of_range', fatal: true };
    }
    if (input.value !== spec.sequence[state.index]) {
      return { kind: 'reject', reason: 'wrong_order', fatal: true };
    }

    state.index += 1;
    return state.index >= spec.sequence.length ? { kind: 'complete' } : { kind: 'progress' };
  },

  progress(state, spec) {
    return Math.min(100, Math.round((state.index / spec.sequence.length) * 100));
  },
};
