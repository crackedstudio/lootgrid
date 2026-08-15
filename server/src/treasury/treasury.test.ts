import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MILLS_PER_CENT } from '../market/fees';
import { MAX_PRIZE_CENTS, PRIZE_CENTS, prizeCentsFor, setBandSource } from '../prizes';
import { freshWorld, teardownWorld } from '../testing/harness';
import * as agent from './agent';
import { boundedFloor, healthy, obligations, surplus } from './buffer';
import { affordable, bandFor, MIN_PRIZE_CENTS, stepToward, type Inflow } from './pricing';

/**
 * The treasury.
 *
 * Phase 10 asks whether the economy can self-regulate, and architecture §1
 * already settled the shape of the answer:
 *
 *     total prizes ≤ deposits + sponsorship − inference − margin
 *
 * with the warning attached: **prizes scale with player count, never with trade
 * volume.** Funding prizes from trading fees is the closed-loop fallacy, and a
 * treasury that made that mistake would look healthiest exactly while it ate
 * itself. So the first test here is not about arithmetic, it is about which
 * inputs are allowed to move the answer at all.
 */

const empty: Inflow = {
  entryFeeCents: 0,
  rakeCents: 0,
  depositCents: 0,
  inferenceMills: 0,
  hunts: 0,
};

beforeEach(() => {
  freshWorld();
  agent.reset();
});

afterEach(() => {
  setBandSource(null);
  agent.reset();
  teardownWorld();
});

describe('the rake never funds a prize', () => {
  it('ignores trading volume entirely', () => {
    // The closed-loop fallacy, refused at the door. In an economy whose only
    // inflow is prizes, fee revenue is bounded above by prizes minus inference,
    // so fees can never fund the prizes they are levied against.
    const noRake = bandFor({ ...empty, depositCents: 10_000, hunts: 20 });
    const allRake = bandFor({ ...empty, depositCents: 10_000, rakeCents: 500_000, hunts: 20 });

    expect(allRake.prizes).toEqual(noRake.prizes);
  });

  it('scales with deposits', () => {
    // Below saturation, where inflow is actually the binding constraint.
    const lean = bandFor({ ...empty, depositCents: 300, hunts: 20 });
    const flush = bandFor({ ...empty, depositCents: 1_200, hunts: 20 });

    // Prizes scale with player count — deposits are the only real funding.
    expect(flush.prizes.med).toBeGreaterThan(lean.prizes.med);
  });

  it('never rises above the static table', () => {
    // `PRIZE_CENTS.hard` is already the escrow's per-hunt cap, so the table is a
    // CEILING and inflow only ever scales down from it. A treasury that could
    // raise prizes past the cap would be proposing hunts the escrow would refuse
    // to fund.
    const flush = bandFor({ ...empty, depositCents: 100_000_000, hunts: 1 });
    expect(flush.prizes.hard).toBe(PRIZE_CENTS.hard);
    expect(flush.prizes.med).toBe(PRIZE_CENTS.med);
  });

  it('subtracts inference as cost of goods sold', () => {
    const before = bandFor({ ...empty, depositCents: 1_000, hunts: 20 });
    const after = bandFor({
      ...empty,
      depositCents: 1_000,
      inferenceMills: 600 * MILLS_PER_CENT,
      hunts: 20,
    });

    expect(after.prizes.med).toBeLessThan(before.prizes.med);
  });

  it('keeps the shape of the band at every scale', () => {
    // A hard hunt stays worth chasing relative to a med one however lean OR
    // flush the week. Clamping each tier independently collapses this at high
    // inflow — both hit the ceiling and the ratio the difficulty draw and hint
    // pricing depend on disappears.
    for (const depositCents of [500, 5_000, 20_000, 100_000_000]) {
      const band = bandFor({ ...empty, depositCents, hunts: 20 }).prizes;
      expect(band.hard, `hard vs med at ${depositCents}c`).toBeGreaterThan(band.med);
      expect(band.med, `med vs easy at ${depositCents}c`).toBeGreaterThan(band.easy);
    }
  });

  it('says so when it cannot afford to run rewarded hunts', () => {
    // A grid advertising prizes it cannot cover is worse than a quiet one.
    const band = bandFor({ ...empty, depositCents: 1, hunts: 1_000 });
    expect(band.starved).toBe(true);
  });

  it('never exceeds the contract’s own ceiling', () => {
    const band = bandFor({ ...empty, depositCents: 100_000_000, hunts: 1 });
    for (const value of Object.values(band.prizes)) {
      expect(value).toBeLessThanOrEqual(MAX_PRIZE_CENTS);
    }
  });
});

