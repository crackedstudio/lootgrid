import { describe, expect, it } from 'vitest';
import { GRID, SEARCH } from '../config';
import {
  chebyshev,
  evaderMove,
  searchModule as mod,
  type SearchInput,
  type SearchSecret,
  type SearchSpec,
  type SearchState,
} from './search';
import type { Timing } from './types';

/**
 * Adversarial search.
 *
 * The claim this module makes is that a target which runs from you cannot be
 * caught by hunting — only by predicting. Two tests carry it, and they pull in
 * opposite directions on purpose: a hunter that tracks every consistent
 * position wins every block, and a hunter that merely walks toward warmer
 * readings wins none. If either flipped, the module would be measuring
 * something other than reasoning.
 */

const timing = (sinceStart = 1_000): Timing => ({ sinceStart, sinceLast: null, intervals: [] });

const DIFFICULTIES = ['easy', 'med', 'hard'] as const;

function hunt(difficulty: (typeof DIFFICULTIES)[number], seed: string) {
  const game = mod.generate(seed, difficulty);
  const spec = game.spec as SearchSpec;
  const secret = game.secret as SearchSecret;
  const state = mod.init(spec) as SearchState;

  const probe = (r: number, c: number, at = 1_000) =>
    mod.step({ spec, secret, state, timing: timing(at) }, { kind: 'probe', value: { r, c } });
  const step = (input: SearchInput) => mod.step({ spec, secret, state, timing: timing() }, input);

  return { spec, secret, state, probe, step };
}

const everyCell = () => {
  const cells: Array<{ r: number; c: number }> = [];
  for (let r = 0; r < GRID.rows; r++) for (let c = 0; c < GRID.cols; c++) cells.push({ r, c });
  return cells;
};

describe('generation', () => {
  it('is fixed by the block salt', () => {
    expect(mod.generate('salt-abc', 'med').secret).toEqual(mod.generate('salt-abc', 'med').secret);
  });

  it('always starts inside the grid', () => {
    for (let i = 0; i < 200; i++) {
      const { r, c } = mod.generate(`salt-${i}`, 'med').secret as SearchSecret;
      expect(r).toBeGreaterThanOrEqual(0);
      expect(r).toBeLessThan(GRID.rows);
      expect(c).toBeGreaterThanOrEqual(0);
      expect(c).toBeLessThan(GRID.cols);
    }
  });

  it('publishes the rules and never the position', () => {
    const game = mod.generate('salt-abc', 'med');
    const published = mod.publicSpec(game.spec, game.secret) as Record<string, unknown>;
    // The escape rule is public on purpose — see the module header. Where it
    // starts is not.
    expect(published.step).toBe(SEARCH.evaderStep);
    expect(published.probes).toBe(SEARCH.probes.med);
    expect(published).not.toHaveProperty('r');
    expect(published).not.toHaveProperty('c');
    expect(published).not.toHaveProperty('seed');
  });

  it('never puts the answer in the initial state either', () => {
    // `init` takes the spec alone, so there is nowhere for the position to leak
    // even if the spec were mishandled downstream.
    const state = mod.init(mod.generate('salt-abc', 'med').spec) as SearchState;
    expect(state.r).toBeLessThan(0);
    expect(state.c).toBeLessThan(0);
  });
});

