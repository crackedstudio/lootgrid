# LOOTGRID v2 — Implementation Plan

**Source:** `docs/briefing.md` (the outside review)
**Status:** Phases 1–6 shipped. Phase 0 was skipped at the user's direction — worth
knowing, because it means everything below is being built without the funnel that would
tell us whether any of it worked. §0-A was decided (stop relaying reveals). §0-B is half-resolved: proximity
targeting shipped, the Compass's explicit choice did not. §0-D still gates
funding any zone.
**Scope:** ten phases built the machinery. This plan is the first one that changes the game.

---

## How this plan was built

Every claim in the briefing was checked against the code before being planned
against. Most held. Three did not, and one change the briefing treats as simple
turns out to break an existing on-chain guarantee. Those are §0.

### Confirmed against the code

| Briefing claim | Where it's true |
|---|---|
| Map never resets | `zones.rotates_at` and `zone_seed_history` exist (`001_init.sql:22,29`); nothing ever bumps `epoch`. Half-built exactly as described |
| 1.85% treasure density | `HUNTS_PER_ZONE = 4` over `GRID` 18×12 = 216 (`config.ts:6,132`) |
| Energy refills in 108s | `max: 12 × regenMs: 9_000` (`config.ts:12,15`) |
| Winner decided by tap speed | `TAP.target: 14, limitMs: 6_000` (`config.ts:81`) |
| Tile types do nothing | `tileType()` computes a label (`grid.ts:9`); the open handler records it and branches on nothing (`http.ts:281`) |
| Fog is shared | `reveals` PK is `(zone_id, epoch, r, c)` — no player column (`001_init.sql:46`) |
| ~$9/day in prizes | `DIFFICULTY_WEIGHTS` doc comment computes 56.6¢ × 16 live hunts (`prizes.ts`) |

### Where the briefing is wrong, or already solved