describe('the band moves down fast and up slowly', () => {
  const current = { easy: 10, med: 100, hard: 200 };

  it('rises gradually', () => {
    // A lucky week must not commit the treasury to a level it cannot hold.
    const next = stepToward(current, { easy: 100, med: 500, hard: 500 });
    expect(next.med).toBeGreaterThan(current.med);
    expect(next.med).toBeLessThan(300);
  });

  it('falls sharply', () => {
    const next = stepToward(current, { easy: 1, med: 10, hard: 20 });
    // Paying what you cannot afford is worse than paying less than you could.
    expect(next.med).toBeLessThan(60);
  });

  it('always moves at least a cent', () => {
    // Otherwise a band converges asymptotically and never arrives.
    const next = stepToward({ easy: 1, med: 1, hard: 1 }, { easy: 2, med: 2, hard: 2 });
    expect(next.med).toBe(2);
  });

  it('never drops below the floor', () => {
    const next = stepToward({ easy: 1, med: 1, hard: 1 }, { easy: 0, med: 0, hard: 0 });
    expect(next.easy).toBe(MIN_PRIZE_CENTS);
  });

  it('converges when the target holds still', () => {
    let band = { easy: 1, med: 10, hard: 20 };
    const target = { easy: 5, med: 60, hard: 300 };
    for (let i = 0; i < 200; i++) band = stepToward(band, target);
    expect(band).toEqual(target);
  });
});

describe('the buffer is what makes payouts never wait', () => {
  it('counts live hunts at the dearest tier', () => {
    // Being wrong this way costs idle float. Being wrong the other way costs a
    // winner their prize.
    const band = { easy: 1, med: 50, hard: 500 };
    const before = obligations(band);
    expect(before.liveHuntCents % band.hard).toBe(0);
    expect(before.floorCents).toBeGreaterThan(before.liveHuntCents);
  });

  it('includes headroom for hunts not created yet', () => {
    const band = { easy: 1, med: 50, hard: 500 };
    expect(obligations(band).lookaheadCents).toBeGreaterThan(0);
  });

  it('reports a treasury below its obligations as unhealthy', () => {
    expect(healthy(100, 500)).toBe(false);
    expect(healthy(500, 500)).toBe(true);
  });

  it('never reports a negative surplus', () => {
    expect(surplus(100, 500)).toBe(0);
  });

  it('caps a runaway floor so the failure is visible', () => {
    // A bug that never resolved hunts would otherwise compute a floor larger
    // than the treasury and freeze allocation forever while looking prudent.
    expect(boundedFloor(Number.MAX_SAFE_INTEGER)).toBeLessThan(Number.MAX_SAFE_INTEGER);
  });
});

