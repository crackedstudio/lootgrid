import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULTS, type AgentConfig } from './config';
import * as negotiate from './negotiate';
import { messageSchema, type Message } from './protocol';

/**
 * Agents haggling.
 *
 * Two properties carry this file. The first is that a negotiation **ends** —
 * bounded rounds are not enough on their own when both sides round in their own
 * favour, so the termination test drives every pair of configurations against
 * each other rather than picking a plausible one.
 *
 * The second is that no sequence of messages talks an agent past a limit its
 * owner set. A negotiation that could do that would make `maxHintPriceCents`
 * advisory, and a spending limit that a stranger can argue with is not one.
 */

const BUYER = '0x00000000000000000000000000000000000000b1';
const SELLER = '0x00000000000000000000000000000000000000e2';

const config = (over: Partial<AgentConfig> = {}): AgentConfig => ({
  ...DEFAULTS,
  zones: ['ridge'],
  ...over,
});

interface Sim {
  outcome: 'agreed' | 'walked' | 'stalled';
  agreedCents: number | null;
  exchanges: number;
  /** Every message either side put on the wire, in order. */
  wire: Message[];
}

/**
 * Run a whole negotiation between two policies.
 *
 * Both sides go through `respond`, and every message is re-validated against the
 * schema on the way — a policy that emitted something the protocol would reject
 * is a policy that would fail at the mailbox in production.
 */
function simulate(
  buyerConfig: AgentConfig,
  sellerConfig: AgentConfig,
  askCents: number,
  rationalCeilingCents: number,
  opts: { reliabilityBps?: number; zoneId?: string } = {},
): Sim {
  const reliabilityBps = opts.reliabilityBps ?? 8_000;
  const zoneId = opts.zoneId ?? 'ridge';
  const threadId = 'th_sim';

  negotiate.reset();
  negotiate.openThread(threadId, 'lst_1', BUYER, SELLER, askCents);

  const buyerStance: negotiate.Stance = {
    side: 'buyer',
    config: buyerConfig,
    rationalCeilingCents,
    reliabilityBps,
    zoneId,
  };
  const sellerStance: negotiate.Stance = {
    side: 'seller',
    config: sellerConfig,
    minTradeCents: 1,
    reliabilityBps,
    zoneId,
  };

  const wire: Message[] = [];
  let current: Message | null = negotiate.open(
    BUYER,
    threadId,
    zoneId,
    buyerConfig.maxHintPriceCents,
    buyerConfig.minReliabilityBps,
  );
  let turn: 'seller' | 'buyer' = 'seller';
  let exchanges = 0;

  // Generously above MAX_ROUNDS: if the policy needs more than this it has not
  // terminated, which is the thing being tested.
  const HARD_STOP = 40;

  while (current && exchanges < HARD_STOP) {
    expect(messageSchema.safeParse(current).success, JSON.stringify(current)).toBe(true);
    wire.push(current);
    exchanges += 1;

    const me = turn === 'seller' ? SELLER : BUYER;
    const stance = turn === 'seller' ? sellerStance : buyerStance;
    current = negotiate.respond(me, current, stance);
    turn = turn === 'seller' ? 'buyer' : 'seller';
  }

  const thread = negotiate.getThread(threadId);
  const outcome =
    exchanges >= HARD_STOP
      ? 'stalled'
      : thread?.status === 'agreed'
        ? 'agreed'
        : 'walked';

  return { outcome, agreedCents: thread?.agreedCents ?? null, exchanges, wire };
}

afterEach(() => negotiate.reset());

