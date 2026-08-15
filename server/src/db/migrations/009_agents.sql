-- Player agents: who they are, what they may do, and what they have spent.
--
-- ─────────────────────────── the server holds no keys ───────────────────────
--
-- There is no private key column here and there must never be one. An agent's
-- address is bound through `PlayerRegistry.sessionKeyOf`, and the signing key
-- for it lives wherever the runtime's signer lives — not in the game database,
-- which is backed up by copying a file.
--
-- What IS here is the identity, the configuration a player set, and the ledger
-- of what has been spent against it. None of that is authoritative over money:
-- the vault enforces its own caps on chain, and these rows are the server's
-- much cheaper first line of defence so an agent that would exceed them never
-- gets as far as a transaction.

CREATE TABLE agents (
  -- The agent's address. Also the session key bound in PlayerRegistry.
  id           TEXT    PRIMARY KEY,
  -- The player who owns it. MUST differ from `id` — the vault refuses equality
  -- on chain and so does the registry, and a row that violated it would mean an
  -- agent that can withdraw. Enforced in identity.ts, and again here.
  player_id    TEXT    NOT NULL,
  -- AgentVault address, read back from the factory rather than assumed. NULL
  -- until the player has actually deployed one.
  vault        TEXT,
  -- active | paused | killed. `killed` is terminal off chain; the on-chain kill
  -- switch is what actually stops it, and this only records that it happened.
  status       TEXT    NOT NULL,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  -- One agent per player. A second would be a second spender on the same vault
  -- with no way to tell which one made a trade.
  UNIQUE (player_id)
);

CREATE INDEX agents_player ON agents (player_id);

-- What the player told their agent to do.
--
-- Typed, not free text. Every field is a number or a member of a closed set,
-- because this is read into a prompt and anything a player can type here a
-- prompt-injected model can be told to type back. See agents/config.ts.
CREATE TABLE agent_config (
  agent_id            TEXT    PRIMARY KEY REFERENCES agents (id),
  -- How boldly to trade hints, 0–100. The only genuinely subjective knob.
  aggression          INTEGER NOT NULL,
  -- Ceiling on a single hint purchase, in cents. Mirrors the vault's perTxCap
  -- and is checked first so a doomed trade never becomes a transaction.
  max_hint_price_cents INTEGER NOT NULL,
  -- Daily spend ceiling in cents. Mirrors the vault's perDayCap, same reason.
  daily_budget_cents  INTEGER NOT NULL,
  -- Inference spend allowed per hunt, in mills (thousandths of a cent).
  -- Mills because at measured DeepSeek pricing a whole hunt costs about a
  -- quarter of one cent — see agents/budget.ts.
  inference_mills_per_hunt INTEGER NOT NULL,
  -- Which zones it may enter. JSON array of zone ids; empty means none.
  zones               TEXT    NOT NULL DEFAULT '[]',
  -- Minimum reliability, in bps, below which it will not buy a hint at all.
  min_reliability_bps INTEGER NOT NULL DEFAULT 0,
  updated_at          INTEGER NOT NULL
);

-- Every spend, on chain or on inference, against one ledger.
--
-- Both kinds live in one table because the question that matters is "what has
-- this agent cost its owner today", and answering it from two places invites
-- the two to disagree. `kind` separates them where it matters.
CREATE TABLE agent_spend (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id   TEXT    NOT NULL REFERENCES agents (id),
  -- hint | inference. A hint spend moves money; an inference spend is cost of
  -- goods sold against the same deposit, which is why it is metered at all.
  kind       TEXT    NOT NULL,
  -- Mills throughout, so the two kinds are addable. A hint at 12c is 12000.
  amount_mills INTEGER NOT NULL,
  -- The hunt it was spent on, when there is one. Inference is always per hunt;
  -- a hint purchase names the hunt it was bought about.
  hunt_id    TEXT,
  -- Trade id for a hint purchase, matching the vault's on-chain `tradeRef`.
  -- Null for inference. Lets a payment on chain be tied to the decision here.
  trade_ref  TEXT,
  spent_at   INTEGER NOT NULL
);

-- The two queries this table exists to answer: today's total for an agent, and
-- this hunt's inference so far.
CREATE INDEX agent_spend_daily ON agent_spend (agent_id, spent_at);
CREATE INDEX agent_spend_hunt ON agent_spend (agent_id, hunt_id, kind);
