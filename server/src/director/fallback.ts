import { hashInt } from '../hash';
import type { Difficulty } from '../types';
import {
  DIFFICULTY_MAX,
  DIFFICULTY_MIN,
  ROUND_TYPES,
  TWISTS,
  type BlindState,
  type Directive,
} from './types';

/**
 * The round the game uses when the Director does not answer in time.
 *
 * ─────────────────────────── gameplay never waits ───────────────────────────
 *
 * Same rule as the relayer and the escrow worker, applied to the one component
 * that sits closest to the critical path. Past the Director's budget the round
 * is supplied from the block's salt and the hunt's difficulty — deterministic,
 * instant, and identical for everyone racing.
 *
 * This is not an error path. It is the *default* path, and the Director is an
 * optimisation on top of it: if the model never answers again, every hunt keeps
 * running exactly as it did before phase 8, which is the property that makes it
 * safe to put a model here at all.
 *
 * ─────────────────────────── deterministic, so it is checkable ──────────────
 *
 * Derived from `(salt, huntId, round)` and nothing else. Two consequences worth
 * having: everyone racing a round gets the same directive without coordination,
 * and a fallback round can be recomputed from the transcript afterwards by
 * anyone who wants to confirm the Director was not quietly involved.
 */

/**
 * Prize difficulty → the middle of the round-difficulty band it should sit in.
 *
 * The two scales are separate on purpose (see `types.ts`): a hunt's prize tier
 * is fixed and committed to, while round difficulty moves during play. This is
 * the only place they touch, and it only sets a starting point.
 */
const BASE: Record<Difficulty, number> = { easy: 2, med: 3, hard: 4 };

/**
 * A directive from the block's own salt.
 *
 * Wanders by one step around the hunt's base difficulty rather than sitting
 * still: a hunt whose every round is identical is a hunt with one round in it,
 * repeated. The wander is deterministic, so it is variety rather than
 * randomness.
 */
export function fallbackDirective(
  salt: string,
  huntId: string,
  round: number,
  difficulty: Difficulty,
): Directive {
  const base = BASE[difficulty] ?? 3;
  const drift = (hashInt(salt, huntId, `round:${round}`) % 3) - 1; // -1, 0, or +1

  return {
    difficulty: clamp(base + drift),
    roundType: ROUND_TYPES[hashInt(salt, huntId, `type:${round}`) % ROUND_TYPES.length]!,
    // Twists are rarer than not: `none` occupies half the draw, because a
    // complication every single round is just the baseline with extra words.
    twist:
      hashInt(salt, huntId, `twist:${round}`) % 2 === 0
        ? 'none'
        : TWISTS[hashInt(salt, huntId, `twistpick:${round}`) % TWISTS.length]!,
  };
}

function clamp(value: number): number {
  return Math.max(DIFFICULTY_MIN, Math.min(DIFFICULTY_MAX, value));
}

/**
 * The prompt the Director is given.
 *
 * Built from the blind state alone — there is nothing else to build it from,
 * which is the point. Note what a hijacked model could do with the most
 * favourable reading of this: choose a number between 1 and 5.
 */
export function promptFor(state: BlindState, fallback: Directive): string {
  return [
    'You are setting the difficulty of the next round of a race.',
    `Round ${state.round}. ${state.racers} racers.`,
    `Their progress, sorted and anonymous: [${state.progress.join(', ')}].`,
    `Elapsed: ${state.elapsedMs}ms.`,
    'Reply with one JSON object and nothing else:',
    '{"difficulty":1-5,"roundType":"standard|sprint|endurance|precision","twist":"none|fog|decoys|silence|haste"}',
    `If unsure, reply exactly: ${JSON.stringify(fallback)}`,
  ].join('\n');
}
