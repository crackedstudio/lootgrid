import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as agentRepo from '../db/repos/agents';
import { MILLS_PER_CENT } from '../market/fees';
import { AGENT_DIFFICULTY_WEIGHTS, prizeCentsFor } from '../prizes';
import { freshWorld, teardownWorld } from '../testing/harness';
import * as budget from './budget';
import { defaultConfig, type AgentConfig } from './config';

/**
 * Budgets.
 *
 * The plan's risk register lists "inference cost exceeds prize value" for this
 * phase, and the architecture's own estimate of that cost turned out to be wrong
 * by two orders of magnitude in one direction while the prize band moved an
 * order of magnitude in the other. So these tests pin the arithmetic rather than
 * the intent: if pricing changes, they should fail and be re-derived, not
 * quietly keep passing.
 *
 * The other property here is an ordering one, and it is the whole control: an
 * agent must be refused its NEXT call, not billed for the one it just made.
 */

const AGENT = '0x00000000000000000000000000000000000000a1';
const PLAYER = '0x00000000000000000000000000000000000000b0';
const FLASH = 'deepseek-v4-flash';
const PRO = 'deepseek-v4-pro';

let config: AgentConfig;

beforeEach(() => {
  freshWorld();
  agentRepo.create(AGENT, PLAYER);
  config = { ...defaultConfig(), zones: ['ridge'] };
});

afterEach(() => teardownWorld());

describe('the measured cost of thinking', () => {
  it('prices a call in mills, not cents', () => {
    // ~0.27 mills per call at DeepSeek v4-flash rates for a 1.5k/200 token turn.
    // Rounded up, because the budget is checked before the call and guessing
    // low is the dangerous direction.
    expect(budget.callCostMills(FLASH)).toBe(1);
    expect(budget.callCostMills(PRO)).toBe(2);
  });

  it('prices an unknown model as the expensive one', () => {
    // Fail expensive, not cheap: a new model id must not accidentally be free.
    expect(budget.callCostMills('something-new')).toBe(budget.DEFAULT_CALL_MILLS);
    expect(budget.DEFAULT_CALL_MILLS).toBeGreaterThanOrEqual(budget.callCostMills(PRO));
  });

  it('lets a whole hunt of thinking cost a fraction of a cent', () => {
    // Ten calls is the practical ceiling — the phase 6 modules cap their own
    // rounds — against the architecture's assumed two hundred.
    const perHunt = 10 * budget.callCostMills(FLASH);
    expect(perHunt).toBeLessThan(MILLS_PER_CENT);
  });
});

describe('inference is bounded by what the hunt is worth', () => {
  it('never allows more than a share of the prize', () => {
    for (const difficulty of ['easy', 'med', 'hard'] as const) {
      const ceiling = budget.prizeCeilingMills(difficulty);
      const prize = prizeCentsFor(difficulty) * MILLS_PER_CENT;
      expect(ceiling).toBeLessThanOrEqual(prize * budget.INFERENCE_SHARE_OF_PRIZE + 1);
    }
  });

  it('takes the tighter of the player’s budget and the prize ceiling', () => {
    // A player who sets a generous inference budget should still not spend more
    // thinking about a hunt than the hunt is worth.
    const generous = { ...config, inferenceMillsPerHunt: 1_000_000 };
    const hunt = { id: 'h1', difficulty: 'easy' as const };

    // easy = 1c prize, so the ceiling is 100 mills however generous the player is.
    for (let i = 0; i < budget.prizeCeilingMills('easy'); i++) {
      const decision = budget.canInfer(AGENT, generous, hunt, FLASH);
      expect(decision.ok).toBe(true);
      budget.record(AGENT, 'inference', budget.callCostMills(FLASH), { huntId: hunt.id });
    }

    expect(budget.canInfer(AGENT, generous, hunt, FLASH)).toMatchObject({
      ok: false,
      reason: 'inference_budget',
    });
  });

  /**
   * THE ordering property. A looping agent must be refused its next call rather
   * than billed for it and told afterwards — which is also why cost is estimated
   * from the model rather than measured from the response.
   */
  it('refuses the next call, not the last one', () => {
    const hunt = { id: 'h1', difficulty: 'med' as const };
    const tight = { ...config, inferenceMillsPerHunt: 2 };

    expect(budget.canInfer(AGENT, tight, hunt, FLASH).ok).toBe(true);
    budget.record(AGENT, 'inference', 1, { huntId: hunt.id });
    expect(budget.canInfer(AGENT, tight, hunt, FLASH).ok).toBe(true);
    budget.record(AGENT, 'inference', 1, { huntId: hunt.id });

    // Cap reached. The third call is refused BEFORE it is made.
    const decision = budget.canInfer(AGENT, tight, hunt, FLASH);
    expect(decision.ok).toBe(false);
    expect(decision.reason).toBe('inference_budget');
    expect(agentRepo.spentOnHunt(AGENT, hunt.id, 'inference')).toBe(2);
  });

  it('meters each hunt separately', () => {
    const tight = { ...config, inferenceMillsPerHunt: 1 };
    budget.record(AGENT, 'inference', 1, { huntId: 'h1' });

    expect(budget.canInfer(AGENT, tight, { id: 'h1', difficulty: 'med' }, FLASH).ok).toBe(false);
    // A different hunt has its own allowance — the cap is per hunt by design.
    expect(budget.canInfer(AGENT, tight, { id: 'h2', difficulty: 'med' }, FLASH).ok).toBe(true);
  });

  it('still respects the daily budget', () => {
    // Inference is cost of goods sold against the same deposit that buys hints,
    // so it lands in the same daily ledger.
    const oneCentDay = { ...config, dailyBudgetCents: 1, inferenceMillsPerHunt: 100_000 };
    budget.record(AGENT, 'hint', MILLS_PER_CENT, { huntId: 'h1' });

    expect(budget.canInfer(AGENT, oneCentDay, { id: 'h1', difficulty: 'hard' }, FLASH)).toMatchObject(
      { ok: false, reason: 'daily_budget' },
    );
  });
});

