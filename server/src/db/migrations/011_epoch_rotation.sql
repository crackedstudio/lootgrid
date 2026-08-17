-- Epoch rotation: turn on the reset the schema has been ready for since phase 0.
--
-- `zones.rotates_at` and `zone_seed_history` were both written in 001_init, and
-- neither was ever used — nothing bumped an epoch, so every map ever printed is
-- still the one being played. This migration only schedules the first rotation;
-- the sweep that acts on it lives in the referee.
--
-- Existing zones are given a rotation up to three days out rather than one in
-- the past. A backfill of `now` would reset every live map on the next tick of
-- the sweeper, which is the correct behaviour eventually and a hostile way to
-- deploy it.
--
-- Staggered by rowid, for the same reason `seedZones` staggers a fresh world:
-- a flat backfill would land every zone on the same tick and empty the entire
-- game at once, three days after this migration runs. Spread across the window,
-- there is always a map partway through its life.

UPDATE zones
   SET rotates_at =
       (CAST(strftime('%s', 'now') AS INTEGER) * 1000)
       + CAST(
           (3 * 24 * 60 * 60 * 1000) * (
             (SELECT COUNT(*) FROM zones z2 WHERE z2.rowid <= zones.rowid)
             * 1.0 / (SELECT COUNT(*) FROM zones)
           ) AS INTEGER
         )
 WHERE rotates_at IS NULL;

-- The sweeper reads this on a 60s timer, so it wants an index once there are
-- more than a handful of zones.
CREATE INDEX IF NOT EXISTS idx_zones_rotates_at ON zones (rotates_at)
  WHERE rotates_at IS NOT NULL;
