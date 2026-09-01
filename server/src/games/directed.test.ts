import { describe, expect, it } from 'vitest';
import type { Directive } from '../director/types';
import { deductionModule, type DeductionSpec, type DeductionSecret, type DeductionState } from './deduction';
import { searchModule, type SearchSpec, type SearchSecret, type SearchState } from './search';
import {
  potAfter,
  negotiationModule,
  type NegotiationSpec,
  type NegotiationSecret,
  type NegotiationState,
} from './negotiation';
import type { Timing } from './types';

/**
 * The Director, where the money is.
 *
 * Until now `directedRound` was implemented by exactly one module — `math`,
 * which is XP-only and human-zone-only — so ~650 lines of correct plumbing
 * shaped no hunt that paid anything. These three are the agent cash games.
 *
 * Three properties are checked for each, and they are the same three that make
 * it safe to let a model touch a race with a prize on it:
 *
 *   1. **A null directive plays exactly as before.** That is the path taken
 *      whenever the model is slow, absent or wrong, which is most of the time.
 *   2. **The lever is bounded.** No directive may make a hunt unwinnable, so
 *      every knob has a floor and a ceiling the Director cannot push through.
 *   3. **Judged against what was served.** A directive shapes the round about
 *      to be sent, never the one being answered — a player is never repriced
 *      under an input already in flight.
 */

const timing = (sinceStart = 1_000): Timing => ({ sinceStart, sinceLast: null, intervals: [] });

const directive = (over: Partial<Directive> = {}): Directive => ({
  difficulty: 3,
  roundType: 'standard',
  twist: 'none',
  ...over,
});

const ALL: Directive[] = [1, 2, 3, 4, 5].flatMap(d =>
  (['standard', 'sprint', 'endurance', 'precision'] as const).flatMap(roundType =>
    (['none', 'fog', 'decoys', 'silence', 'haste'] as const).map(twist => ({
      difficulty: d,
      roundType,
      twist,
    })),
  ),
);

// ─────────────────────────── deduction ───────────────────────────

describe('deduction takes direction by price, never by lying', () => {
  const play = () => {
    // A block that lends `parity` at the ordinary price, so everything below
    // measures the DIRECTIVE's effect on cost and nothing else. Left to the
    // salt, whether this block answers parity at all — and what it charges —
    // would vary per block and these tests would be reading the recipe.
    const game = deductionModule.generate('salt-ded', 'med', {
      cell: { r: 0, c: 0 },
      recipe: { extras: ['parity'], dear: [] },
    });
    return {
      spec: game.spec as DeductionSpec,
      secret: game.secret as DeductionSecret,
      state: deductionModule.init(game.spec as DeductionSpec) as DeductionState,
    };
  };

  const probe = (
    ctx: ReturnType<typeof play>,
    d: Directive | null,
  ) =>
    deductionModule.step(
      { ...ctx, timing: timing(), directive: d },
      { kind: 'probe', value: { kind: 'parity', parity: 'even' } },
    );

  it('asks for a directive only while a probe remains', () => {
    const { spec, state } = play();
    state.used = 0;
    expect(deductionModule.directedRound!(state, spec)).toBe(1);
    state.used = spec.budget - 1;
    expect(deductionModule.directedRound!(state, spec)).toBeNull();
  });

  it('charges one per probe when nothing is directing', () => {
    const ctx = play();
    probe(ctx, null);
    expect(ctx.state.used).toBe(1);
  });

  it('never prices a probe outside one or two, under any directive', () => {
    // The floor and the ceiling. Free probes make the budget a suggestion; a
    // dear enough round ends a twelve-probe game on a decision never offered.
    for (const d of ALL) {
      const ctx = play();
      probe(ctx, d);
      const quoted = (probe(ctx, d) as { emit: { nextCost: number } }).emit.nextCost;
      expect(quoted).toBeGreaterThanOrEqual(1);
      expect(quoted).toBeLessThanOrEqual(2);
    }
  });

  it('publishes the price before it is paid', () => {
    const ctx = play();
    const first = probe(ctx, directive({ difficulty: 5 })) as { emit: { nextCost: number } };
    expect(first.emit.nextCost).toBe(2);

    const before = ctx.state.used;
    probe(ctx, directive({ difficulty: 5 }));
    // Charged exactly what the previous emit quoted.
    expect(ctx.state.used - before).toBe(2);
  });

  it('charges the price quoted, not the price now', () => {
    // The ordering property. A probe already in flight cannot be repriced by a
    // directive that arrived while it was travelling.
    const ctx = play();
    probe(ctx, directive({ difficulty: 1 })); // quotes 1 for the next probe
    const before = ctx.state.used;
    probe(ctx, directive({ difficulty: 5 })); // dear NOW, but 1 was quoted
    expect(ctx.state.used - before).toBe(1);
  });

  it('keeps every answer truthful whatever the directive says', () => {
    // The forbidden lever, asserted rather than assumed: a `fog` that made an
    // answer sometimes wrong would be undetectable from inside and would make
    // the hunt unwinnable.
    for (const d of ALL.filter(x => x.twist === 'fog' || x.twist === 'decoys')) {
      const ctx = play();
      const even = ctx.secret.c % 2 === 0;
      const res = probe(ctx, d) as { emit: { answer: boolean } };
      expect(res.emit.answer).toBe(even);
    }
  });
});

// ─────────────────────────── search ───────────────────────────

