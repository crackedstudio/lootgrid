import { describe, expect, it } from 'vitest';
import { NEGOTIATION } from '../config';
import {
  CONCEDE_RATES,
  isFeasible,
  negotiationModule as mod,
  negotiationRecipeSchema,
  potAfter,
  type NegotiationInput,
  type NegotiationRecipe,
  type NegotiationSecret,
  type NegotiationSpec,
  type NegotiationState,
} from './negotiation';
import type { Timing } from './types';

/**
 * Negotiation.
 *
 * Two properties decide whether this module answers phase 6's question or only
 * appears to:
 *
 *   1. **Every block is winnable.** A hunt that cannot be solved is not a hard
 *      hunt, it is a broken one, and it takes a player's energy for nothing.
 *   2. **No constant strategy wins.** If offering the same thing every round
 *      beats it, there is no reasoning here and the yes is false.
 *
 * Most of what follows is those two, tested against every block a salt can
 * produce rather than against one convenient example.
 */

const timing = (sinceStart = 1_000): Timing => ({ sinceStart, sinceLast: null, intervals: [] });

const DIFFICULTIES = ['easy', 'med', 'hard'] as const;

/**
 * A counterparty whose window is open from the first round.
 *
 * Two tests below need an over-generous offer to be ACCEPTED before they can
 * assert it is then punished, and that only happens while the opening ask is
 * low enough to clear. It used to be true of `salt-3` by luck, back when every
 * block conceded at the same rate and only `opensAt` moved. Now that the rate
 * varies it is stated instead of hoped for — which is what the test meant all
 * along.
 */
const OPENS_IMMEDIATELY: NegotiationRecipe = { concedeBps: 1_200, opensAt: 0 };

function table(
  difficulty: (typeof DIFFICULTIES)[number],
  seed: string,
  recipe?: NegotiationRecipe,
) {
  const game = mod.generate(seed, difficulty, recipe ? { cell: { r: 0, c: 0 }, recipe } : undefined);
  const spec = game.spec as NegotiationSpec;
  const secret = game.secret as NegotiationSecret;
  const state = mod.init(spec) as NegotiationState;

  const offer = (keepBps: number, at = 1_000) =>
    mod.step(
      { spec, secret, state, timing: timing(at), directive: null },
      { kind: 'offer', value: { keepBps } },
    );

  const step = (input: NegotiationInput) => mod.step({ spec, secret, state, timing: timing(), directive: null }, input);

  return { spec, secret, state, offer, step };
}

describe('generation', () => {
  it('is fixed by the block salt', () => {
    expect(mod.generate('salt-abc', 'med').secret).toEqual(mod.generate('salt-abc', 'med').secret);
  });

  it('publishes both lines and hides only the schedule', () => {
    const game = mod.generate('salt-abc', 'med');
    const published = mod.publicSpec(game.spec, game.secret) as Record<string, unknown>;

    // Nothing about this game may kill a player for something they could not
    // have computed, so both boundaries are in the spec.
    expect(published.insultBps).toBe(NEGOTIATION.insultBps.med);
    expect(published.openingAskBps).toBeGreaterThan(0);
    // How fast they come down is the game.
    expect(published).not.toHaveProperty('concedeBps');
    expect(published).not.toHaveProperty('opensAt');
  });

  it('makes the corridor narrower as difficulty rises', () => {
    const widths = DIFFICULTIES.map(d => (mod.generate('s', d).spec as NegotiationSpec).insultBps);
    expect(widths[0]).toBeGreaterThan(widths[1]!);
    expect(widths[1]).toBeGreaterThan(widths[2]!);
  });
});

describe('every block is winnable', () => {
  it.each(DIFFICULTIES)('has a closable deal at %s, for any salt', difficulty => {
    for (let i = 0; i < 200; i++) {
      const { spec, secret } = table(difficulty, `salt-${i}`);

      // A deal exists at `opensAt`: the ask has come down far enough that
      // keeping the minimum satisfies it. This is what the generator solved for.
      const round = secret.opensAt;
      const ask = spec.openingAskBps - secret.concedeBps * round;
      const pot = potAfter(round, spec.decayBps);

      expect(pot - ask).toBeGreaterThanOrEqual(spec.minKeepBps);
      expect(round).toBeLessThan(spec.rounds);
    }
  });

  it('never opens with an ask above the whole pot', () => {
    for (const difficulty of DIFFICULTIES) {
      for (let i = 0; i < 200; i++) {
        const { spec } = table(difficulty, `salt-${i}`);
        expect(spec.openingAskBps).toBeGreaterThan(0);
        expect(spec.openingAskBps).toBeLessThanOrEqual(10_000);
      }
    }
  });
});

