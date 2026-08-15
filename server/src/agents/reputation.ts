import { keccak256, toHex, type Hex } from 'viem';
import * as erc8004 from '../chain/erc8004';
import * as marketRepo from '../db/repos/market';
import { logger } from '../logger';
import * as metrics from '../metrics';

/**
 * Whether to trust a counterparty you have never met.
 *
 * ─────────────────────────── the question phase 9 asks ──────────────────────
 *
 * "Does trust scale past players who already know each other?" A hint market
 * with ten regulars needs no reputation system; one with ten thousand strangers
 * cannot work without one. ERC-8004 supplies the shared ledger — but a ledger
 * is not trust, and the gap between them is this file.
 *
 * ─────────────────────────── the attack, stated plainly ─────────────────────
 *
 * The registry blocks self-feedback by owner, so an agent cannot praise itself.
 * It does nothing about **two wallets praising each other**, which costs an
 * attacker one extra keypair. Any system that reads `getSummary` and acts on it
 * is trivially farmable, and a reputation number that can be manufactured is
 * worse than none: it launders a stranger into looking like a regular.
 *
 * The plan is explicit that this is not preventable, only expensive — *detect
 * and slash, not prevent*. So three things happen here, and none of them is a
 * ban:
 *
 *   1. **Only verified trades count.** Feedback is prepared only after the
 *      referee has seen a trade *settle on chain* between those two parties.
 *      No trade, no feedback — so reputation cannot be minted by talking.
 *   2. **Stake weights it.** A counterparty who paid five dollars counts far
 *      more than one who paid a cent, and each counterparty's contribution is
 *      capped. Manufacturing reputation therefore means moving real money
 *      through a market that takes a rake on every pass.
 *   3. **Concentration and reciprocity are discounted.** Volume that goes back
 *      and forth between the same pair is exactly what a wash looks like, and
 *      exactly what an honest trading relationship also looks like — so it is
 *      damped rather than punished, and surfaced rather than judged.
 *
 * ─────────────────────────── what this deliberately is not ──────────────────
 *
 * It is not a fraud detector and does not block anybody. It produces a number
 * that is expensive to inflate and a risk score a human can look at. Slashing
 * belongs to the Validation Registry and a stake, which is phase 10 territory.
 */

/** Raw registry score below which we would not trade, before any weighting. */
export const MIN_RAW = 0;

/**
 * Most one counterparty may contribute to effective stake, in cents.
 *
 * The cap is what makes a wash pair expensive: past this, more volume with the
 * same partner buys nothing. To look well-traded you need *many* partners, and
 * every one of them costs a fresh wallet, real balance, and rake.
 */
export const PER_COUNTERPARTY_CAP_CENTS = 200;

/** Distinct counterparties at which the diversity weight saturates. */
export const DIVERSITY_TARGET = 5;

export interface TrustReport {
  /** The registry's own number, 0–100. Zero when nobody has rated. */
  rawValue: number;
  /** How many ratings it is built from. */
  ratings: number;
  /** Trades the referee actually saw settle. The only ones that count here. */
  verifiedTrades: number;
  distinctCounterparties: number;
  /** Capped, summed trade value in cents. */
  effectiveStakeCents: number;
  /** 0–10000. How much of this agent's volume is round-tripping with one partner. */
  washRiskBps: number;
  /**
   * What to actually act on, 0–100.
   *
   * The registry's number, damped by everything above. An agent with a perfect
   * raw score, one counterparty and four cents of volume lands near zero — which
   * is the correct reading of "somebody said they were good once".
   */
  trust: number;
}

/**
 * Trades this agent settled, as buyer or seller.
 *
 * Only `delivered`: a trade the referee watched settle on chain and then handed
 * the hint over for. Quoted and abandoned trades are intentions, and intentions
 * are free.
 */
function verified(agentId: string) {
  return marketRepo
    .tradesOf(agentId, 500)
    .filter(t => t.status === 'delivered');
}

/**
 * Assemble the trust report for an agent.
 *
 * The registry read can fail — it is somebody else's contract on a network we
 * do not control — and a failure must not read as "untrusted". It reads as
 * "unrated", and the local evidence still stands on its own.
 */
