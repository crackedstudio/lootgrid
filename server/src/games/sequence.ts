import { RACE, SEQUENCE } from '../config';
import { hash, seededStream } from '../hash';
import type { Difficulty } from '../types';
import type { GameModule, StepResult } from './types';

export interface SeqTile {
  id: number;
  color: string;
}

export interface SeqSpec {
  tiles: SeqTile[];
  n: number;
  limitMs: number;
}

export type SeqSecret = null;

export interface SeqState {
  next: number;
}

export interface SeqInput {
  kind: string;
  value?: unknown;
}

const PALETTE = ['#FF3D3D', '#FF7A1A', '#FFD51F', '#2CE66A', '#29E6E6', '#2F6BFF', '#8A3DFF'];
const COUNT: Record<Difficulty, number> = { easy: 4, med: SEQUENCE.n, hard: 7 };

/**
 * Tap 1→N in order. Like Memory, the client necessarily knows the answer — the
 * layout has to be rendered — so the timing floor is the only real defence.
 */
export const sequenceModule: GameModule<SeqSpec, SeqSecret, SeqState, SeqInput> = {
  type: 'sequence',

  generate(seed, difficulty) {
    const rnd = seededStream(hash(seed, 'sequence'));
    const n = COUNT[difficulty] ?? SEQUENCE.n;

    const tiles: SeqTile[] = Array.from({ length: n }, (_, i) => ({
      id: i + 1,
      color: PALETTE[i % PALETTE.length]!,
    }));

    // Deterministic Fisher–Yates: everyone racing the block sees the identical
    // layout, so nobody gets a luckier arrangement than anybody else.
    for (let i = tiles.length - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      [tiles[i], tiles[j]] = [tiles[j]!, tiles[i]!];
    }

    return { spec: { tiles, n, limitMs: SEQUENCE.limitMs }, secret: null, limitMs: SEQUENCE.limitMs };
  },

  publicSpec(spec) {
    return spec;
  },

  init() {
    return { next: 1 };
  },

  step({ spec, state, timing }, input): StepResult {
    if (timing.sinceStart > spec.limitMs + RACE.latencyGraceMs) {
      return { kind: 'reject', reason: 'too_slow', fatal: true };
    }
    if (input.kind !== 'tap') return { kind: 'reject', reason: 'bad_input', fatal: true };

    if (timing.sinceLast !== null && timing.sinceLast < SEQUENCE.minIntervalMs) {
      return { kind: 'reject', reason: 'interval_floor', fatal: true };
    }

    if (typeof input.value !== 'number' || !Number.isInteger(input.value)) {
      return { kind: 'reject', reason: 'bad_tile', fatal: true };
    }
    if (input.value !== state.next) {
      return { kind: 'reject', reason: 'wrong_order', fatal: true };
    }

    state.next += 1;
    return state.next > spec.n ? { kind: 'complete' } : { kind: 'progress' };
  },

  progress(state, spec) {
    return Math.min(100, Math.round(((state.next - 1) / spec.n) * 100));
  },
};