describe('no constant strategy wins', () => {
  /**
   * The line the simple design would have made unbeatable: offer the bare
   * minimum, every round, until they say yes.
   */
  function alwaysMinimum(difficulty: (typeof DIFFICULTIES)[number], seed: string) {
    const { spec, offer } = table(difficulty, seed);
    for (let round = 0; round < spec.rounds; round++) {
      const result = offer(spec.minKeepBps);
      if (result.kind === 'complete') return 'won';
      if (result.kind === 'reject') return result.reason;
    }
    return 'ran_out';
  }

  it('throws the bare-minimum strategy out of most blocks', () => {
    // If this passed everywhere, the module would be a formality and phase 6's
    // question would have a false answer.
    const outcomes = Array.from({ length: 200 }, (_, i) => alwaysMinimum('hard', `salt-${i}`));
    const insulted = outcomes.filter(o => o === 'insulted').length;

    expect(insulted).toBeGreaterThan(0);
    expect(outcomes.filter(o => o === 'won').length).toBeLessThan(outcomes.length);
  });

  it('punishes opening at the ceiling', () => {
    // Keeping the whole pot offers nothing at all, which is below any ask by
    // more than the published margin.
    const { offer } = table('hard', 'salt-7');
    expect(offer(10_000)).toEqual({ kind: 'reject', reason: 'insulted', fatal: true });
  });

  it('punishes closing below the minimum', () => {
    // Accepted, and still a loss. A deal at any price is not the game.
    const { spec, offer } = table('hard', 'salt-3', OPENS_IMMEDIATELY);
    const tooGenerous = Math.max(0, spec.minKeepBps - 2_000);
    const result = offer(tooGenerous);

    expect(result).toEqual({ kind: 'reject', reason: 'conceded_too_much', fatal: true });
  });
});

/**
 * What a competent agent does, using only what it has been told: take the deal
 * the moment the ask has fallen far enough to leave the minimum, and until then
 * concede exactly one basis point more than the walk-away line demands — never
 * a penny more generous, never an insult.
 *
 * It never reads the secret. Everything it needs is in the spec and in the ask
 * republished after each refusal.
 *
 * At module scope because the recipe-space sweep needs it too. Offering the
 * bare minimum every round is NOT a substitute and was the first thing tried:
 * on a block that concedes fast from a late opening, the minimum is below the
 * walk-away line in the early rounds and gets you thrown out — which is the
 * `insultBps` rule doing exactly what its comment says it is for.
 */
function play(
  difficulty: (typeof DIFFICULTIES)[number],
  seed: string,
  recipe?: NegotiationRecipe,
) {
  const { spec, state, offer } = table(difficulty, seed, recipe);

  for (let round = 0; round < spec.rounds; round++) {
    const pot = potAfter(round, spec.decayBps);
    const ask = state.askBps;

    // The most that can be kept while still satisfying them right now.
    const bestKeep = pot - ask;
    const target =
      bestKeep >= spec.minKeepBps
        ? bestKeep // The window is open. Take it.
        : pot - (ask - spec.insultBps) - 1; // Not yet. Survive the round.

    const result = offer(target);
    if (result.kind === 'complete') return { outcome: 'won' as const, round };
    if (result.kind === 'reject') return { outcome: result.reason, round };
  }
  return { outcome: 'ran_out' as const, round: spec.rounds };
}

describe('a strategy that reads the rules does win', () => {
  it.each(DIFFICULTIES)('wins every %s block', difficulty => {
    // The bar that matters. Reasoning from the published rules beats the
    // constant strategy above on the same blocks — and never dies to a rule it
    // could have computed.
    const outcomes = Array.from({ length: 200 }, (_, i) => play(difficulty, `salt-${i}`).outcome);

    expect(outcomes.filter(o => o === 'won')).toHaveLength(200);
    expect(outcomes.filter(o => o === 'insulted')).toHaveLength(0);
    expect(outcomes.filter(o => o === 'conceded_too_much')).toHaveLength(0);
  });
});

