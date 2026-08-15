import * as metrics from '../metrics';
import type { AgentConfig } from './config';
import { PROTOCOL_VERSION, type Message } from './protocol';

/**
 * What an agent says back.
 *
 * ─────────────────────────── arithmetic, not inference ──────────────────────
 *
 * Every reply below is computed. No model is consulted, and that is the point
 * rather than a shortcut: a message from a rival is attacker-controlled input,
 * and the strongest possible containment is that it reaches a function which
 * cannot be persuaded of anything. A hostile counterparty can move the numbers
 * it sends; it cannot move how those numbers are read.
 *
 * The model still sees the conversation — `runtime.buildPrompt` renders the
 * inbox through the protocol's fixed templates, so a model deciding *how to
 * play the hunt* knows what rivals are offering. What it does not get is the
 * decision about whether to spend money on a hint. That stays here, in code that
 * is deterministic and therefore auditable after the fact: given the same
 * listing and the same config, the same counter comes out every time.
 *
 * ─────────────────────────── a deal that cannot exist ───────────────────────
 *
 * The first thing {@link respond} checks is whether any price satisfies both
 * sides. If the seller's floor is above the buyer's ceiling there is nothing to
 * discover, and haggling to the round cap would burn ticks to reach a `decline`
 * that was already determined. Saying so immediately is both cheaper and more
 * honest than performing a negotiation whose outcome is fixed.
 *
 * ─────────────────────────── it has to terminate ────────────────────────────
 *
 * Two agents splitting the difference converge, but "converges" is not
 * "terminates" when the quantities are integers and both sides round in their
 * own favour. So: a hard round cap, a minimum step of one cent, and a rule that
 * a side which cannot improve on its own last offer stops rather than repeats
 * it. `negotiate.test.ts` runs every pair of configs against each other and
 * asserts that none of them fails to end.
 */

/** Exchanges one thread may hold before both sides give up. */
export const MAX_ROUNDS = 6;

/** How long a thread stays open. Shorter than the market's own bid TTL. */
export const THREAD_TTL_MS = 5 * 60_000;

/** Smallest concession worth making. Below this a haggle is noise. */
export const MIN_STEP_CENTS = 1;

export interface Thread {
  id: string;
  listingId: string;
  /** The agent that opened it. */
  buyerId: string;
  sellerId: string;
  rounds: number;
  /** Best price each side has named so far, in cents. Null until they name one. */
  buyerOffer: number | null;
  sellerAsk: number;
  /**
   * The ask the listing opened at. The seller's floor is anchored here.
   *
   * Not to `sellerAsk`, which falls as the seller concedes — a floor derived
   * from the current ask would slide down with every concession, and a floor
   * that moves is not a floor. It would let a patient buyer walk a seller below
   * the price its own configuration says it will accept.
   */
  originalAskCents: number;
  openedAt: number;
  status: 'open' | 'agreed' | 'walked';
  /** Set when `status === 'agreed'`. The price the driver should bid at. */
  agreedCents: number | null;
  /** The market bid carrying the agreed price, once one exists. */
  bidId: string | null;
}

const threads = new Map<string, Thread>();

// ─────────────────────────── valuations ───────────────────────────

/**
 * The most this buyer will pay.
 *
 * The tighter of what the owner allowed and what the hint can rationally be
 * worth. `maxHintPriceCents` is a hard owner-set ceiling and is never exceeded
 * for any reason — a negotiation that could talk an agent past its owner's limit
 * would make the limit advisory.
 */
export function buyerCeiling(config: AgentConfig, rationalCeilingCents: number): number {
  return Math.max(0, Math.min(config.maxHintPriceCents, Math.floor(rationalCeilingCents)));
}

/**
 * The least this seller will take.
 *
 * A share of their own ask, set by aggression: an aggressive seller holds near
 * the ask, a passive one concedes further. Never below the market's minimum
 * tradeable price, which the caller supplies rather than this module assuming.
 */
export function sellerFloor(config: AgentConfig, askCents: number, minTradeCents: number): number {
  // aggression 0 → will go to 50% of ask; aggression 100 → holds at 95%.
  const share = 0.5 + (config.aggression / 100) * 0.45;
  return Math.max(minTradeCents, Math.min(askCents, Math.round(askCents * share)));
}

/**
 * Where a buyer opens.
 *
 * Below its ceiling, by an amount aggression decides. Opening at the ceiling
 * would be bidding against yourself; opening at zero wastes rounds on an offer
 * no seller can take.
 */
