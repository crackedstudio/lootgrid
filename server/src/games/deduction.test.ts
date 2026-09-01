import { describe, expect, it } from 'vitest';
import { DEDUCTION, GRID } from '../config';
import type { HintPayload } from '../hints/types';
import { candidates, deductionModule as mod, deductionRecipeSchema, EXTRA_KINDS } from './deduction';
import type {
  DeductionInput,
  DeductionRecipe,
  DeductionSecret,
  DeductionSpec,
  DeductionState,
} from './deduction';
import type { Timing } from './types';

/**
 * Deduction.
 *
 * The question phase 6 exists to answer is whether there is a challenge worth
 * an agent solving. For this module that reduces to something testable: can it
 * be beaten by guessing, by brute force, or by asking careless questions? If
 * any of those work it is not a reasoning game, it is a formality.
 */

const timing = (sinceStart = 1_000): Timing => ({ sinceStart, sinceLast: null, intervals: [] });

/** A block that lends every probe kind, for tests about answers rather than prices. */
const ALL_EXTRAS: DeductionRecipe = { extras: [...EXTRA_KINDS], dear: [] };

function play(
  difficulty: 'easy' | 'med' | 'hard' = 'med',
  seed = 'salt-abc',
  recipe?: DeductionRecipe,
) {
  const game = mod.generate(seed, difficulty, recipe ? { cell: { r: 0, c: 0 }, recipe } : undefined);
  const spec = game.spec as DeductionSpec;
  const secret = game.secret as DeductionSecret;
  const state = mod.init(spec) as DeductionState;

  const step = (input: DeductionInput, at = 1_000) =>
    mod.step(
      { spec, secret, state, timing: at === 0 ? timing(0) : timing(at), directive: null },
      input,
    );

  const probe = (payload: HintPayload) => step({ kind: 'probe', value: payload });
  const commit = (r: number, c: number) => step({ kind: 'commit', value: { r, c } });

  return { spec, secret, state, step, probe, commit };
}

describe('generation', () => {
  it('is fixed by the block salt', () => {
    expect(mod.generate('salt-abc', 'med').secret).toEqual(mod.generate('salt-abc', 'med').secret);
  });

  it('differs across blocks', () => {
    const cells = new Set(
      Array.from({ length: 50 }, (_, i) => JSON.stringify(mod.generate(`salt-${i}`, 'med').secret)),
    );
    expect(cells.size).toBeGreaterThan(10);
  });

  it('always hides a cell inside the grid', () => {
    for (let i = 0; i < 200; i++) {
      const { r, c } = mod.generate(`salt-${i}`, 'med').secret as DeductionSecret;
      expect(r).toBeGreaterThanOrEqual(0);
      expect(r).toBeLessThan(GRID.rows);
      expect(c).toBeGreaterThanOrEqual(0);
      expect(c).toBeLessThan(GRID.cols);
    }
  });

  it('never puts the answer in the public spec', () => {
    const game = mod.generate('salt-abc', 'med');
    const published = JSON.stringify(mod.publicSpec(game.spec, game.secret));
    const { r, c } = game.secret as DeductionSecret;
    // The spec is the rules; the secret is the game.
    expect(published).not.toContain('"r"');
    expect(published).not.toContain('"c"');
    // The rules, all of them, and nothing else. `allowed` and `dear` are rules
    // — which questions this block answers and what each costs — and a player
    // who is not told them is playing a price list they can only discover by
    // being charged for it.
    const parsed = JSON.parse(published) as Record<string, unknown>;
    expect(Object.keys(parsed).sort()).toEqual(
      ['allowed', 'budget', 'cols', 'dear', 'limitMs', 'rows'],
    );
    expect(parsed.rows).toBe(GRID.rows);
    expect(parsed.cols).toBe(GRID.cols);
    expect(parsed.budget).toBe(DEDUCTION.budget.med);
    expect(parsed.limitMs).toBe(DEDUCTION.limitMs);
    void r;
    void c;
  });

  it('tightens the budget as difficulty rises', () => {
    const budgets = (['easy', 'med', 'hard'] as const).map(
      d => (mod.generate('s', d).spec as DeductionSpec).budget,
    );
    expect(budgets[0]).toBeGreaterThan(budgets[1]!);
    expect(budgets[1]).toBeGreaterThan(budgets[2]!);
  });
});

