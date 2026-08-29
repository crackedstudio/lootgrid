import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as agentRepo from '../db/repos/agents';
import { MILLS_PER_CENT } from '../market/fees';
import { AGENT_DIFFICULTY_WEIGHTS, prizeCentsFor } from '../prizes';
import { env } from '../env';
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
    // ~26.6 mills per call at DeepSeek v4-flash rates for a 1.5k/200 token turn.
    // Rounded up, because the budget is checked before the call and guessing low
    // is the dangerous direction.
    //
    // These were 1 and 2, from a comment that converted DOLLARS as if they were
    // cents — a mill is a thousandth of a cent, so $0.000266 is 26.6 mills and
    // not 0.27. The house was under-billing itself 27x. The assertion is written
    // against the arithmetic rather than the constant so the same slip cannot
    // pass twice.
    const millsPerCall = (inputPerM: number, outputPerM: number) =>
      Math.ceil((1500 * inputPerM + 200 * outputPerM) * 100 * 1000);

    expect(budget.callCostMills(FLASH)).toBe(millsPerCall(0.14 / 1e6, 0.28 / 1e6));
    expect(budget.callCostMills(PRO)).toBe(millsPerCall(0.435 / 1e6, 0.87 / 1e6));
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

    // The ceiling is a share of the prize however generous the player is.
    // Counted in CALLS rather than mills — a call is 27 mills now, and a loop
    // that assumed 1 exhausted the cap on its second iteration.
    const callsAllowed = Math.floor(budget.prizeCeilingMills('easy') / budget.callCostMills(FLASH));
    for (let i = 0; i < callsAllowed; i++) {
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
    // Exactly two calls' worth, expressed in calls so it survives a price change.
    const call = budget.callCostMills(FLASH);
    const tight = { ...config, inferenceMillsPerHunt: 2 * call };

    expect(budget.canInfer(AGENT, tight, hunt, FLASH).ok).toBe(true);
    budget.record(AGENT, 'inference', call, { huntId: hunt.id });
    expect(budget.canInfer(AGENT, tight, hunt, FLASH).ok).toBe(true);
    budget.record(AGENT, 'inference', call, { huntId: hunt.id });

    // Cap reached. The third call is refused BEFORE it is made.
    const decision = budget.canInfer(AGENT, tight, hunt, FLASH);
    expect(decision.ok).toBe(false);
    expect(decision.reason).toBe('inference_budget');
    expect(agentRepo.spentOnHunt(AGENT, hunt.id, 'inference')).toBe(2 * call);
  });

  it('meters each hunt separately', () => {
    const tight = { ...config, inferenceMillsPerHunt: budget.callCostMills(FLASH) };
    budget.record(AGENT, 'inference', budget.callCostMills(FLASH), { huntId: 'h1' });

    expect(budget.canInfer(AGENT, tight, { id: 'h1', difficulty: 'med' }, FLASH).ok).toBe(false);
    // A different hunt has its own allowance — the cap is per hunt by design.
    expect(budget.canInfer(AGENT, tight, { id: 'h2', difficulty: 'med' }, FLASH).ok).toBe(true);
  });

  /**
   * ─────────────────────────── whose ceiling stops a call ───────────────────
   *
   * This test used to assert the opposite: that inference counted against
   * `dailyBudgetCents`, on the reasoning that thinking was "cost of goods sold
   * against the same deposit that buys hints". That stopped being true when the
   * house started funding inference through seats — a player's deposit no longer
   * pays for it, so charging it to their ceiling charged them for our costs, and
   * raising a hint budget quietly authorised more house spending. AGENTS_BYO
   * §7.5(4). The two ledgers are separate now, and these two tests are the pair
   * that says so in both directions.
   */
  it('is not stopped by the player spending their own budget on hints', () => {
    const oneCentDay = { ...config, dailyBudgetCents: 1, inferenceMillsPerHunt: 100_000 };
    budget.record(AGENT, 'hint', MILLS_PER_CENT, { huntId: 'h1' });

    // The player's day is fully spent. The house's is untouched, so the agent
    // may still think — it simply cannot buy anything.
    expect(budget.canInfer(AGENT, oneCentDay, { id: 'h1', difficulty: 'hard' }, FLASH).ok).toBe(
      true,
    );
    expect(budget.canBuyHint(AGENT, oneCentDay, {
      priceCents: 1,
      reliabilityBps: 10_000,
      zoneId: oneCentDay.zones[0] ?? 'ridge',
    }).ok).toBe(false);
  });

  it('is stopped by the house’s own daily ceiling', () => {
    const roomy = { ...config, dailyBudgetCents: 10_000, inferenceMillsPerHunt: 100_000 };
    // Spend the house's day, on a different hunt so the per-hunt cap is not
    // what refuses this — it must be the daily one.
    budget.record(AGENT, 'inference', env.AGENT_HOUSE_DAILY_MILLS, { huntId: 'h0' });

    expect(budget.canInfer(AGENT, roomy, { id: 'h1', difficulty: 'hard' }, FLASH)).toMatchObject({
      ok: false,
      reason: 'house_daily_budget',
    });
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
    // Realistic contention. The agent tier is capped at 100 seats and only a
    // fraction of them chase any one hunt, so these are the counts that matter.
    for (const entrants of [1, 8, 40]) {
      expect(budget.viableFor('easy', entrants, FLASH), `flash/${entrants}`).toBe(true);
      expect(budget.viableFor('easy', entrants, PRO), `pro/${entrants}`).toBe(true);
    }
    // The expensive model on the cheapest tier is the first thing to become
    // unviable, and it does so at 72 — which is why it is the combination worth
    // watching if seats ever outgrow the cap.
    expect(budget.viableFor('easy', 100, FLASH)).toBe(true);
    expect(budget.viableFor('easy', 100, PRO)).toBe(false);
  });

  it('still refuses a hunt once contention makes thinking cost more than the share', () => {
    // The property that actually matters: an agent that enters anything is an
    // agent that loses money. The crossovers moved in by ~27x when the unit
    // error in CALL_MILLS was corrected — they were 4,000 and 10,000 while a
    // call was priced at 1 mill instead of 27.
    //
    // The expensive model still gives up first, which is the shape that should
    // survive any future re-pricing.
    expect(budget.viableFor('easy', 4_000, PRO)).toBe(false);
    expect(budget.viableFor('easy', 4_000, FLASH)).toBe(false);
    // The expensive model gives up first at every tier: on `hard` it stops at
    // ~600 entrants where flash runs to ~1,850.
    expect(budget.viableFor('hard', 700, FLASH)).toBe(true);
    expect(budget.viableFor('hard', 700, PRO)).toBe(false);
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
  it('still records both kinds in one ledger', () => {
    // Splitting the CEILINGS did not split the ledger. One question — what has
    // this agent cost, all in — is still answered from one place.
    budget.record(AGENT, 'hint', 5 * MILLS_PER_CENT, { huntId: 'h1', tradeRef: '0xabc' });
    budget.record(AGENT, 'inference', 12, { huntId: 'h1' });

    const since = Date.now() - 60_000;
    expect(agentRepo.spentSince(AGENT, since)).toBe(5 * MILLS_PER_CENT + 12);
  });

  it('shows the owner what THEY have spent, not what the house has', () => {
    // The kill-switch screen answers "how much of my money is left". Folding
    // house-funded thinking into that number would bill a player, on screen,
    // for compute they were told was included.
    budget.record(AGENT, 'hint', 5 * MILLS_PER_CENT, { huntId: 'h1' });
    budget.record(AGENT, 'inference', 12, { huntId: 'h1' });

    expect(budget.remainingToday(AGENT, config)).toBe(
      config.dailyBudgetCents * MILLS_PER_CENT - 5 * MILLS_PER_CENT,
    );
    expect(budget.houseRemainingToday(AGENT)).toBe(env.AGENT_HOUSE_DAILY_MILLS - 12);
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
