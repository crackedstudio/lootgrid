# LOOTGRID v3 — Implementation Plan

Status: **plan.** Companion to [`GAME_AND_ECONOMY.md`](./GAME_AND_ECONOMY.md), which owns the
*why*. This document owns the *order*, the file paths and the gates. It supersedes
[`IMPLEMENTATION_PLAN.md`](./IMPLEMENTATION_PLAN.md) (v2) for player-facing work; v2's P0–P10
infrastructure stays built and is repointed rather than rebuilt.

Fifteen phases in three waves. Each ships something usable, answers one question, and can be
stopped at without stranding the phases before it.

**Two decisions this plan is built on** (see `GAME_AND_ECONOMY.md` §11):

- **Large shared zones.** No instancing, no player caps. Private fog carries the load instead.
- **Combined prize funding.** ~$300/month self-funded floor, sponsor-funded weekly headline.

---

## The shape of the work

```
WAVE A — the world works
  P0  epoch rotation + funnel metrics   ← the world must survive players at all
   │
  P1  client: responsive + viewport     ← nothing at 60×60 is playable without this
   │
  P2  private fog + 60×60 grid          ← THE structural change
   │
  P3  positional hints
   │
  P4  Survey · Claim · real tile types   ← 🚩 THE GATE: is discovery fun?
   │
WAVE B — it retains and earns
  P5  FTUE                              ← 🚩 GATE: does D1 move?
   │
  P6  energy retune + Keys
   │
  P7  The Crack (cash resolution)
   │
  P8  prizes, cycles, head start
   │
  P9  purchasables + Cycle Pass         ← 🚩 GATE: does conversion clear 3%?
   │
WAVE C — the money is safe and scales
  P10 Prospector rank
   │
  P11 sybil hardening                   ← 🚩 GATE: before real money, without exception
   │
  P12 market: pricing, rake, Scout Reports
   │
  P13 sponsor path
   │
  P14 weekly Vault Final
```

**Do not reorder P2 before P1** (a 3,600-cell board cannot be rendered by the current client),
**P4 before P2** (Survey is meaningless on a shared map that solves itself), or **P11 after
any phase that touches real money.** Everything else has slack.

| Track | Can run in parallel with |
| --- | --- |
| Client work (P1) | P0 server work |
| Contracts (P12, P13) | The server phase before them |
| Legal review (§8.3) | All of Wave A |
| Sponsor conversations | P5 onward — you need a demo, not a finished game |

---

# WAVE A — the world works

## Phase 0 — Epoch rotation and funnel metrics

**Question:** none. This is the bug fix that everything else needs.

`zone.epoch` exists, `seedSecret` is documented as published on rotation, and nothing rotates
it. One player exhausts a zone in ~31 minutes and `replenish` can then never place another
hunt (`GAME_AND_ECONOMY.md` §2.1).

| Work | Path |
| --- | --- |
| `rotateEpoch(zoneId)` — bump epoch, publish old `seedSecret`, reseed hunts | `server/src/store.ts` |
| Scheduled rotation on cycle boundary | `server/src/timerWheel.ts` |
| Manual rotation endpoint (ops) | `server/src/http.ts` |
| Expose revealed seeds for finished epochs | `server/src/http.ts` (`/audit/zones/:id` already has the shape) |
| **Funnel metrics** — the five that matter | `server/src/metrics.ts` |

The five metrics, and nothing else until these are trustworthy:

```
lootgrid_taps_to_first_hunt          histogram
lootgrid_hints_held_at_entry         histogram
lootgrid_energy_empty_total          counter
lootgrid_retention_cohort            gauge, by D1/D7 cohort
lootgrid_conversion_total            counter, by product
```

**Done when:** a zone rotates on schedule, the previous epoch's `seedSecret` is publicly
fetchable and recomputes the old map, and the five gauges are live on the dashboard.

**Watch:** rotation must not orphan live hunts, in-flight attempts or unexpired hints. Decide
explicitly whether a hunt in `resolving` blocks rotation (it should) and test it.

---

## Phase 1 — Client: responsive layout and viewport rendering

**Question:** does it run on the target hardware?

[`src/App.jsx:31`](../src/App.jsx:31) hardcodes a 390×844 frame. Target devices are commonly
360×800. This is a launch blocker independently of anything else, and 3,600 tiles as
inline-styled divs will not render on a Tecno-class device.