describe('the game cannot be won the cheap ways', () => {
  it('ends on a wrong commit', () => {
    // The one that matters. If a commit were retryable, 216 guesses would beat
    // any amount of reasoning and the module would be decorative.
    const { secret, commit } = play();
    const wrong = commit((secret.r + 1) % GRID.rows, secret.c);
    expect(wrong).toEqual({ kind: 'reject', reason: 'wrong_cell', fatal: true });
  });

  it('refuses probes past the budget', () => {
    const { spec, probe } = play();
    for (let i = 0; i < spec.budget; i++) {
      expect(probe({ kind: 'parity', parity: 'even' }).kind).toBe('progress');
    }
    expect(probe({ kind: 'parity', parity: 'even' })).toEqual({
      kind: 'reject',
      reason: 'budget_exhausted',
      fatal: true,
    });
  });

  it('refuses a probe that is not in the hint vocabulary', () => {
    // The phase 1 boundary, inherited: a closed schema with no free-text field,
    // because in phase 7 this input arrives from a model that can spend money.
    const { step } = play();
    for (const bad of [{ kind: 'note', text: 'where is it?' }, { kind: 'region' }, null, 42, 'NW']) {
      expect(step({ kind: 'probe', value: bad })).toEqual({
        kind: 'reject',
        reason: 'bad_probe',
        fatal: true,
      });
    }
  });

  it('refuses a commit outside the grid', () => {
    const { step } = play();
    for (const bad of [{ r: -1, c: 0 }, { r: 0, c: GRID.cols }, { r: 1.5, c: 2 }, {}, null]) {
      expect(step({ kind: 'commit', value: bad })).toEqual({
        kind: 'reject',
        reason: 'bad_commit',
        fatal: true,
      });
    }
  });

  it('refuses an unknown input kind', () => {
    expect(play().step({ kind: 'guess', value: { r: 0, c: 0 } })).toEqual({
      kind: 'reject',
      reason: 'bad_input',
      fatal: true,
    });
  });

  it('times out like every other module', () => {
    const { spec, step } = play();
    expect(step({ kind: 'probe', value: { kind: 'parity', parity: 'even' } }, spec.limitMs + 10_000)).toEqual({
      kind: 'reject',
      reason: 'too_slow',
      fatal: true,
    });
  });
});

describe('answers are truthful and consistent', () => {
  it('answers exactly what cellMatches would', () => {
    // Hints and probes share one predicate implementation on purpose: a hint
    // bought in the market is a probe someone else paid for, and the two must
    // mean the same thing.
    const { secret, probe, state } = play('med', 'salt-abc', ALL_EXTRAS);
    const payload: HintPayload = { kind: 'region', quadrant: 'NW' };
    probe(payload);

    const answered = state.answers[0]!;
    const expected = secret.r < Math.floor(GRID.rows / 2) && secret.c < Math.floor(GRID.cols / 2);
    expect(answered.answer).toBe(expected);
  });

  it('never sends the remaining candidate count back', () => {
    // Intersecting your own constraints IS the game. Returning the count would
    // leave only the arithmetic.
    const { probe } = play('med', 'salt-abc', ALL_EXTRAS);
    const result = probe({ kind: 'parity', parity: 'even' });
    expect(result.kind).toBe('progress');
    // A whitelist, not a snapshot: the point is that nothing describing the
    // remaining candidate set can appear, so a new field is only allowed here
    // once someone has looked at it and confirmed it says nothing about where
    // the treasure is. `nextCost` is the Director's price for the next probe.
    expect(Object.keys((result as { emit: object }).emit)).toEqual([
      'answer',
      'used',
      'budgetLeft',
      'nextCost',
      // The full price list. Like `nextCost` it is about what a question COSTS,
      // and neither says anything about which cells are still standing.
      'prices',
    ]);
  });

  it('keeps the true cell inside the candidate set, always', () => {
    // If a truthful answer could ever exclude the answer, the game would be
    // unwinnable and no test of strategy below would mean anything.
    const { secret, probe, state } = play();
    const probes: HintPayload[] = [
      { kind: 'region', quadrant: 'NW' },
      { kind: 'parity', parity: 'even' },
      { kind: 'rowBand', from: 0, to: 8 },
      { kind: 'distance', r: 9, c: 6, within: 4 },
    ];
    for (const p of probes) {
      probe(p);
      expect(candidates(state.answers)).toContainEqual({ r: secret.r, c: secret.c });
    }
  });
});