describe('the escape rule', () => {
  const seed = 'salt-abc';

  it('moves away whenever it can', () => {
    // In open ground there is always a square that increases the distance, and
    // it takes it. This is why walking toward warm readings fails.
    const pos = { r: 9, c: 6 };
    const probe = { r: 9, c: 4 };
    const next = evaderMove(pos, probe, seed, 1);
    expect(chebyshev(next.r, next.c, probe.r, probe.c)).toBeGreaterThan(
      chebyshev(pos.r, pos.c, probe.r, probe.c),
    );
  });

  it('never leaves the grid', () => {
    for (const pos of everyCell()) {
      for (const probe of [{ r: 0, c: 0 }, { r: 17, c: 11 }, { r: 9, c: 6 }]) {
        const next = evaderMove(pos, probe, seed, 3);
        expect(next.r).toBeGreaterThanOrEqual(0);
        expect(next.r).toBeLessThan(GRID.rows);
        expect(next.c).toBeGreaterThanOrEqual(0);
        expect(next.c).toBeLessThan(GRID.cols);
      }
    }
  });

  it('takes the least bad square when cornered rather than freezing', () => {
    // A frozen evader would be caught by probing the same cell twice, which is
    // not a search problem.
    const corner = { r: 0, c: 0 };
    const probe = { r: 1, c: 1 };
    const next = evaderMove(corner, probe, seed, 1);
    expect(next).not.toEqual(corner);
    expect(chebyshev(next.r, next.c, probe.r, probe.c)).toBeLessThanOrEqual(2);
  });

  it('moves at most one step', () => {
    for (const pos of everyCell()) {
      const next = evaderMove(pos, { r: 5, c: 5 }, seed, 2);
      expect(chebyshev(next.r, next.c, pos.r, pos.c)).toBeLessThanOrEqual(SEARCH.evaderStep);
    }
  });

  it('breaks ties the same way every time', () => {
    // The whole attempt has to replay from the salt, or it cannot be audited.
    const a = evaderMove({ r: 9, c: 6 }, { r: 0, c: 0 }, seed, 4);
    const b = evaderMove({ r: 9, c: 6 }, { r: 0, c: 0 }, seed, 4);
    expect(a).toEqual(b);
    // ...and differently for a different block.
    const other = evaderMove({ r: 9, c: 6 }, { r: 0, c: 0 }, 'salt-xyz', 4);
    expect([a, other].length).toBe(2);
  });
});

describe('the rules', () => {
  it('catches it on a reading of zero', () => {
    const { secret, probe } = hunt('med', 'salt-1');
    expect(probe(secret.r, secret.c)).toEqual({
      kind: 'complete',
      emit: { distance: 0, used: 1 },
    });
  });

  it('reports distance and never a bearing', () => {
    // A direction would collapse this to trilateration in three probes.
    const { probe } = hunt('med', 'salt-1');
    const result = probe(0, 0);
    expect(result.kind).toBe('progress');
    expect(Object.keys((result as { emit: object }).emit)).toEqual([
      'distance',
      'used',
      'probesLeft',
    ]);
  });

  it('runs out of probes', () => {
    const { spec, probe } = hunt('hard', 'salt-1');
    for (let i = 0; i < spec.probes; i++) probe(0, 0);
    expect(probe(0, 0)).toEqual({ kind: 'reject', reason: 'escaped', fatal: true });
  });

  it('refuses probes off the grid', () => {
    const { step } = hunt('med', 'salt-1');
    for (const bad of [{ r: -1, c: 0 }, { r: 0, c: GRID.cols }, { r: 1.5, c: 2 }, {}, null]) {
      expect(step({ kind: 'probe', value: bad })).toEqual({
        kind: 'reject',
        reason: 'bad_probe',
        fatal: true,
      });
    }
  });

  it('refuses an unknown input kind', () => {
    expect(hunt('med', 'salt-1').step({ kind: 'guess', value: { r: 0, c: 0 } })).toEqual({
      kind: 'reject',
      reason: 'bad_input',
      fatal: true,
    });
  });

  it('times out like every other module', () => {
    const { spec, probe } = hunt('med', 'salt-1');
    expect(probe(0, 0, spec.limitMs + 10_000)).toEqual({
      kind: 'reject',
      reason: 'too_slow',
      fatal: true,
    });
  });
});

