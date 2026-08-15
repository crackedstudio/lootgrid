import { getDb } from '../index';

/**
 * Storage for the hint market.
 *
 * Two things this repo will not do, both deliberate:
 *
 *   * It never joins a listing to a hint's payload. Browsing the market must not
 *     be able to return the thing being sold, and the cheapest way to guarantee
 *     that is for the query that lists never to touch the column that holds it.
 *
 *   * It never marks a listing sold. Information copies rather than moves, so a
 *     hint sells many times and a listing closes only when its seller cancels it
 *     or its hunt expires.
 */

export type ListingStatus = 'open' | 'cancelled';
export type BidStatus = 'open' | 'accepted' | 'withdrawn';
export type TradeStatus = 'quoted' | 'funded' | 'delivered' | 'refunded' | 'abandoned';

export interface Listing {
  id: string;
  hintId: string;
  sellerId: string;
  zoneId: string;
  huntId: string;
  tier: number;
  reliabilityBps: number;
  askCents: number;
  status: ListingStatus;
  expiresAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface Bid {
  id: string;
  listingId: string;
  bidderId: string;
  priceCents: number;
  status: BidStatus;
  expiresAt: number;
  createdAt: number;
  updatedAt: number;
}

export interface Trade {
  id: string;
  /** bytes32 hex — what HintEscrow knows this trade by. */
  tradeId: string;
  listingId: string;
  hintId: string;
  zoneId: string;
  /** bytes32 hex the referee vouched for. Checked at both ends of the trade. */
  hintHash: string;
  buyerId: string;
  sellerId: string;
  priceCents: number;
  /** Token base units, as a decimal string. Never a number. */
  amount: string;
  rakeMills: number;
  rakeWaived: boolean;
  status: TradeStatus;
  expiresAt: number;
  fundedAt: number | null;
  settledAt: number | null;
  deliveredAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface RakeRow {
  zoneId: string;
  tradedCents: number;
  accruedMills: number;
  waivedMills: number;
  collectedCents: number;
  trades: number;
}

interface ListingRow {
  id: string;
  hint_id: string;
  seller_id: string;
  zone_id: string;
  hunt_id: string;
  tier: number;
  reliability_bps: number;
  ask_cents: number;
  status: string;
  expires_at: number | null;
  created_at: number;
  updated_at: number;
}

interface BidRow {
  id: string;
  listing_id: string;
  bidder_id: string;
  price_cents: number;
  status: string;
  expires_at: number;
  created_at: number;
  updated_at: number;
}

interface TradeRow {
  id: string;
  trade_id: string;
  listing_id: string;
  hint_id: string;
  zone_id: string;
  hint_hash: string;
  buyer_id: string;
  seller_id: string;
  price_cents: number;
  amount: string;
  rake_mills: number;
  rake_waived: number;
  status: string;
  expires_at: number;
  funded_at: number | null;
  settled_at: number | null;
  delivered_at: number | null;
  created_at: number;
  updated_at: number;
}

interface RakeRaw {
  zone_id: string;
  traded_cents: number;
  accrued_mills: number;
  waived_mills: number;
  collected_cents: number;
  trades: number;
}

const toListing = (r: ListingRow): Listing => ({
  id: r.id,
  hintId: r.hint_id,
  sellerId: r.seller_id,
  zoneId: r.zone_id,
  huntId: r.hunt_id,
  tier: r.tier,
  reliabilityBps: r.reliability_bps,
  askCents: r.ask_cents,
  status: r.status as ListingStatus,
  expiresAt: r.expires_at,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

const toBid = (r: BidRow): Bid => ({
  id: r.id,
  listingId: r.listing_id,
  bidderId: r.bidder_id,
  priceCents: r.price_cents,
  status: r.status as BidStatus,
  expiresAt: r.expires_at,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

const toTrade = (r: TradeRow): Trade => ({
  id: r.id,
  tradeId: r.trade_id,
  listingId: r.listing_id,
  hintId: r.hint_id,
  zoneId: r.zone_id,
  hintHash: r.hint_hash,
  buyerId: r.buyer_id,
  sellerId: r.seller_id,
  priceCents: r.price_cents,
  amount: r.amount,
  rakeMills: r.rake_mills,
  rakeWaived: r.rake_waived === 1,
  status: r.status as TradeStatus,
  expiresAt: r.expires_at,
  fundedAt: r.funded_at,
  settledAt: r.settled_at,
  deliveredAt: r.delivered_at,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

const toRake = (r: RakeRaw): RakeRow => ({
  zoneId: r.zone_id,
  tradedCents: r.traded_cents,
  accruedMills: r.accrued_mills,
  waivedMills: r.waived_mills,
  collectedCents: r.collected_cents,
  trades: r.trades,
});

let cache: ReturnType<typeof build> | null = null;

function build() {
  const db = getDb();
  return {
    insertListing: db.prepare(`
      INSERT INTO hint_listings
        (id, hint_id, seller_id, zone_id, hunt_id, tier, reliability_bps,
         ask_cents, status, expires_at, created_at, updated_at)
      VALUES (@id, @hintId, @sellerId, @zoneId, @huntId, @tier, @reliabilityBps,
              @askCents, 'open', @expiresAt, @now, @now)
    `),
    getListing: db.prepare('SELECT * FROM hint_listings WHERE id = ?'),
    listingFor: db.prepare('SELECT * FROM hint_listings WHERE hint_id = ? AND seller_id = ?'),
    // Expired listings are filtered rather than swept: a hint dies with its
    // hunt, so a background job to close them would only ever be doing what
    // this predicate already does for free.
    openInZone: db.prepare(`
      SELECT * FROM hint_listings
      WHERE zone_id = ? AND status = 'open' AND (expires_at IS NULL OR expires_at > ?)
      ORDER BY ask_cents ASC, created_at ASC
      LIMIT ?
    `),
    openEverywhere: db.prepare(`
      SELECT * FROM hint_listings
      WHERE status = 'open' AND (expires_at IS NULL OR expires_at > ?)
      ORDER BY created_at DESC
      LIMIT ?
    `),
    ofSeller: db.prepare(`
      SELECT * FROM hint_listings WHERE seller_id = ? ORDER BY created_at DESC LIMIT ?
    `),
    cancelListing: db.prepare(`
      UPDATE hint_listings SET status = 'cancelled', updated_at = ?
      WHERE id = ? AND seller_id = ? AND status = 'open'
    `),
    reopenListing: db.prepare(`
      UPDATE hint_listings SET status = 'open', ask_cents = ?, expires_at = ?, updated_at = ?
      WHERE id = ?
    `),

    insertBid: db.prepare(`
      INSERT INTO hint_bids (id, listing_id, bidder_id, price_cents, status, expires_at, created_at, updated_at)
      VALUES (@id, @listingId, @bidderId, @priceCents, 'open', @expiresAt, @now, @now)
    `),
    getBid: db.prepare('SELECT * FROM hint_bids WHERE id = ?'),
    bidsFor: db.prepare(`
      SELECT * FROM hint_bids
      WHERE listing_id = ? AND status = 'open' AND expires_at > ?
      ORDER BY price_cents DESC, created_at ASC
      LIMIT ?
    `),
    bidOf: db.prepare('SELECT * FROM hint_bids WHERE listing_id = ? AND bidder_id = ?'),
    setBidStatus: db.prepare('UPDATE hint_bids SET status = ?, updated_at = ? WHERE id = ? AND status = ?'),
    replaceBid: db.prepare(`
      UPDATE hint_bids SET price_cents = ?, status = 'open', expires_at = ?, updated_at = ?
      WHERE id = ?
    `),

    insertTrade: db.prepare(`
      INSERT INTO hint_trades
        (id, trade_id, listing_id, hint_id, zone_id, hint_hash, buyer_id, seller_id, price_cents,
         amount, rake_mills, rake_waived, status, expires_at, created_at, updated_at)
      VALUES (@id, @tradeId, @listingId, @hintId, @zoneId, @hintHash, @buyerId, @sellerId, @priceCents,
              @amount, @rakeMills, @rakeWaived, 'quoted', @expiresAt, @now, @now)
    `),
    getTrade: db.prepare('SELECT * FROM hint_trades WHERE id = ?'),
    // Status is part of the WHERE clause on every transition, so a concurrent
    // second caller updates zero rows rather than moving the trade twice.
    advanceTrade: db.prepare(`
      UPDATE hint_trades SET status = ?, updated_at = ? WHERE id = ? AND status = ?
    `),
    stampFunded: db.prepare('UPDATE hint_trades SET funded_at = ? WHERE id = ? AND funded_at IS NULL'),
    stampSettled: db.prepare('UPDATE hint_trades SET settled_at = ? WHERE id = ? AND settled_at IS NULL'),
    stampDelivered: db.prepare(
      'UPDATE hint_trades SET delivered_at = ? WHERE id = ? AND delivered_at IS NULL',
    ),
    tradesOf: db.prepare(`
      SELECT * FROM hint_trades WHERE buyer_id = ? OR seller_id = ?
      ORDER BY created_at DESC LIMIT ?
    `),
    liveTradeFor: db.prepare(`
      SELECT * FROM hint_trades
      WHERE listing_id = ? AND buyer_id = ? AND status IN ('quoted', 'funded')
      ORDER BY created_at DESC LIMIT 1
    `),
    deliveredCount: db.prepare(`
      SELECT COUNT(*) AS n FROM hint_trades WHERE hint_id = ? AND status = 'delivered'
    `),

    bumpRake: db.prepare(`
      INSERT INTO market_rake (zone_id, traded_cents, accrued_mills, waived_mills, collected_cents, trades, updated_at)
      VALUES (@zoneId, @tradedCents, @accruedMills, @waivedMills, @collectedCents, 1, @now)
      ON CONFLICT (zone_id) DO UPDATE SET
        traded_cents    = traded_cents + @tradedCents,
        accrued_mills   = accrued_mills + @accruedMills,
        waived_mills    = waived_mills + @waivedMills,
        collected_cents = collected_cents + @collectedCents,
        trades          = trades + 1,
        updated_at      = @now
    `),
    getRake: db.prepare('SELECT * FROM market_rake WHERE zone_id = ?'),
    allRake: db.prepare('SELECT * FROM market_rake ORDER BY traded_cents DESC'),
  };
}

const s = () => (cache ??= build());

export function resetStatements(): void {
  cache = null;
}

// ─────────────────────────── listings ───────────────────────────

export interface NewListing {
  id: string;
  hintId: string;
  sellerId: string;
  zoneId: string;
  huntId: string;
  tier: number;
  reliabilityBps: number;
  askCents: number;
  expiresAt: number | null;
}

/**
 * Create or revive a listing.
 *
 * A seller who cancels and relists the same hint reuses the row rather than
 * creating a second one — the uniqueness constraint is on (hint, seller), and
 * two rows for the same hint would split the book against itself.
 */
export function putListing(l: NewListing, now = Date.now()): Listing {
  const existing = s().listingFor.get(l.hintId, l.sellerId) as ListingRow | undefined;
  if (existing) {
    s().reopenListing.run(l.askCents, l.expiresAt, now, existing.id);
    return getListing(existing.id)!;
  }
  s().insertListing.run({ ...l, now });
  return getListing(l.id)!;
}

export function getListing(id: string): Listing | null {
  const row = s().getListing.get(id) as ListingRow | undefined;
  return row ? toListing(row) : null;
}

export function openListings(zoneId: string | null, limit = 100, now = Date.now()): Listing[] {
  const rows = zoneId
    ? (s().openInZone.all(zoneId, now, limit) as ListingRow[])
    : (s().openEverywhere.all(now, limit) as ListingRow[]);
  return rows.map(toListing);
}

export function listingsOfSeller(sellerId: string, limit = 100): Listing[] {
  return (s().ofSeller.all(sellerId, limit) as ListingRow[]).map(toListing);
}

/** Returns false when the listing was not this seller's, or was already closed. */
export function cancelListing(id: string, sellerId: string, now = Date.now()): boolean {
  return s().cancelListing.run(now, id, sellerId).changes > 0;
}

// ─────────────────────────── bids ───────────────────────────

export interface NewBid {
  id: string;
  listingId: string;
  bidderId: string;
  priceCents: number;
  expiresAt: number;
}

/** Create a bid, or move this bidder's existing one to a new price. */
export function putBid(b: NewBid, now = Date.now()): Bid {
  const existing = s().bidOf.get(b.listingId, b.bidderId) as BidRow | undefined;
  if (existing) {
    s().replaceBid.run(b.priceCents, b.expiresAt, now, existing.id);
    return getBid(existing.id)!;
  }
  s().insertBid.run({ ...b, now });
  return getBid(b.id)!;
}

export function getBid(id: string): Bid | null {
  const row = s().getBid.get(id) as BidRow | undefined;
  return row ? toBid(row) : null;
}

export function bidsFor(listingId: string, limit = 50, now = Date.now()): Bid[] {
  return (s().bidsFor.all(listingId, now, limit) as BidRow[]).map(toBid);
}

/** Move a bid between states. False means somebody else moved it first. */
export function setBidStatus(id: string, from: BidStatus, to: BidStatus, now = Date.now()): boolean {
  return s().setBidStatus.run(to, now, id, from).changes > 0;
}

// ─────────────────────────── trades ───────────────────────────

export interface NewTrade {
  id: string;
  tradeId: string;
  listingId: string;
  hintId: string;
  zoneId: string;
  hintHash: string;
  buyerId: string;
  sellerId: string;
  priceCents: number;
  amount: string;
  rakeMills: number;
  rakeWaived: boolean;
  expiresAt: number;
}

export function insertTrade(t: NewTrade, now = Date.now()): Trade {
  s().insertTrade.run({ ...t, rakeWaived: t.rakeWaived ? 1 : 0, now });
  return getTrade(t.id)!;
}

export function getTrade(id: string): Trade | null {
  const row = s().getTrade.get(id) as TradeRow | undefined;
  return row ? toTrade(row) : null;
}

/**
 * Move a trade forward, from an exactly-named previous state.
 *
 * The `from` argument is what makes this safe to call twice: two concurrent
 * pollers both observing settlement will only ever produce one delivery, since
 * the second update matches no row.
 */
export function advanceTrade(
  id: string,
  from: TradeStatus,
  to: TradeStatus,
  now = Date.now(),
): boolean {
  return s().advanceTrade.run(to, now, id, from).changes > 0;
}

export function stampFunded(id: string, now = Date.now()): void {
  s().stampFunded.run(now, id);
}

export function stampSettled(id: string, now = Date.now()): void {
  s().stampSettled.run(now, id);
}

export function stampDelivered(id: string, now = Date.now()): void {
  s().stampDelivered.run(now, id);
}

export function tradesOf(playerId: string, limit = 50): Trade[] {
  return (s().tradesOf.all(playerId, playerId, limit) as TradeRow[]).map(toTrade);
}

/** This buyer's unfinished trade against a listing, if any. */
export function liveTradeFor(listingId: string, buyerId: string): Trade | null {
  const row = s().liveTradeFor.get(listingId, buyerId) as TradeRow | undefined;
  return row ? toTrade(row) : null;
}

/** How many times a hint has actually been delivered. Price decay, measured. */
export function deliveredCount(hintId: string): number {
  return (s().deliveredCount.get(hintId) as { n: number }).n;
}

// ─────────────────────────── rake ───────────────────────────

export function bumpRake(
  zoneId: string,
  d: { tradedCents: number; accruedMills: number; waivedMills: number; collectedCents: number },
  now = Date.now(),
): void {
  s().bumpRake.run({ zoneId, ...d, now });
}

export function rakeFor(zoneId: string): RakeRow | null {
  const row = s().getRake.get(zoneId) as RakeRaw | undefined;
  return row ? toRake(row) : null;
}

export function allRake(): RakeRow[] {
  return (s().allRake.all() as RakeRaw[]).map(toRake);
}