describe('the rules', () => {
  it('costs a round per offer', () => {
    const { spec, state, offer } = table('hard', 'salt-1');
    // One basis point above the published walk-away line: never an insult,
    // never enough to close.
    offer(potAfter(0, spec.decayBps) - (state.askBps - spec.insultBps) - 1);
    expect(state.round).toBe(1);
  });

  it('ends when the rounds run out', () => {
    const { spec, state, offer } = table('hard', 'salt-1');
    state.round = spec.rounds;
    // Terminal, or there is no deadline and no reason to hurry.
    expect(offer(spec.minKeepBps)).toEqual({ kind: 'reject', reason: 'no_deal', fatal: true });
  });

  it('shrinks the pot every round', () => {
    expect(potAfter(1, NEGOTIATION.decayBps)).toBeLessThan(potAfter(0, NEGOTIATION.decayBps));
    expect(potAfter(5, NEGOTIATION.decayBps)).toBeLessThan(potAfter(4, NEGOTIATION.decayBps));
    // Waiting must cost, or there is no deadline pressure at all.
    expect(potAfter(0, NEGOTIATION.decayBps)).toBe(10_000);
  });

  it('concedes faster than the pot decays, or waiting could never pay', () => {
    const { secret } = table('hard', 'salt-1');
    const oneRoundOfDecay = potAfter(0, 800) - potAfter(1, 800);
    expect(secret.concedeBps).toBeGreaterThan(oneRoundOfDecay);
  });

  it('refuses malformed offers', () => {
    const { step } = table('med', 'salt-1');
    for (const bad of [{ keepBps: -1 }, { keepBps: 10_001 }, { keepBps: 1.5 }, {}, null, 5_000]) {
      expect(step({ kind: 'offer', value: bad })).toEqual({
        kind: 'reject',
        reason: 'bad_offer',
        fatal: true,
      });
    }
  });

  it('refuses an unknown input kind', () => {
    expect(table('med', 'salt-1').step({ kind: 'accept' })).toEqual({
      kind: 'reject',
      reason: 'bad_input',
      fatal: true,
    });
  });

  it('times out like every other module', () => {
    const { spec, offer } = table('med', 'salt-1');
    expect(offer(5_000, spec.limitMs + 10_000)).toEqual({
      kind: 'reject',
      reason: 'too_slow',
      fatal: true,
    });
  });
});

describe('progress', () => {
  it('tracks the window closing, not rounds spent', () => {
    // A bar that rises as you run out of time is worse than no bar. This one
    // measures how far the ask still has to fall before a winning deal exists.
    const { spec, state } = table('hard', 'salt-1');
    const before = mod.progress(state, spec);

    state.askBps = Math.max(0, state.askBps - 1_200);
    expect(mod.progress(state, spec)).toBeGreaterThanOrEqual(before);
    expect(mod.progress(state, spec)).toBeLessThanOrEqual(99);
  });

  it('is zero for a deal that closed below the minimum', () => {
    const { spec, state, offer } = table('hard', 'salt-3', OPENS_IMMEDIATELY);
    offer(Math.max(0, spec.minKeepBps - 2_000));
    expect(state.closed).toBe(true);
    expect(mod.progress(state, spec)).toBe(0);
  });
});

