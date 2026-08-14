import type { Address, Hex } from 'viem';
import * as attestor from '../chain/attestor';
import * as escrowRead from '../chain/hintEscrow';
import { OnChainStatus } from '../chain/hintEscrow';
import * as hintRepo from '../db/repos/hints';
import * as repo from '../db/repos/market';
import { env } from '../env';
import { badRequest, conflict, forbidden, notFound } from '../errors';
import * as hints from '../hints';
import type { Hint } from '../hints/types';
import { logger } from '../logger';
import * as metrics from '../metrics';
import { randomHex } from '../hash';
import { MAX_PRIZE_CENTS, prizeCentsFor, toTokenUnits } from '../prizes';
import * as store from '../store';
import type { Player } from '../types';
import { chargeFor, isTradeable, MIN_TRADE_CENTS, splitAccrual } from './fees';
import { hintHashOf, hintNonce } from './hash';
import { suggestAsk } from './pricing';

/**
 * The hint market: list, bid, settle.
 *
 * ─────────────────────────── what is being sold ───────────────────────────
 *
 * Not a hint — a *copy* of one. Delivery grants the buyer their own row in
 * `player_hints`; the seller keeps theirs. That is why a listing is never marked
 * sold, why prices decay with each copy, and why the whole thing is a market in
 * information rather than in goods. Architecture §5.
 *
 * ─────────────────────────── the order of operations ────────────────────────
 *
 *   1. seller lists a hint they hold
 *   2. buyer takes the ask, or bids and has it accepted
 *   3. the referee vouches for the hint and hands the buyer `fund` calldata
 *   4. the buyer escrows the money themselves — the server holds no float
 *   5. either party asks for a release; the referee signs one
 *   6. once the contract says *settled*, and not before, the hint is granted
 *
 * Step 6 is the load-bearing one. Deliver earlier and a buyer takes the hint,
 * sits on it until the trade expires, refunds, and has it for free. Settling
 * first means the information moves only after the money has.
 *
 * ─────────────────────────── what the referee will not do ───────────────────
 *
 * It never says whether a hint is true. It vouches that the game issued it, at
 * a stated tier drawn from a pool of stated reliability, and stops there.
 * Certifying accuracy would mean handing over the answer, and a market where
 * the outcome is known is not a market.
 */

/** Longest a seller may leave a bid standing. Short: hints decay fast. */
export const BID_TTL_MS = 10 * 60_000;

/** Nothing may be listed above the largest prize — no hint is worth more. */
export const MAX_ASK_CENTS = MAX_PRIZE_CENTS;

/**
 * Whether the market can operate at all.
 *
 * Needs both signers and the escrow address: one to say a hint is genuine, one
 * to release the money, and a contract to verify them against. Missing any of
 * them and the honest answer is that the feature is off — not that trades
 * silently accumulate in a database with no way to settle.
 */
export function enabled(): boolean {
  return env.HINT_MARKET_ENABLED && attestor.hintEnabled() && attestor.releaseEnabled();
}

function requireEnabled(): void {
  if (!enabled()) throw notFound('market_disabled');
}

// ─────────────────────────── listings ───────────────────────────

export interface ListingView {
  id: string;
  hintId: string;
  sellerId: string;
  zoneId: string;
  huntId: string;
  tier: number;
  reliabilityBps: number;
  askCents: number;
  expiresAt: number | null;
  /** Copies already delivered. The buyer's warning that this is not fresh. */
  sold: number;
  /** What the pricing model would ask, for comparison against the seller's ask. */
  suggestedCents: number;
  /** False when no price for this hunt's hints leaves a buyer better off. */
  rational: boolean;
  /**
   * The seller's weighted trust, 0–100, or null when reputation is off.
   *
   * Deliberately the weighted number rather than the registry's raw score:
   * showing a buyer a figure a wash farm can manufacture would be worse than
   * showing them nothing, because it looks like diligence.
   */
  sellerTrust?: number | null;
}

/**
 * A listing as anyone may see it.
 *
 * Note what is absent: `payload`. The browse path never joins to it, and this
 * type is the reason — a view model that cannot hold the hint cannot leak it,
 * however the query above it is later rewritten.
 */