| Work | Path |
| --- | --- |
| Delete the fixed frame; fluid layout | `src/App.jsx` |
| **Viewport renderer** — ~15×15 window, pan/zoom, minimap | `src/components/GridScreen.jsx` |
| Tile rendering to canvas or virtualised list | `src/components/GridScreen.jsx` |
| Viewport-scoped tile fetch | `src/api/entry.js`, `src/hooks/useGameState.js` |
| **In-app performance telemetry** | `src/lib/perf.js` (new) → `server/src/metrics.ts` |
| HTTPS dev tunnel (MiniPay refuses plain HTTP) | tooling / `README.md` |

**The rendered tile count stays constant (~225) regardless of world size.** World size becomes
a data question, not a rendering one, and scales to 200×200 later without a second rewrite.

### Verification, given a phone-only test surface

The only test surface is **MiniPay on a real phone** — no emulator, no DevTools throttling, no
attachable profiler. That changes how this phase is verified: **you cannot read performance,
so the app has to report it.**

```
lootgrid_client_frame_ms        histogram, p50/p95, tagged by screen
lootgrid_client_long_task_ms    histogram — anything blocking >50ms
lootgrid_client_viewport_fps    gauge, sampled during pan
```

Collect via `requestAnimationFrame` deltas and `PerformanceObserver`, batch, and post to the
metrics endpoint. This is the only way P1's gate becomes a number rather than an impression.

**Watch — the dev phone is not the target device.** A developer's handset is almost always
faster than the median Tecno or Infinix a MiniPay user is on, so "it feels smooth here" is not
evidence. Budget conservatively — **target a comfortable 60fps on the dev device** so the
margin absorbs weaker hardware — and treat real-user p95 frame time as the truth once players
exist.

**Done when:** the app fills a 360×640 viewport with no horizontal scroll, a 60×60 grid pans
and zooms with p95 frame time under 16ms on the dev phone inside MiniPay, and frame telemetry
is landing on the dashboard.

**Watch:** this is the largest single client change in the plan. It must land **before** the
responsive polish, not after, or the layout gets done twice.

---

## Phase 2 — Private fog on a shared zone

**Question:** does the world survive its own players?

The structural change (`GAME_AND_ECONOMY.md` §4.5). Hunt locations stay global; fog becomes
per player.

| Work | Path |
| --- | --- |
| Migration: per-player reveal bitmap | `server/src/db/migrations/<next>_private_fog.sql` |
| **Bitmap BLOB per (player, zone, epoch)** — 3,600 bits = 450 bytes | `server/src/db/repos/zones.ts` |
| `revealsFor` / `getReveal` / `addReveal` become player-scoped | `server/src/store.ts` |
| Reveal broadcast scoped to the acting player | `server/src/referee.ts`, `server/src/ws.ts` |
| Grid to 60×60, 24 live hunts | `server/src/config.ts` |
| Hunt discovery: private → head start → public | `server/src/referee.ts` |

**Do not store per-player reveals as rows.** At 3,600 cells × 10,000 players that is 36M rows
per epoch. A bitmap is 4.5 MB for the same population.

**Done when:** player A revealing a cell does not reveal it for player B; a discovered hunt is
private for `HEAD_START_MS` then broadcasts to the zone; and a 60×60 zone with 24 hunts seeds,
rotates and replenishes correctly.

**Watch:** [`grid.ts:9`](../server/src/grid.ts:9) `tileType` is a pure function of
`(seedSecret, epoch, r, c)` and stays global — only *who has seen it* becomes private. Keep
that separation clean or the map secrecy tests in `security.test.ts` will start lying.

---

## Phase 3 — Positional, compounding hints

**Question:** can a player accumulate information about one hunt?

Today [`hints/index.ts:104`](../server/src/hints/index.ts:104) picks which of N live hunts a
hint concerns at random, so hints scatter and never triangulate (§2.2).

| Work | Path |
| --- | --- |
| Hint drop targets the **nearest live hunt** | `server/src/hints/index.ts` |
| Draw from the unowned remainder of that hunt's set | `server/src/hints/index.ts` |
| Drop rate to ~60% for a player's first 20 reveals in a zone | `server/src/hints/generate.ts` |
| Hint inventory grouped by hunt | `src/components/HuntsScreen.jsx` |

**Fix it partially, not fully.** Tying hints to the *nearest* hunt fixes solo deduction while
leaving distant hunts as something you must travel to or **buy** — which is what creates the
market in P12. Do not make hints follow the player's intent.