**1. Hints are already location-based.** The briefing (§3 #2, §9) says hints
can't do detective work. They can: `region`, `exclusion`, `rowBand`, `colBand`,
`parity` and `distance` are all spatial, with a pure `cellMatches` predicate the
client already mirrors (`hints/types.ts:110`). The real defect is narrower and
worth naming precisely — **hint scatter**. `awardForReveal` draws which hunt a
hint concerns from the same hash as the drop (`hints/index.ts:104`), so six
hints spread across four live hunts. The fix is targeting, not a new hint
system. That is much cheaper than the briefing implies.

**2. The 25% information cap already exists.** §5b proposes capping information
at 25% of the prize; `market/pricing.ts:52` is `MAX_VALUE_SHARE = 0.25`. §5e's
35%-per-copy decay is `DECAY_PER_SALE = 0.35`. Both are live and tested. These
are policy to *keep*, not build.

**3. Survey has a working implementation to lift from.** `games/search.ts` is
already a Chebyshev hot/cold probe game with a published movement rule and a
budget. Survey against a *static* treasure is that module with the evader
removed — a simplification of existing, tested code.

### The conflict the briefing misses

**Private fog breaks the on-chain reveal relay.** Every tile open publishes a
`reveal` event to chain, deduped on `reveal:{zone}:{epoch}:{r}:{c}`
(`http.ts:296`). Make fog private and that key collides across players — and
worse, publishing per-player reveals on chain **republishes the map publicly**,
which defeats private fog completely. You cannot ship §4c without deciding what
happens to this. See §0-C.

---

## §0 — Decisions needed before any code

These four change what gets built. They are not implementation details.

### A. What happens to on-chain reveals under private fog

The relay currently makes every uncovered tile a public, auditable fact. Private
fog makes that self-defeating. Three options:

| Option | Cost |
|---|---|
| **Stop relaying reveals; keep relaying outcomes** (recommended) | Loses "every dig is on chain". Keeps the claims that matter — hunt commitments, hint sets, settlements, payouts. The audit story in §5j survives intact |
| Relay a per-player commitment, reveal at epoch end | Preserves auditability with a one-epoch delay. Real work: new commitment scheme, new contract path |
| Keep public reveals, accept fog leaks | Private fog becomes cosmetic. Free-riding and the sybil defence in §7a both come back |

Recommendation: option 1. The reveal relay is the weakest of the on-chain
claims and the only one private fog contradicts.

### B. Does the Compass flip a deliberate invariant?

`hints/index.ts:104` says, in a comment written on purpose: *"Which hunt this
cell speaks to is itself part of the draw, so a player cannot steer their hints
towards a hunt they have already narrowed down."*

The Prospector's Compass (§5c) sells exactly that steering. That may well be
right now that keys cap entries — but it is a designed constraint being sold,
not an oversight being fixed, and it should be overturned deliberately. If
targeting ships, that comment and its rationale have to be rewritten, not
deleted.

### C. Grid resize is not a config change

`GRID = {12, 18}` is imported by hint geometry, deduction budgets, and payload
validation. Moving to 60×60 silently breaks three things:

- `parsePayload` hardcodes `within <= 4` (`hints/types.ts:180`) — on a 3,600-tile
  map a radius-4 ring is 0.6% of the grid, so every tier-3 hint becomes a
  near-exact answer
- `quadrantOf` splits into four 900-tile blocks — a tier-1 hint that used to rule
  out 162 cells now rules out 2,700, and `sharpness` (which prices hints) moves
  with it
- `DEDUCTION.budget.hard = 8` is documented as exactly `⌈log₂ 216⌉`
  (`config.ts:150`). At 3,600 cells that is 12, and 8 becomes unwinnable

Hint tiers must be **re-derived from the new grid**, not carried over. Budget
this as its own piece of work, not a line in a config file.

### D. The money gate

The briefing's §7a bottom line is a hard sequencing constraint and this plan
adopts it verbatim:

> **No real money in a zone until private maps, the rank gate and the wallet
> check are all live and tested.**

Phases 1 and 5 below are that gate. Everything downstream of them can be built
in parallel but cannot be *funded* until they land.

---

## Phase 0 — Instrumentation

**Why first:** the briefing's open question #2 says we measure nothing about
players, and it's right. `metrics.ts` has 40+ counters — all system-side
(escrow depth, inference failures, rake). There is no funnel. Every later phase
in this plan is a bet, and none of them can be evaluated without this. It is
also the cheapest phase by a wide margin.

**Build the five metrics named in the briefing, and nothing else:**

| Metric | Where it hooks |
|---|---|
| Taps to first treasure | `http.ts` open handler; new per-player counter reset at first hunt found |
| Hints held at entry | `hints.heldForHunt` already exists (`hints/index.ts:142`) — widen from boolean to count at attempt start |
| Energy-empty moments | `energy.spend` returns `ok: false` (`energy.ts:38`) — currently unrecorded. This is the monetisation moment in §5g |
| D1 / D7 return | `players.created_at` exists; needs a `last_seen_at` column and a daily rollup |
| % who pay | No purchase path exists yet. Land the counter shape now so Phase 7 has somewhere to write |

**Files:** `server/src/metrics.ts`, `server/src/http.ts`, `server/src/energy.ts`,
new migration `011_player_activity.sql`.

**Exit:** all five readable off `/metrics` and non-zero on a real device session.

---

## Phase 1 — A world that doesn't die ✅ shipped

The briefing's §9 first-priority item. Two changes, one milestone.

### 1a. Epoch rotation

Genuinely half-built — finish it rather than design it.

- Scheduler bumps `zones.epoch`, writes the old `seed_secret` into
  `zone_seed_history`, generates a fresh secret and commitment
- Rotation expires live hunts in the outgoing epoch. **Escrow must refund
  unclaimed prizes** — `chain/escrow.ts` has no path for this today and it is
  the one part that isn't already scaffolded
- Reveals from prior epochs are already scoped by `epoch` in the PK, so they age
  out for free
- `store.replenish` reads `zone.epoch` already; no change

**Files:** `server/src/store.ts`, `server/src/db/repos/zones.ts`,
`server/src/chain/escrow.ts`, `server/src/index.ts` (scheduler),
`server/src/config.ts` (`EPOCH_MS`).

**Interval:** 3 days per the briefing, but make it configurable per zone —
`rotates_at` is already a per-zone column, so per-zone cadence costs nothing.

### 1b. Private fog

The load-bearing change. Four problems, one edit — but it touches a lot.

- Migration: `reveals` PK becomes `(zone_id, epoch, player_id, r, c)`
- `store.addReveal` can no longer return false for "someone else got there" —
  the contention refund path at `http.ts:284-289` becomes dead code and should
  be **deleted, not left**
- `store.replenish` currently skips cells any player has revealed
  (`store.ts:236`). Under private fog it must skip only *globally* known cells,
  which now means: none. Decide whether a hunt may spawn under a tile someone
  has already dug — recommendation: yes, and it becomes a pleasant surprise on
  their next visit
- `GET /zones/:id` returns `store.revealsFor(zone)` (`http.ts:244`) — must
  become per-player
- `tile:revealed` broadcast to the zone room (`http.ts:317`) must stop, or the
  fog leaks over the socket
- Resolve §0-A before starting

**Files:** new migration `012_private_fog.sql`, `server/src/db/repos/zones.ts`,
`server/src/store.ts`, `server/src/http.ts`, `server/src/chain/relayer.ts`,
`src/hooks/useGameState.js`, `src/components/GridScreen.jsx`.

**Exit:** two accounts digging the same zone see different maps; one account's
digs never appear in the other's payload or socket stream; a zone survives an
epoch of sustained single-player digging without running out of map.

---

## Phase 2 — Resize and retune ✅ shipped

Depends on Phase 1 (rotation gives a clean epoch to resize into).

**What was decided while building it**, beyond the plan below:

| Decision | Why |
|---|---|
| Hint geometry is now **grid-relative**, not constant | Band widths and ring radii are expressed as the share of the map they should cover, and the constants are recovered from `GRID`. Fed the old 18×12 grid the derivation returns the old numbers exactly — asserted in `generate.test.ts`, which is what makes it a re-derivation rather than a rebalance |
| `sharpness` became **closed-form** | It prices every hint in the market and was walking all 3,600 cells. `candidateCells` stays the readable definition; a test compares the two on every shape the generator emits |
| `SEARCH` got its own **18×12 board**, decoupled from the map | Its probe budgets are an empirical pursuit bound, not a formula. A pursuit problem does not scale like a search problem, and nobody has measured the big-board version. Deduction *does* scale, because it probes in the fog's own hint vocabulary |
| The 1c tier died by **raising the floor**, not deleting `easy` | `Difficulty` is also the *game's* difficulty and easy games should still exist. `MIN_VIABLE_PRIZE_CENTS = 60` is the lowest prize whose 25% hint ceiling clears `MIN_TRADE_CENTS` |
| **`CASH_PER_ZONE = 1`** — new | The plan flagged the burn as a "watch"; it turned out to be load-bearing. 24 *funded* hunts per zone burns ~$168/day against a $100–300/**month** floor. Most treasures are now XP-only puzzle hunts — a `HuntKind` that has existed since phase 0 and had never once been created. Lands at ~$156/month, asserted in `prizes.test.ts` |

**Two bugs the resize exposed**, both silent:

- The client hardcoded `MID_ROW = 9` / `MID_COL = 6`, so every `region` and
  `exclusion` hint would have shaded the wrong quarter of a 60×60 board while
  looking entirely plausible. Geometry now comes from the served dimensions.
- `candidates()` defaulted to `rows = 18, cols = 12` — a default that can only
  ever be wrong. Removed.

**Still open from this phase:** at 54px tiles a 60-wide grid is ~3,240px across.
It scrolls, and that is not a design. The viewport work belongs with Phase 6,
which is where the first-run experience gets built against a real low-end phone.

---

### Original plan

- `GRID` → 60×60, `ENERGY.max` → 40, `regenMs` → 4h/40, `HUNTS_PER_ZONE` → 24
- **Re-derive hint tiers against the new grid** per §0-C. `sharpness()` is the
  function to tune against — it already prices hints and it's pure, so this is
  testable without touching the market
- Lift `parsePayload`'s `within <= 4` bound proportionally
- `DEDUCTION.budget` → `⌈log₂ 3600⌉ = 12` for hard, easy/med scaled up
- **Delete the `easy` prize tier.** `DIFFICULTY_WEIGHTS` (`prizes.ts`) drops to
  `med`/`hard`. This is the highest-value line in the phase: `market/pricing.ts`
  already refuses to price hints on 1¢ hunts, so deleting the tier turns the
  hint market on for the first time. `PRIZE_CENTS.easy` and every `?? band.easy`
  fallback need auditing — the fallback chain assumes `easy` exists

**Watch:** `HUNTS_PER_ZONE = 24` at current weights is a large burn increase.
Re-run the arithmetic in the `DIFFICULTY_WEIGHTS` comment before merging; the
$100–300/month floor in §5h is the constraint, not the old $9/day.

---

## Phase 3 — Three things to do ✅ shipped

**The finding that reordered this phase.** Phase 2 raised a zone from 4 live
treasures to 24, and `awardForReveal` scattered each hint across all of them.
Measured: **300 digs produced 80 hints across 11 treasures and not one about the
hunt carrying the money.** The briefing's problem #2 went from expensive to
unreachable, so targeting became mandatory rather than optional and was built
first. After the fix, digging a 9×9 patch around a treasure yields 27 hints
about it.

**§0-B is resolved for the free path and still open for the paid one.** The
briefing's §5d table is explicit that a *dug* hint is about "whatever's nearest"
and only a *bought* one is about "the one you chose". So targeting-by-proximity
shipped and the anti-steering comment was rewritten rather than deleted:
nearest-first is steerable, but only by digging near the thing, which costs
energy and is the feedback loop exploration should have. Explicit choice without
digging — the Compass — remains unbuilt and still needs the §0-B call.

| Decision | Why |
|---|---|
| Traps are **guaranteed** to pay a hint, not just to cost double | A tile that charges double and then rolls 35% for nothing is punishment that teaches avoidance. Guaranteed-but-false is a real cost with a real consequence, and a contradicting hint is itself information |
| A trap **walks outward** to find a lie | About one hunt in seven has a committed set that is true throughout. Falling back to a true hint would make a trap an expensive clue — the label meaning nothing again, which is the whole problem this phase fixes. Walking outward keeps every hint drawn from a published set, so the honesty audit is untouched |
| Survey is a **local** instrument | Non-obvious and worth knowing: each reading reports the *nearest* treasure, so with 24 on the map, two readings taken far apart describe different treasures and intersect to **nothing**. Triangulation works inside a neighbourhood. Both directions are asserted, so nobody "fixes" it later |
| Minimal `players.xp` added | 23 of 24 treasures pay in a currency that did not exist. A bare counter, not a ledger — XP buys nothing, so there is no solvency question. Phase 4 and the Phase 5 rank gate both need it |
| Dig costs 2, survey costs 6 | Three digs to one survey is the exchange rate. Surveying is the opener; digging is how you finish |

**Fixed here:** the energy bar rendered one pip per point — fine at 12, about
680px at 40, off the side of every target phone. Now a bar and a number.

---

### Original plan

### 3a. Survey

New action, `SURVEY` config block, 6 energy, uncovers nothing.

Lift the distance calculation from `games/search.ts` — drop the evader, keep
the Chebyshev reading and the published-rule discipline. Vagueness is the tuning
knob and the briefing's open question #4 says start coarse; make it a config
band, not a constant.

Survey must **not** grant reveals, so it does not consume map — that property is
half the reason it exists (§4a).

### 3b. Make tiles real

`grid.ts:9` already assigns the five types with the exact distribution the
briefing's §4b table uses. Only the effects are missing:

| Tile | Effect | Note |
|---|---|---|
| clue | Guaranteed hint | `awardForReveal` currently rolls 35% (`HINT_DROP_PCT`) — clue bypasses the roll |
| trap | Double energy + a false hint | The generator already produces false hints with `isTrue` tracked; a trap grants a known-false one. **This must still count against the published reliability audit** or the commitment story breaks |
| mystery | Free neighbouring reveal | Only coherent under private fog — another Phase 1 dependency |
| puzzle | XP minigame | Existing modules, rewired to XP not cash |

**Files:** `server/src/http.ts` (open handler branches on `cell.type` for the
first time), `server/src/hints/index.ts`, `server/src/hints/generate.ts`.

### 3c. Hint targeting

Per §0-B. `awardForReveal` gains a player-chosen target hunt; the drop hash
keeps deciding *whether* and *which tier*, but not *which hunt*. Compass (Phase
7) sells this.

---

## Phase 4 — The Crack ✅ shipped

| Decision | Why |
|---|---|
| `generate` gained a **context carrying the hunt's cell** | The Crack is the first module whose answer must BE the treasure. `deduction` and `search` invent their own targets from the seed; if The Crack did that, hints would describe a position nobody is picking and the whole economy would price unusable information. The module **throws** rather than falling back — a seed-derived answer would generate cleanly, play convincingly, and be unwinnable by deduction |
| Hints used = hints **held**, not "applied" | There is no apply endpoint and there should not be: a player who has seen a hint cannot un-see it before picking. Held is the honest measure and cannot be gamed by declining to declare |
| Snapshotted at the **lock**, persisted | Hints can arrive in the fifteen seconds before the reveal; recomputing at resolution could cost a tiebreak already earned. It is also the raw material for the report card the shop sells |
| Settlement window becomes the **game's own limit** | 400ms was sized for jitter between players who started together. Here it would silently restore "first to answer wins" — the exact thing the phase removes |
| `startedAt` dropped from the tiebreak entirely | Arrival order is who loaded the page first. Correct → fewer hints → deterministic hash, and nothing else |
| All-wrong **reopens** the hunt | Open question #5, answered yes. The money is escrowed for whoever finds it; burning it because the first triers were wrong is the house keeping a pot nobody won. Those who guessed still spent their one attempt |
| The first lock **closes entry** | Once someone has answered, the hunt is being decided. Entry costs 3 energy, so refusing a latecomer beats charging them and cutting them off mid-window |
| Puzzle hunts draw from **all four** reflex games | They were hardcoded to `memory`, so three modules had never been served since the cash pool stopped drawing them. Puzzle hunts are now most of the map, so that is where the variety lives |

**Also fixed:** the deduction solver test was the slowest in the suite by an
order of magnitude after Phase 2's resize (O(probes × options × cells), and
cells went 216 → 3,600). It passed alone and timed out under parallel load.
Sample reduced from 25 boards to 8 — the strategy is deterministic, so the
property is demonstrated either way.

---

### Original plan

Replaces tap-speed with deduction as the win condition. Largest referee change
in the plan.

- Six candidates, identical for everyone, derived from the hunt salt so they are
  committed in advance and checkable at reveal — same discipline as
  `blockGame` and the hint set
- 15s window, everyone locks, simultaneous reveal
- Tiebreak on fewer hints used — needs hint *consumption* tracked, which does
  not exist today (`hints` are held, never spent)
- `RACE.settlementWindowMs` (400ms) and the whole latency-grace apparatus
  (`config.ts:20-33`) become irrelevant for cash hunts. The `ASYNC` split for
  agent zones stays
- Existing four reflex modules move to XP-only

**Files:** `server/src/referee.ts`, `server/src/config.ts`,
`server/src/games/index.ts`, `src/components/Minigame.jsx`.

**Also in scope, and cheap:** surface hunt type/difficulty/prize before
commitment (§4d). `difficulty` and `prizeLabel` are already in the
`GET /zones/:id` payload (`http.ts:253`) — this is a client-side change only.

---

## Phase 5 — The money gate ✅ shipped

| Decision | Why |
|---|---|
| Keys are **derived, not stored** | A key is a count of cash attempts today subtracted from a constant. A stored balance needs a credit path — daily reset, refunds, support tools — and once one exists, "keys cannot be bought" is a policy someone has to remember. There is no function anywhere that can grant one, and a test asserts the module's whole surface is `balance`/`dayStart`/`hasKey` |
| The gate is **time and volume**; the ladder is accuracy | Conflating them breaks both. A burner farm with lucky hints must not rank up, so admission never reads accuracy — only resolved hints across distinct days, which is the axis money cannot move |
| Accuracy is **honestly weak for a digger** | Hints are granted by the drop roll, not chosen, and tier 3 is a coin flip by design. It becomes skill for someone who *buys* hints (they chose) or *sells* them (already bonded against lying). Documented in `rank.ts` rather than glossed |
| Only **resolved** hunts count toward rank | Counting live ones would let an account rank on hints it has not had to be right about, and would leak a game in progress into a public number |
| One `mayEnter`, called from the **referee** | Not the HTTP handler — every entry path reaches the referee, including the agent driver, so a gate placed there cannot be walked around by a caller that did not know about it |
| **Agent zones are not gated** | Not a hole: rank comes from digging fog and agents do not dig, so they would sit at `unranked` forever and the agent zone would silently close. The symptom would have read as "nobody enters", not as a bug. Agents carry stricter admission of their own — registration, budget, bonds, verified-trade reputation |
| Refusals **explain themselves** — except the ban | "Not ranked highly enough" with no number reads as rigged; "two more days" is actionable and gives away nothing not already in `rank.ts`. The shadow ban keeps its disguise as `hunt_not_live`, because telling a botter when they were caught only helps them iterate |
| Nothing gates **XP hunts** | 23 of every 24 treasures. A new player can play essentially the whole game on day one; what they cannot do is take cash out of it. That is also what keeps the free path to every prize real — rank is earned by playing, and playing is free |

**On §0-D — is the money gate closed?** The three the review named are live and
tested: private maps (Phase 1), the rank gate, the wallet check. Two honest
caveats before anyone funds a zone:

- **Wallet age is account age, not on-chain wallet age.** It measures when the
  account first appeared to us. An attacker who registers fifty wallets today
  and waits two days defeats *that check alone* — the rank gate is what makes
  the wait expensive, because those two days have to be spent actually playing
  each account. Reading true wallet age from chain is the stronger version and
  belongs with the on-chain identity work.
- **The win cap per wallet per cycle is not built.** The review lists it as a
  backstop for when everything above fails. The escrow's per-day claim cap
  bounds total damage but not per-identity damage.

---

### Original plan

Nothing here is optional before real money (§0-D).

- **Keys**: new currency, 5/day/verified wallet, unpurchasable. Needs its own
  table and a hard separation from energy in code — not a second field on
  `players`, but a distinct module, so "can this be bought" is answerable by
  reading one file
- **Prospector rank**: `agents/reputation.ts` scores agents on hint accuracy
  already. Extend to human players and gate cash-hunt matching on it. The
  briefing's §4g claim that this makes existing reputation visible is accurate
- **Wallet age + activity check**: `auth/registry.ts` already resolves on-chain
  identity; add an age/history threshold at matchmaking
- `players.shadowBanned` already exists and already stops cash matching
  (`types.ts:33`) — the rank gate should route through the same choke point

---

## Phase 6 — The first eight minutes ✅ shipped

**Measurement warning, stated plainly.** This is the phase whose success is a
funnel question — did more players reach a first treasure, did they come back —
and Phase 0 was skipped, so none of it can be answered. Everything below is a
reasoned bet, not a validated change. If any phase should be followed by
instrumentation, it is this one.

| Decision | Why |
|---|---|
| The first treasure is **placed, not found** | Leaving it to chance is a ~2% proposition: a first bar buys ~20 digs against 24 treasures on 3,600 tiles. No top-grossing mobile game leaves the first win to chance — Clash Royale's tutorial cannot be lost, Candy Crush level one cannot be failed |
| Hunts became **ownable** (`hunts.owner_id`) rather than a tutorial *zone* | A separate zone needs its own map, replenishment and bots, and teaches the game somewhere the game is not. One nullable column and one predicate gets a reserved treasure sitting on the real board among real ones — and it is the mechanism a sponsored or personal hunt wants later |
| The tutorial pays **XP and energy, not cash** | Direct conflict with the review: §6 asks for "a real prize", §7a forbids real money before the gate. §7a is later and stronger, and a cash tutorial prize is fifty wallets and fifty prizes — exactly the hole Phase 5 closed. What the tutorial must deliver is the *fantasy* of finding and winning, which energy and XP deliver |
| The start cell is **searched for, not picked** | The script says "this one is a clue" and only 17% of the board is. Promising a guaranteed hint and then rolling for it repeats the exact mistake this phase exists to fix |
| Onboarding cut to **two cards**, cash unmentioned | All three old cards were lying by the end of Phase 5 — including "speed and skill", which Phase 4 deliberately removed. Cash is real but two days away for a new account, so selling it on card one means refusing it minutes later |
| The grid got **two zoom levels** | Deferred from Phase 2. At a tappable tile size the board is ~3,240px — nine screens by nine. Navigate in the overview, play in the dig view |

**Two bugs the end-to-end check caught**, both from owned hunts being excluded
from `liveHuntsIn`: Survey read `hot` when the placed treasure was one tile
away (it could not see the player's own hunt), and the tutorial's first clue
paid a hint about a treasure on the other side of the map. Both now include the
player's reserved hunts.

**Still not built:** the refill offer on the empty-energy screen. There is no
shop until Phase 7 — the surface is built and waiting for it.

---

### Original plan

Highest-impact phase for retention, lowest technical risk. Depends on Phases
1–4 for the mechanics it teaches to actually exist — **do not build the tutorial
before the game it tutors**, or it lies again.

- Onboarding to two cards, no crypto vocabulary (`OnboardingScreen.jsx`)
- Tutorial zone with a scripted treasure at tap 3 and a second by tap 15,
  calibrated bots, unloseable
- Empty-energy screen shows nearest-treasure distance and offers a refill —
  this is the Phase 0 `energy_empty` metric turned into a surface
- New players weighted away from the cheap tier (moot once Phase 2 deletes it)
- Viewport audit against a low-end Android, not the dev phone (open question #3)

---

## Phase 7 — Shop

Last, because it monetises mechanics that must exist first.

Cycle Pass, energy refills, Compass, hint slots, cosmetics, report cards.
`payments/x402.ts` and `payments/fees.ts` are the existing payment rails.

The §5f thesis — that the business is energy burned *manufacturing hints for
sale*, not the rake — implies the Compass and hint-slot items matter more than
the refill SKU. Instrument them separately from day one.

---

## Sequencing

```
Phase 0  Instrumentation          ── independent, NOT DONE (skipped)
Phase 1  Rotation + private fog   ✅ the money gate, part 1
Phase 2  Resize + retune          ✅ needs 1
Phase 3  Survey + real tiles      ✅ needs 1 (mystery), 2 (survey tuning)
Phase 4  The Crack                ✅ needs 3 (hints worth using)
Phase 5  Keys + rank + wallet     ✅ the money gate, part 2
Phase 6  First-run experience     ✅ needs 1–4 to be truthful
Phase 7  Shop                     ── needs 3 (Compass), 5 (keys boundary)
```

Phases 0 and 5 can run parallel to everything. Phase 1 blocks the most.

---

## What this plan does not answer

Carried forward from the briefing's §10 open list, unchanged and still unowned:

- **#1 — does one-tap payment convert?** The 10× uncertainty that decides whether
  break-even is 950 players or 9,500. Phase 0 + Phase 7 instrument it; nothing
  in this plan answers it
- **#7, #9 — legal.** Airtime/data prize treatment, and whether free energy is a
  sufficient AMOE. Lawyer, local to Kenya and Nigeria
- **#4 — Survey vagueness.** Deliberately left as a config band in Phase 3, to be
  set from real data

---

## Note

`docs/briefing.md` is still empty in the repo — the review text this plan was
built from was pasted into chat, not saved. Save it before this plan gets
read by anyone who wasn't in the meeting.