export async function trustFor(agentId: string): Promise<TrustReport> {
  const trades = verified(agentId);

  const byCounterparty = new Map<string, { cents: number; asBuyer: number; asSeller: number }>();
  for (const trade of trades) {
    const other = trade.buyerId === agentId ? trade.sellerId : trade.buyerId;
    const entry = byCounterparty.get(other) ?? { cents: 0, asBuyer: 0, asSeller: 0 };
    entry.cents += trade.priceCents;
    if (trade.buyerId === agentId) entry.asBuyer += trade.priceCents;
    else entry.asSeller += trade.priceCents;
    byCounterparty.set(other, entry);
  }

  const effectiveStakeCents = [...byCounterparty.values()].reduce(
    (sum, e) => sum + Math.min(e.cents, PER_COUNTERPARTY_CAP_CENTS),
    0,
  );

  let rawValue = 0;
  let ratings = 0;
  const onChainId = agentIdOf(agentId);
  if (onChainId !== null && erc8004.enabled()) {
    try {
      const summary = await erc8004.readSummary(onChainId);
      if (summary) {
        rawValue = summary.value;
        ratings = summary.count;
      }
    } catch {
      // Unrated, not untrusted. A registry outage must not quietly blacklist
      // every agent in the market.
      metrics.reputationReadFailures.inc();
    }
  }

  // The pair signal and the ring signal, combined by taking the worse. They
  // catch different shapes and neither subsumes the other.
  const pairRisk = washRisk(byCounterparty);
  const ringRisk = ringSignal(closureBps(agentId, [...byCounterparty.keys()]), byCounterparty);
  const washRiskBps = Math.max(pairRisk, ringRisk);

  const trust = weight(rawValue, {
    verifiedTrades: trades.length,
    distinctCounterparties: byCounterparty.size,
    effectiveStakeCents,
    washRiskBps,
  });

  return {
    rawValue,
    ratings,
    verifiedTrades: trades.length,
    distinctCounterparties: byCounterparty.size,
    effectiveStakeCents,
    washRiskBps,
    trust,
  };
}

/**
 * How much of this agent's volume looks like a round trip.
 *
 * A wash pair trades both ways with each other: A sells to B, B sells back to A,
 * and both come out with reputation. The signal is volume that is bidirectional
 * *and* concentrated in one partner.
 *
 * Honest traders do this too — a regular counterparty you both buy from and sell
 * to is an ordinary relationship — which is exactly why this damps rather than
 * bans. The number is surfaced so a human can look; it is not a verdict.
 *
 * ─────────────────────────── this catches pairs, not rings ──────────────────
 *
 * Measured: a two-wallet wash scores 10000bps and lands at zero trust however
 * much volume it pushes. A *ring* of five wallets trading in a circle scored
 * 2000bps and reached 80 — because concentration is by definition low when the
 * volume is spread, and spreading it is the entire trick.
 *
 * {@link closureBps} is the second-order answer, and it is what actually
 * separates a ring from a market maker: ask whether your counterparties trade
 * with anybody outside your own circle. A ring is closed by construction; a
 * market maker's partners have partners.
 */
export function washRisk(
  byCounterparty: Map<string, { cents: number; asBuyer: number; asSeller: number }>,
): number {
  const total = [...byCounterparty.values()].reduce((sum, e) => sum + e.cents, 0);
  if (total === 0) return 0;

  let reciprocal = 0;
  let largest = 0;
  for (const entry of byCounterparty.values()) {
    // The two-way portion: whichever direction is smaller, doubled, is the
    // volume that came back.
    reciprocal += 2 * Math.min(entry.asBuyer, entry.asSeller);
    largest = Math.max(largest, entry.cents);
  }

  const reciprocalBps = Math.min(10_000, Math.round((reciprocal / total) * 10_000));
  const concentrationBps = Math.round((largest / total) * 10_000);

  // Both at once is the pair signature. Either alone is ordinary: a one-sided
  // relationship with a single partner is a new trader, and two-way volume
  // spread over many partners is a market maker.
  return Math.round((reciprocalBps * concentrationBps) / 10_000);
}

/**
 * How closed this agent's trading circle is, 0–10000.
 *
 * For every counterparty, what share of *their* volume stays inside our little
 * group? A ring of colluding wallets is closed by construction — they have
 * nobody else to trade with, because inventing more counterparties means
 * inventing more wallets. A genuine market maker's partners trade all over the
 * place.
 *
 * This is the signal that survives spreading, which is why it is separate from
 * {@link washRisk} rather than folded into it: concentration measures how the
 * volume sits, closure measures who the people are.
 */
export function closureBps(agentId: string, counterparties: string[]): number {
  if (counterparties.length === 0) return 0;

  const circle = new Set([agentId.toLowerCase(), ...counterparties.map(c => c.toLowerCase())]);
  let inside = 0;
  let total = 0;

  for (const other of counterparties) {
    for (const trade of marketRepo.tradesOf(other, 500)) {
      if (trade.status !== 'delivered') continue;
      const far = trade.buyerId === other ? trade.sellerId : trade.buyerId;
      total += trade.priceCents;
      if (circle.has(far.toLowerCase())) inside += trade.priceCents;
    }
  }

  return total === 0 ? 0 : Math.round((inside / total) * 10_000);
}

/**
 * Closure only means something when the circle is also trading with itself.
 *
 * A brand-new trader has one counterparty and therefore a closed-looking
 * circle, which is not suspicious — it is just new. Requiring reciprocity too
 * is what keeps this from flagging everybody's first trade.
 */
