-- Refunds: give an unclaimed pot back when its epoch closes.
--
-- Until now the outbox only ever moved money OUT — `fundHunt` and nothing else.
-- Epoch rotation makes the reverse trip routine: a map is torn up every three
-- days, and every hunt nobody cracked leaves a funded pot behind on a grid no
-- player can reach again. The contract has always had `refund(huntId)` for this
-- and it is permissionless, so this is a queue entry, not a new capability.
--
-- ─────────────────────────── why rebuild the table ───────────────────────────
--
-- `hunt_id` was UNIQUE, which was exactly right when funding was the only job:
-- one pot per hunt, enforced here and again by the contract's AlreadyFunded. A
-- refund is a second row for the same hunt, so the constraint has to widen to
-- (hunt_id, kind) — and SQLite cannot alter a constraint in place. The rebuild
-- is the migration.
--
-- The pairing still holds where it matters: one fund and one refund per hunt,
-- and the contract's `settled` flag is the real backstop against a pot being
-- both claimed and refunded.

ALTER TABLE escrow_queue RENAME TO escrow_queue_old;

CREATE TABLE escrow_queue (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  hunt_id    TEXT    NOT NULL,
  -- fund | refund. The direction the money travels.
  kind       TEXT    NOT NULL DEFAULT 'fund',
  -- Base units, decimal string. Never a float, never a JS number.
  -- Zero on a refund row: the contract returns whatever the pot actually holds,
  -- and a figure recorded here could only ever disagree with it.
  amount     TEXT    NOT NULL,
  -- On a refund this is the moment the pot becomes refundable. `refund` reverts
  -- with NotExpired before it, so the worker must not send early.
  expires_at INTEGER NOT NULL,
  status     TEXT    NOT NULL,          -- pending | sent | confirmed | dead
  attempts   INTEGER NOT NULL DEFAULT 0,
  tx_hash    TEXT,
  last_error TEXT,
  next_at    INTEGER NOT NULL,          -- ms epoch; backoff target
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (hunt_id, kind)
);

INSERT INTO escrow_queue
  (id, hunt_id, kind, amount, expires_at, status, attempts, tx_hash, last_error,
   next_at, created_at, updated_at)
SELECT
   id, hunt_id, 'fund', amount, expires_at, status, attempts, tx_hash, last_error,
   next_at, created_at, updated_at
FROM escrow_queue_old;

DROP TABLE escrow_queue_old;

CREATE INDEX escrow_queue_due ON escrow_queue (status, next_at);