function toView(l: repo.Listing, hint: Hint | null, sold: number): ListingView {
  const hunt = store.getHunt(l.huntId);
  const prize = hunt ? prizeCentsFor(hunt.difficulty) : 0;
  const suggestion = hint
    ? suggestAsk(hint, prize, sold)
    : { cents: l.askCents, rational: false, ceilingCents: 0, informationValue: 0 };

  return {
    id: l.id,
    hintId: l.hintId,
    sellerId: l.sellerId,
    zoneId: l.zoneId,
    huntId: l.huntId,
    tier: l.tier,
    reliabilityBps: l.reliabilityBps,
    askCents: l.askCents,
    expiresAt: l.expiresAt,
    sold,
    suggestedCents: suggestion.cents,
    rational: suggestion.rational,
  };
}

/** Offer a hint for sale. The seller keeps it either way. */
export function list(player: Player, hintId: string, askCents: number, now = Date.now()): ListingView {
  requireEnabled();

  const hint = hintRepo.get(hintId);
  if (!hint) throw notFound('no_such_hint');
  if (!hintRepo.holds(player.id, hintId)) throw forbidden('not_your_hint');

  const hunt = store.getHunt(hint.huntId);
  // A hint about a settled hunt is worthless, and selling one would be the
  // clearest possible way to poison a young market.
  if (!hunt || hunt.status !== 'live') throw conflict('hunt_not_live');
  if (hint.expiresAt !== null && hint.expiresAt <= now) throw conflict('hint_expired');

  if (!isTradeable(askCents)) {
    throw badRequest('ask_too_low', `minimum trade is ${MIN_TRADE_CENTS}c`);
  }
  if (askCents > MAX_ASK_CENTS) throw badRequest('ask_too_high');

  const listing = repo.putListing(
    {
      id: `lst_${randomHex(8)}`,
      hintId,
      sellerId: player.id,
      zoneId: hint.zoneId,
      huntId: hint.huntId,
      tier: hint.tier,
      reliabilityBps: hint.reliabilityBps,
      askCents,
      expiresAt: hunt.expiresAt,
    },
    now,
  );

  metrics.marketListings.inc({ tier: String(hint.tier) });
  return toView(listing, hints.toPublic(hint), repo.deliveredCount(hintId));
}

export function cancel(player: Player, listingId: string, now = Date.now()): void {
  const listing = repo.getListing(listingId);
  if (!listing) throw notFound('no_such_listing');
  if (listing.sellerId !== player.id) throw forbidden('not_your_listing');
  if (!repo.cancelListing(listingId, player.id, now)) throw conflict('listing_not_open');
}

export function browse(zoneId: string | null, limit = 50, now = Date.now()): ListingView[] {
  return repo.openListings(zoneId, limit, now).map(l => {
    const hint = hintRepo.get(l.hintId);
    return toView(l, hint ? hints.toPublic(hint) : null, repo.deliveredCount(l.hintId));
  });
}

export function myListings(player: Player): ListingView[] {
  return repo
    .listingsOfSeller(player.id)
    .map(l => {
      const hint = hintRepo.get(l.hintId);
      return toView(l, hint ? hints.toPublic(hint) : null, repo.deliveredCount(l.hintId));
    });
}

// ─────────────────────────── bids ───────────────────────────

export function bid(
  player: Player,
  listingId: string,
  priceCents: number,
  now = Date.now(),
): repo.Bid {
  requireEnabled();

  const listing = openListingOr404(listingId, now);
  if (listing.sellerId === player.id) throw forbidden('own_listing');
  if (!isTradeable(priceCents)) throw badRequest('bid_too_low');
  // At or above the ask there is nothing to negotiate — take it instead. Letting
  // it through would create a bid the seller must accept to get a worse price
  // than simply waiting.
  if (priceCents >= listing.askCents) throw badRequest('bid_at_or_above_ask');

  const b = repo.putBid(
    {
      id: `bid_${randomHex(8)}`,
      listingId,
      bidderId: player.id,
      priceCents,
      expiresAt: now + BID_TTL_MS,
    },
    now,
  );
  metrics.marketBids.inc();
  return b;
}

