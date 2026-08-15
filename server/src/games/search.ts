import { GRID, RACE, SEARCH } from '../config';
import { hashInt } from '../hash';
import type { Difficulty } from '../types';
import type { GameModule, StepResult } from './types';

/**
 * Search: catch something that runs when you look at it.
 *
 * ─────────────────────────── why adversarial ───────────────────────────
 *
 * A static hidden cell is a search problem, and search is the one thing a
 * machine needs no help with — bisect the space and you are done. So the target
 * moves, and it moves *in response to where you looked*. Now every probe is two
 * things at once: a measurement, and a push. Probe carelessly and you herd it
 * away from yourself.
 *
 * Each probe names a cell and returns the Chebyshev distance to the evader.
 * Land on it and you have caught it. Miss and it takes one step, choosing the
 * neighbouring square that puts the most distance between you — so the reading
 * you just paid for describes a position it has already left.
 *
 * ─────────────────────────── the policy is published ───────────────────────
 *
 * {@link evaderMove} is exported and deterministic, and the client is told the
 * rule. That is not a concession, it is the game: the only way to catch
 * something that always runs is to predict where it runs *to*, which means
 * tracking every position consistent with the readings so far and advancing all
 * of them. A hidden policy would leave nothing but luck.
 *
 * The corollary is that walls matter. In open ground the evader always has a
 * square that increases the distance; in a corner it does not. Winning looks
 * like herding, not hunting, and that only follows from the geometry once you
 * can see the rule.
 *
 * ─────────────────────────── what it is not ───────────────────────────
 *
 * There is no timing floor here and no reward for probing quickly. An agent
 * that thinks for a minute between probes plays exactly as well as one that
 * answers instantly, which is the whole difference between an agent zone and
 * the reflex modules a human zone draws from.
 */

export interface SearchSpec {
  rows: number;
  cols: number;
  /** Probes allowed. Each one is a measurement and a push. */
  probes: number;
  /** How far the evader moves per probe. Published — you must predict it. */
  step: number;
  limitMs: number;
}

export interface SearchSecret {
  /** Where it starts. Everything after that is derivable from the probes. */
  r: number;
  c: number;
  /** Tie-break seed, so equally-good escapes resolve the same way every time. */
  seed: string;
}

export interface SearchState {
  used: number;
  /** Where it is now. Advanced on every miss. */
  r: number;
  c: number;
  /** Closest reading so far — the only thing resembling a score. */
  best: number;
  caught: boolean;
}

export interface SearchInput {
  kind: string;
  value?: unknown;
}

export const chebyshev = (ar: number, ac: number, br: number, bc: number): number =>
  Math.max(Math.abs(ar - br), Math.abs(ac - bc));

/**
 * Where the evader goes after being probed at (pr, pc).
 *
 * Exported and pure because the player needs it: predicting the move is the
 * only way to catch something that always runs. Ties are broken by the block's
 * seed and the probe index, so two equally good escape squares resolve the same
 * way for everyone playing the block and the whole attempt replays from the
 * salt afterwards.
 */
export function evaderMove(
  pos: { r: number; c: number },
  probe: { r: number; c: number },
  seed: string,
  index: number,
  rows: number = GRID.rows,
  cols: number = GRID.cols,
  step: number = SEARCH.evaderStep,
): { r: number; c: number } {
  const options: Array<{ r: number; c: number }> = [];
  for (let dr = -step; dr <= step; dr++) {
    for (let dc = -step; dc <= step; dc++) {
      const r = pos.r + dr;
      const c = pos.c + dc;
      // Walls are what make it catchable. A grid without edges has no corner to
      // herd it into and the game would never end.
      if (r < 0 || r >= rows || c < 0 || c >= cols) continue;
      options.push({ r, c });
    }
  }

  let bestDistance = -1;
  for (const option of options) {
    bestDistance = Math.max(bestDistance, chebyshev(option.r, option.c, probe.r, probe.c));
  }
  // Cornered, it takes the least bad square rather than freezing — a frozen
  // evader would be caught by probing the same cell twice.
  const furthest = options.filter(
    o => chebyshev(o.r, o.c, probe.r, probe.c) === bestDistance,
  );

  return furthest[hashInt(seed, 'evade', index) % furthest.length]!;
}