describe('it is solvable, and only by playing well', () => {
  /**
   * A halving strategy: each probe splits the surviving candidates as evenly as
   * possible. This is what "optimal information gain" means in practice, and it
   * is the thing the `hard` budget is set to require.
   */
  function solve(spec: DeductionSpec, secret: DeductionSecret, probe: (p: HintPayload) => unknown) {
    const answers: DeductionState['answers'] = [];
    // The full band range, not just prefixes. A crippled question set cannot
    // reach the floor, and blaming the module for that would be measuring the
    // strategy rather than the game.
    const options: HintPayload[] = [];
    for (let from = 0; from < GRID.rows; from++) {
      for (let to = from; to < GRID.rows; to++) options.push({ kind: 'rowBand', from, to });
    }
    for (let from = 0; from < GRID.cols; from++) {
      for (let to = from; to < GRID.cols; to++) options.push({ kind: 'colBand', from, to });
    }
    options.push({ kind: 'parity', parity: 'even' }, { kind: 'parity', parity: 'odd' });

    let used = 0;
    while (candidates(answers).length > 1 && used < spec.budget) {
      const live = candidates(answers);
      // Pick the question whose yes-set is closest to half the live set.
      let best = options[0]!;
      let bestGap = Infinity;
      for (const option of options) {
        const yes = live.filter(cell => cellMatchesLocal(option, cell.r, cell.c)).length;
        // A question everyone answers the same way teaches nothing.
        if (yes === 0 || yes === live.length) continue;
        const gap = Math.abs(yes - live.length / 2);
        if (gap < bestGap) {
          bestGap = gap;
          best = option;
        }
      }
      probe(best);
      answers.push({ payload: best, answer: cellMatchesLocal(best, secret.r, secret.c) });
      used += 1;
    }
    return { answers, used, left: candidates(answers) };
  }

  // A local copy so the strategy is not written in terms of the module's own
  // helper — a solver that shares the code under test proves less.
  function cellMatchesLocal(p: HintPayload, r: number, c: number): boolean {
    switch (p.kind) {
      case 'rowBand':
        return r >= p.from && r <= p.to;
      case 'colBand':
        return c >= p.from && c <= p.to;
      case 'parity':
        return ((r + c) % 2 === 0 ? 'even' : 'odd') === p.parity;
      default:
        throw new Error(`strategy does not use ${p.kind}`);
    }
  }

  it.each(['easy', 'med', 'hard'] as const)(
    'is winnable at %s by halving the space',
    difficulty => {
      // Eight salts, not twenty-five. The solver is O(probes x options x cells)
      // and the grid went from 216 cells to 3,600 in phase 2, which made this
      // the slowest test in the suite by an order of magnitude — enough that it
      // timed out under parallel load while passing in isolation. The strategy
      // is deterministic, so eight independent boards demonstrate the property
      // as well as twenty-five did and the test stays honest about cost.
      for (let i = 0; i < 8; i++) {
        const { spec, secret, probe, commit } = play(difficulty, `salt-${i}`);
        const { used, left } = solve(spec, secret, probe);

        expect(left).toHaveLength(1);
        expect(used).toBeLessThanOrEqual(spec.budget);
        expect(commit(left[0]!.r, left[0]!.c)).toEqual({ kind: 'complete' });
      }
    },
  );

  it('is NOT winnable by asking the same question repeatedly', () => {
    // The budget only bites if a wasted probe is unrecoverable. Ten identical
    // questions leave the grid exactly as wide as one did.
    const { spec, probe, state } = play('hard');
    for (let i = 0; i < spec.budget; i++) probe({ kind: 'parity', parity: 'even' });

    expect(state.used).toBe(spec.budget);
    expect(candidates(state.answers).length).toBeGreaterThan(1);
    // Out of questions, still guessing between more than a hundred cells.
    expect(mod.progress(state, spec)).toBeLessThan(60);
  });

  it('leaves a hard attempt no room for a wasted probe', () => {
    // 18x12 = 216 cells needs ceil(log2(216)) = 8 perfect questions, and `hard`
    // gives exactly 8. This is the arithmetic the difficulty is set from.
    const hard = (mod.generate('s', 'hard').spec as DeductionSpec).budget;
    expect(hard).toBe(Math.ceil(Math.log2(GRID.rows * GRID.cols)));
  });
});

