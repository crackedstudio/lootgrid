-- Durable outbox for funding hunt prizes on chain.
--
-- Same shape and the same rule as relay_queue: gameplay never waits on it. A row
-- is inserted in the transaction that creates the hunt, and a worker funds the
-- pot out of band. If the RPC is down, the treasury is unfunded or the chain is
-- congested, hunts still open and play normally — they simply have no prize
-- attached yet, and a claim against them reverts NotFunded until the pot lands.
--
-- Unlike relay_queue this moves real money, so the differences matter:
--
--   * hunt_id is UNIQUE rather than a derived dedupe string. One pot per hunt is
--     enforced here AND by the contract's AlreadyFunded, so a retry after a lost
--     response cannot double-fund. The at-least-once delivery that is merely
--     noisy for a log line would be expensive here.
--
--   * amount is TEXT. It is a token base-unit bigint — 5e18 for $5 of an 18dp
--     stablecoin — which exceeds what SQLite's INTEGER can hold exactly.
CREATE TABLE escrow_queue (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  hunt_id    TEXT    NOT NULL UNIQUE,
  -- Base units, decimal string. Never a float, never a JS number.
  amount     TEXT    NOT NULL,
  expires_at INTEGER NOT NULL,
  status     TEXT    NOT NULL,          -- pending | sent | confirmed | dead
  attempts   INTEGER NOT NULL DEFAULT 0,
  tx_hash    TEXT,
  last_error TEXT,
  next_at    INTEGER NOT NULL,          -- ms epoch; backoff target
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX escrow_queue_due ON escrow_queue (status, next_at);
