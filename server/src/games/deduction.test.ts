import { describe, expect, it } from 'vitest';
import { DEDUCTION, GRID } from '../config';
import type { HintPayload } from '../hints/types';
import { candidates, deductionModule as mod } from './deduction';
import type { DeductionInput, DeductionSecret, DeductionSpec, DeductionState } from './deduction';
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

function play(difficulty: 'easy' | 'med' | 'hard' = 'med', seed = 'salt-abc') {
  const game = mod.generate(seed, difficulty);
  const spec = game.spec as DeductionSpec;
  const secret = game.secret as DeductionSecret;
  const state = mod.init(spec) as DeductionState;

  const step = (input: DeductionInput, at = 1_000) =>
    mod.step({ spec, secret, state, timing: at === 0 ? timing(0) : timing(at) }, input);

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
    expect(JSON.parse(published)).toEqual({
      rows: GRID.rows,
      cols: GRID.cols,
      budget: DEDUCTION.budget.med,
      limitMs: DEDUCTION.limitMs,
    });
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
    const { secret, probe, state } = play();
    const payload: HintPayload = { kind: 'region', quadrant: 'NW' };
    probe(payload);

    const answered = state.answers[0]!;
    const expected = secret.r < Math.floor(GRID.rows / 2) && secret.c < Math.floor(GRID.cols / 2);
    expect(answered.answer).toBe(expected);
  });

  it('never sends the remaining candidate count back', () => {
    // Intersecting your own constraints IS the game. Returning the count would
    // leave only the arithmetic.
    const { probe } = play();
    const result = probe({ kind: 'parity', parity: 'even' });
    expect(result.kind).toBe('progress');
    expect(Object.keys((result as { emit: object }).emit)).toEqual([
      'answer',
      'used',
      'budgetLeft',
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
      for (let i = 0; i < 25; i++) {
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
