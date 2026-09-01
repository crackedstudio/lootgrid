-- The block's puzzle recipe, and who chose it.
--
-- A recipe is the space one hunt's puzzle may differ from another's in — which
-- probe kinds a deduction block lends and what it charges, which board a search
-- block is played on, how fast a negotiation counterparty softens. Before this
-- existed `generate` produced a spec with no degrees of freedom, and `deduction`
-- and `search` measured at ONE distinct spec across 500 salts: every hunt in the
-- game posed a byte-identical puzzle and only the answer moved.
--
-- Why a column rather than a field inside `game_spec`: the game is generated
-- lazily, on the first attempt. A recipe has to exist BEFORE that — it is an
-- input to generation, not an output — and it is written by a worker that runs
-- after the hunt is created and long before anyone plays it.
--
-- NULL is the ordinary state, not a gap. It means "nobody has authored one",
-- and every module falls back to the recipe its own salt implies, which is
-- deterministic, always legal, and always winnable. Every hunt created before
-- this migration is NULL and plays exactly as it always did.
ALTER TABLE hunts ADD COLUMN recipe TEXT;

-- 'model' or 'salt'. The observability half of the feature: it is what makes
-- "is the agent actually authoring these, or has it been falling back all
-- along?" a query rather than a guess.
ALTER TABLE hunts ADD COLUMN recipe_author TEXT;
