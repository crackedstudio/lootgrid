-- Commit-reveal over each hunt's hint set.
--
-- The house issues hints, some of which lie, funds the prize, and from phase 4
-- charges to enter. Committing to the whole set — truth flags included — before
-- the hunt opens is what turns "the house lied to me" from an unfalsifiable
-- accusation into a checkable number. See docs/AGENTIC_ARCHITECTURE.md §5.0.
--
-- The row is written in the same transaction as the hunt itself, so a hunt can
-- never be playable without a published commitment. That ordering is the whole
-- guarantee: a commitment made after play has begun proves nothing.
CREATE TABLE hint_commitments (
  hunt_id     TEXT    PRIMARY KEY,
  zone_id     TEXT    NOT NULL,
  epoch       INTEGER NOT NULL,
  -- keccak over the version tag, hunt id, salt, and every hint with its tier,
  -- advertised reliability and truth flag. See hints/commit.ts.
  commitment  TEXT    NOT NULL,
  -- Encoding version, so a future change to the digest leaves old commitments
  -- verifiable rather than orphaned.
  version     TEXT    NOT NULL,
  committed_at INTEGER NOT NULL,
  -- Set when the hunt ends and the set becomes publicly checkable. NULL means
  -- the hunt is still live and nothing may be disclosed.
  revealed_at INTEGER
);

CREATE INDEX hint_commitments_zone ON hint_commitments (zone_id, epoch);
CREATE INDEX hint_commitments_revealed ON hint_commitments (zone_id, revealed_at);