export function withdrawBid(player: Player, bidId: string, now = Date.now()): void {
  const b = repo.getBid(bidId);
  if (!b) throw notFound('no_such_bid');
  if (b.bidderId !== player.id) throw forbidden('not_your_bid');
  if (!repo.setBidStatus(bidId, 'open', 'withdrawn', now)) throw conflict('bid_not_open');
}

export function bidsFor(player: Player, listingId: string, now = Date.now()): repo.Bid[] {
  const listing = repo.getListing(listingId);
  if (!listing) throw notFound('no_such_listing');
  // Only the seller sees the book for their own listing. Published bids would
  // let a rival read another agent's valuation of a hint for free, which is
  // information they did not pay for.
  if (listing.sellerId !== player.id) throw forbidden('not_your_listing');
  return repo.bidsFor(listingId, 50, now);
}

/**
 * Accept a bid, producing a quote for the bidder.
 *
 * The seller's acceptance does not move money — it authorises the *bidder* to
 * fund at that price. A bidder who has changed their mind simply never funds,
 * and the quote expires.
 */
export async function acceptBid(player: Player, bidId: string, now = Date.now()): Promise<Quote> {
  requireEnabled();

  const b = repo.getBid(bidId);
  if (!b) throw notFound('no_such_bid');
  if (b.expiresAt <= now) throw conflict('bid_expired');

  const listing = openListingOr404(b.listingId, now);
  if (listing.sellerId !== player.id) throw forbidden('not_your_listing');

  const buyer = store.getPlayer(b.bidderId);
  if (!buyer) throw conflict('no_such_bidder');

  if (!repo.setBidStatus(bidId, 'open', 'accepted', now)) throw conflict('bid_not_open');
  return quote(buyer, listing, b.priceCents, now);
}

function openListingOr404(listingId: string, now: number): repo.Listing {
  const listing = repo.getListing(listingId);
  if (!listing) throw notFound('no_such_listing');
  if (listing.status !== 'open') throw conflict('listing_not_open');
  if (listing.expiresAt !== null && listing.expiresAt <= now) throw conflict('listing_expired');
  return listing;
}

// ─────────────────────────── quoting and funding ───────────────────────────

export interface Quote {
  tradeId: string;
  /** bytes32 the contract knows this trade by. */
  onChainId: Hex;
  listingId: string;
  sellerId: string;
  priceCents: number;
  /** Token base units, as a decimal string — never a JS number. */
  amount: string;
  expiresAt: number;
  vouch: attestor.HintAttestation;
  /**
   * Allowance for exactly this trade, to be sent first.
   *
   * A buyer who already has a sufficient allowance can skip it — but a `fund`
   * that reverts for want of one looks to a player like a broken market, so it
   * is always offered rather than inferred.
   */
  approval: attestor.SubmitCall;
  /** Ready for `eth_sendTransaction`. The buyer signs and sends it themselves. */
  call: attestor.SubmitCall;
}

/** Take a listing at its asking price. */
export async function buy(player: Player, listingId: string, now = Date.now()): Promise<Quote> {
  requireEnabled();
  const listing = openListingOr404(listingId, now);
  return quote(player, listing, listing.askCents, now);
}

/**
 * Everything the buyer needs to escrow payment, and nothing they could act on
 * without doing so.
 *
 * The vouch is issued here rather than at listing time because it carries a
 * short deadline: an attestation is a bearer token, and one minted when a
 * listing was created would still be valid days later.
 */