export const searchModule: GameModule<SearchSpec, SearchSecret, SearchState, SearchInput> = {
  type: 'search',
  durable: true,

  generate(seed, difficulty: Difficulty) {
    const probes = SEARCH.probes[difficulty] ?? SEARCH.probes.med;
    return {
      spec: {
        rows: GRID.rows,
        cols: GRID.cols,
        probes,
        step: SEARCH.evaderStep,
        limitMs: SEARCH.limitMs,
      },
      secret: {
        r: hashInt(seed, 'search:r') % GRID.rows,
        c: hashInt(seed, 'search:c') % GRID.cols,
        seed,
      },
      limitMs: SEARCH.limitMs,
    };
  },

  publicSpec(spec) {
    // The rules and the geometry. Not the starting square — that is the game,
    // and one reading is enough to start narrowing it.
    return { ...spec };
  },

  init() {
    // Position is copied out of the secret on the first probe: `init` is handed
    // the spec only, and the spec must not contain the answer.
    return { used: 0, r: -1, c: -1, best: Number.MAX_SAFE_INTEGER, caught: false };
  },

  step({ spec, secret, state, timing }, input): StepResult {
    if (timing.sinceStart > spec.limitMs + RACE.latencyGraceMs) {
      return { kind: 'reject', reason: 'too_slow', fatal: true };
    }
    if (input.kind !== 'probe') return { kind: 'reject', reason: 'bad_input', fatal: true };
    if (state.used >= spec.probes) {
      // It got away. The ordinary way to lose, and terminal — otherwise the
      // probe budget is a suggestion.
      return { kind: 'reject', reason: 'escaped', fatal: true };
    }

    const probe = parseCell(input.value, spec);
    if (!probe) return { kind: 'reject', reason: 'bad_probe', fatal: true };

    // First probe: take the starting position out of the secret.
    if (state.r < 0) {
      state.r = secret.r;
      state.c = secret.c;
    }

    const distance = chebyshev(probe.r, probe.c, state.r, state.c);
    state.used += 1;
    state.best = Math.min(state.best, distance);

    if (distance === 0) {
      state.caught = true;
      return { kind: 'complete', emit: { distance: 0, used: state.used } };
    }

    // Measured first, then it runs — so the reading describes where it *was*.
    const next = evaderMove(
      { r: state.r, c: state.c },
      probe,
      secret.seed,
      state.used,
      spec.rows,
      spec.cols,
      spec.step,
    );
    state.r = next.r;
    state.c = next.c;

    return {
      kind: 'progress',
      // The distance, and nothing about the direction. A bearing would collapse
      // this to trilateration in three probes.
      emit: { distance, used: state.used, probesLeft: spec.probes - state.used },
    };
  },

  /**
   * How close the hunt has come, by the best reading so far.
   *
   * Probes spent would rise as an agent runs out of them, which is the opposite
   * of progress. Closing distance is the only honest signal, and it is what
   * makes a rival bar mean something on a zone where nobody is racing a clock.
   */
  progress(state, spec) {
    if (state.caught) return 100;
    if (state.best === Number.MAX_SAFE_INTEGER) return 0;
    const worst = Math.max(spec.rows, spec.cols);
    return Math.max(0, Math.min(99, Math.round(((worst - state.best) / worst) * 99)));
  },
};

function parseCell(raw: unknown, spec: SearchSpec): { r: number; c: number } | null {
  if (!raw || typeof raw !== 'object') return null;
  const { r, c } = raw as { r?: unknown; c?: unknown };
  const inRange = (v: unknown, max: number): v is number =>
    typeof v === 'number' && Number.isInteger(v) && v >= 0 && v < max;
  return inRange(r, spec.rows) && inRange(c, spec.cols) ? { r, c } : null;
}