export function ringSignal(
  closure: number,
  byCounterparty: Map<string, { cents: number; asBuyer: number; asSeller: number }>,
): number {
  const total = [...byCounterparty.values()].reduce((sum, e) => sum + e.cents, 0);
  if (total === 0) return 0;

  const reciprocal = [...byCounterparty.values()].reduce(
    (sum, e) => sum + 2 * Math.min(e.asBuyer, e.asSeller),
    0,
  );
  const reciprocalBps = Math.min(10_000, Math.round((reciprocal / total) * 10_000));

  return Math.round((closure * reciprocalBps) / 10_000);
}

interface Evidence {
  verifiedTrades: number;
  distinctCounterparties: number;
  effectiveStakeCents: number;
  washRiskBps: number;
}

/**
 * Turn a registry number into something worth acting on.
 *
 * Multiplicative on purpose: a perfect score from one cheap counterparty should
 * not merely be reduced, it should be nearly worthless, because that is what it
 * is worth. Every factor is 0–1 and they compound.
 */
export function weight(rawValue: number, evidence: Evidence): number {
  if (evidence.verifiedTrades === 0) return 0;

  // Saturating rather than linear: the difference between one partner and five
  // is enormous, between fifty and sixty is nothing.
  const diversity = Math.min(1, evidence.distinctCounterparties / DIVERSITY_TARGET);
  const stake = Math.min(1, evidence.effectiveStakeCents / (PER_COUNTERPARTY_CAP_CENTS * DIVERSITY_TARGET));
  const clean = 1 - evidence.washRiskBps / 10_000;

  return Math.max(0, Math.round(rawValue * diversity * stake * clean));
}

/**
 * The registry's numeric id for one of our agents.
 *
 * Not stored yet: registration is the player's transaction and the id comes back
 * in its receipt, so until they have registered there is nothing to look up.
 * Returning null means "unregistered", which weights to zero without special
 * casing anywhere else.
 */
export function agentIdOf(agentId: string): bigint | null {
  const row = registrations.get(agentId.toLowerCase());
  return row ?? null;
}

/** agentAddress → ERC-8004 token id, learned when a player registers. */
const registrations = new Map<string, bigint>();

export function recordRegistration(agentAddress: string, onChainId: bigint): void {
  registrations.set(agentAddress.toLowerCase(), onChainId);
}

export function reset(): void {
  registrations.clear();
}

// ─────────────────────────── giving feedback ───────────────────────────

export interface FeedbackOffer {
  agentId: string;
  onChainId: string;
  value: number;
  tradeRef: string;
  call: ReturnType<typeof erc8004.feedbackCall>;
}

/**
 * Prepare the feedback a player may leave about a counterparty.
 *
 * Refuses unless the referee has actually seen a settled trade between the two.
 * That is the "count only verified trades" rule, enforced where it can be: not
 * by hoping people are honest, but by never handing anybody the transaction
 * unless the trade happened.
 *
 * The player sends it. Feedback signed by a house key would be the house rating
 * agents, which is a different and much weaker signal than a counterparty
 * rating the party they paid.
 */
export function feedbackOffer(
  raterId: string,
  subjectId: string,
  value: number,
  endpoint = '',
): FeedbackOffer | null {
  const onChainId = agentIdOf(subjectId);
  if (onChainId === null) return null;

  const trade = marketRepo
    .tradesOf(raterId, 200)
    .find(
      t =>
        t.status === 'delivered' &&
        (t.buyerId === subjectId || t.sellerId === subjectId) &&
        (t.buyerId === raterId || t.sellerId === raterId),
    );

  if (!trade) {
    // No settled trade between these two. Reputation that can be minted by
    // talking is not reputation.
    logger.info({ raterId, subjectId }, 'feedback refused — no verified trade');
    return null;
  }

  // Binds the rating to the trade it is about, so a rating can be checked
  // against the ledger afterwards rather than taken on trust.
  const feedbackHash = keccak256(toHex(`lootgrid:feedback:v1|${trade.tradeId}|${value}`));

  metrics.reputationFeedback.inc();
  return {
    agentId: subjectId,
    onChainId: String(onChainId),
    value,
    tradeRef: trade.tradeId,
    call: erc8004.feedbackCall(onChainId, value, endpoint, '', feedbackHash),
  };
}

/**
 * Whether an agent will trade with this counterparty.
 *
 * Applied before money moves, and deliberately lenient in one direction: an
 * agent nobody has rated is *unrated*, and a market that refuses everyone
 * unrated can never admit a newcomer. What it refuses is a counterparty whose
 * trust has been weighed and found wanting.
 */
export async function acceptable(counterparty: string, minTrust: number): Promise<boolean> {
  if (minTrust <= 0) return true;

  const report = await trustFor(counterparty);
  // Never traded and never rated: unknown, not bad. The stake and diversity
  // weights already make an unknown counterparty worth little to a cautious
  // agent, without making the market unenterable.
  if (report.ratings === 0 && report.verifiedTrades === 0) return true;

  const ok = report.trust >= minTrust;
  if (!ok) metrics.reputationRefusals.inc();
  return ok;
}
