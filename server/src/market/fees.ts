/**
 * The rake on hint trades, and the arithmetic that makes one possible at all.
 *
 * ─────────────────────────── what the rake is for ───────────────────────────
 *
 * It meters player deposits; it does not fund prizes. In a closed economy where
 * the only inflow is prizes, fee revenue is bounded above by prizes minus
 * inference — so funding prizes from trading fees is a perpetual motion machine.
 * See docs/AGENTIC_ARCHITECTURE.md §1.
 *
 * ─────────────────────────── the dust problem is real ───────────────────────
 *
 * Prizes sit between $0.01 and $5, so hints will trade for cents. A 2.5% rake on
 * a 1c trade is 0.025c — unrepresentable in cents, and far below the gas to move
 * it. Rounding it up to 1c would be a 100% tax; rounding down to 0 collects
 * nothing forever.
 *
 * So the rake accrues in **mills** (1/1000 of a cent) and settles only once a
 * seller's balance crosses a whole cent. Fractions are kept, not discarded, and
 * nothing is transferred until it is worth transferring. This is the "accrue
 * off-chain, settle in batches" the plan calls for, and doing it from day one
 * matters: retrofitting it after agents have optimised around a per-trade fee is
 * much harder.
 *
 * ─────────────────────────── circumvention ───────────────────────────
 *
 * Rational agents will batch, pool, or trade off-platform to dodge a rake. The
 * defence is not a bigger fee or a smaller one — it is that the referee's
 * attestation of a hint's authenticity exists ONLY on-platform. Off-platform, a
 * buyer has no proof the hint is real and is straight back in the lemon market.
 * The rake is the price of verification and escrow, so it has to stay clearly
 * below the cost of doing without them.
 */

/** 2.5%. Low enough to be worth paying for escrow and attestation. */
export const RAKE_BPS = 250;

export const MILLS_PER_CENT = 1_000;

/**
 * Below this a trade is refused outright.
 *
 * Not about the rake — about the parties. A trade worth less than the attention
 * it costs to make is noise in the order book, and on agent zones it is a cheap
 * way to spam a rival's decision loop.
 */
export const MIN_TRADE_CENTS = 1;

/**
 * Accrued rake is only moved once it crosses a whole cent. Below that the
 * transfer would cost more than it collects.
 */
export const SETTLE_THRESHOLD_MILLS = MILLS_PER_CENT;

/**
 * Trades below this pay no rake at all.
 *
 * The fee waiver from architecture §5, and it is about liquidity rather than
 * generosity: at 5¢ the rake is a tenth of a cent, which is worth less than the
 * gas to move and less than the thought a seller spends deciding whether it is
 * worth listing at all. Taxing the bottom of the book thins the book.
 *
 * **Must match `HintEscrow.rakeWaiverAmount`**, converted to the settlement
 * token's decimals. The contract is what actually waives; this constant only
 * predicts it, and a disagreement shows up as a ledger that never reconciles.
 */
export const RAKE_WAIVER_CENTS = 5;

/** Rake on a trade, in mills. Exact — no rounding, nothing discarded. */
export function rakeMillsFor(priceCents: number): number {
  if (!Number.isInteger(priceCents) || priceCents < 0) {
    throw new Error(`price must be a non-negative whole number of cents, got ${priceCents}`);
  }
  // priceCents * 1000 mills * bps / 10000 — integer throughout.
  return Math.floor((priceCents * MILLS_PER_CENT * RAKE_BPS) / 10_000);
}

export interface Charge {
  /** Rake actually taken, in mills. Zero under the waiver. */
  chargedMills: number;
  /** Rake the waiver gave back. Zero above it. */
  waivedMills: number;
}

/**
 * What a trade of this size actually pays, after the waiver.
 *
 * Both halves are returned rather than just the charge, so "what did the waiver
 * cost us" stays an answerable question instead of an invisible one.
 */
export function chargeFor(priceCents: number): Charge {
  const full = rakeMillsFor(priceCents);
  return priceCents < RAKE_WAIVER_CENTS
    ? { chargedMills: 0, waivedMills: full }
    : { chargedMills: full, waivedMills: 0 };
}

/** What the seller is owed, in mills, before any accrual is settled. */
export function sellerMillsFor(priceCents: number): number {
  return priceCents * MILLS_PER_CENT - rakeMillsFor(priceCents);
}

export function isTradeable(priceCents: number): boolean {
  return Number.isInteger(priceCents) && priceCents >= MIN_TRADE_CENTS;
}

export interface Accrual {
  /** Whole cents to move now. */
  settleCents: number;
  /** Fraction carried forward. Always less than a cent. */
  remainderMills: number;
}

/**
 * Split an accrued balance into what settles now and what carries.
 *
 * The carried remainder is the whole point: discarding it would quietly tax
 * every small trade at 100%, and over a busy market that is real money going
 * nowhere.
 */
export function splitAccrual(balanceMills: number): Accrual {
  if (balanceMills < SETTLE_THRESHOLD_MILLS) {
    return { settleCents: 0, remainderMills: balanceMills };
  }
  return {
    settleCents: Math.floor(balanceMills / MILLS_PER_CENT),
    remainderMills: balanceMills % MILLS_PER_CENT,
  };
}

/**
 * Effective rake actually taken across a run of trades, in basis points.
 *
 * Worth watching rather than assuming: with accrual the realised rate converges
 * on {@link RAKE_BPS}, but a market of only sub-threshold trades collects
 * nothing until it does. A realised rate stuck near zero means the market is
 * all dust.
 */
export function realisedRakeBps(totalPriceCents: number, collectedCents: number): number {
  if (totalPriceCents <= 0) return 0;
  return Math.round((collectedCents / totalPriceCents) * 10_000);
}
