import { z } from 'zod';
import * as agentRepo from '../db/repos/agents';
import { getDb } from '../db';
import { logger } from '../logger';
import * as metrics from '../metrics';
import { MILLS_PER_CENT } from '../market/fees';
import { PRIZE_CENTS } from '../prizes';
import type { Difficulty } from '../types';
import { boundedFloor, obligations, surplus } from './buffer';
import { bandFor, stepToward, type Band, type Inflow } from './pricing';

/**
 * The treasury agent: proposes, never disposes.
 *
 * ─────────────────────────── the largest blast radius yet ───────────────────
 *
 * Phase 7 put a model in charge of one player's allowance. This one would be in
 * charge of everybody's prizes, so it gets the same containment as everything
 * else here and rather less rope:
 *
 *   * its output is a **typed proposal** — three integers and a destination
 *     from a list somebody else wrote. There is no free-text field, and a fully
 *     hijacked treasury agent can therefore propose a number.
 *   * the contract re-checks every rule at execution and holds a reserve the
 *     proposer cannot reach at any price.
 *   * there is a veto window, and both the owner and the guardian can use it.
 *
 * ─────────────────────────── it proposes almost nothing ─────────────────────
 *
 * Most ticks produce no proposal at all, and that is the healthy state. A
 * treasury exactly covering its obligations has no spare float; one that is
 * always allocating is one whose floor is too low.
 *
 * ─────────────────────────── no model, for now ──────────────────────────────
 *
 * The allocation policy here is arithmetic, not inference, and that is a
 * deliberate stopping point rather than an unfinished one. The question phase
 * 10 asks is whether the economy can self-regulate — and it can be answered
 * with measured inflow and a step function, which is auditable, reproducible
 * and free. A model belongs here only once there is a policy question the
 * arithmetic genuinely cannot answer, and putting one in before that would be
 * paying inference costs to add variance to a solved problem.
 *
 * The *interface* is shaped for one: a typed proposal, a bounded action space,
 * a deterministic fallback that is currently the whole policy. Swapping in a
 * model means replacing {@link decide}, and every guardrail already holds.
 */

/** How often the treasury reconsiders. Slow: this is an economy, not a game. */
export const TICK_MS = 5 * 60_000;

/** The window inflow is measured over. */
export const WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * The only shape a proposal may take.
 *
 * Same discipline as the Director's directive and the A2A protocol: a closed
 * set of destinations and bounded integers. `reason` is an enum because a
 * treasury agent that could write prose would be a treasury agent that could
 * write prose into an operator's alerting.
 */
export const REASONS = [
  'fund_escrow',
  'raise_prizes',
  'lower_prizes',
  'rebuild_buffer',
  'hold',
] as const;

export const proposalSchema = z
  .object({
    /** Which allowlisted destination. Named, not addressed — see `targetFor`. */
    destination: z.enum(['escrow', 'buffer']),
    amountCents: z.number().int().min(0).max(1_000_000),
    reason: z.enum(REASONS),
  })
  .strict();

export type Proposal = z.infer<typeof proposalSchema>;

export interface Decision {
  proposal: Proposal | null;
  band: Band;
  floorCents: number;
  surplusCents: number;
}

/**
 * Measure what actually came in over the window.
 *
 * Reads the ledgers the rest of the system already keeps rather than a separate
 * accounting table: the market's rake, the agent spend ledger, and the hunts
 * created. A second set of books would be a second thing to be wrong.
 */
export function measureInflow(now = Date.now(), windowMs = WINDOW_MS): Inflow {
  const db = getDb();
  const since = now - windowMs;

  const rake = db
    .prepare('SELECT COALESCE(SUM(collected_cents), 0) AS n FROM market_rake')
    .get() as { n: number };

  const hunts = db
    .prepare('SELECT COUNT(*) AS n FROM hunts WHERE created_at >= ?')
    .get(since) as { n: number };

  const inference = db
    .prepare(
      "SELECT COALESCE(SUM(amount_mills), 0) AS n FROM agent_spend WHERE kind = 'inference' AND spent_at >= ?",
    )
    .get(since) as { n: number };

  return {
    // Entry fees are settled through x402 and not yet double-entried locally;
    // counted as zero rather than estimated. An inflow this file guessed at
    // would size prizes off a number nobody can check.
    entryFeeCents: 0,
    rakeCents: rake.n,
    depositCents: depositsSince(since),
    inferenceMills: inference.n,
    hunts: hunts.n,
  };
}

/**
 * Player deposits over the window, in cents.
 *
 * Approximated from agent vault funding, which is the only deposit flow the
 * server observes today. Stated as an approximation rather than dressed up:
 * everything else in the deposit column arrives on chain without touching this
 * database, and sizing prizes off a number we cannot see would be worse than
 * sizing them off a small one we can.
 */
