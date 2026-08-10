-- Players. `id` is the wallet address (lowercased) once AUTH_MODE=chain.
CREATE TABLE players (
  id            TEXT    PRIMARY KEY,
  handle        TEXT    NOT NULL,
  session_key   TEXT,                      -- address bound via PlayerRegistry
  energy_value  INTEGER NOT NULL,
  energy_at     INTEGER NOT NULL,          -- ms epoch; energy is computed from this
  trust_score   REAL    NOT NULL DEFAULT 1.0,
  shadow_banned INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,
  last_seen_at  INTEGER NOT NULL
);

-- A zone's seed is secret for the life of its epoch: it *is* the fog.
CREATE TABLE zones (
  id          TEXT    PRIMARY KEY,
  name        TEXT    NOT NULL,
  accent      TEXT    NOT NULL,
  epoch       INTEGER NOT NULL,
  seed_secret TEXT    NOT NULL,
  seed_commit TEXT    NOT NULL,
  rotates_at  INTEGER,
  created_at  INTEGER NOT NULL
);

-- Published when an epoch rotates, so players can verify the map was fixed in
-- advance and not rewritten under them.
CREATE TABLE zone_seed_history (
  zone_id     TEXT    NOT NULL,
  epoch       INTEGER NOT NULL,
  seed_secret TEXT    NOT NULL,
  seed_commit TEXT    NOT NULL,
  revealed_at INTEGER NOT NULL,
  PRIMARY KEY (zone_id, epoch)
);

CREATE TABLE reveals (
  zone_id   TEXT    NOT NULL,
  epoch     INTEGER NOT NULL,
  r         INTEGER NOT NULL,
  c         INTEGER NOT NULL,
  type      TEXT    NOT NULL,
  player_id TEXT    NOT NULL,
  handle    TEXT    NOT NULL,
  at        INTEGER NOT NULL,
  PRIMARY KEY (zone_id, epoch, r, c)
);

CREATE TABLE hunts (
  id            TEXT    PRIMARY KEY,
  zone_id       TEXT    NOT NULL,
  epoch         INTEGER NOT NULL,
  r             INTEGER NOT NULL,
  c             INTEGER NOT NULL,
  salt          TEXT    NOT NULL,          -- revealed at resolution
  cell_commit   TEXT    NOT NULL,
  kind          TEXT    NOT NULL,          -- cash | puzzle
  difficulty    TEXT    NOT NULL,
  prize_label   TEXT    NOT NULL,
  status        TEXT    NOT NULL,          -- live | resolving | resolved | expired
  winner_id     TEXT,
  -- The block's game, generated once from the salt and shared by every racer.
  game_type     TEXT,
  game_spec     TEXT,                      -- json
  game_secret   TEXT,                      -- json; never leaves the server
  game_limit_ms INTEGER,
  expires_at    INTEGER,
  created_at    INTEGER NOT NULL,
  resolved_at   INTEGER,
  UNIQUE (zone_id, epoch, r, c)
);

CREATE TABLE attempts (
  id                TEXT    PRIMARY KEY,
  hunt_id           TEXT    NOT NULL,
  player_id         TEXT    NOT NULL,
  handle            TEXT    NOT NULL,
  game_type         TEXT    NOT NULL,
  started_at        INTEGER NOT NULL,
  deadline_at       INTEGER NOT NULL,
  status            TEXT    NOT NULL,      -- active | won | lost | failed | abandoned
  last_seq          INTEGER NOT NULL DEFAULT 0,
  elapsed_ms        INTEGER,
  fail_reason       TEXT,
  progress          INTEGER NOT NULL DEFAULT 0,
  intervals         TEXT    NOT NULL DEFAULT '[]',
  max_clock_skew_ms INTEGER NOT NULL DEFAULT 0,
  finished_at       INTEGER,
  -- One shot per player per block: retries must not beat reflexes.
  UNIQUE (hunt_id, player_id)
);

-- Append-only input log. Never read during play — this is the anti-cheat audit
-- trail, written in one batch when an attempt finishes.
CREATE TABLE attempt_events (
  attempt_id TEXT    NOT NULL,
  seq        INTEGER NOT NULL,
  kind       TEXT    NOT NULL,
  t_client   INTEGER NOT NULL,
  t_server   INTEGER NOT NULL,
  PRIMARY KEY (attempt_id, seq)
);

-- Replay protection for signed requests.
CREATE TABLE request_nonces (
  player_id TEXT    NOT NULL,
  nonce     TEXT    NOT NULL,
  seen_at   INTEGER NOT NULL,
  PRIMARY KEY (player_id, nonce)
);

CREATE INDEX idx_attempts_hunt_status ON attempts (hunt_id, status);
CREATE INDEX idx_attempts_player      ON attempts (player_id, started_at);
CREATE INDEX idx_hunts_zone_status    ON hunts (zone_id, epoch, status);
CREATE INDEX idx_hunts_expiry         ON hunts (status, expires_at);
CREATE INDEX idx_reveals_zone         ON reveals (zone_id, epoch);
CREATE INDEX idx_nonces_seen          ON request_nonces (seen_at);
