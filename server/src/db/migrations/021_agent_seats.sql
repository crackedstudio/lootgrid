-- Funded seats: the house's DeepSeek tokens, bought by the player who uses them.
--
-- ─────────────────────────── what this is NOT ───────────────────────────
--
-- It is not an entry fee, and the distinction is legal rather than cosmetic.
-- AGENT_TIER.md §2: selling anything a player NEEDS in order to compete for a
-- cash prize is "an entry fee with extra steps", which is the gambling
-- definition in many jurisdictions. payments/x402.ts carries the same warning.
--
-- So a seat buys exactly one thing: inference the house pays for on the
-- player's behalf. It buys no key, no entry, no retry and no advantage that
-- cannot be had for free. An agent with no seat still enters every hunt a
-- seated one can, still races it, and still wins it — it simply plays the
-- deterministic fallback line instead of a model's, which agents/validate.ts
-- was built to make a good move rather than a placeholder.
--
-- That is the free path AGENT_TIER.md §3 requires, and it is what makes the
-- sentence "money buys convenience, never a chance at a prize" true rather than
-- merely stated.
--
-- ─────────────────────────── mills, not cents ───────────────────────────
--
-- Credit is denominated in mills — thousandths of a CENT — because a whole hunt
-- of thinking costs roughly a quarter of one cent at measured DeepSeek pricing.
-- Cents would round every call to zero and bill nothing. See agents/budget.ts,
-- which had exactly that bug at 100x.

CREATE TABLE agent_seats (
  agent_id      TEXT    PRIMARY KEY REFERENCES agents (id),
  -- Denormalised so the seat cap can be counted per player without a join, and
  -- so a seat survives being read after its agent row is gone.
  player_id     TEXT    NOT NULL,
  -- Inference mills bought. Never decremented — spending is recorded separately
  -- so a seat's history is auditable against what was actually consumed.
  mills_granted INTEGER NOT NULL,
  -- Mills consumed against this seat. Remaining credit is granted - spent.
  mills_spent   INTEGER NOT NULL DEFAULT 0,
  -- What the player actually paid, in cents. Kept for reconciliation: §9.5 of
  -- AGENT_TIER.md insists on billing what was spent rather than what was
  -- assumed, and that comparison is impossible without the price paid.
  paid_cents    INTEGER NOT NULL,
  -- The x402 settlement reference. UNIQUE so a replayed payment envelope cannot
  -- be credited twice — the client returns the envelope we gave it, so every
  -- field in it is attacker-controlled by the time it comes back.
  tx_ref        TEXT    UNIQUE,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

-- The seat cap is "how many agents the house is willing to FUND", so it counts
-- seats with credit left, not seats ever sold.
CREATE INDEX agent_seats_live ON agent_seats (player_id)
  WHERE mills_spent < mills_granted;
