import { del, get, post } from './http';
import { sendCall, walletAvailable } from './records';

/**
 * The hint market.
 *
 * ─────────────────────────── what a buyer is told ───────────────────────────
 *
 * A listing carries the zone, the hunt, the tier and the advertised reliability
 * of that tier — and never the hint itself. That is not an oversight in the API:
 * reading a hint *is* receiving it, so the payload arrives exactly once, on
 * delivery, after the money has settled.
 *
 * The UI's job is to make the odds impossible to miss. A tier-3 hint is close to
 * a coin flip, and someone spending money on directions deserves to know that
 * before they spend it rather than after.
 *
 * ─────────────────────────── the purchase, in full ──────────────────────────
 *
 *   1. `buy` (or `acceptBid`) returns a quote — a vouch and two transactions
 *   2. the buyer sends `approval`, then `call`, from their own wallet
 *   3. `sync` reports the trade's state on chain, and hands back a release
 *   4. the buyer sends the release; the money becomes the seller's
 *   5. `sync` again, and the hint arrives
 *
 * Unlike `records.js`, nothing here swallows its errors. A public record that
 * fails to publish costs nothing; a payment that silently fails to send is a
 * player staring at a hint they believe they bought.
 */

export const fetchListings = zoneId =>
  get(`/market/listings${zoneId ? `?zoneId=${encodeURIComponent(zoneId)}` : ''}`).then(
    r => r.listings ?? [],
  );

export const fetchMyListings = () => get('/market/listings/mine').then(r => r.listings ?? []);
export const fetchTrades = () => get('/market/trades').then(r => r.trades ?? []);
export const fetchStats = () => get('/market/stats').then(r => r.zones ?? []);

/**
 * A seller's weighted trust.
 *
 * The weighted figure, not the registry's raw score. Showing a buyer a number a
 * wash farm can manufacture would be worse than showing them nothing — it looks
 * like diligence while being exactly what the attacker produced for you.
 */
export const fetchTrust = sellerId =>
  get(`/market/trust/${encodeURIComponent(sellerId)}`).catch(() => null);

/**
 * How to describe a counterparty in one phrase.
 *
 * "Unrated" is not a warning. Everyone starts there, and a market that treats a
 * newcomer as a suspect never gets a second trader.
 */
export function trustLabel(report) {
  if (!report || report.verifiedTrades === 0) return { text: 'UNRATED', tone: 'neutral' };
  if (report.washRiskBps > 6_000) return { text: 'CIRCULAR TRADING', tone: 'bad' };
  if (report.trust >= 70) return { text: `TRUSTED ${report.trust}`, tone: 'good' };
  if (report.trust >= 30) return { text: `MIXED ${report.trust}`, tone: 'neutral' };
  return { text: `THIN ${report.trust}`, tone: 'warn' };
}

export const listHint = (hintId, askCents) =>
  post('/market/listings', { hintId, askCents }).then(r => r.listing);

export const cancelListing = id => del(`/market/listings/${encodeURIComponent(id)}`);

export const bidOn = (listingId, priceCents) =>
  post(`/market/listings/${encodeURIComponent(listingId)}/bids`, { priceCents }).then(r => r.bid);

export const fetchBids = listingId =>
  get(`/market/listings/${encodeURIComponent(listingId)}/bids`).then(r => r.bids ?? []);

export const acceptBid = bidId =>
  post(`/market/bids/${encodeURIComponent(bidId)}/accept`).then(r => r.quote);

export const quoteBuy = listingId =>
  post(`/market/listings/${encodeURIComponent(listingId)}/buy`).then(r => r.quote);

export const syncTrade = tradeId =>
  post(`/market/trades/${encodeURIComponent(tradeId)}/sync`).then(r => r.trade);

/**
 * Escrow payment for a quote: approve, then fund.
 *
 * Sequential and both awaited. Sending `fund` before the allowance has landed
 * reverts, and a revert here reads to a player as the market being broken rather
 * than as a transaction they need to resend.
 */
export async function fundQuote(quote) {
  if (!walletAvailable()) throw new Error('no_wallet');
  await sendCall(quote.approval);
  return sendCall(quote.call);
}

/** Submit the referee's release. Either party may — whoever wants it finished. */
export function submitRelease(trade) {
  if (!trade?.release?.call) return Promise.resolve(null);
  return sendCall(trade.release.call);
}

// ─────────────────────────── presentation ───────────────────────────

export const formatCents = cents => `$${(cents / 100).toFixed(2)}`;

/**
 * Human summary of what is on offer, without the hint.
 *
 * Every word here is doing work: "70% of the time" is the whole basis on which
 * someone decides what to pay, and burying it would make the market look more
 * certain than it is.
 */
export function describeListing(listing) {
  const pct = Math.round((listing.reliabilityBps ?? 0) / 100);
  const shape =
    listing.tier === 3
      ? 'A sharp claim'
      : listing.tier === 2
        ? 'A narrow claim'
        : 'A broad claim';
  return `${shape}, right ${pct}% of the time`;
}

/** Whether the seller is asking more than the pricing model would. */
export function overpriced(listing) {
  return listing.askCents > listing.suggestedCents;
}

/**
 * Plain-language state of a trade, for a player who does not think in enums.
 *
 * `funded` is the one that needs explaining: the money is escrowed and the hint
 * is deliberately still withheld, because delivery before settlement would let
 * a buyer take the hint and then refund.
 */
export function tradeStatusLabel(status) {
  switch (status) {
    case 'quoted':
      return 'Awaiting your payment';
    case 'funded':
      return 'Paid — release to receive';
    case 'delivered':
      return 'Received';
    case 'refunded':
      return 'Refunded';
    case 'abandoned':
      return 'Expired unpaid';
    default:
      return status;
  }
}
