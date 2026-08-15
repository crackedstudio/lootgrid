-- The hint market: listings, bids, and the trades they become.
--
-- ─────────────────────────── information copies ───────────────────────────
--
-- The one thing that makes this unlike every other order book: a sale does not
-- consume the thing sold. A hint has many holders after it is traded, not a new
-- one — which is why `player_hints` was a separate table from day one, and why a
-- listing stays OPEN after a sale rather than being filled and closed.
--
-- That is also the market's central weakness (architecture §5, "zero marginal
-- cost"), and it is designed around rather than solved: hints are partial, so
-- one leak does not end a round; they expire with their hunt, so the resale
-- window is short; and the first buyer is expected to pay the most.
--
-- ─────────────────────────── money is never here ───────────────────────────
--
-- Nothing in these tables holds funds. A trade is the server's record of
-- something HintEscrow is doing on chain, and every status below is a
-- *observation* of that contract rather than an instruction to it. If this
-- database were lost, buyers would still be refunded by the contract's own
-- expiry path, because the escrow does not consult it.

-- A standing offer to sell a hint the seller holds.
CREATE TABLE hint_listings (
  id              TEXT    PRIMARY KEY,
  hint_id         TEXT    NOT NULL REFERENCES hints (id),
  seller_id       TEXT    NOT NULL,
  -- Denormalised so the browse endpoint can rank and filter listings without
  -- touching `hints` — which is the table that knows the payload. Keeping the
  -- two apart makes it structurally harder to leak a hint into a listing view.
  zone_id         TEXT    NOT NULL,
  hunt_id         TEXT    NOT NULL,
  tier            INTEGER NOT NULL,
  reliability_bps INTEGER NOT NULL,
  ask_cents       INTEGER NOT NULL,
  -- open | cancelled. Deliberately no 'sold': see the header.
  status          TEXT    NOT NULL,
  -- Mirrors the hint's own expiry. A hint outlives its usefulness the moment
  -- its hunt resolves, so there is nothing to sell past this.
  expires_at      INTEGER,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  -- One live listing per hint per seller. A second is not more supply, it is
  -- the same hint twice, and it would split the order book against itself.
  UNIQUE (hint_id, seller_id)
);

CREATE INDEX hint_listings_browse ON hint_listings (zone_id, status, ask_cents);
CREATE INDEX hint_listings_seller ON hint_listings (seller_id, status);

-- An offer below the ask. The seller may take it or leave it.
CREATE TABLE hint_bids (
  id          TEXT    PRIMARY KEY,
  listing_id  TEXT    NOT NULL REFERENCES hint_listings (id),
  bidder_id   TEXT    NOT NULL,
  price_cents INTEGER NOT NULL,
  -- open | accepted | withdrawn
  status      TEXT    NOT NULL,
  expires_at  INTEGER NOT NULL,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  -- One live bid per bidder per listing. Otherwise a bidder can paper a book
  -- with offers they never intend to honour, which on agent zones is a cheap
  -- way to spam a rival's decision loop.
  UNIQUE (listing_id, bidder_id)
);

CREATE INDEX hint_bids_listing ON hint_bids (listing_id, status, price_cents DESC);

-- One purchase, and the escrow trade backing it.
CREATE TABLE hint_trades (
  id          TEXT    PRIMARY KEY,
  -- keccak of the id, as bytes32 hex. What the contract knows this trade by,
  -- stored rather than recomputed so a change to the derivation cannot orphan
  -- money already escrowed under the old one.
  trade_id    TEXT    NOT NULL UNIQUE,
  listing_id  TEXT    NOT NULL REFERENCES hint_listings (id),
  hint_id     TEXT    NOT NULL REFERENCES hints (id),
  zone_id     TEXT    NOT NULL,
  -- What the referee vouched for, as bytes32 hex. Recorded at quote time so
  -- both ends can be checked against it later: that the money on chain was
  -- escrowed for THIS hint, and that the hint delivered is the one paid for.
  hint_hash   TEXT    NOT NULL,
  buyer_id    TEXT    NOT NULL,
  seller_id   TEXT    NOT NULL,
  price_cents INTEGER NOT NULL,
  -- Token base units, decimal string. Never a float, never a JS number — 5e18
  -- exceeds what SQLite's INTEGER holds exactly. Same rule as escrow_queue.
  amount      TEXT    NOT NULL,
  -- What the rake would be, in mills. Recorded even when the contract waives it,
  -- so "how much did the waiver cost" is answerable rather than guessed at.
  rake_mills  INTEGER NOT NULL,
  rake_waived INTEGER NOT NULL,
  -- quoted    — the buyer has a vouch and calldata; nothing is on chain yet
  -- funded    — the contract holds the money
  -- delivered — settled on chain AND the hint granted. Terminal, and the only
  --             status in which the buyer has the hint
  -- refunded  — expired unsettled; the contract returned the money
  -- abandoned — quoted and never funded
  status      TEXT    NOT NULL,
  -- Mirrors the on-chain expiry. After this the buyer may refund, so the
  -- referee must not release.
  expires_at  INTEGER NOT NULL,
  funded_at   INTEGER,
  settled_at  INTEGER,
  delivered_at INTEGER,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE INDEX hint_trades_buyer ON hint_trades (buyer_id, created_at DESC);
CREATE INDEX hint_trades_seller ON hint_trades (seller_id, created_at DESC);
CREATE INDEX hint_trades_open ON hint_trades (status, expires_at);

-- Rolling rake arithmetic, per zone.
--
-- The rake accrues in mills (thousandths of a cent) because at this prize scale
-- a percentage fee cannot be expressed in cents at all: 2.5% of a 1c trade is
-- 0.025c. Rounding up would be a 100% tax, rounding down collects nothing
-- forever. Fractions are carried here and only reported as collected once they
-- cross a whole cent — see market/fees.ts.
--
-- This is a mirror of what the contract does, not the source of truth for it.
-- Its job is to answer "is this market all dust?", which is the question that
-- decides whether the rake is worth charging at all.
CREATE TABLE market_rake (
  zone_id         TEXT    PRIMARY KEY,
  traded_cents    INTEGER NOT NULL DEFAULT 0,
  accrued_mills   INTEGER NOT NULL DEFAULT 0,
  -- Rake the waiver gave back to sellers. Keeps small trades liquid, and the
  -- cost of that decision visible.
  waived_mills    INTEGER NOT NULL DEFAULT 0,
  collected_cents INTEGER NOT NULL DEFAULT 0,
  trades          INTEGER NOT NULL DEFAULT 0,
  updated_at      INTEGER NOT NULL
);