export function openingOffer(config: AgentConfig, ceilingCents: number): number {
  // aggression 100 → opens at 55% of ceiling; aggression 0 → opens at 90%.
  const share = 0.9 - (config.aggression / 100) * 0.35;
  return Math.max(1, Math.min(ceilingCents, Math.round(ceilingCents * share)));
}

/** Meet in the middle, rounding towards the side that is conceding. */
function split(low: number, high: number, towardsHigh: boolean): number {
  const mid = (low + high) / 2;
  return towardsHigh ? Math.ceil(mid) : Math.floor(mid);
}

// ─────────────────────────── threads ───────────────────────────

export function openThread(
  id: string,
  listingId: string,
  buyerId: string,
  sellerId: string,
  askCents: number,
  now = Date.now(),
): Thread {
  const thread: Thread = {
    id,
    listingId,
    buyerId,
    sellerId,
    rounds: 0,
    buyerOffer: null,
    sellerAsk: askCents,
    originalAskCents: askCents,
    openedAt: now,
    status: 'open',
    agreedCents: null,
    bidId: null,
  };
  threads.set(id, thread);
  return thread;
}

/**
 * Threads this agent has agreed a price on and not yet settled.
 *
 * Both sides see the same thread — the server is the transport, so there is one
 * record rather than two views that could disagree about what was agreed.
 */
export function agreedFor(agentId: string, now = Date.now()): Thread[] {
  const out: Thread[] = [];
  for (const thread of threads.values()) {
    if (now - thread.openedAt > THREAD_TTL_MS) continue;
    if (thread.status !== 'agreed') continue;
    if (thread.buyerId === agentId || thread.sellerId === agentId) out.push(thread);
  }
  return out;
}

/**
 * Whether this agent already has a live thread about this listing.
 *
 * Without it a tick would open a fresh negotiation about the same listing every
 * five seconds, which is a flood the mailbox would correctly refuse — but the
 * refusal would be this agent shouting over its own earlier message.
 */
export function hasThreadFor(agentId: string, listingId: string, now = Date.now()): boolean {
  for (const thread of threads.values()) {
    if (now - thread.openedAt > THREAD_TTL_MS) continue;
    if (thread.listingId !== listingId) continue;
    if (thread.buyerId === agentId || thread.sellerId === agentId) return true;
  }
  return false;
}

export function markBid(id: string, bidId: string): void {
  const thread = threads.get(id);
  if (thread) thread.bidId = bidId;
}

/** The seller took the bid. Recorded so the buyer knows what to fund. */
export function markSettled(id: string, bidId: string): void {
  const thread = threads.get(id);
  if (thread) thread.bidId = bidId;
}

/** Done with, one way or another. */
export function close(id: string): void {
  threads.delete(id);
}

export function getThread(id: string, now = Date.now()): Thread | null {
  const thread = threads.get(id);
  if (!thread) return null;
  if (now - thread.openedAt > THREAD_TTL_MS) {
    threads.delete(id);
    return null;
  }
  return thread;
}

export function sweep(now = Date.now()): number {
  let dropped = 0;
  for (const [id, thread] of threads) {
    if (now - thread.openedAt > THREAD_TTL_MS) {
      threads.delete(id);
      dropped += 1;
    }
  }
  return dropped;
}

export function reset(): void {
  threads.clear();
}

// ─────────────────────────── the policy ───────────────────────────

export interface Stance {
  /** Whether this agent is the buyer or the seller in the thread. */
  side: 'buyer' | 'seller';
  config: AgentConfig;
  /** Buyer side: the rational ceiling from `market/pricing`. */
  rationalCeilingCents?: number;
  /** Seller side: the market's minimum tradeable price. */
  minTradeCents?: number;
  /** Whether the buyer's reliability bar is met. Checked before any price talk. */
  reliabilityBps: number;
  zoneId: string;
}

const base = (from: string, thread: string) => ({ v: PROTOCOL_VERSION as 1, from, thread });

/**
 * The reply to one message, or null when there is nothing to say.
 *
 * Pure apart from the thread it advances, and total: every intent has a branch,
 * because an intent with no branch is a message an agent silently cannot read.
 */