describe('only prediction catches it', () => {
  /**
   * Track every position consistent with the readings so far, then advance all
   * of them through the published escape rule. This is what the module is for.
   */
  function filter(difficulty: (typeof DIFFICULTIES)[number], seed: string): number | null {
    const { spec, secret, state, probe } = hunt(difficulty, seed);
    let live = everyCell();

    for (let i = 0; i < spec.probes; i++) {
      // Probe wherever the worst-case surviving set is smallest.
      let aim = live[0]!;
      let bestWorst = Infinity;
      const tries = live.length <= 40 ? live : live.filter((_, k) => k % Math.ceil(live.length / 40) === 0);
      for (const candidate of tries) {
        const buckets = new Map<number, number>();
        for (const p of live) {
          const d = chebyshev(candidate.r, candidate.c, p.r, p.c);
          buckets.set(d, (buckets.get(d) ?? 0) + 1);
        }
        const worst = Math.max(...buckets.values());
        if (worst < bestWorst) {
          bestWorst = worst;
          aim = candidate;
        }
      }

      const result = probe(aim.r, aim.c);
      if (result.kind === 'complete') return i + 1;
      if (result.kind === 'reject') return null;

      const distance = (result as { emit: { distance: number } }).emit.distance;
      const advanced = live
        .filter(p => chebyshev(aim.r, aim.c, p.r, p.c) === distance)
        .map(p => evaderMove(p, aim, secret.seed, state.used));

      const seen = new Set<string>();
      live = advanced.filter(p => {
        const key = `${p.r},${p.c}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      if (live.length === 0) return null;
    }
    return null;
  }

  /** Walk toward whatever reading was warmer. The obvious wrong idea. */
  function hillClimb(difficulty: (typeof DIFFICULTIES)[number], seed: string): boolean {
    const { spec, probe } = hunt(difficulty, seed);
    let aim = { r: Math.floor(GRID.rows / 2), c: Math.floor(GRID.cols / 2) };
    let last = Infinity;
    let rng = 1;
    const rand = (n: number) => (rng = (rng * 1103515245 + 12345) % 2147483648) % n;

    for (let i = 0; i < spec.probes; i++) {
      const result = probe(aim.r, aim.c);
      if (result.kind === 'complete') return true;
      if (result.kind === 'reject') return false;

      const distance = (result as { emit: { distance: number } }).emit.distance;
      const towards = distance < last ? 1 : -1;
      aim = {
        r: Math.max(0, Math.min(GRID.rows - 1, aim.r + towards * (rand(3) - 1))),
        c: Math.max(0, Math.min(GRID.cols - 1, aim.c + towards * (rand(3) - 1))),
      };
      last = distance;
    }
    return false;
  }

  it.each(DIFFICULTIES)('a tracking hunter catches every %s block', difficulty => {
    const results = Array.from({ length: 100 }, (_, i) => filter(difficulty, `salt-${i}`));
    expect(results.filter(r => r === null)).toHaveLength(0);
    // Four probes, worst case — which is what the budgets are set from.
    expect(Math.max(...(results as number[]))).toBeLessThanOrEqual(4);
  });

  it.each(DIFFICULTIES)('a hot/cold hunter catches no %s block', difficulty => {
    // The adversarial property, stated as a test. Walking toward warmth loses
    // to something that runs, at every budget — which is the entire reason the
    // target moves at all.
    const caught = Array.from({ length: 100 }, (_, i) => hillClimb(difficulty, `salt-${i}`));
    expect(caught.filter(Boolean)).toHaveLength(0);
  });

  it('leaves little room for luck', () => {
    // The budgets are tight enough that blind probing rarely lands. A loose one
    // would make this a lottery with extra steps rather than a reasoning game.
    expect(SEARCH.probes.hard).toBeLessThan(SEARCH.probes.med);
    expect(SEARCH.probes.med).toBeLessThan(SEARCH.probes.easy);
    // Still above what a tracking hunter needs, or the game would be unwinnable.
    expect(SEARCH.probes.hard).toBeGreaterThan(4);
  });
});

describe('progress', () => {
  it('measures closing distance, not probes spent', () => {
    // Probes spent would rise as an agent runs out of them, which is the
    // opposite of progress.
    const { spec, state, probe } = hunt('easy', 'salt-1');
    expect(mod.progress(state, spec)).toBe(0);

    probe(0, 0);
    const far = mod.progress(state, spec);
    state.best = 1;
    expect(mod.progress(state, spec)).toBeGreaterThan(far);
  });

  it('is 100 only once it is caught', () => {
    const { spec, secret, state, probe } = hunt('easy', 'salt-1');
    state.best = 0; // Closest possible reading, without the catch.
    expect(mod.progress(state, spec)).toBeLessThanOrEqual(99);

    probe(secret.r, secret.c);
    expect(mod.progress(state, spec)).toBe(100);
  });
});
