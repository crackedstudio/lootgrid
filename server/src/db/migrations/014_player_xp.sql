-- XP: the reward for everything that is not money.
--
-- Phase 2 made most treasures XP-only — twenty-three of a zone's twenty-four —
-- because twenty-four funded hunts per zone would burn more in a day than the
-- prize budget holds in a month. That left the game paying out in a currency
-- that did not exist.
--
-- It is deliberately a bare counter and not a ledger. XP buys nothing, moves
-- nowhere, and is never redeemed, so the audit trail that `energy_ledger` and
-- the escrow queue need does not apply — inflating it costs the treasury
-- nothing. If XP ever gains a spend path this becomes the wrong shape and
-- should be revisited.
--
-- Three things ahead of this need it and none should have to invent their own:
-- the puzzle tile (phase 3), the reflex minigames once they stop deciding cash
-- (phase 4), and the Prospector rank that gates cash hunts (phase 5).

ALTER TABLE players ADD COLUMN xp INTEGER NOT NULL DEFAULT 0;

-- Rank reads this in phase 5, and a leaderboard is the obvious first query.
CREATE INDEX idx_players_xp ON players (xp DESC);