describe('search takes direction by speed, and always publishes it', () => {
  const play = () => {
    const game = searchModule.generate('salt-search', 'med');
    return {
      spec: game.spec as SearchSpec,
      secret: game.secret as SearchSecret,
      state: searchModule.init(game.spec as SearchSpec) as SearchState,
    };
  };

  const probeAt = (ctx: ReturnType<typeof play>, d: Directive | null, r = 0, c = 0) =>
    searchModule.step({ ...ctx, timing: timing(), directive: d }, { kind: 'probe', value: { r, c } });

  it('asks for a directive only while a probe remains', () => {
    const { spec, state } = play();
    state.used = 0;
    expect(searchModule.directedRound!(state, spec)).toBe(1);
    state.used = spec.probes - 1;
    expect(searchModule.directedRound!(state, spec)).toBeNull();
  });

  it('runs at the block’s own pace when nothing is directing', () => {
    const ctx = play();
    const res = probeAt(ctx, null) as { emit: { nextStep: number } };
    expect(res.emit.nextStep).toBe(ctx.spec.step);
  });

  it('never leaves the quarry motionless or uncatchable', () => {
    // Zero is a stationary target and solves itself; too fast and the reading
    // stops meaning anything, so every miss reads as luck.
    for (const d of ALL) {
      const ctx = play();
      const res = probeAt(ctx, d) as { emit: { nextStep: number } };
      expect(res.emit.nextStep).toBeGreaterThanOrEqual(1);
      expect(res.emit.nextStep).toBeLessThanOrEqual(3);
    }
  });

  it('always tells the player the speed it will run at', () => {
    // "Published — you must predict it" is the contract. A hidden speed turns a
    // bad guess and bad luck into the same thing.
    for (const d of ALL.slice(0, 20)) {
      const ctx = play();
      const res = probeAt(ctx, d) as { emit: Record<string, unknown> };
      expect(res.emit).toHaveProperty('nextStep');
    }
  });

  it('moves at the speed it was running, not the speed just announced', () => {
    const slow = play();
    probeAt(slow, directive({ difficulty: 1, roundType: 'endurance' }));
    const announced = slow.state.nextStep!;

    // Second probe: it should have moved by `announced`, and only then adopt
    // whatever the new directive says.
    const before = { r: slow.state.r, c: slow.state.c };
    probeAt(slow, directive({ difficulty: 5, roundType: 'sprint' }), 17, 11);
    const moved = Math.max(
      Math.abs(slow.state.r - before.r),
      Math.abs(slow.state.c - before.c),
    );
    expect(moved).toBeLessThanOrEqual(announced);
  });
});

// ─────────────────────────── negotiation ───────────────────────────

describe('negotiation takes direction by stubbornness, within a floor', () => {
  const play = () => {
    const game = negotiationModule.generate('salt-nego', 'med');
    return {
      spec: game.spec as NegotiationSpec,
      secret: game.secret as NegotiationSecret,
      state: negotiationModule.init(game.spec as NegotiationSpec) as NegotiationState,
    };
  };

  /**
   * An offer low enough to be refused, high enough not to insult.
   *
   * Composed against the CURRENT pot, not the original: the pot decays every
   * round, and an offer sized to the opening pot reads as an insult by round
   * two — which is the rule working, and would make this a test of the helper.
   */
  const refuse = (ctx: ReturnType<typeof play>, d: Directive | null) => {
    const pot = potAfter(ctx.state.round, ctx.spec.decayBps);
    // Offer exactly one basis point under the ask: refused, because it does not
    // meet it, and not an insult, because it is nowhere near insultBps below.
    const keepBps = Math.max(0, pot - ctx.state.askBps + 1);
    return negotiationModule.step(
      { ...ctx, timing: timing(), directive: d },
      { kind: 'offer', value: { keepBps } },
    );
  };

  const lowball = (ctx: ReturnType<typeof play>) => refuse(ctx, null);

  it('asks for a directive only while a round remains', () => {
    const { spec, state } = play();
    state.round = 0;
    expect(negotiationModule.directedRound!(state, spec)).toBe(1);
    state.round = spec.rounds - 1;
    expect(negotiationModule.directedRound!(state, spec)).toBeNull();
  });

  it('concedes on the block’s own schedule when nothing is directing', () => {
    const ctx = play();
    const opening = ctx.state.askBps;
    lowball(ctx);
    expect(ctx.state.askBps).toBe(Math.max(0, opening - ctx.secret.concedeBps));
  });

  it('never lets them stop conceding entirely', () => {
    // `generate` promises a deal exists at or above minKeepBps. A schedule that
    // flattens to nothing can walk the ask past that promise.
    const base = play().secret.concedeBps;
    for (const d of ALL) {
      const ctx = play();
      refuse(ctx, d);
      const conceded = ctx.state.nextConcedeBps!;
      expect(conceded).toBeGreaterThanOrEqual(Math.round(base * 0.66));
      expect(conceded).toBeLessThanOrEqual(base * 1.3);
    }
  });

  it('concedes what was scheduled, not what was just decided', () => {
    const ctx = play();
    refuse(ctx, directive({ difficulty: 1 })); // sets a generous next concession
    const scheduled = ctx.state.nextConcedeBps!;
    const ask = ctx.state.askBps;

    refuse(ctx, directive({ difficulty: 5 })); // stubborn NOW, but the schedule stood
    expect(ctx.state.askBps).toBe(Math.max(0, ask - scheduled));
  });
});