describe('buying a hint', () => {
  const hint = { priceCents: 20, reliabilityBps: 7_000, zoneId: 'ridge' };

  it('allows one inside every limit', () => {
    expect(budget.canBuyHint(AGENT, config, hint).ok).toBe(true);
  });

  it('refuses one above the per-hint ceiling', () => {
    const cheap = { ...config, maxHintPriceCents: 5 };
    expect(budget.canBuyHint(AGENT, cheap, hint)).toMatchObject({ ok: false, reason: 'hint_price' });
  });

  it('refuses one below the reliability floor', () => {
    const picky = { ...config, minReliabilityBps: 9_000 };
    expect(budget.canBuyHint(AGENT, picky, hint)).toMatchObject({ ok: false, reason: 'reliability' });
  });

  it('treats an empty zone list as no zones, never all zones', () => {
    // A config that defaulted to "everywhere" would be an agent trading
    // somewhere its owner never chose.
    const nowhere = { ...config, zones: [] };
    expect(budget.canBuyHint(AGENT, nowhere, hint)).toMatchObject({
      ok: false,
      reason: 'zone_not_allowed',
    });
  });

  it('refuses once the day is spent', () => {
    const small = { ...config, dailyBudgetCents: 25 };
    budget.record(AGENT, 'hint', 20 * MILLS_PER_CENT, { huntId: 'h1' });

    const decision = budget.canBuyHint(AGENT, small, hint);
    expect(decision).toMatchObject({ ok: false, reason: 'daily_budget' });
    expect(decision.remainingMills).toBe(5 * MILLS_PER_CENT);
  });

  it('forgets yesterday', () => {
    const small = { ...config, dailyBudgetCents: 25 };
    const yesterday = Date.now() - 25 * 60 * 60 * 1000;
    budget.record(AGENT, 'hint', 25 * MILLS_PER_CENT, { huntId: 'h0' }, yesterday);

    expect(budget.canBuyHint(AGENT, small, hint).ok).toBe(true);
  });
});

describe('whether a hunt is worth entering at all', () => {
  /**
   * The finding that changed `prizes.ts`. Inference belongs on the cost side of
   * architecture §1's EV, and on the easy tier it dominates.
   */
  /**
   * Raising the prize floor bought the cheap tier back.
   *
   * This test used to assert the opposite, and it was right to: a 1c prize is
   * 1,000 mills against ~10–20 mills of thinking, so any real contention made
   * an easy hunt a loss once inference was counted, and a rational agent
   * refused. That was the finding that shaped `prizes.ts`.
   *
   * At a 60c floor the same arithmetic runs the other way — the tier is viable
   * against contention an order of magnitude past anything realistic. Agent
   * zones still do not *offer* it (see `AGENT_DIFFICULTY_WEIGHTS`), but that is
   * now a judgement about what makes an interesting problem rather than an
   * arithmetic necessity, and the two should not be confused again.
   */
  it('makes the cheap tier viable now that the prize floor has risen', () => {
    for (const entrants of [1, 8, 40, 100]) {
      expect(budget.viableFor('easy', entrants, FLASH), `flash/${entrants}`).toBe(true);
      expect(budget.viableFor('easy', entrants, PRO), `pro/${entrants}`).toBe(true);
    }
  });

  it('still refuses a hunt once contention makes thinking cost more than the share', () => {
    // The mechanism is intact, just an order of magnitude further out. This is
    // the property that actually matters — an agent that enters anything is an
    // agent that loses money — and the expensive model still gives up first.
    expect(budget.viableFor('easy', 4_000, PRO)).toBe(false);
    expect(budget.viableFor('easy', 4_000, FLASH)).toBe(true);
    expect(budget.viableFor('easy', 10_000, FLASH)).toBe(false);
  });

  it('leaves the paying tiers comfortably viable', () => {
    for (const entrants of [1, 8, 40]) {
      expect(budget.viableFor('med', entrants, PRO)).toBe(true);
      expect(budget.viableFor('hard', entrants, PRO)).toBe(true);
    }
  });

  it('agent zones still never draw easy hunts', () => {
    // Encoded where the hunts are actually created. Note the reason has moved:
    // this was forced while an easy hunt paid 1c and no rational agent would
    // enter one, and it is now a judgement that an agent zone should pose
    // problems worth reasoning about. The assertion is the same; do not
    // re-derive the old justification from it.
    expect(AGENT_DIFFICULTY_WEIGHTS.map(([d]) => d)).not.toContain('easy');
  });
});

describe('the ledger', () => {
  it('adds both kinds of spend together', () => {
    // One question — what has this agent cost its owner today — answered from
    // one place, so the two kinds cannot disagree.
    budget.record(AGENT, 'hint', 5 * MILLS_PER_CENT, { huntId: 'h1', tradeRef: '0xabc' });
    budget.record(AGENT, 'inference', 12, { huntId: 'h1' });

    const remaining = budget.remainingToday(AGENT, config);
    expect(remaining).toBe(config.dailyBudgetCents * MILLS_PER_CENT - 5 * MILLS_PER_CENT - 12);
  });

  it('keeps the trade reference for a hint purchase', () => {
    // Ties an on-chain payment back to the decision that caused it.
    budget.record(AGENT, 'hint', 1_000, { huntId: 'h1', tradeRef: '0xdeadbeef' });
    expect(agentRepo.recentSpend(AGENT)[0]).toMatchObject({
      kind: 'hint',
      tradeRef: '0xdeadbeef',
    });
  });
});