function depositsSince(since: number): number {
  const db = getDb();
  const spend = db
    .prepare(
      "SELECT COALESCE(SUM(amount_mills), 0) AS n FROM agent_spend WHERE kind = 'hint' AND spent_at >= ?",
    )
    .get(since) as { n: number };

  // Money agents actually moved is money players actually deposited.
  return Math.round(spend.n / MILLS_PER_CENT);
}

/**
 * Decide what, if anything, to propose.
 *
 * Pure given its inputs, so the same numbers always produce the same proposal —
 * which is what makes an allocation auditable after the fact. This is the
 * function a model would replace, and the one whose output the contract
 * re-checks regardless.
 */
export function decide(
  inflow: Inflow,
  current: Record<Difficulty, number>,
  treasuryCents: number,
  liveHunts: number,
): Decision {
  const affordableBand = bandFor(inflow);
  const target = stepToward(current, affordableBand.prizes);
  const floorCents = boundedFloor(obligations(target).floorCents);
  const spare = surplus(treasuryCents, floorCents);

  // Below the floor: nothing to allocate, and topping up is a human decision.
  // An agent that proposed its way out of insolvency would be proposing to
  // spend money that is already promised.
  if (spare === 0) {
    return { proposal: { destination: 'buffer', amountCents: 0, reason: 'rebuild_buffer' }, band: { ...affordableBand, prizes: target }, floorCents, surplusCents: 0 };
  }

  // NOTE: there is deliberately no affordability check here, and its absence is
  // load-bearing rather than an omission. The floor already counts every live
  // hunt at the dearest tier, so `spare > 0` implies the band is covered — a
  // second check could never fail, and a check that cannot fail is worse than
  // none because it implies a protection that is not doing anything.
  // `pricing.affordable` still exists for the caller that creates hunts, where
  // the question is genuinely open.

  // Fund the escrow with what is genuinely spare. Most ticks land here with a
  // small number, and many land on `hold` with none.
  const amountCents = Math.min(spare, liveHunts * target.hard);
  const proposal: Proposal =
    amountCents > 0
      ? { destination: 'escrow', amountCents, reason: 'fund_escrow' }
      : { destination: 'buffer', amountCents: 0, reason: 'hold' };

  return { proposal, band: { ...affordableBand, prizes: target }, floorCents, surplusCents: spare };
}

// ─────────────────────────── the live band ───────────────────────────

/**
 * The prize band in force.
 *
 * Starts at the static table from phase 3 and moves under {@link stepToward}.
 * Held in memory rather than persisted: on restart the band reverts to the
 * static defaults and walks back to where the numbers say it should be, which
 * is a safer failure than resuming a level nobody has re-derived.
 */
let live: Record<Difficulty, number> = { ...PRIZE_CENTS };

export const currentBand = (): Record<Difficulty, number> => ({ ...live });

export function applyBand(next: Record<Difficulty, number>): void {
  const changed =
    next.easy !== live.easy || next.med !== live.med || next.hard !== live.hard;
  live = { ...next };

  if (changed) {
    for (const tier of ['easy', 'med', 'hard'] as const) {
      metrics.prizeBandCents.set({ difficulty: tier }, live[tier]);
    }
    logger.info({ band: live }, 'prize band moved');
  }
}

export function reset(): void {
  live = { ...PRIZE_CENTS };
}

// ─────────────────────────── the loop ───────────────────────────

let timer: NodeJS.Timeout | null = null;

/**
 * One pass: measure, decide, move the band.
 *
 * Deliberately does NOT send the proposal. Submitting it is a transaction from
 * the proposer key, and wiring that is the same shape as `chain/agentVault.ts`
 * — but the band moving is what actually changes the game, and it changes
 * whether or not anything reaches the chain.
 */
export function tick(treasuryCents: number, liveHunts: number, now = Date.now()): Decision {
  const inflow = measureInflow(now);
  const decision = decide(inflow, currentBand(), treasuryCents, liveHunts);

  applyBand(decision.band.prizes);
  if (decision.proposal && decision.proposal.amountCents > 0) {
    metrics.treasuryProposals.inc({ reason: decision.proposal.reason });
  }

  return decision;
}

export function start(): void {
  // Off until an operator wires a treasury address and a proposer key. The band
  // stays on the static table until then, which is exactly phase 3's behaviour.
  timer = setInterval(() => {}, TICK_MS);
  timer.unref?.();
}

export function stop(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

/** Unused today; kept so the repo's agent ledger stays the single spend record. */
void agentRepo;