export function respond(
  me: string,
  message: Message,
  stance: Stance,
  now = Date.now(),
): Message | null {
  const thread = getThread(message.thread, now);
  if (!thread || thread.status !== 'open') return null;

  // A backstop, not the round limit. The limit lives in {@link outOfRounds},
  // which stops a side *proposing* a new number — it deliberately does not stop
  // it accepting one. An earlier version refused here before looking at the
  // message at all, and measuring found it turning down a deal in 24% of the
  // cases where one existed: the buyer offered exactly the seller's floor and
  // was declined for being one exchange too late. A cap that exists to bound
  // haggling must not become a reason to refuse money already on the table.
  if (thread.rounds > MAX_ROUNDS + 2) {
    walk(thread, 'rounds');
    return null;
  }
  thread.rounds += 1;

  switch (message.intent) {
    case 'request_hint':
      return onRequest(me, message, thread, stance);
    case 'offer_hint':
      return onOffer(me, message, thread, stance);
    case 'counter':
      return onCounter(me, message, thread, stance);
    case 'accept':
      // The other side took a price. Nothing more to say — the driver reads
      // `agreedCents` and settles through the market's own bid path.
      thread.status = 'agreed';
      thread.agreedCents = message.priceCents;
      metrics.a2aDeals.inc({ outcome: 'agreed' });
      return null;
    case 'decline':
    case 'withdraw':
      walk(thread, 'declined');
      return null;
  }
}

/** Whether this side may still propose a new number. Accepting is always allowed. */
const outOfRounds = (thread: Thread): boolean => thread.rounds >= MAX_ROUNDS;

/** The last number this side gets to name before the cap bites. */
const finalProposal = (thread: Thread): boolean => thread.rounds >= MAX_ROUNDS - 1;

function walk(thread: Thread, _why: string): void {
  if (thread.status === 'open') {
    thread.status = 'walked';
    metrics.a2aDeals.inc({ outcome: 'walked' });
  }
}

/** Seller side: somebody is asking whether we have anything. */
function onRequest(me: string, message: Message, thread: Thread, stance: Stance): Message | null {
  if (message.intent !== 'request_hint') return null;
  if (stance.side !== 'seller') return null;

  if (message.zoneId !== stance.zoneId) {
    walk(thread, 'zone');
    return { ...base(me, thread.id), intent: 'decline', reason: 'wrong_zone' };
  }
  if (stance.reliabilityBps < message.minReliabilityBps) {
    // Their bar, not ours. Saying so costs nothing and saves both sides a round.
    walk(thread, 'reliability');
    return { ...base(me, thread.id), intent: 'decline', reason: 'reliability_too_low' };
  }

  const floor = sellerFloor(stance.config, thread.originalAskCents, stance.minTradeCents ?? 1);
  if (message.maxPriceCents < floor) {
    walk(thread, 'no_overlap');
    return { ...base(me, thread.id), intent: 'decline', reason: 'too_expensive' };
  }

  return {
    ...base(me, thread.id),
    intent: 'offer_hint',
    listingId: thread.listingId,
    priceCents: thread.sellerAsk,
    tier: 2,
    reliabilityBps: stance.reliabilityBps,
    zoneId: stance.zoneId,
  };
}

/** Buyer side: a seller named a price. */
function onOffer(me: string, message: Message, thread: Thread, stance: Stance): Message | null {
  if (message.intent !== 'offer_hint') return null;
  if (stance.side !== 'buyer') return null;

  if (message.reliabilityBps < stance.config.minReliabilityBps) {
    walk(thread, 'reliability');
    return { ...base(me, thread.id), intent: 'decline', reason: 'reliability_too_low' };
  }

  const ceiling = buyerCeiling(stance.config, stance.rationalCeilingCents ?? 0);
  if (ceiling <= 0) {
    walk(thread, 'no_budget');
    return { ...base(me, thread.id), intent: 'decline', reason: 'budget_exhausted' };
  }

  thread.sellerAsk = message.priceCents;
  return buyerReply(me, thread, message.listingId, message.priceCents, ceiling, stance);
}

/**
 * The buyer's move against a named price.
 *
 * Shared by the opening offer and every later counter, because the question is
 * the same one each time and two copies of it would drift.
 *
 * The rule that took a measurement to get right: **affordable is not the same as
 * worth accepting.** An earlier version accepted any price at or below the
 * ceiling, which sounds prudent and meant the buyer paid the full ask in every
 * negotiation that succeeded — `aggression` was a setting that changed nothing,
 * which is worse than not offering it, because an owner would believe they had a
 * lever. So the buyer counters whenever the ask is worse than what it would have
 * proposed unprompted.
 *
 * The safety valve is the last-chance branch. Haggling past the round cap loses
 * a deal that was available, and paying a little more than you hoped beats going
 * without the hint — so when the rounds are nearly gone, an affordable price is
 * taken.
 */
