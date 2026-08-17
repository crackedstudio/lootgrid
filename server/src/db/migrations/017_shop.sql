-- The shop: what was bought, and what is still in effect.
--
-- Two tables because they answer two different questions and have opposite
-- lifetimes. `purchases` is append-only history that must never be edited;
-- `entitlements` is mutable current state that expires.
--
-- ─────────────────────────── why the log is not optional ────────────────────
--
-- The single highest-value use of everything three phases of on-chain work
-- built is a claim: *"70% of everything spent on this grid goes into the pot,
-- and you can check."* Players will work out our take from public data whether
-- we publish it or not, so the number has to be one we are happy to defend and
-- it has to be computable from something we did not get to edit afterwards.
--
-- That makes `purchases` the denominator of the payout ratio, which is why it
-- is append-only, why the price is recorded at the moment of sale rather than
-- read from the catalogue later, and why a refund would be a new row rather
-- than a change to an old one.
--
-- ─────────────────────────── what cannot be in here ─────────────────────────
--
-- Nothing in either table grants an entry, a key, or a retry. That is not
-- enforced by a constraint because it does not need to be: a key is a count of
-- cash attempts already recorded, subtracted from a constant (keys.ts). There
-- is no balance for a purchase to credit, so the rule holds by the absence of a
-- mechanism rather than by anyone remembering it. See shop/catalogue.ts.

CREATE TABLE purchases (
  id          TEXT    PRIMARY KEY,
  player_id   TEXT    NOT NULL,
  sku         TEXT    NOT NULL,
  -- The price AS CHARGED. Never re-read from the catalogue: prices change, and
  -- a payout ratio computed against today's prices would misdescribe last
  -- month's revenue.
  price_cents INTEGER NOT NULL,
  -- Whatever the payment rail gave us to identify the settlement. Null in dev,
  -- where purchases are free and the shop is exercised without a facilitator.
  payment_ref TEXT,
  created_at  INTEGER NOT NULL
);

CREATE INDEX idx_purchases_player ON purchases (player_id, created_at DESC);
CREATE INDEX idx_purchases_sku    ON purchases (sku, created_at);

-- Effects that outlive the request that bought them.
--
-- One row per (player, kind): a second Cycle Pass extends the one you have
-- rather than starting a rival one, and a second Compass adds to the charges
-- left rather than replacing them. Buying something twice must never be worth
-- less than buying it twice.
CREATE TABLE entitlements (
  player_id  TEXT    NOT NULL,
  -- pass | compass | refillCredits
  kind       TEXT    NOT NULL,
  -- Charges left, for the counted kinds. Ignored by `pass`, which is pure time.
  remaining  INTEGER NOT NULL DEFAULT 0,
  -- ms epoch, or NULL for kinds that do not expire.
  expires_at INTEGER,
  -- Which treasure a Compass is pointed at. Null for every other kind.
  target_id  TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (player_id, kind)
);

-- The pass lives on the player, not only in `entitlements`.
--
-- Every other entitlement is read at the moment it is used — a Compass when a
-- hint drops, a credit when one is spent. The pass is different: it changes the
-- REGEN RATE, which `energy.currentEnergy` computes on essentially every
-- request, and that function is pure and takes no database handle by design.
--
-- Putting the expiry on the row the player is already loaded from keeps that
-- function pure and keeps a table lookup off the hottest path in the server.
-- `entitlements` still carries the pass row so the shop can describe what
-- somebody holds in one query; this column is what the energy math reads.
ALTER TABLE players ADD COLUMN pass_until INTEGER;

-- When the daily top-up was last taken. Claimed on first sight rather than
-- pushed by a job — a scheduler that credits energy to sleeping accounts is a
-- scheduler that has to be right about time zones forever.
ALTER TABLE players ADD COLUMN pass_topped_up_at INTEGER;