describe('a negotiation always ends', () => {
  it('terminates for every pairing of aggression and ceiling', () => {
    // The property bounded rounds alone does not give you. Two sides splitting
    // the difference converge; with integer cents and each side rounding its own
    // way, converging is not the same as arriving.
    const stances = [0, 25, 40, 75, 100];
    const asks = [5, 12, 25, 60, 200];
    const ceilings = [1, 8, 25, 90, 400];

    let stalled = 0;
    let checked = 0;
    for (const buyerAggr of stances) {
      for (const sellerAggr of stances) {
        for (const ask of asks) {
          for (const ceiling of ceilings) {
            const sim = simulate(
              config({ aggression: buyerAggr, maxHintPriceCents: ceiling }),
              config({ aggression: sellerAggr }),
              ask,
              ceiling,
            );
            checked += 1;
            if (sim.outcome === 'stalled') stalled += 1;
          }
        }
      }
    }

    expect(checked).toBe(stances.length ** 2 * asks.length * ceilings.length);
    expect(stalled, `${stalled} of ${checked} negotiations never ended`).toBe(0);
  });

  it('actually haggles in the contested middle', () => {
    // Guards the bug measuring this matrix found: an earlier policy accepted any
    // affordable price, so every successful negotiation was the buyer paying the
    // full ask and `aggression` changed nothing. Termination alone stayed green
    // throughout — a negotiation that never happens terminates beautifully.
    const stances = [0, 25, 40, 75, 100];
    const asks = [5, 12, 25, 60, 200];
    const ceilings = [1, 8, 25, 90, 400];

    let multiRound = 0;
    for (const buyerAggr of stances) {
      for (const sellerAggr of stances) {
        for (const ask of asks) {
          for (const ceiling of ceilings) {
            const sim = simulate(
              config({ aggression: buyerAggr, maxHintPriceCents: ceiling }),
              config({ aggression: sellerAggr }),
              ask,
              ceiling,
            );
            // Opening request, an offer, a counter, and a reply to it.
            if (sim.exchanges >= 4) multiRound += 1;
          }
        }
      }
    }

    expect(multiRound, 'no negotiation ever got past a single counter').toBeGreaterThan(20);
  });

  it('never takes more exchanges than the round cap allows', () => {
    const sim = simulate(config({ aggression: 100 }), config({ aggression: 100 }), 200, 190);
    // Each side's reply counts a round, plus the opening request.
    expect(sim.exchanges).toBeLessThanOrEqual(negotiate.MAX_ROUNDS + 2);
  });

  it('refuses a deal that cannot exist without haggling towards it', () => {
    // Seller floor above buyer ceiling. Rounds spent discovering that are ticks
    // burned to reach a conclusion the arithmetic already had.
    const sim = simulate(config({ maxHintPriceCents: 3 }), config({ aggression: 100 }), 200, 3);

    expect(sim.outcome).toBe('walked');
    expect(sim.exchanges).toBeLessThanOrEqual(3);
    expect(sim.wire.at(-1)).toMatchObject({ intent: 'decline' });
  });
});

describe('no message talks an agent past its owner', () => {
  it('never agrees above the configured ceiling', () => {
    for (const ceiling of [1, 5, 25, 100]) {
      for (const ask of [2, 20, 90, 400]) {
        const sim = simulate(config({ maxHintPriceCents: ceiling }), config(), ask, 10_000);
        if (sim.agreedCents !== null) {
          expect(sim.agreedCents, `ceiling ${ceiling}, ask ${ask}`).toBeLessThanOrEqual(ceiling);
        }
      }
    }
  });

  it('is bounded by the rational ceiling as well as the owner one', () => {
    // The tighter of the two, always. A generous owner limit does not make a
    // hint worth more than the prize it points at.
    const sim = simulate(config({ maxHintPriceCents: 500 }), config(), 400, 12);
    if (sim.agreedCents !== null) expect(sim.agreedCents).toBeLessThanOrEqual(12);
  });

  it('refuses on reliability before it discusses price at all', () => {
    const sim = simulate(config({ minReliabilityBps: 9_500 }), config(), 20, 100, {
      reliabilityBps: 4_000,
    });

    expect(sim.outcome).toBe('walked');
    expect(sim.wire.some(m => m.intent === 'decline' && m.reason === 'reliability_too_low')).toBe(
      true,
    );
    // Never named a price. A cheap unreliable hint is still an unreliable hint.
    expect(sim.wire.some(m => m.intent === 'counter')).toBe(false);
  });

  it('refuses a zone its owner never allowed', () => {
    const sim = simulate(config(), config(), 20, 100, { zoneId: 'ridge' });
    // Same zone: this one should get as far as prices.
    expect(sim.wire.some(m => m.intent === 'offer_hint' || m.intent === 'accept')).toBe(true);

    negotiate.reset();
    negotiate.openThread('th_sim', 'lst_1', BUYER, SELLER, 20);
    const reply = negotiate.respond(
      SELLER,
      negotiate.open(BUYER, 'th_sim', 'elsewhere', 50, 0),
      { side: 'seller', config: config(), minTradeCents: 1, reliabilityBps: 9_000, zoneId: 'ridge' },
    );
    expect(reply).toMatchObject({ intent: 'decline', reason: 'wrong_zone' });
  });
});

