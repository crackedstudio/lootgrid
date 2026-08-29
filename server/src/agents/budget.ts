import * as agentRepo from '../db/repos/agents';
import { env } from '../env';
import { MILLS_PER_CENT } from '../market/fees';
import { prizeCentsFor } from '../prizes';
import type { AgentConfig } from './config';
import type { Difficulty } from '../types';

/**
 * What an agent is allowed to spend, and the arithmetic behind the numbers.
 *
 * ─────────────────────────── two kinds of money ───────────────────────────
 *
 * An agent spends on hints (which moves a player's funds) and on inference
 * (which the house pays and meters back). Both are metered here, in mills —
 * thousandths of a cent — because at this scale a whole hunt's thinking costs
 * about a quarter of one cent and cents cannot express that.
 *
 * ─────────────────────────── the pricing, measured ──────────────────────────
 *
 * Architecture §7 assumed ~$0.005 per call and ~200 calls per hunt, and asked
 * for both to be re-checked before the prize range was fixed. They were, against
 * DeepSeek's published pricing in August 2026, and both were wrong by more than
 * an order of magnitude — in opposite directions from what you might guess.
 *
 *   deepseek-v4-flash   input $0.14/1M (cache miss), output $0.28/1M
 *   deepseek-v4-pro     input $0.435/1M,             output $0.87/1M
 *
 * A turn in these games is a small prompt: the rules, the history so far, and a
 * request for one structured move. Call it 1,500 input and 200 output tokens.
 *
 *   flash   1500 × 0.14/1M + 200 × 0.28/1M  =  $0.000266
 *   pro     1500 × 0.435/1M + 200 × 0.87/1M =  $0.000827
 *
 * ─────────────────────────── a unit error, corrected ────────────────────────
 *
 * This block previously read "~0.27 mills per call on flash" and priced a call
 * at 1 mill. That converted **dollars as if they were cents**: a mill is a
 * thousandth of a CENT ({@link MILLS_PER_CENT} = 1000), so $0.000266 is 0.0266
 * cents — **26.6 mills**, not 0.27. The house was under-billing itself 27x on
 * flash and 41x on pro.
 *
 * It mattered in two places beyond the ledger. `viableFor` puts inference on the
 * cost side of EV, which is the right place, but with a cost 27x too low — so
 * agents entered hunts that were genuinely negative-EV believing they were
 * ahead. And under house-funded tokens it is the difference between a seat that
 * is profitable and one that is quietly subsidised.
 *
 * The call count is still bounded by the game modules themselves — deduction
 * allows at most ⌈log₂ cells⌉ probes plus a commit, search five, negotiation
 * five — so a hunt is about thirteen calls, not two hundred. Roughly 350 mills
 * of thinking per hunt on flash, against the ~$1 the architecture feared. Still
 * two orders of magnitude cheaper than the fear; simply not four.
 *
 * ─────────────────────────── but the prizes fell too ────────────────────────
 *
 * §7's 8%-of-a-$12-prize was computed against a prize band this game no longer
 * has. Prizes are $0.01–$5.00 (prizes.ts), so the ratio that matters is:
 *
 * At the corrected prices and the current band (prizes.ts), a hunt's worth of
 * thinking is:
 *
 *   hard  $5.00   ~350 mills   0.07% of the prize
 *   med   $1.20   ~350 mills   0.29%
 *   easy  $0.60   ~350 mills   0.58%
 *
 * Comfortable at every tier — but that is a statement about ONE entrant. The
 * house pays per entrant with no divisor, so {@link viableFor} protects the
 * agent's EV and not ours. See docs/AGENTS_BYO.md §1.3.
 */

/**
 * Mills per inference call, by model. Rounded up from the arithmetic above.
 *
 * Deliberately a fixed estimate rather than a per-response token count. The
 * budget has to be checked BEFORE the call — a looping agent must not be able to
 * bill past its cap and be told afterwards — and you cannot know a call's cost
 * before making it. Overestimating slightly is the safe direction.
 */
export const CALL_MILLS: Record<string, number> = {
  'deepseek-v4-flash': 27,
  'deepseek-v4-pro': 83,
};

/** Anything unrecognised is priced as the expensive model. Fail expensive, not cheap. */
export const DEFAULT_CALL_MILLS = 83;

export function callCostMills(model: string): number {
  return CALL_MILLS[model] ?? DEFAULT_CALL_MILLS;
}

/**
 * Share of a prize that may be spent on thinking about it.
 *
 * Ten per cent is generous against measured costs — a med hunt's ceiling is 5,000
 * mills against ~10 mills of actual usage — and it is not there to be a binding
 * constraint. It is there so that if a model starts looping, or pricing changes
 * by two orders of magnitude, the loss is bounded by something proportional to
 * what was at stake.
 */
export const INFERENCE_SHARE_OF_PRIZE = 0.1;