async function quote(
  buyer: Player,
  listing: repo.Listing,
  priceCents: number,
  now: number,
): Promise<Quote> {
  if (listing.sellerId === buyer.id) throw forbidden('own_listing');
  if (!isTradeable(priceCents)) throw badRequest('price_too_low');

  const hint = hintRepo.get(listing.hintId);
  if (!hint) throw notFound('no_such_hint');
  // Paying for something you already hold is a mistake the market should catch,
  // not a trade. Grants are idempotent, so it would take the money and change
  // nothing.
  if (hintRepo.holds(buyer.id, listing.hintId)) throw conflict('already_held');

  const hunt = store.getHunt(listing.huntId);
  if (!hunt || hunt.status !== 'live') throw conflict('hunt_not_live');

  // The trade cannot outlive the thing it is about: a hint delivered after its
  // hunt resolves is worth nothing, and the buyer would have no recourse but the
  // refund path.
  const expiresAt = Math.min(now + env.HINT_TRADE_TTL_SEC * 1000, hunt.expiresAt ?? Infinity);
  if (expiresAt <= now + 60_000) throw conflict('hunt_ending');

  const outstanding = repo.liveTradeFor(listing.id, buyer.id);
  if (outstanding && outstanding.status === 'funded') throw conflict('trade_already_funded');
  // Reused only at the same price. A quote is a promise about an amount, and
  // handing back an old trade id after a bid was accepted lower would quote one
  // number while the escrow expects another.
  const existing = outstanding?.priceCents === priceCents ? outstanding : null;

  const nonce = hintNonce(hunt.salt, hint.id);
  const hintHash = hintHashOf(hints.toPublic(hint), nonce);

  const amount = toTokenUnits(priceCents, env.HINT_TOKEN_DECIMALS);
  const charge = chargeFor(priceCents);

  // A quote that was never funded is reissued rather than duplicated: the buyer
  // may simply have closed their wallet. A second row would be a second trade id
  // and a second chance to fund the same purchase twice.
  const trade =
    existing ??
    (() => {
      const id = `trd_${randomHex(8)}`;
      return repo.insertTrade(
        {
          id,
          // Derived from the row id, so the two can never drift apart and leave
          // money escrowed under a bytes32 nothing here recognises.
          tradeId: attestor.toBytes32Id(id),
          listingId: listing.id,
          hintId: listing.hintId,
          zoneId: listing.zoneId,
          hintHash,
          buyerId: buyer.id,
          sellerId: listing.sellerId,
          priceCents,
          amount: amount.toString(),
          rakeMills: charge.chargedMills,
          rakeWaived: charge.chargedMills === 0,
          expiresAt,
        },
        now,
      );
    })();

  const vouch = await attestor.signHint(
    trade.hintHash as Hex,
    attestor.toBytes32Id(listing.zoneId),
    hint.tier,
    hint.reliabilityBps,
    now,
  );

  return {
    tradeId: trade.id,
    onChainId: trade.tradeId as Hex,
    listingId: listing.id,
    sellerId: trade.sellerId,
    priceCents: trade.priceCents,
    amount: trade.amount,
    expiresAt: trade.expiresAt,
    vouch,
    approval: escrowRead.approvalCall(BigInt(trade.amount)),
    call: attestor.fundCall(
      trade.tradeId as Hex,
      trade.sellerId as Address,
      BigInt(trade.amount),
      Math.floor(trade.expiresAt / 1000),
      vouch,
    ),
  };
}

// ─────────────────────────── settlement ───────────────────────────

export interface TradeView {
  id: string;
  onChainId: string;
  listingId: string;
  hintId: string;
  buyerId: string;
  sellerId: string;
  priceCents: number;
  amount: string;
  status: repo.TradeStatus;
  expiresAt: number;
  /** Present once the contract holds the money and the trade is releasable. */
  release?: attestor.ReleaseAttestation;
  /** Present to the buyer once, and only once, the trade has settled on chain. */
  delivered?: {
    hint: Hint;
    /** The blinding factor, so the buyer can recompute the vouched hash. */
    nonce: Hex;
    hintHash: Hex;
  };
  /** Set when the chain disagrees with what was quoted. Nothing is released. */
  mismatch?: string;
}

/**
 * Bring a trade up to date with the chain, and act on what it says.
 *
 * This is the only place a hint is granted by purchase, and it is deliberately
 * driven by a poll rather than by an event subscription: the question is about
 * one trade the caller already knows the id of, and a missed log must never be
 * the reason a paid-for hint is not delivered.
 *
 * Safe to call repeatedly and concurrently — every state change is a conditional
 * update from an exactly-named previous state, so a second caller changes
 * nothing and the ledger is bumped once.
 */