describe('the recipe space', () => {
  const MAX_OPENS_AT = 4;

  /** Every recipe the schema accepts: 5 concession rates × 5 opening rounds. */
  function everyRecipe(): NegotiationRecipe[] {
    const out: NegotiationRecipe[] = [];
    for (const concedeBps of CONCEDE_RATES) {
      for (let opensAt = 0; opensAt <= MAX_OPENS_AT; opensAt++) out.push({ concedeBps, opensAt });
    }
    return out;
  }

  it('enumerates exactly the space the schema accepts', () => {
    const all = everyRecipe();
    expect(all).toHaveLength(CONCEDE_RATES.length * (MAX_OPENS_AT + 1));
    for (const recipe of all) expect(negotiationRecipeSchema.safeParse(recipe).success).toBe(true);
  });

  /**
   * The guarantee `generate` makes, checked at every point in the space.
   *
   * The opening ask is SOLVED so that a deal at exactly `minKeepBps` exists at
   * `opensAt` and not before. That solve couples the concession rate, the
   * opening round and the difficulty's floor, and the schema can only see the
   * first two — so a rate that was fine at round 0 can imply an ask above the
   * whole pot at round 4, which is not a negotiation, it is a wall.
   *
   * `isFeasible` is the check that catches it. This asserts the two agree:
   * every recipe it passes produces a closable block, and every recipe it
   * refuses is refused by `generate` too rather than quietly producing one.
   */
  it.each(DIFFICULTIES)('is closable wherever isFeasible says so, at %s', difficulty => {
    const rounds = NEGOTIATION.rounds[difficulty];
    const minKeepBps = NEGOTIATION.minKeepBps[difficulty];

    for (const recipe of everyRecipe()) {
      const feasible = isFeasible(recipe, minKeepBps, rounds);
      const { spec, secret } = table(difficulty, 'salt-space', recipe);

      if (!feasible) {
        // Refused, not repaired: the block falls back to its salt's own recipe,
        // which is feasible by construction. An author's infeasible choice must
        // never become a block nobody can close.
        expect(isFeasible(secret as NegotiationRecipe, minKeepBps, rounds)).toBe(true);
        continue;
      }

      expect(secret.concedeBps).toBe(recipe.concedeBps);
      expect(secret.opensAt).toBe(recipe.opensAt);
      expect(spec.openingAskBps).toBeLessThanOrEqual(spec.potBps);

      // The deal the generator promises, taken by the strategy the module
      // documents. Played round by round through `step` rather than asserted
      // arithmetically, so this measures the game and not the formula it was
      // built from — and it closes at `opensAt` exactly, which is the "and not
      // before" half of the promise.
      const label = `${difficulty} ${recipe.concedeBps}bps @${recipe.opensAt}`;
      const result = play(difficulty, 'salt-space', recipe);
      expect(result.outcome, label).toBe('won');
      expect(result.round, label).toBe(recipe.opensAt);
    }
  });

  it('hides a concession rate that actually differs between blocks', () => {
    // The one number a player cannot see was the constant 1,200 on every block
    // ever generated. An agent that measured it once knew it forever, and the
    // only genuinely hidden value in the module was a lookup.
    const rates = new Set<number>();
    for (let i = 0; i < 500; i++) {
      rates.add((mod.generate(`variety-${i}`, 'med').secret as NegotiationSecret).concedeBps);
    }
    expect(rates.size).toBe(CONCEDE_RATES.length);
  });

  it('gives blocks genuinely different tables', () => {
    // Five distinct specs across 500 salts before this: `openingAskBps` moved
    // with `opensAt` and nothing else did.
    const specs = new Set<string>();
    for (let i = 0; i < 500; i++) {
      specs.add(JSON.stringify(mod.generate(`variety-${i}`, 'med').spec));
    }
    expect(specs.size).toBeGreaterThan(10);
  });

  it('concedes faster than the pot decays, at every rate', () => {
    // The property the original constant was chosen for. Concede slower than
    // the pot shrinks and waiting could never pay, so the only rational line
    // would be to close in round 0 regardless of the ask — and the game would
    // have no reasoning in it at any rate.
    for (const rate of CONCEDE_RATES) expect(rate).toBeGreaterThan(NEGOTIATION.decayBps);
  });

  it('rejects what an author must not be able to say', () => {
    const bad: unknown[] = [
      // Not one of the measured rates.
      { concedeBps: 1_100, opensAt: 0 },
      // Slower than the decay: waiting could never pay.
      { concedeBps: 500, opensAt: 0 },
      // Past the cap, where the ask implies a wall.
      { concedeBps: 1_200, opensAt: 5 },
      { concedeBps: 1_200, opensAt: -1 },
      // Strict: the opening ask is solved, never stated. An author who could
      // state it could state one with no deal reachable behind it.
      { concedeBps: 1_200, opensAt: 0, openingAskBps: 0 },
      { concedeBps: 1_200, opensAt: 0, minKeepBps: 0 },
    ];
    for (const value of bad) {
      expect(negotiationRecipeSchema.safeParse(value).success, JSON.stringify(value)).toBe(false);
    }
  });
});