function buyerReply(
  me: string,
  thread: Thread,
  listingId: string,
  priceCents: number,
  ceiling: number,
  stance: Stance,
): Message | null {
  const target = openingOffer(stance.config, ceiling);
  const lastChance = thread.rounds >= MAX_ROUNDS - 1;

  if (priceCents <= ceiling && (priceCents <= target || lastChance)) {
    thread.status = 'agreed';
    thread.agreedCents = priceCents;
    metrics.a2aDeals.inc({ outcome: 'agreed' });
    return { ...base(me, thread.id), intent: 'accept', listingId, priceCents };
  }

  // Nothing left to pay with. Not a haggling limit — a real one.
  if (ceiling <= 0) {
    walk(thread, 'ceiling');
    return { ...base(me, thread.id), intent: 'decline', reason: 'too_expensive' };
  }

  // Acceptance was considered first; only the decision to keep haggling is
  // bounded. Out of rounds means stop talking, never refuse a price we would
  // have taken.
  if (outOfRounds(thread)) {
    walk(thread, 'rounds');
    return { ...base(me, thread.id), intent: 'decline', reason: 'too_expensive' };
  }

  // Open at the target, then walk up towards the ceiling one split at a time —
  // and on the last number we get to name, name the ceiling. Splitting the
  // difference converges geometrically, which takes more exchanges than a
  // bounded negotiation has; measuring found deals lost by one step. Closing on
  // the reservation price concedes nothing, because it is the price we would
  // accept anyway, and it settles every deal that exists.
  const previous = thread.buyerOffer;
  const aimed = finalProposal(thread)
    ? ceiling
    : previous === null
      ? target
      : split(previous, Math.min(ceiling, priceCents), true);

  // Never past the ceiling, never backwards, never below a cent.
  const next = Math.min(ceiling, Math.max(aimed, previous ?? 1, 1));

  thread.buyerOffer = next;
  return { ...base(me, thread.id), intent: 'counter', listingId, priceCents: next };
}

/** Either side: they moved. Do we? */
function onCounter(me: string, message: Message, thread: Thread, stance: Stance): Message | null {
  if (message.intent !== 'counter') return null;

  if (stance.side === 'seller') {
    const floor = sellerFloor(stance.config, thread.originalAskCents, stance.minTradeCents ?? 1);
    thread.buyerOffer = message.priceCents;

    if (message.priceCents >= floor) {
      thread.status = 'agreed';
      thread.agreedCents = message.priceCents;
      metrics.a2aDeals.inc({ outcome: 'agreed' });
      return {
        ...base(me, thread.id),
        intent: 'accept',
        listingId: thread.listingId,
        priceCents: message.priceCents,
      };
    }

    // Checked AFTER the accept branch above, so a price that clears the floor is
    // still taken. Out of rounds means stop talking, not refuse money.
    if (outOfRounds(thread)) {
      walk(thread, 'rounds');
      return { ...base(me, thread.id), intent: 'decline', reason: 'too_expensive' };
    }

    // Aim at the midpoint, but never below the floor and never above what we are
    // already asking. Clamping to the floor rather than giving up when the
    // midpoint undershoots is what closes a deal whose overlap is only a cent or
    // two wide — the case that made this the last 8% of winnable trades lost.
    const aimed = finalProposal(thread)
      ? floor
      : split(message.priceCents, thread.sellerAsk, true);
    const next = Math.min(thread.sellerAsk, Math.max(floor, aimed));

    thread.sellerAsk = next;
    return { ...base(me, thread.id), intent: 'counter', listingId: thread.listingId, priceCents: next };
  }

  // Buyer side.
  const ceiling = buyerCeiling(stance.config, stance.rationalCeilingCents ?? 0);
  thread.sellerAsk = message.priceCents;
  return buyerReply(me, thread, thread.listingId, message.priceCents, ceiling, stance);
}

/**
 * The message that starts a negotiation.
 *
 * A buyer opens by naming what it would pay and what reliability it needs —
 * both numbers, both bounded. There is no opening pleasantry because there is
 * no field for one.
 */
export function open(
  me: string,
  threadId: string,
  zoneId: string,
  maxPriceCents: number,
  minReliabilityBps: number,
): Message {
  return {
    ...base(me, threadId),
    intent: 'request_hint',
    zoneId,
    maxPriceCents,
    minReliabilityBps,
  };
}