describe('the shape of a deal', () => {
  it('takes a price it would already pay rather than countering it', () => {
    // Countering a price you would accept is how a negotiation loses a deal it
    // already had.
    const sim = simulate(config({ maxHintPriceCents: 50 }), config(), 10, 50);

    expect(sim.outcome).toBe('agreed');
    expect(sim.agreedCents).toBe(10);
    expect(sim.wire.some(m => m.intent === 'counter')).toBe(false);
  });

  it('meets in the middle when both sides have room', () => {
    const sim = simulate(
      config({ aggression: 50, maxHintPriceCents: 40 }),
      config({ aggression: 20 }),
      60,
      40,
    );

    if (sim.outcome === 'agreed') {
      expect(sim.agreedCents).toBeGreaterThan(0);
      expect(sim.agreedCents).toBeLessThanOrEqual(40);
    }
  });

  it('lets an aggressive buyer pay less than a passive one', () => {
    // Otherwise `aggression` is a setting that does nothing, which is worse than
    // not having it — an owner would think they had a lever.
    const patient = simulate(config({ aggression: 0, maxHintPriceCents: 60 }), config({ aggression: 50 }), 80, 60);
    const pushy = simulate(config({ aggression: 100, maxHintPriceCents: 60 }), config({ aggression: 50 }), 80, 60);

    if (patient.agreedCents !== null && pushy.agreedCents !== null) {
      expect(pushy.agreedCents).toBeLessThanOrEqual(patient.agreedCents);
    }
  });

  it('is deterministic, so a trade can be explained afterwards', () => {
    const a = simulate(config({ aggression: 60, maxHintPriceCents: 30 }), config({ aggression: 30 }), 50, 30);
    const b = simulate(config({ aggression: 60, maxHintPriceCents: 30 }), config({ aggression: 30 }), 50, 30);

    expect(a.wire).toEqual(b.wire);
    expect(a.agreedCents).toBe(b.agreedCents);
  });

  it('anchors the seller floor to the opening ask, not the current one', () => {
    // A floor derived from the ask as it falls slides down with every
    // concession, which would let a patient buyer walk a seller below the price
    // its own configuration says it accepts.
    negotiate.openThread('th_anchor', 'lst_1', BUYER, SELLER, 100);
    const stance: negotiate.Stance = {
      side: 'seller',
      config: config({ aggression: 100 }),
      minTradeCents: 1,
      reliabilityBps: 9_000,
      zoneId: 'ridge',
    };

    const floor = negotiate.sellerFloor(stance.config, 100, 1);
    let reply = negotiate.respond(
      SELLER,
      { v: 1, from: BUYER, thread: 'th_anchor', intent: 'counter', listingId: 'lst_1', priceCents: 10 },
      stance,
    );

    // Keep pushing. Every concession must stay at or above the original floor.
    let guard = 0;
    while (reply && reply.intent === 'counter' && guard++ < 10) {
      expect(reply.priceCents).toBeGreaterThanOrEqual(floor);
      reply = negotiate.respond(
        SELLER,
        { v: 1, from: BUYER, thread: 'th_anchor', intent: 'counter', listingId: 'lst_1', priceCents: 10 },
        stance,
      );
    }
    const thread = negotiate.getThread('th_anchor');
    if (thread?.agreedCents !== null && thread?.agreedCents !== undefined) {
      expect(thread.agreedCents).toBeGreaterThanOrEqual(floor);
    }
  });
});

describe('threads', () => {
  it('says nothing about a thread it does not know', () => {
    // A message naming a thread nobody opened is the cheapest thing a hostile
    // agent can send. It must cost a null, not a state entry.
    const reply = negotiate.respond(
      SELLER,
      { v: 1, from: BUYER, thread: 'th_nonexistent', intent: 'counter', listingId: 'l', priceCents: 5 },
      { side: 'seller', config: config(), minTradeCents: 1, reliabilityBps: 9_000, zoneId: 'ridge' },
    );
    expect(reply).toBeNull();
  });

  it('says nothing more once a thread is settled', () => {
    const sim = simulate(config({ maxHintPriceCents: 50 }), config(), 10, 50);
    expect(sim.outcome).toBe('agreed');

    const extra = negotiate.respond(
      SELLER,
      { v: 1, from: BUYER, thread: 'th_sim', intent: 'counter', listingId: 'lst_1', priceCents: 1 },
      { side: 'seller', config: config(), minTradeCents: 1, reliabilityBps: 9_000, zoneId: 'ridge' },
    );
    expect(extra).toBeNull();
  });

  it('forgets a thread once it goes stale', () => {
    negotiate.openThread('th_old', 'lst_1', BUYER, SELLER, 20, 1_000);
    expect(negotiate.getThread('th_old', 1_000)).not.toBeNull();
    expect(negotiate.getThread('th_old', 1_000 + negotiate.THREAD_TTL_MS + 1)).toBeNull();
  });

  it('sweeps stale threads so the table cannot grow without bound', () => {
    for (let i = 0; i < 50; i++) negotiate.openThread(`th_${i}`, 'lst_1', BUYER, SELLER, 20, 1_000);
    expect(negotiate.sweep(1_000 + negotiate.THREAD_TTL_MS + 1)).toBe(50);
    expect(negotiate.sweep(1_000 + negotiate.THREAD_TTL_MS + 1)).toBe(0);
  });
});