describe('what the agent proposes', () => {
  const rich: Inflow = { ...empty, depositCents: 50_000, hunts: 20 };

  it('proposes nothing when there is no spare float', () => {
    // A treasury exactly covering its obligations is healthy, not stalled — and
    // an agent that proposed its way out of insolvency would be proposing to
    // spend money already promised.
    const decision = agent.decide(rich, { ...PRIZE_CENTS }, 0, 16);
    expect(decision.proposal?.amountCents).toBe(0);
    expect(decision.surplusCents).toBe(0);
  });

  it('funds the escrow out of genuine surplus', () => {
    const decision = agent.decide(rich, { ...PRIZE_CENTS }, 5_000_000, 16);
    expect(decision.proposal?.destination).toBe('escrow');
    expect(decision.proposal?.amountCents).toBeGreaterThan(0);
  });

  it('proposes nothing rather than spending promised money', () => {
    // The floor counts every live hunt at the dearest tier, so a treasury that
    // cannot cover its band has no surplus by construction — which is why
    // `decide` needs no separate affordability branch. One that could never
    // fail would imply a protection that was not doing anything.
    const decision = agent.decide(rich, { easy: 1, med: 500, hard: 500 }, 600, 100);
    expect(decision.proposal?.amountCents).toBe(0);
    expect(decision.surplusCents).toBe(0);
  });

  it('only ever emits a legal proposal', () => {
    // The containment: a fully hijacked treasury agent proposes a number from a
    // closed set of destinations.
    for (const treasury of [0, 1_000, 5_000_000]) {
      const decision = agent.decide(rich, { ...PRIZE_CENTS }, treasury, 16);
      expect(agent.proposalSchema.safeParse(decision.proposal).success).toBe(true);
    }
  });

  it('rejects anything that is not a proposal', () => {
    for (const bad of [
      { destination: 'attacker', amountCents: 1, reason: 'hold' },
      { destination: 'escrow', amountCents: -1, reason: 'hold' },
      { destination: 'escrow', amountCents: 1, reason: 'because I said so' },
      { destination: 'escrow', amountCents: 1, reason: 'hold', note: 'hi' },
    ]) {
      expect(agent.proposalSchema.safeParse(bad).success).toBe(false);
    }
  });

  it('is deterministic, so an allocation can be audited afterwards', () => {
    const a = agent.decide(rich, { ...PRIZE_CENTS }, 5_000_000, 16);
    const b = agent.decide(rich, { ...PRIZE_CENTS }, 5_000_000, 16);
    expect(a).toEqual(b);
  });
});

describe('the live band drives real prizes', () => {
  it('leaves prices exactly as phase 3 had them when the treasury is off', () => {
    // A treasury that is switched off must change nothing.
    setBandSource(null);
    expect(prizeCentsFor('med')).toBe(PRIZE_CENTS.med);
  });

  it('changes what a hunt is worth once it is on', () => {
    setBandSource(agent.currentBand);
    agent.applyBand({ easy: 2, med: 120, hard: 480 });

    expect(prizeCentsFor('easy')).toBe(2);
    expect(prizeCentsFor('med')).toBe(120);
    expect(prizeCentsFor('hard')).toBe(480);
  });

  it('reverts to the static table on restart', () => {
    // Safer than resuming a level nobody has re-derived: the band walks back to
    // wherever the numbers say it should be.
    setBandSource(agent.currentBand);
    agent.applyBand({ easy: 5, med: 300, hard: 500 });
    agent.reset();

    expect(prizeCentsFor('med')).toBe(PRIZE_CENTS.med);
  });
});

describe('measuring what actually came in', () => {
  it('reads the ledgers the rest of the system already keeps', () => {
    // A second set of books would be a second thing to be wrong.
    const inflow = agent.measureInflow();
    expect(inflow.hunts).toBeGreaterThan(0); // freshWorld seeds hunts
    expect(inflow.inferenceMills).toBe(0);
    expect(inflow.rakeCents).toBe(0);
  });

  it('does not invent an entry-fee figure', () => {
    // Entry fees settle through x402 and are not double-entried locally.
    // Sizing prizes off a number nobody can check would be worse than a small
    // one that is real.
    expect(agent.measureInflow().entryFeeCents).toBe(0);
  });
});

describe('affordability is the last check', () => {
  it('refuses a band the float cannot cover', () => {
    expect(affordable({ easy: 1, med: 50, hard: 500 }, 16, 1_000)).toBe(false);
    expect(affordable({ easy: 1, med: 50, hard: 500 }, 16, 8_000)).toBe(true);
  });
});