**Done when:** a player digging in one region accumulates 3+ hints about the same hunt within
~10 reveals, and the same zone salt still reproduces an identical hint set (P2 of v2's
commitment scheme must keep verifying).

**Watch:** `hints/commit.ts` commits to the hint *set*, not to who receives what. Confirm the
commitment still verifies after this change — `verify-cli.ts` is the test.

---

## Phase 4 — Survey, Claim, and real tile types

**Question: is discovery actually fun?** 🚩

This is the gate v2's P1 was meant to be and could not be. Everything downstream assumes the
answer is yes.

| Work | Path |
| --- | --- |
| `survey` module — bucketed Chebyshev distance to nearest live hunt | `server/src/grid.ts`, `server/src/http.ts` |
| `claim` — public marker, 3 per cycle, bonus on correct | `server/src/http.ts`, migration |
| Tile types become mechanical (`clue` / `trap` / `mystery`) | `server/src/grid.ts`, `server/src/http.ts` |
| Verb costs: Dig 2⚡ · Survey 6⚡ · Trap 4⚡ | `server/src/config.ts` |
| Three-verb UI + warmth visualisation | `src/components/GridScreen.jsx` |
| Rewrite onboarding copy so it describes what exists | `src/data/gameData.js` |

Survey buckets start at `0–2 / 3–5 / 6–10 / 11+` and are tuned from probe-count telemetry.
This is the human-facing sibling of the agent `deduction` module — keep the two conceptually
aligned.

> ### 🚩 Gate
> Playtest with people who did not build it. **If trilateration is not satisfying with
> perfect information flow, zero friction and no money involved, stop and redesign.** No
> market, prize, agent or sponsor downstream rescues a discovery loop that is not fun.
>
> Signals: median taps-to-first-hunt under 20 · players using Survey unprompted by session 2 ·
> players able to explain their reasoning afterwards.

---

# WAVE B — it retains and earns

## Phase 5 — FTUE

**Question: does D1 move?** 🚩

80% of new players currently never reach a race in session 1 (§2.3).

| Work | Path |
| --- | --- |
| Tutorial zone with a **guaranteed hunt on tap 3** | `server/src/store.ts` |
| Second guaranteed hunt by tap 15; randomise after two races | `server/src/store.ts` |
| Calibrated bots for the tutorial race | `server/src/testing/harness.ts` (extend) |
| Onboarding to 2 cards, plain language, no "on-chain" | `src/components/OnboardingScreen.jsx`, `src/data/gameData.js` |
| Zone picker shows live hunt count and prize band | `src/components/ZoneScreen.jsx` |
| Energy-empty screen: offer + distance to nearest hunt | `src/components/GridScreen.jsx` |

**Done when:** a new player reaches a resolved hunt within 90 seconds of first launch, and the
first five hunts they see are weighted toward `hard` rather than the cheap tier.

> ### 🚩 Gate
> D1 above 30%. Below that, the loop is not holding people and Wave B monetisation will
> measure nothing but noise.

---

## Phase 6 — Energy retune and Keys

**Question:** can a session have a shape, and can entry be capped per identity?

| Work | Path |
| --- | --- |
| Energy: cap 40, regen 1/6min, daily free refill | `server/src/config.ts`, `server/src/energy.ts` |
| **Keys**: 5/day per wallet, non-purchasable | `server/src/db/migrations/<next>_keys.sql`, new `server/src/keys.ts` |
| Cash hunt entry costs 1 key, 0⚡ | `server/src/referee.ts` |
| Referral grants (energy only, **never keys**) | `server/src/http.ts` |
| Key + energy display | `src/components/GridScreen.jsx`, `src/components/NavBar.jsx` |

**Done when:** energy refills in 4 hours, a key allowance resets daily per wallet, and no code
path anywhere can grant a key for money or for a referral. Assert that in a test.

**Watch:** keys are the hard per-identity cap that instancing would otherwise have provided
(§8.1). Every future feature will be tempted to grant "just a few extra." The invariant is
that keys come from exactly two faucets: the daily grant and rank milestones.

---

## Phase 7 — The Crack

**Question:** does the resolution reward the skill the loop builds?

