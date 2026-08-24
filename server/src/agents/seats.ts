import { getDb } from '../db';
import { env } from '../env';
import { logger } from '../logger';
import { MILLS_PER_CENT } from '../market/fees';

/**
 * Funded seats — the house's inference, bought by the player who uses it.
 *
 * ─────────────────────────── the one rule ───────────────────────────
 *
 * **A seat buys compute. It never buys entry.**
 *
 * AGENT_TIER.md §2 is unambiguous about why: charging for something a player
 * needs in order to compete for a cash prize is an entry fee with extra steps,
 * which is the gambling definition in many jurisdictions. `payments/x402.ts`
 * carries the same warning about `ENTRY_FEES_ENABLED`.
 *
 * So {@link hasCredit} gates ONE thing — whether the house will pay a provider
 * on this agent's behalf. It gates no hunt, no entry, no key and no prize. An
 * unseated agent enters the same hunts, races the same opponents and wins the
 * same money; it plays `validate.fallbackMove` instead of a model's move, and
 * those fallbacks were deliberately written to be competent rather than
 * placeholders precisely so this remains true.
 *
 * If you ever find yourself adding a seat check to an entry path, that is the
 * change that turns this product into a different legal category.
 *
 * ─────────────────────────── the cap is a budget, not a queue ───────────────
 *
 * {@link SEAT_CAP} is how many agents the house is willing to fund at once. It
 * is not how many may play — that is unbounded, because the free path is
 * unbounded. Selling the 101st seat would mean promising inference the budget
 * cannot buy, so the sale is refused rather than the play.
 */

/** How many funded seats the house will carry at once. AGENT_TIER.md §1. */
export const SEAT_CAP = Number(env.AGENT_SEAT_CAP ?? 100);

/** What a seat costs, in cents. */
export const SEAT_PRICE_CENTS = Number(env.AGENT_SEAT_PRICE_CENTS ?? 100);

/**
 * Inference mills a seat buys.
 *
 * Priced against a CAP rather than against usage (AGENT_TIER.md §5.1): the
 * player buys a known quantity of thinking, and the house's exposure is that
 * quantity times the seat count — a number it can check against a budget before
 * anyone is charged. Usage-based pricing would make the bill a discovery.
 *
 * At ~350 mills of thinking per hunt on flash, 50_000 mills is roughly 140
 * hunts' worth.
 */
export const MILLS_PER_SEAT = Number(env.AGENT_SEAT_MILLS ?? 50_000);

export interface Seat {
  agentId: string;
  playerId: string;
  millsGranted: number;
  millsSpent: number;
  paidCents: number;
  createdAt: number;
}

interface Row {
  agent_id: string;
  player_id: string;
  mills_granted: number;
  mills_spent: number;
  paid_cents: number;
  created_at: number;
}

const toSeat = (r: Row): Seat => ({
  agentId: r.agent_id,
  playerId: r.player_id,
  millsGranted: r.mills_granted,
  millsSpent: r.mills_spent,
  paidCents: r.paid_cents,
  createdAt: r.created_at,
});

/** Seats with credit left. The cap counts these, never seats ever sold. */
export function occupied(): number {
  const row = getDb()
    .prepare(`SELECT COUNT(*) AS n FROM agent_seats WHERE mills_spent < mills_granted`)
    .get() as { n: number };
  return row.n;
}

export function seatsLeft(): number {
  return Math.max(0, SEAT_CAP - occupied());
}

export function get(agentId: string): Seat | null {
  const row = getDb()
    .prepare(`SELECT * FROM agent_seats WHERE agent_id = ?`)
    .get(agentId) as Row | undefined;
  return row ? toSeat(row) : null;
}

/** Inference mills this agent has left. Zero for an unseated agent. */
export function creditOf(agentId: string): number {
  const seat = get(agentId);
  return seat ? Math.max(0, seat.millsGranted - seat.millsSpent) : 0;
}

/**
 * Whether the house will pay for this agent's next thought.
 *
 * The ONLY thing a seat gates. Callers must fall back to a deterministic move
 * when this is false — never skip the turn, and never refuse the hunt.
 */
export function hasCredit(agentId: string, mills = 1): boolean {
  return creditOf(agentId) >= mills;
}

/**
 * Credit a paid seat.
 *
 * `txRef` is UNIQUE in the schema, so a replayed settlement envelope raises
 * rather than double-crediting. The client hands back the envelope we gave it,
 * which makes every field in it attacker-controlled by the time it returns.
 */
export function grant(
  agentId: string,
  playerId: string,
  opts: { mills?: number; paidCents?: number; txRef?: string | null } = {},
  now = Date.now(),
): Seat {
  const mills = opts.mills ?? MILLS_PER_SEAT;
  const paid = opts.paidCents ?? SEAT_PRICE_CENTS;

  getDb()
    .prepare(
      `INSERT INTO agent_seats
         (agent_id, player_id, mills_granted, mills_spent, paid_cents, tx_ref, created_at, updated_at)
       VALUES (?, ?, ?, 0, ?, ?, ?, ?)
       ON CONFLICT (agent_id) DO UPDATE SET
         -- Topping up an existing seat adds credit rather than resetting it, so
         -- a player who buys twice keeps what they already paid for.
         mills_granted = mills_granted + excluded.mills_granted,
         paid_cents    = paid_cents + excluded.paid_cents,
         tx_ref        = excluded.tx_ref,
         updated_at    = excluded.updated_at`,
    )
    .run(agentId, playerId, mills, paid, opts.txRef ?? null, now, now);

  logger.info({ agentId, mills, paidCents: paid }, 'agent seat funded');
  return get(agentId)!;
}

/**
 * Consume credit for a call the house paid for.
 *
 * Returns whether it could. A false must produce a fallback move, never a
 * skipped turn — see the header.
 */
export function consume(agentId: string, mills: number, now = Date.now()): boolean {
  if (mills <= 0) return true;
  const res = getDb()
    .prepare(
      `UPDATE agent_seats
          SET mills_spent = mills_spent + ?, updated_at = ?
        WHERE agent_id = ?
          -- Guarded in SQL rather than read-then-write: two turns settling at
          -- once must not both see the same remaining credit and both spend it.
          AND mills_granted - mills_spent >= ?`,
    )
    .run(mills, now, agentId, mills);
  return res.changes > 0;
}

/** What the UI shows before a player pays. */
export function offer(agentId: string) {
  return {
    priceCents: SEAT_PRICE_CENTS,
    mills: MILLS_PER_SEAT,
    seatsLeft: seatsLeft(),
    cap: SEAT_CAP,
    credit: creditOf(agentId),
    /**
     * Stated in the payload, not merely in the docs. A client that renders this
     * cannot honestly describe the purchase as buying access.
     */
    buys: 'inference the house pays for on your behalf',
    doesNotBuy: 'entry, keys, retries, or any advantage in winning',
    freeAlternative:
      'Play without a seat: your agent enters the same hunts for the same prizes, ' +
      'using its deterministic strategy instead of a model.',
  };
}

/** Mills → cents, for display. */
export const millsToCents = (mills: number): number => mills / MILLS_PER_CENT;
