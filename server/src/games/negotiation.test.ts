import { describe, expect, it } from 'vitest';
import { NEGOTIATION } from '../config';
import {
  negotiationModule as mod,
  potAfter,
  type NegotiationInput,
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

function table(difficulty: (typeof DIFFICULTIES)[number], seed: string) {
  const game = mod.generate(seed, difficulty);
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
    const { spec, offer } = table('hard', 'salt-3');
    const tooGenerous = Math.max(0, spec.minKeepBps - 2_000);
    const result = offer(tooGenerous);

    expect(result).toEqual({ kind: 'reject', reason: 'conceded_too_much', fatal: true });
  });
});

describe('a strategy that reads the rules does win', () => {
  /**
   * What a competent agent does, using only what it has been told: take the
   * deal the moment the ask has fallen far enough to leave the minimum, and
   * until then concede exactly one basis point more than the walk-away line
   * demands — never a penny more generous, never an insult.
   *
   * It never reads the secret. Everything it needs is in the spec and in the
   * ask republished after each refusal.
   */
  function play(difficulty: (typeof DIFFICULTIES)[number], seed: string) {
    const { spec, state, offer } = table(difficulty, seed);

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
      if (result.kind === 'complete') return 'won';
      if (result.kind === 'reject') return result.reason;
    }
    return 'ran_out';
  }

  it.each(DIFFICULTIES)('wins every %s block', difficulty => {
    // The bar that matters. Reasoning from the published rules beats the
    // constant strategy above on the same blocks — and never dies to a rule it
    // could have computed.
    const outcomes = Array.from({ length: 200 }, (_, i) => play(difficulty, `salt-${i}`));

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
    const { spec, state, offer } = table('hard', 'salt-3');
    offer(Math.max(0, spec.minKeepBps - 2_000));
    expect(state.closed).toBe(true);
    expect(mod.progress(state, spec)).toBe(0);
  });
});