| Work | Path |
| --- | --- |
| `crack` module — 6 salt-derived candidates, 15s locked window, simultaneous reveal | `server/src/games/crack.ts` |
| Hint application eliminates candidates | `server/src/games/crack.ts`, `server/src/hints/index.ts` |
| Tiebreak: fewer hints used, then earlier commit | `server/src/games/crack.ts` |
| **Failed Crack reopens the hunt** | `server/src/referee.ts` |
| Register as the cash resolution; demote tap/math/sequence/memory to XP | `server/src/games/index.ts` |
| **Telegraph type, difficulty and prize before commit** | `server/src/http.ts`, `src/components/HuntPreview.jsx` |
| Simultaneous-reveal UI | `src/components/Minigame.jsx` |

The `GameModule` interface (`generate` / `publicSpec` / `init` / `step` / `progress`) is
unchanged — this is a new module, not a new contract.

**The candidate set is derived from the hunt's salt and identical for everyone**, exactly as
`gameTypeForBlock` and `difficultyForBlock` already are. What differs per player is only how
many candidates their hints have eliminated. A candidate set that varied per player would mean
the house choosing who gets the easy hunt.

**A failed Crack must reopen the hunt.** A wrong guess cannot be allowed to kill a funded
prize — the hunt stands until claimed or expired, and the escrow's permissionless refund
handles the expiry case.

**Done when:** all racers get an identical candidate set, picks are unreadable until the window
closes, hints demonstrably narrow it, and outcome is independent of network latency and device
speed. Test the last one explicitly with simulated RTT.

**Watch:** the 400ms `RACE.settlementWindowMs` becomes irrelevant for cash hunts. Do not delete
it — the XP minigames still use it.

---

## Phase 8 — Prizes, cycles and the head start

**Question:** does the economy have a rhythm?

| Work | Path |
| --- | --- |
| Kill `easy`; band → med $0.25 / hard $2.00 / jackpot $10.00 | `server/src/prizes.ts` |
| **2–4 cash hunts/day** at `hard`, remainder XP-only | `server/src/prizes.ts`, `server/src/store.ts` |
| Budget guard: refuse to seed a cash hunt past the daily allowance | `server/src/treasury/pricing.ts` |
| 3-day cycle boundary drives epoch rotation | `server/src/timerWheel.ts` |
| `HEAD_START_MS = 20 * 60 * 1000` — **preparation window** | `server/src/config.ts` |
| Crack window opens for all at broadcast, not at discovery | `server/src/referee.ts` |
| Cycle countdown + Vault appointment UI | `src/components/HomeScreen.jsx` |

Budget is **$100–300/month self-funded**. At ~70% claim rate that is 2–4 hard hunts/day plus a
$5–30 Weekly Final; break-even lands between ~950 and ~2,900 MAU (`GAME_AND_ECONOMY.md` §7.3).
**Make the daily cash allowance a config value with a hard guard** — an unbounded seeder is
how a $200 budget becomes a $2,000 one overnight.

**The head start is a preparation window, not an exclusive attempt.** The discoverer learns
about the hunt 20 minutes early and uses it to apply hints and buy Scout Reports; the Crack
opens for everyone simultaneously at broadcast. Implemented as an exclusive attempt instead,
a 20-minute window against a 15-second Crack would mean nearly every hunt resolves solo and
multiplayer racing disappears.

**Done when:** cash hunts are capped at the configured daily allowance, a discoverer gets 20
minutes of private preparation and no more, and a cycle visibly opens and closes.

**Watch:** the hint market needs prizes of $0.60+ to have any legal price at all (§6.5). If the
budget tightens, cut *frequency*, never *value* — a $0.50 hunt has no market and a day with no
cash hunt at all is better than a day of unsellable ones.

---

## Phase 9 — Purchasables

**Question: will they pay, and at what rate?** 🚩

✅ **Unblocked** — MiniPay's Mini App policy permits consumable purchases and cash-prize
contests.

| Work | Path |
| --- | --- |
| Product catalog, $0.05 floor, no escalating prices | `server/src/payments/catalog.ts` (new) |
| x402 purchase flow for consumables | `server/src/payments/x402.ts` (extend) |
| Energy refills, 5-pack, **Cycle Pass**, Compass, hint slots, Assay, cosmetics | as above |
| Empty-bar offer at the sunk-cost moment | `src/components/GridScreen.jsx` |
| Local-currency display alongside cUSD | `src/components/*` |

**Never surface an offer as an interstitial.** The empty-bar screen fires only when the player
is mid-region on a grid they have been narrowing.

