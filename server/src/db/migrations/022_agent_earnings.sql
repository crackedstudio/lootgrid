-- What an agent WON, kept deliberately apart from what it spent.
--
-- ─────────────────────────── why not a row in agent_spend ───────────────────
--
-- The obvious shape is a third `kind` alongside 'hint' and 'inference', with a
-- credit instead of a debit. It is also a spending exploit.
--
-- Every ceiling in budget.ts is enforced by SUMming that table: canBuyHint and
-- canInfer both ask "how much has this agent spent today" and refuse past a
-- limit. A credit row lands in the same SUM and nets off — so an agent that won
-- a prize would quietly be granted more budget to spend, and one that won
-- enough would have no ceiling at all. The bug would look like generosity and
-- read like an accounting nicety.
--
-- Separate table, separate functions, no shared SUM. Net position is computed
-- where it is displayed, never where a limit is enforced.
--
-- ─────────────────────────── awarded, not collected ─────────────────────────
--
-- The server pays nobody. A winner requests a signed voucher and claims from
-- escrow themselves, so a row here means "this agent won a prize it may now
-- claim", not "this agent has the money". They diverge whenever a winner never
-- bothers to claim, which for a prize worth cents is a real and expected case.
-- `claimed_at` is the seam for reconciling the two later; nothing sets it yet,
-- and a NULL is the honest answer rather than an optimistic one.

CREATE TABLE agent_earnings (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id   TEXT    NOT NULL,
  hunt_id    TEXT    NOT NULL,
  -- Mills, matching agent_spend, so a net figure is one subtraction and not a
  -- unit conversion somebody gets wrong once.
  amount_mills INTEGER NOT NULL,
  difficulty TEXT    NOT NULL,
  -- How many were racing. Kept because it is what `viableFor` predicted
  -- against: the a-priori EV model divides the prize by entrants, and without
  -- this column there is no way to check the prediction after the fact.
  racers     INTEGER NOT NULL,
  earned_at  INTEGER NOT NULL,
  claimed_at INTEGER,

  -- One prize per agent per hunt. UNIQUE (hunt_id, player_id) already holds on
  -- attempts, so a second row here would mean a hunt resolved twice.
  UNIQUE (agent_id, hunt_id)
);

CREATE INDEX agent_earnings_daily ON agent_earnings (agent_id, earned_at);