export async function sync(player: Player, tradeId: string, now = Date.now()): Promise<TradeView> {
  requireEnabled();

  const trade = repo.getTrade(tradeId);
  if (!trade) throw notFound('no_such_trade');
  if (trade.buyerId !== player.id && trade.sellerId !== player.id) throw forbidden('not_your_trade');

  if (trade.status === 'delivered') return withDelivery(trade, player);
  // `abandoned` is deliberately NOT terminal here. A buyer who funded a quote
  // late — after the server gave up on it — still has money on chain, and
  // refusing to look would leave them waiting for a refund with no explanation.
  if (trade.status === 'refunded') return view(trade);

  const chain = await escrowRead.readTrade(trade.tradeId as Hex);

  switch (chain.status) {
    case OnChainStatus.None: {
      // Never funded. Once the quote's own window has passed there is nothing to
      // wait for — the buyer would have to start again at a fresh price anyway.
      if (now > trade.expiresAt) {
        repo.advanceTrade(trade.id, 'quoted', 'abandoned', now);
        metrics.marketTrades.inc({ result: 'abandoned' });
        return view(repo.getTrade(trade.id)!);
      }
      return view(trade);
    }

    case OnChainStatus.Funded: {
      const mismatch = checkFunding(trade, chain);
      if (mismatch) {
        // The chain holds money under this id that does not match the quote —
        // wrong seller, wrong amount, wrong hint. Releasing it would pay for
        // something nobody agreed to; the buyer's refund still works.
        logger.warn({ tradeId: trade.id, mismatch }, 'funded trade does not match its quote');
        metrics.marketTrades.inc({ result: 'mismatch' });
        return { ...view(trade), mismatch };
      }

      if (advanceFrom(trade.id, UNFUNDED, 'funded', now)) {
        repo.stampFunded(trade.id, now);
        metrics.marketTrades.inc({ result: 'funded' });
      }

      // Past expiry the contract will refuse a release anyway, and signing one
      // would only invite a transaction that reverts.
      if (now >= trade.expiresAt) return view(repo.getTrade(trade.id)!);

      const release = await attestor.signRelease(
        trade.tradeId as Hex,
        chain.hintHash,
        trade.buyerId as Address,
        now,
      );
      return { ...view(repo.getTrade(trade.id)!), release };
    }

    case OnChainStatus.Settled: {
      repo.stampSettled(trade.id, now);
      deliver(trade, now);
      return withDelivery(repo.getTrade(trade.id)!, player);
    }

    case OnChainStatus.Refunded: {
      if (advanceFrom(trade.id, ['funded', ...UNFUNDED], 'refunded', now)) {
        metrics.marketTrades.inc({ result: 'refunded' });
      }
      return view(repo.getTrade(trade.id)!);
    }
  }
}

/**
 * States a trade can be in before the contract has taken the money.
 *
 * `abandoned` is one of them because the server gives up on a quote at its
 * expiry while the buyer's wallet does not — a transaction sent just before the
 * deadline can land just after it, and that money is still theirs.
 */
const UNFUNDED: repo.TradeStatus[] = ['quoted', 'abandoned'];

/** First matching transition wins; the rest are no-ops. Idempotent by design. */
function advanceFrom(
  id: string,
  from: repo.TradeStatus[],
  to: repo.TradeStatus,
  now: number,
): boolean {
  return from.some(status => repo.advanceTrade(id, status, to, now));
}

/**
 * What the chain holds must be what the buyer was quoted, field for field.
 *
 * `hintHash` is the one that matters most: without it a buyer could fund a
 * trade id against a vouch for some other, sharper hint and have the referee
 * release it. The rest catch a mis-sent transaction rather than an attack.
 */
function checkFunding(trade: repo.Trade, chain: escrowRead.OnChainTrade): string | null {
  const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
  if (!same(chain.hintHash, trade.hintHash)) return 'hint';
  if (!same(chain.buyer, trade.buyerId)) return 'buyer';
  if (!same(chain.seller, trade.sellerId)) return 'seller';
  if (chain.amount.toString() !== trade.amount) return 'amount';
  return null;
}