> ### 🚩 Gate
> **Conversion is the number the entire business rests on.** Base case is 3%; the spread
> between pessimistic and optimistic is 10× and moves break-even from 10,000 MAU to 1,000
> (§7.3). Instrument this cycle to answer only this question. Do not scale spend until it is
> measured.

---

# WAVE C — the money is safe and scales

## Phase 10 — Prospector rank

**Question:** does the deduction skill become visible and permanent?

Rank is the meta, *and* it is the sybil gate that replaces instancing. It has to exist before
P11 can use it.

| Work | Path |
| --- | --- |
| Rank from **hint accuracy over time**, not winnings | `server/src/hints/stats.ts` (extend) |
| Migration: `player_rank` | `server/src/db/migrations/<next>_rank.sql` |
| Surface ERC-8004 reputation as the visible rank | `server/src/agents/reputation.ts` |
| Rank display, leaderboard from real results | `src/components/BoardScreen.jsx`, `src/components/YouScreen.jsx` |

**Done when:** `BOARD_DATA` and `PROFILE_FINDS` are gone and both screens derive from real
results — a known issue in the README since v1.

**Watch:** rank must be earnable only through play over time. Anything that lets a fresh wallet
reach a cash-eligible rank quickly voids P11.

---

## Phase 11 — Sybil hardening

**Question: can real money safely touch this?** 🚩

Instancing was declined, so this stack is doing that work and must be built in full (§8.1).

| Work | Path |
| --- | --- |
| **Rank gate on cash hunt entry** | `server/src/referee.ts` |
| Wallet age + MiniPay activity gate on key grants | `server/src/keys.ts`, `server/src/auth/verify.ts` |
| Per-wallet win cap per cycle | `server/src/referee.ts` |
| Anomaly detection: win-rate and entry-pattern outliers | `server/src/metrics.ts`, new `server/src/security/anomaly.ts` |
| Shadow-ban path for detected farms | `server/src/store.ts` (`shadowBanned` already exists) |

**Posture: detect and slash, not prevent.** The same stance `AGENTIC_ARCHITECTURE.md` §6
already takes on reputation wash-trading.

> ### 🚩 Gate
> **No real money in any zone until per-player fog (P2), the rank gate and the wallet gate are
> live and tested.** Model a 50-account farm against the shipped constants and show the
> extraction is bounded. This gate has no exceptions and no partial pass.

---

## Phase 12 — Market: pricing, rake, Scout Reports

**Question:** does an information market form on top of a loop that works?

| Work | Path |
| --- | --- |
| **`RAKE_WAIVER_CENTS` → 1 or removed** | [`server/src/market/fees.ts`](../server/src/market/fees.ts) |
| `MIN_TRADE_CENTS` → 5 | `server/src/market/fees.ts` |
| Match `HintEscrow.rakeWaiverAmount` on chain | `contracts/src/HintEscrow.sol` |
| Fixed tier pricing for humans: 5¢ / 12¢ / 25¢ | `server/src/market/pricing.ts` |
| Scout Report bundles (one hunt, max 3 copies, sales close at finale) | `server/src/market/*.ts` |
| Seller-entry disclosure; per-tier reputation | `src/components/MarketScreen.jsx` |
| **House-listed Scout Reports** from the committed set only | `server/src/market/house.ts` (new) |

At a 5¢ floor the existing 5¢ waiver makes every minimum trade rake-free by construction —
fix that first or the market generates nothing.

**Done when:** the ledger reconciles between `fees.ts` and `HintEscrow`, and a house listing
can be traced back to a committed, later-revealed hint set.

**Watch:** the house selling hints it issued, for a prize it funded, is only defensible because
of the §5.0 commitment scheme. **House listings must be impossible outside the committed
set** — enforce it in code, not in review.

---

## Phase 13 — Sponsor path

**Question:** will someone pay for a branded zone?

| Work | Path |
| --- | --- |
| `Sponsor` model: zone branding, campaign window, funded pot | `server/src/db/migrations/<next>_sponsors.sql` |
| Campaign config + funding into escrow | `server/src/chain/escrow.ts` |
| **Reach reporting** — uniques, sessions, hunts entered, completion | `server/src/metrics.ts` |
| Branded zone theming | `src/components/ZoneScreen.jsx`, `src/index.css` |
| Publish the payout ratio, verifiable against escrow | `src/components/HomeScreen.jsx` |

