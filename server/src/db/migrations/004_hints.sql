-- Hints: directions toward a hunt, and the core loop of v2.
--
-- The set is a pure function of the hunt's salt, so this table is a cache of
-- something reproducible rather than the source of truth. It is persisted
-- anyway, for three reasons: phase 2 commits to the exact bytes, phase 5 needs
-- stable ids to trade against, and a later change to the generator must not
-- silently rewrite hints players already hold.
CREATE TABLE hints (
  id              TEXT    PRIMARY KEY,          -- "<huntId>:<idx>"
  hunt_id         TEXT    NOT NULL,
  zone_id         TEXT    NOT NULL,
  epoch           INTEGER NOT NULL,
  idx             INTEGER NOT NULL,
  tier            INTEGER NOT NULL,             -- 1 vague..3 sharp
  reliability_bps INTEGER NOT NULL,             -- advertised accuracy of the tier
  payload         TEXT    NOT NULL,             -- json, closed schema — never free text
  -- SERVER ONLY. Never serialised to a client, and the input to phase 2's
  -- commitment. A player learns the advertised rate, never this bit.
  is_true         INTEGER NOT NULL,
  -- Mirrors the hunt's own expiry, which is itself nullable. NULL means the
  -- hint outlives no deadline of its own — it dies with its hunt.
  expires_at      INTEGER,
  created_at      INTEGER NOT NULL,
  UNIQUE (hunt_id, idx)
);

CREATE INDEX hints_hunt ON hints (hunt_id);
CREATE INDEX hints_zone_epoch ON hints (zone_id, epoch);

-- Ownership, kept separate from the hint itself because in phase 5 a hint can
-- have many holders: information does not move when it is sold, it copies.
CREATE TABLE player_hints (
  player_id   TEXT    NOT NULL,
  hint_id     TEXT    NOT NULL REFERENCES hints (id),
  -- How it was obtained. 'reveal' is the only source in phase 1; 'trade' and
  -- 'deduction' arrive later and make this worth recording now.
  source      TEXT    NOT NULL,
  acquired_at INTEGER NOT NULL,
  PRIMARY KEY (player_id, hint_id)
);

CREATE INDEX player_hints_player ON player_hints (player_id, acquired_at DESC);
