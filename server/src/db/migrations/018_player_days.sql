-- Which days a player was active. The only new state the funnel needs.
--
-- ─────────────────────────── why a table and not a column ───────────────────
--
-- `players.last_seen_at` exists and has been written exactly once per player,
-- at signup, since phase 0 — nothing ever called `touch`. So retention was not
-- merely unmeasured, it was unmeasurable.
--
-- Fixing the column would still not be enough. `last_seen_at` records only the
-- most recent visit, which answers "has this player come back at all" and
-- cannot answer "did the players who joined on Tuesday come back on
-- Wednesday". D1 and D7 are cohort questions: they need to know whether a
-- specific player was present on a specific day, and one timestamp cannot say.
--
-- One row per player per active day answers both, exactly, and costs one write
-- per player per day — not one per request. `INSERT OR IGNORE` makes the
-- hot-path call idempotent, so the throttle is the primary key rather than a
-- timer somebody has to get right.
--
-- ─────────────────────────── what a "day" is ───────────────────────────
--
-- Whole UTC days, matching `keys.dayStart` and the escrow's daily cap. Local
-- days would be more flattering to read and would need a timezone per player
-- that we do not have and should not guess.

CREATE TABLE player_days (
  player_id TEXT    NOT NULL,
  -- Days since the epoch, UTC. Integer division, not a formatted date.
  day       INTEGER NOT NULL,
  PRIMARY KEY (player_id, day)
);

-- The cohort queries read "who was active on day N", so day leads.
CREATE INDEX idx_player_days_day ON player_days (day, player_id);