**Done when:** a sponsor can fund a pot, see verified reach, and a player can independently
check the published payout ratio against on-chain escrow.

---

## Phase 14 — The weekly Vault Final

**Question:** does an appointment event carry retention?

| Work | Path |
| --- | --- |
| Qualification by Prospector rank | `server/src/keys.ts`, `server/src/referee.ts` |
| Scheduled simultaneous finale | `server/src/timerWheel.ts` |
| Sponsor-funded pot at $300–1,000 | `server/src/chain/escrow.ts` |
| Countdown, qualification status, live finale UI | `src/components/HomeScreen.jsx`, `src/components/Minigame.jsx` |

The finale is also the last line of sybil defence — one human cannot play fifty accounts in a
live 90-second window. Keep it simultaneous and keep hint sales closed for its duration.

---

## Verification gates

Every phase, before merge:

```bash
cd contracts && forge test && forge fmt --check
cd server   && npm run typecheck && npm test
cd .        && npm run lint && npm run build
```

Phase-specific additions:

| Phase | Extra |
| --- | --- |
| P0 | A rotated epoch's published seed recomputes the previous map exactly |
| P1 | 60×60 pans at p95 frame time <16ms **inside MiniPay on the dev phone**, with frame telemetry live |
| P2 | Player A's reveal is provably invisible to player B; `security.test.ts` still passes |
| P3 | `verify-cli.ts` still reproduces the hint commitment |
| P4 | Playtest with external players — the gate, not a checkbox |
| P6 | No code path grants a key for money or referral |
| P7 | Outcome independent of simulated RTT and device speed |
| P9 | Conversion measured, not estimated |
| P11 | 50-account farm modelled against shipped constants; extraction bounded |
| P12 | `fees.ts` and `HintEscrow` reconcile; house listings restricted to the committed set |

---

## Risk register

| Risk | Phase | Mitigation |
| --- | --- | --- |
| **Discovery is not fun** | P4 | The gate exists for this. Hold it — v2 did not |
| Viewport rendering is slower than budgeted on low-end Android | P1 | Prototype in MiniPay on a real device before committing to 60×60 |
| **Dev phone is faster than the median MiniPay device** | P1 | Frame telemetry from real sessions is the truth. Budget for 60fps on the dev phone so the margin absorbs weaker hardware |
| **Cash-hunt seeder overruns the $100–300 budget** | P8 | Hard daily allowance guard in config, not a comment. Alert on burn vs. budget |
| Head start implemented as an exclusive attempt | P8 | Would delete multiplayer racing. Assert in a test that the Crack window opens at broadcast, not at discovery |
| Per-player fog storage grows faster than modelled | P2 | Bitmap BLOB, not rows. Measure at 10k synthetic players |
| Hints still fail to triangulate after P3 | P3, P4 | P4's gate catches it; be willing to raise drop rate further |
| D1 does not move after FTUE work | P5 | Gate. If the loop is not holding people, monetisation measures noise |
| MiniPay prohibits consumables | P9 | Confirm before building the catalog. The ad restriction was found late |
| Conversion lands at the pessimistic end | P9 | Break-even moves to 10,000 MAU. Cut the self-funded floor, lean harder on sponsors |
| **Sybil farms extract the pot** | P11 | Gate with no exceptions. Instancing was declined; this stack carries it alone |
| Rank is farmable | P10, P11 | Rank from accuracy over time, never from volume. Model the farm |
| Hint market goes dark when prizes drop below $0.60 | P8, P12 | Cut cash-hunt frequency, never value |
| No sponsor signs | P13 | Self-funded floor must stand alone. That is why it exists |
| Legal review blocks cash prizes in a launch market | all | Local counsel starts during Wave A; jurisdictional gating at signup |

---

## Before you start

1. ~~Confirm MiniPay's Mini App policy on consumables and cash prizes.~~ **Done — permitted.**
2. **Stand up an HTTPS dev tunnel.** MiniPay refuses plain HTTP, and MiniPay-on-a-phone is the
   only test surface, so every phase from P1 onward needs this before it can be tested at all.
   This is the first thing to do.
3. **Start local legal review now.** It gates P8 and P13 but takes longer than Wave A.
4. **Accept that verification is telemetry, not tooling.** With no emulator and no attachable
   profiler, anything you cannot measure from inside the app is something you are guessing at.
   That is why the frame-time beacon is in P1 and the five funnel metrics are in P0 rather
   than deferred to "later".