export interface Decision {
  ok: boolean;
  /** Machine-readable, for metrics and for the client. Never prose. */
  reason?:
    | 'daily_budget'
    | 'house_daily_budget'
    | 'hint_price'
    | 'inference_budget'
    | 'inference_unaffordable'
    | 'reliability'
    | 'zone_not_allowed'
    | 'agent_not_active';
  /** What remains, in mills, after this decision. For the UI. */
  remainingMills?: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

const ok = (remainingMills?: number): Decision => ({ ok: true, remainingMills });
const no = (reason: NonNullable<Decision['reason']>, remainingMills?: number): Decision => ({
  ok: false,
  reason,
  remainingMills,
});

/**
 * Whether an agent may buy this hint, at this price, right now.
 *
 * Checked before any transaction is built. The vault enforces its own caps on
 * chain and is the real authority; this exists so a doomed trade never becomes a
 * transaction that reverts and costs gas to learn nothing.
 */
export function canBuyHint(
  agentId: string,
  config: AgentConfig,
  hint: { priceCents: number; reliabilityBps: number; zoneId: string },
  now = Date.now(),
): Decision {
  if (hint.priceCents > config.maxHintPriceCents) return no('hint_price');
  if (hint.reliabilityBps < config.minReliabilityBps) return no('reliability');
  // An empty zone list means no zones, not all zones. A config that defaulted
  // to "everywhere" would be an agent trading somewhere its owner never chose.
  if (!config.zones.includes(hint.zoneId)) return no('zone_not_allowed');

  // Hints only. The owner's budget is the owner's money, and since the house
  // began funding inference (`seats.ts`) the two are no longer one deposit —
  // counting thinking against this ceiling would charge a player for our costs.
  const spentToday = agentRepo.spentSince(agentId, now - DAY_MS, 'hint');
  const limit = config.dailyBudgetCents * MILLS_PER_CENT;
  const cost = hint.priceCents * MILLS_PER_CENT;

  if (spentToday + cost > limit) return no('daily_budget', Math.max(0, limit - spentToday));
  return ok(limit - spentToday - cost);
}

/**
 * Whether an agent may make another inference call for this hunt.
 *
 * **Checked before the call, never after.** That ordering is the whole control:
 * an agent stuck in a loop must be refused its next call rather than billed for
 * it and told later. It is also why cost is estimated from the model rather than
 * measured from the response.
 */
export function canInfer(
  agentId: string,
  config: AgentConfig,
  hunt: { id: string; difficulty: Difficulty },
  model: string,
  now = Date.now(),
): Decision {
  const cost = callCostMills(model);
  const spentOnHunt = agentRepo.spentOnHunt(agentId, hunt.id, 'inference');

  // The tighter of what the player allowed and what the prize can justify. A
  // player who sets a generous inference budget should still not spend more
  // thinking about a hunt than the hunt is worth.
  const perHuntCap = Math.min(config.inferenceMillsPerHunt, prizeCeilingMills(hunt.difficulty));
  if (spentOnHunt + cost > perHuntCap) {
    return no('inference_budget', Math.max(0, perHuntCap - spentOnHunt));
  }

  // ─────────────────────────── the house's ceiling, not the player's ────────
  //
  // This used to read `config.dailyBudgetCents`, which meant a player raising
  // their hint budget silently authorised more of OUR spending on thinking
  // (AGENTS_BYO §7.5(4)). Inference is house money now, so it is bounded by a
  // house number and counted against house spend alone.
  //
  // Still not the exposure bound: the seat is the prepaid total and
  // `runtime.ts` draws it down per call. This is the rate limit that stops one
  // looping agent finishing a seat in an afternoon.
  const houseToday = agentRepo.spentSince(agentId, now - DAY_MS, 'inference');
  const houseLimit = env.AGENT_HOUSE_DAILY_MILLS;
  if (houseToday + cost > houseLimit) {
    return no('house_daily_budget', Math.max(0, houseLimit - houseToday));
  }

  return ok(perHuntCap - spentOnHunt - cost);
}

/** Inference a prize can justify, in mills. See {@link INFERENCE_SHARE_OF_PRIZE}. */
export function prizeCeilingMills(difficulty: Difficulty): number {
  return Math.floor(prizeCentsFor(difficulty) * MILLS_PER_CENT * INFERENCE_SHARE_OF_PRIZE);
}

/**
 * Whether a hunt is worth an agent's time at all, before any hint is bought.
 *
 * The uncomfortable arithmetic from architecture §1, with inference on the cost
 * side where it belongs:
 *
 *     EV  =  prize / entrants  −  inference
 *
 * On the easy tier that is negative at three entrants on the cheap model and at
 * two on the expensive one, so an agent that enters is paying to lose. A rational
 * one refuses, which means the house should not be drawing those hunts on agent
 * zones in the first place — see `prizes.ts`.
 */
export function viableFor(
  difficulty: Difficulty,
  entrants: number,
  model: string,
  callsPerHunt = 10,
): boolean {
  const share = (prizeCentsFor(difficulty) * MILLS_PER_CENT) / Math.max(1, entrants);
  return share > callCostMills(model) * callsPerHunt;
}

/** Record a spend. Both kinds land in one ledger — see the migration. */
export function record(
  agentId: string,
  kind: agentRepo.SpendKind,
  amountMills: number,
  opts: { huntId?: string | null; tradeRef?: string | null } = {},
  now = Date.now(),
): void {
  agentRepo.addSpend(agentId, kind, amountMills, opts, now);
}

/**
 * What an agent has left of its OWNER's budget today, in mills.
 *
 * Hints only, because this is the number on the owner's kill-switch screen and
 * it should answer "how much of my money is left", not "how much of my money
 * plus some of the house's compute". The combined figure is still available
 * from `agentRepo.spentSince` without a kind, and the ledger still shows both.
 */
export function remainingToday(agentId: string, config: AgentConfig, now = Date.now()): number {
  const spent = agentRepo.spentSince(agentId, now - DAY_MS, 'hint');
  return Math.max(0, config.dailyBudgetCents * MILLS_PER_CENT - spent);
}

/** What the house will still fund for this agent today, in mills. */
export function houseRemainingToday(agentId: string, now = Date.now()): number {
  const spent = agentRepo.spentSince(agentId, now - DAY_MS, 'inference');
  return Math.max(0, env.AGENT_HOUSE_DAILY_MILLS - spent);
}