describe('progress', () => {
  it('measures narrowing, not effort', () => {
    // Budget spent would show an agent burning questions badly as "progress".
    const { spec, probe, state } = play();
    const before = mod.progress(state, spec);
    probe({ kind: 'rowBand', from: 0, to: 8 });
    expect(mod.progress(state, spec)).toBeGreaterThan(before);
  });

  it('starts at nothing and ends at everything', () => {
    const { spec, state, secret, commit } = play();
    expect(mod.progress(state, spec)).toBe(0);
    commit(secret.r, secret.c);
    expect(mod.progress(state, spec)).toBe(100);
  });

  it('stops short of 100 while the cell is merely known', () => {
    // Knowing the answer is not winning it — the commit still has to land, and
    // a rival bar that read 100 before that would be lying.
    const { spec, state } = play();
    state.answers = [{ payload: { kind: 'distance', r: 0, c: 0, within: 0 }, answer: true }];
    expect(candidates(state.answers)).toHaveLength(1);
    expect(mod.progress(state, spec)).toBe(99);
  });
});

describe('the recipe space', () => {
  /**
   * Every recipe the schema can produce, all eighty-one of them.
   *
   * `extras` is any subset of four kinds and `dear` any subset of that, so the
   * space is 3⁴ — small enough to enumerate exhaustively, which is the right
   * way to test a bound. Sampling would leave the one unwinnable corner to
   * chance, and the corner is the entire point: a schema that accepts a recipe
   * nobody can solve is a schema that lets an author take a prize off the board.
   */
  function everyRecipe(): DeductionRecipe[] {
    const out: DeductionRecipe[] = [];
    for (let mask = 0; mask < 1 << EXTRA_KINDS.length; mask++) {
      const extras = EXTRA_KINDS.filter((_, i) => mask & (1 << i));
      for (let dmask = 0; dmask < 1 << extras.length; dmask++) {
        out.push({ extras: [...extras], dear: extras.filter((_, i) => dmask & (1 << i)) });
      }
    }
    return out;
  }

  it('enumerates exactly the space the schema accepts', () => {
    const all = everyRecipe();
    expect(all).toHaveLength(3 ** EXTRA_KINDS.length);
    for (const recipe of all) expect(deductionRecipeSchema.safeParse(recipe).success).toBe(true);
  });

  /**
   * Bisection on each axis, using only the two kinds every block must lend.
   *
   * Deliberately ignores `extras` entirely. The guarantee being tested is not
   * "some recipe is winnable" but "the floor holds no matter what the recipe
   * withheld", and the floor is the core pair: ⌈log₂ 60⌉ + ⌈log₂ 60⌉ = 12
   * probes at one apiece, which is exactly `DEDUCTION.budget.hard`. A solver
   * that reached for `parity` when it happened to be on offer would prove the
   * bound only for the blocks that offered it.
   */
  function bisect(
    spec: DeductionSpec,
    secret: DeductionSecret,
    probe: (p: HintPayload) => { kind: string },
  ) {
    const half = (
      kind: 'rowBand' | 'colBand',
      len: number,
      truth: number,
    ): { rejected: boolean } => {
      let lo = 0;
      let hi = len - 1;
      while (lo < hi) {
        const mid = Math.floor((lo + hi) / 2);
        const result = probe({ kind, from: lo, to: mid });
        // A rejection here means the block refused a kind it promised, or
        // charged past a budget the bound says it cannot reach. Either way the
        // floor is broken and the test must fail loudly rather than loop.
        if (result.kind !== 'progress') return { rejected: true };
        if (truth >= lo && truth <= mid) hi = mid;
        else lo = mid + 1;
      }
      return { rejected: false };
    };

    const rows = half('rowBand', spec.rows, secret.r);
    if (rows.rejected) return { rejected: true };
    return half('colBand', spec.cols, secret.c);
  }

  it('is solvable on every recipe in the space, at the hardest budget', () => {
    // Hard, because it is the only difficulty with no slack: the budget is the
    // information-theoretic floor exactly. Easy and med hold a fortiori.
    for (const recipe of everyRecipe()) {
      const { spec, secret, state, probe, commit } = play('hard', 'salt-space', recipe);

      expect(bisect(spec, secret, probe as (p: HintPayload) => { kind: string }).rejected).toBe(
        false,
      );
      // The module's own accounting, not the solver's — this is the assertion
      // the pre-existing winnability tests cannot make, because they count
      // probes locally and never pay the block's prices.
      expect(state.used).toBeLessThanOrEqual(spec.budget);
      expect(candidates(state.answers)).toHaveLength(1);
      expect(commit(secret.r, secret.c)).toEqual({ kind: 'complete' });
    }
  });

  it('never lends less than the core pair, and never prices it dear', () => {
    for (const recipe of everyRecipe()) {
      const { spec } = play('hard', 'salt-core', recipe);
      // The two rules the floor rests on. `dear` cannot name a core kind
      // because the schema has no way to say one — asserted here as behaviour
      // rather than trusted as a type, since the spec is what `step` reads.
      expect(spec.allowed).toEqual(expect.arrayContaining(['rowBand', 'colBand']));
      expect(spec.dear).not.toContain('rowBand');
      expect(spec.dear).not.toContain('colBand');
    }
  });

  it('refuses a probe of a kind this block does not lend', () => {
    // Without this the `allowed` list is advice, every block answers all six
    // kinds, and the recipe varies the description of the puzzle rather than
    // the puzzle.
    const { probe } = play('med', 'salt-abc', { extras: ['parity'], dear: [] });
    expect(probe({ kind: 'region', quadrant: 'NW' })).toEqual({
      kind: 'reject',
      reason: 'kind_not_allowed',
      fatal: true,
    });
  });

  it('charges each kind the price it published', () => {
    const { spec, state, probe } = play('med', 'salt-abc', {
      extras: ['parity', 'distance'],
      dear: ['distance'],
    });
    expect(spec.dear).toEqual(['distance']);

    probe({ kind: 'parity', parity: 'even' });
    expect(state.used).toBe(1);

    // Two, because this block priced rings dear — and the player was told so in
    // `publicSpec` before they spent anything.
    probe({ kind: 'distance', r: 10, c: 10, within: 4 });
    expect(state.used).toBe(3);
  });

  it('quotes the whole price list before the first probe', () => {
    // `init` has no previous round to have published one, so it quotes its own.
    // A block whose first probe is charged a price nobody stated is the trap
    // the published list exists to prevent.
    const { state } = play('med', 'salt-abc', { extras: ['distance'], dear: ['distance'] });
    expect(state.nextPrices).toEqual({ rowBand: 1, colBand: 1, distance: 2 });
  });

  it('gives blocks genuinely different tools and prices', () => {
    // The measurement that started this. `deduction` produced ONE distinct spec
    // across 500 salts per difficulty — every hunt in the game posed a
    // byte-identical question and only the answer moved.
    const specs = new Set<string>();
    for (let i = 0; i < 500; i++) {
      specs.add(JSON.stringify(mod.generate(`variety-${i}`, 'med').spec));
    }
    expect(specs.size).toBeGreaterThan(20);
  });

  it('rejects what an author must not be able to say', () => {
    const bad: unknown[] = [
      // A price list for a tool the block never lent you.
      { extras: ['parity'], dear: ['distance'] },
      // The same probe advertised twice.
      { extras: ['parity', 'parity'], dear: [] },
      // Not in the vocabulary at all.
      { extras: ['rowBand'], dear: [] },
      { extras: ['freeText'], dear: [] },
      // Strict: an extra field is a rejection, not a shrug. A recipe accepted
      // minus-the-key is an author learning it can smuggle one past the schema.
      { extras: [], dear: [], budget: 99 },
      { extras: [], dear: [], limitMs: 1 },
    ];
    for (const value of bad) {
      expect(deductionRecipeSchema.safeParse(value).success, JSON.stringify(value)).toBe(false);
    }
  });
});
