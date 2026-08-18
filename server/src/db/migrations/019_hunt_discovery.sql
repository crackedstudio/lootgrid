-- Discovery is private, and a treasure's location is not public until it is.
--
-- ─────────────────────────── the hole this closes ───────────────────────────
--
-- Phase 1 made fog per-player and phase 3 built Survey and hint intersection on
-- top of it, but `GET /zones/:id` kept serving `r` and `c` for every live hunt
-- to every player. So the whole point of a 3,600-cell map was undone by its own
-- payload: a player opened the overview and saw all twenty-four treasures.
--
-- Survey reported the distance to a treasure the client could already locate.
-- Hints narrowed toward a cell already on screen. Private fog hid tile types
-- around a target that was never hidden. Three phases of deduction machinery
-- were decoration.
--
-- It is the same class of bug the v1 README describes fixing — "the grid used to
-- be computable from the bundle, so every treasure location was readable from
-- devtools" — reintroduced one layer up. The map stopped being in the bundle and
-- started being in the response.
--
-- Nothing caught it because `security.test.ts` locks down the seed secret, the
-- hunt salt and the block game spec, and never the coordinates. In v1 they were
-- legitimately public: you found a hunt by digging on a shared map and everyone
-- seeing it was the design. Private fog changed what "secret" means and the
-- tests did not follow.
--
-- ─────────────────────────── head start, not monopoly ───────────────────────
--
-- Making discovery private raises the opposite risk: if a hunt stayed visible
-- only to whoever found it, nobody would ever race and the multiplayer game
-- would quietly disappear. So visibility is time-bounded, exactly as
-- AGENTIC_ARCHITECTURE.md §5 already requires of hints:
--
--   discovered            → private to its discoverers
--   + DISCOVERY.headStart → public to the zone; anyone may enter and race
--   + publicAfter (undug)  → public anyway, so no treasure sits dead on the map
--
-- The head start buys PREPARATION, not an exclusive attempt. The Crack resolves
-- in fifteen seconds, so an exclusive window of any length would mean nearly
-- every hunt resolves solo. What the twenty minutes are for is narrowing: apply
-- hints, buy a scout report, work the candidate set. Then everyone cracks it
-- together and the finder simply arrives better prepared.
--
-- ─────────────────────────── why two objects ────────────────────────────────
--
-- `public_at` is on the hunt because going public is a property of the treasure,
-- not of any one player. `hunt_discoveries` is a table because under private fog
-- two players can independently dig the same cell during the head start, and
-- both have earned the right to see what they found. A single `discovered_by`
-- column would have hidden the second finder's own treasure from them.

ALTER TABLE hunts ADD COLUMN public_at INTEGER;

-- Existing rows keep today's behaviour: already public, visible to everyone.
-- Backfilling to `created_at` rather than to a future time means this migration
-- cannot retroactively hide a treasure someone is already hunting.
UPDATE hunts SET public_at = created_at WHERE public_at IS NULL;

-- Who has personally found which treasure, and when.
CREATE TABLE hunt_discoveries (
  hunt_id      TEXT    NOT NULL,
  player_id    TEXT    NOT NULL,
  discovered_at INTEGER NOT NULL,
  PRIMARY KEY (hunt_id, player_id)
);

-- The visibility read is "everything public, plus everything I found", so the
-- lookup is by player.
CREATE INDEX idx_hunt_discoveries_player ON hunt_discoveries (player_id);

-- Ordering live hunts by when they go public drives both the visibility query
-- and the sweeper that broadcasts them.
CREATE INDEX idx_hunts_public_at ON hunts (zone_id, epoch, public_at);
