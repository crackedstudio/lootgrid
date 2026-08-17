-- Private fog: your map is yours.
--
-- ─────────────────────────── what changes ───────────────────────────
--
-- Until now `reveals` was keyed (zone_id, epoch, r, c) — one shared map per
-- epoch, uncovered collectively. Everyone hunts the same treasure in the same
-- zone still; what you have personally dug is now yours alone.
--
-- ─────────────────────────── why ───────────────────────────
--
-- The shared map was quietly doing four kinds of damage at once, and this one
-- key change addresses all of them:
--
--   * It made the world consumable at a rate set by population. A zone's
--     lifetime fell as players arrived, which is precisely backwards.
--
--   * It made finding treasure charity. You burn the energy locating a hunt;
--     the instant you uncover it everyone in the zone is told, and someone who
--     spent nothing races you on equal terms. The rational move was to wait.
--
--   * It was a free hint, and it undercut the thing we sell. Every tile anyone
--     uncovered told everyone else where treasure was NOT — a standing subsidy
--     against the hint market.
--
--   * It made fifty burner wallets cheap. One account could solve a map and
--     forty-nine could ride it. Now each pays its own exploration cost.
--
-- ─────────────────────────── the existing rows ───────────────────────────
--
-- Every historical reveal already records the `player_id` that opened it, so
-- the widened key is a straight rebuild with no data loss and no guessing —
-- each row simply becomes that player's own reveal. Rows from a shared epoch
-- will therefore look, to everyone else, like tiles they never opened. That is
-- correct: under the new rule they never did.

ALTER TABLE reveals RENAME TO reveals_old;

CREATE TABLE reveals (
  zone_id   TEXT    NOT NULL,
  epoch     INTEGER NOT NULL,
  player_id TEXT    NOT NULL,
  r         INTEGER NOT NULL,
  c         INTEGER NOT NULL,
  type      TEXT    NOT NULL,
  handle    TEXT    NOT NULL,
  at        INTEGER NOT NULL,
  -- player_id ahead of r/c: every read is "this player's map", so the prefix
  -- the index needs to be useful for is (zone, epoch, player).
  PRIMARY KEY (zone_id, epoch, player_id, r, c)
);

INSERT INTO reveals (zone_id, epoch, player_id, r, c, type, handle, at)
SELECT zone_id, epoch, player_id, r, c, type, handle, at FROM reveals_old;

DROP TABLE reveals_old;

-- Replaces idx_reveals_zone from 001_init, which the rename took with it.
CREATE INDEX idx_reveals_zone ON reveals (zone_id, epoch);