/**
 * Hand the hint over and book the rake. Runs exactly once per trade.
 *
 * The grant and the state change are both idempotent, and the ledger is bumped
 * only when this call is the one that moved the trade — otherwise two pollers
 * arriving together would each charge the same rake.
 */
function deliver(trade: repo.Trade, now: number): void {
  // From `quoted` too: a buyer whose funding and release both land between two
  // polls never passes through `funded` as far as this server is concerned.
  if (!advanceFrom(trade.id, ['funded', ...UNFUNDED], 'delivered', now)) return;

  hintRepo.grant(trade.buyerId, trade.hintId, 'trade', now);
  repo.stampDelivered(trade.id, now);
  bookRake(trade, now);

  metrics.marketTrades.inc({ result: 'delivered' });
  metrics.marketTradePriceCents.observe(trade.priceCents);
}

/**
 * Add a settled trade to the zone's rake ledger.
 *
 * `accrued_mills` carries the fraction of a cent that has not yet been reported
 * as collected. Discarding it would quietly tax every small trade at 100% —
 * across a busy market that is real money going nowhere. See fees.ts.
 */
function bookRake(trade: repo.Trade, now: number): void {
  const previous = repo.rakeFor(trade.zoneId);
  const carried = previous?.accruedMills ?? 0;
  const split = splitAccrual(carried + trade.rakeMills);

  repo.bumpRake(
    trade.zoneId,
    {
      tradedCents: trade.priceCents,
      // Stored as the carried remainder, not a running total: the total is
      // collected_cents × 1000 + this.
      accruedMills: split.remainderMills - carried,
      // Recomputed rather than read off the trade: `rake_mills` holds what was
      // actually charged, which is zero under the waiver — so the cost of the
      // waiver would otherwise be invisible in exactly the case it matters.
      waivedMills: chargeFor(trade.priceCents).waivedMills,
      collectedCents: split.settleCents,
    },
    now,
  );

  const row = repo.rakeFor(trade.zoneId);
  if (row && row.tradedCents > 0) {
    metrics.marketRealisedRakeBps.set(
      { zone: trade.zoneId },
      Math.round((row.collectedCents / row.tradedCents) * 10_000),
    );
  }
}

function view(t: repo.Trade): TradeView {
  return {
    id: t.id,
    onChainId: t.tradeId,
    listingId: t.listingId,
    hintId: t.hintId,
    buyerId: t.buyerId,
    sellerId: t.sellerId,
    priceCents: t.priceCents,
    amount: t.amount,
    status: t.status,
    expiresAt: t.expiresAt,
  };
}

/**
 * A delivered trade, with the hint attached for the buyer.
 *
 * The seller sees the same trade without it — they already hold the hint, and
 * echoing it back would put a payload on a path that does not need one.
 */
function withDelivery(trade: repo.Trade, player: Player): TradeView {
  const base = view(trade);
  if (trade.buyerId !== player.id) return base;

  const hint = hintRepo.get(trade.hintId);
  const hunt = store.getHunt(hint?.huntId ?? '');
  if (!hint || !hunt) return base;

  const nonce = hintNonce(hunt.salt, hint.id);
  const publicHint = hints.toPublic(hint);
  const hintHash = hintHashOf(publicHint, nonce);

  // The same check the buyer is about to run, against the hash recorded when
  // they were quoted. If the hint has changed under them since, they hear it
  // from us rather than discovering it themselves.
  if (hintHash.toLowerCase() !== trade.hintHash.toLowerCase()) {
    logger.error({ tradeId: trade.id }, 'delivered hint does not match its vouch');
    return { ...base, mismatch: 'hint_hash' };
  }

  return { ...base, delivered: { hint: publicHint, nonce, hintHash } };
}

export function myTrades(player: Player): TradeView[] {
  return repo.tradesOf(player.id).map(view);
}

/** Rake as it actually landed, per zone. Surfaced by the market stats endpoint. */
export function rakeStats() {
  return repo.allRake().map(r => ({
    ...r,
    // A realised rate stuck near zero means the market is all dust — which is
    // the thing worth knowing about a fee at this scale.
    realisedBps: r.tradedCents > 0 ? Math.round((r.collectedCents / r.tradedCents) * 10_000) : 0,
  }));
}
