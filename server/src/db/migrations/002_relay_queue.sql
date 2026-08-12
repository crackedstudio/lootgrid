-- Durable outbox for on-chain gameplay records.
--
-- Gameplay never waits on this table. A row is inserted inside the same request
-- that already succeeded, and a background worker drains it. If the chain, the
-- RPC or the relayer key is unavailable, rows accumulate and drain later — the
-- game is unaffected, only the public record lags.
CREATE TABLE relay_queue (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  kind       TEXT    NOT NULL,          -- reveal | entry | resolution
  payload    TEXT    NOT NULL,          -- json args, shape per kind
  -- Idempotency. Derived from the game fact itself (zone/epoch/r/c for a
  -- reveal, hunt+player for an entry), so a retried enqueue after a crash
  -- cannot produce a second transaction for the same event.
  dedupe_key TEXT    NOT NULL UNIQUE,
  status     TEXT    NOT NULL,          -- pending | sent | confirmed | dead
  attempts   INTEGER NOT NULL DEFAULT 0,
  tx_hash    TEXT,
  last_error TEXT,
  next_at    INTEGER NOT NULL,          -- ms epoch; backoff target
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- The worker's only hot query: oldest due work first.
CREATE INDEX idx_relay_due ON relay_queue (status, next_at, id);
