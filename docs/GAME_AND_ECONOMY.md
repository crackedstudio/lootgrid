# LOOTGRID — Game Design & Economy (v3)

Status: **external design review. Nothing here is implemented.** Companion to
[`AGENTIC_ARCHITECTURE.md`](./AGENTIC_ARCHITECTURE.md) (which owns the trust model) and
[`IMPLEMENTATION_PLAN.md`](./IMPLEMENTATION_PLAN.md) (which owns build order). This document
owns **the game the player actually plays and the money that moves because of it.**

Where the two earlier documents assumed a loop and built infrastructure around it, this one
audits the loop itself. Every number below was computed against the shipped constants in
`server/src/`, and every file path is a real one.

Questions still open for the team are marked **❓ OPEN** inline and collected in §11.

---

## 0. Context this document was written against

| | |
| --- | --- |
| **Primary audience** | **MiniPay retail, Africa-first.** Low-end Android, cUSD balances, thin data, cash-motivated, not crypto-native |
| **Stage** | No external players. No metrics. Pre-launch by any honest definition |
| **Business goal** | Stated as "all of the above" — hackathon, indie income, VC-scale, prestige |
| **Hard constraint** | **No rewarded video.** MiniPay will not permit it |
| **Hard constraint** | **$0.05 minimum on any transaction** |

**On the goal.** Those four goals conflict and cannot be pursued simultaneously this
quarter. The sequence that works:

1. **The hackathon build is already won.** Agents, x402, ERC-8004, hash-chained transcripts,
   bonded hint listings — the story is complete and defensible today.
2. **Next cycle makes the human game good.** That is the only path to the other three goals,
   and it is where zero of the last ten phases went.
3. **The agent layer becomes the story, not the product.** Keep it, showcase it, do not ask a
   MiniPay retail user to configure an agent vault.

---

## 1. Verdict

**Rethink the game; keep the machine.**

The engineering is excellent — arguably better than the design it serves. The escrow,
attestation, commit-reveal deception audit, hint bonding and slashing, multi-tenant agent
pool and treasury agent are all real and all working. They sit on top of a loop that:

- **80% of new players never once experience** in their first session
- has a **modal reward of one cent**
- decorates **44% of its grid** with tile types that do nothing
- makes its signature deduction mechanic **statistically unreachable**
- and runs on a world that **one player permanently destroys in about 31 minutes**

Your own plan named the right gate — *"is hint-driven discovery actually fun?"* — then
shipped P2 through P10 past it without ever building the version that could answer it.

Nothing below throws away work. Almost all of it makes existing work load-bearing for the
first time.

---

## 2. The diagnosis, with the arithmetic

### 2.1 The world is a consumable that never regenerates

`zone.epoch` exists. `types.ts:55` documents `seedSecret` as *"published when the epoch
rotates."* Reveals are keyed on `(zone.id, zone.epoch)`. **Nothing in the codebase ever
rotates an epoch** — zones are seeded at `epoch: 1` in [`store.ts:106`](../server/src/store.ts:106)
and stay there forever.

```
216 cells ÷ (1⚡ per dig, 400⚡/hour regen)  ≈  31 minutes
```

One player, playing normally, permanently kills a zone in half an hour. Worse:
[`replenish`](../server/src/store.ts:221) only places hunts on **unrevealed** cells, so once
a zone is exhausted it spins its 200-iteration guard and creates zero hunts, forever. Four
zones means one person ends the entire game world in an afternoon.

**This is the single most urgent fix in this document, and the field for it is already in
your schema.**

### 2.2 The deduction game is statistically unreachable

[`hints/generate.ts:172`](../server/src/hints/generate.ts:172) drops a hint on 35% of
reveals. [`hints/index.ts:104`](../server/src/hints/index.ts:104) then picks *which of the 4
live hunts it concerns* at random.

```
effective rate for a hint about ONE specific hunt = 35% ÷ 4 = 8.75%
to hold 3 hints on one hunt                       ≈ 34 reveals
average hint reliability = .35(.90) + .40(.70) + .25(.50) = 0.72
```

Thirty-four reveals is ~3 full energy bars for a hunt with a 60% chance of paying $0.01,
which may be won or expire meanwhile. A realistic inventory is **one hint each about four
different hunts** — which narrows nothing. The P1 gate cannot be answered by this build.

### 2.3 80% of new players never see the core promise

```
hunt density = 4 hunts ÷ 216 cells = 1.85%
P(hunt within first energy bar of 12 taps) = 1 − 0.9815¹² = 20.1%
```

Onboarding card 3 promises *"first to crack it wins."* Four of five players spend their
entire first session never reaching a race.

### 2.4 The skill you build is not the skill that pays

Every ounce of design capital is in *inference* — hints, tiers, reliability, deduction, a
market for derived information. Victory is then decided by **mashing to 14 taps in 6
seconds**, settled in a 400ms window.

A player who deduced the location brilliantly and one who wandered onto the tile compete
identically, resolved by thumb speed. For Africa-first hardware the *perception* is worse
than the reality: **"I lost because my phone is slow"** is trust-fatal, and server-measured
elapsed time does not fix a feeling.

### 2.5 44% of the grid is decoration pretending to be a system

[`grid.ts:9`](../server/src/grid.ts:9) assigns `empty | clue | trap | mystery | puzzle` at
56/17/12/9/6. Grep the server: **none of them do anything.** A `trap` costs nothing. A
`clue` gives no clue. Onboarding promises *"Clues run warm when treasure is near"* — a
proximity mechanic that exists nowhere in the codebase.

### 2.6 Discovery is a public good funded privately

Fog is **shared**. A player spends ~54 taps locating a hunt; the moment it reveals,
[`referee.ts:339`](../server/src/referee.ts:339) broadcasts to the whole zone and someone who
spent nothing enters on identical terms. Rational play is to free-ride.

Worse for the economy: **a shared map is itself a free public hint.** Every revealed tile
tells everyone where a hunt *is not*. The more populated a zone, the more the map solves
itself for free — which is a direct tax on the value of every hint you hope to sell.

Shared fog gives you one aesthetic benefit (the "living map") and three structural bugs: this
one, §2.1's exhaustion, and the sybil economics in §8.1. **§4.5 resolves all three by making
fog private while keeping the zone shared.**

### 2.7 Energy is not a gate, and no meta exists

Cap 12, regen 9s → **full refill in 108 seconds.** That is a burst limiter, not a session
shape, and it means the "monetised sink" promised in `AGENTIC_ARCHITECTURE.md` §8 cannot
exist — nobody pays to skip 108 seconds. Nothing accrues across sessions. D7 has no
mechanism.

### 2.8 The revenue model does not reach the burn

```
rake  = 2.5%, waived ≤5¢ (market/fees.ts)
hint ceiling on a med hunt = 25% × 50¢ = 12¢
realistic trade 3–8¢  →  ~0.2¢ per trade
$100/day of rake  =  50,000 trades/day

prize burn today = 16 hunts × 56.6¢ EV = $9.06/day
break-even on burn alone = ~4,500 trades/day across 16 hunts
                          = 280 trades per hunt, on 6 hints per hunt
                          = each hint resold 47× while price decays 35%/copy
```

**The rake cannot reach the burn. Not at scale, not ever, at these constants.**

---

## 3. KPI baseline

Benchmarks are emerging-market casual mobile, not global averages — global numbers would
flatter you into a bad plan.

| Metric | Benchmark | Likely today | Gap driver |
| --- | --- | --- | --- |
| D1 | 35–42% | 12–18% | 80% never see a race in session 1 |
| D7 | 12–18% | 3–5% | No meta; hints expire with the hunt |
| D30 | 4–7% | <1% | Nothing accrues |
| Session length | 8–14 min | 3–5 min | 108s full refill = no session shape |
| Sessions/day | 3–5 | 1–2 | No appointment mechanic |
| ARPDAU | $0.008–0.02 | $0.000 | Sub-cent rake; fees flag-disabled |
| Conversion | 1.5–3% | ~0% | Nothing worth buying |
| LTV (90d) | $0.15–0.60 | **negative** | $0.566/hunt out, ~$0 in |

**❓ OPEN — instrumentation:** none of these are measurable today. `prom-client` is wired for
system metrics but there is no player funnel. Which of these do we instrument in the first
build? Recommendation: taps-to-first-hunt, hints-held-at-entry, energy-empty events, D1/D7 by
cohort, and conversion — nothing else until those five are trustworthy.

---

## 4. The game

### 4.1 The grid gets three verbs, not one

The grid currently has exactly one verb: tap fog. That is the poverty — not the minigame
count. Minesweeper gets three verbs out of two buttons and has held players for thirty years.

| Verb | Cost | Effect |
| --- | --- | --- |
| **Dig** | **2⚡** | Reveal one tile. Chance of a hint |
| **Survey** | **6⚡** | Returns **bucketed Chebyshev distance to the nearest live hunt** from that tile. Reveals no tiles |
| **Claim** | Free, 3 per cycle | Publicly mark a tile as your prediction. Correct claims pay a bonus |

**Survey is the keystone**, and it does four jobs at once — the reliable sign you have found
the right mechanic:

1. **It is the deduction engine.** Three surveys trilaterate a position. That is a real
   reasoning loop, not a slot pull.
2. **It absorbs energy without consuming map** — exactly what the sizing math in §4.5 needs.
3. **It makes your onboarding copy true.** *"Clues run warm when treasure is near"* currently
   describes a mechanic that exists nowhere in the codebase (§2.5). Survey **is** warmth.
4. **It is never a null result.** A hunt-count-in-an-area probe returns zero ~83% of the time
   at these densities; a bucketed distance is always informative.

Buckets should be coarse enough to require several probes — e.g. `0–2 / 3–5 / 6–10 / 11+`.
Note this is the human-facing sibling of the agent `deduction` module's probe budget, so both
halves of the game now share one conceptual core.

**Claim is free depth.** Public claims let players see where rivals believe treasure is,
which immediately creates misdirection as a strategy and produces the "living map of what
everyone thinks" the README promises and the build does not deliver. **With fog now private
(§4.5), Claims and hunt broadcasts become the entire social layer** — which is the right
place for it, since it shows intent rather than leaking information.

### 4.2 Tile types become real, or they go

Either make them mechanical or delete them. Recommended:

| Tile | 56/17/12/9/6 | New behaviour |
| --- | --- | --- |
| `empty` | 56% | As today |
| `clue` | 17% | Guaranteed positional hint (see §4.3) |
| `trap` | 12% | Costs 4⚡ instead of 2⚡, and yields a **false** hint |
| `mystery` | 9% | Reveals one adjacent tile free |
| `puzzle` | 6% | XP-only minigame hunt |

### 4.3 Hints become positional and compounding

Change [`hints/index.ts:104`](../server/src/hints/index.ts:104) so a reveal yields a hint
about the **nearest live hunt**, drawn from the unowned remainder of that hunt's 6-hint set.
Raise the drop rate to ~60% for a player's first 20 reveals in a grid.

**Fix it partially, not fully.** Keeping hints tied to the *nearest* hunt means a player who
wants intelligence about a hunt across the map must still walk there or **buy it** — which is
what creates the market in §6.4. Locality fixes solo play; distance preserves trade.

### 4.4 One cash resolution, telegraphed

**Cash hunts get exactly one resolution mechanic.** Poker resolves on best hand, chess on
checkmate — every deep competitive game has a single consistent resolution and all its
variety upstream. Rotating cash resolutions means rotating *who wins*, which reads as
arbitrary and prevents mastery.

> **The Crack** — 6 candidate tiles, **derived from the hunt's salt and identical for
> everyone**. Your hints eliminate candidates: three good hints might narrow 6 → 2; no hints
> is a 1-in-6 guess. Everyone gets the same fixed 15-second window. All picks lock; all
> reveal simultaneously. Correct pick wins.
> **Tiebreak: fewer hints used**, then earlier commit.

The candidate set being salt-derived and public is what keeps this a fair race — everyone
faces the identical challenge, exactly as `gameTypeForBlock` already guarantees today. **What
differs between players is only how well they have narrowed it**, which is precisely the
skill the loop builds and the thing hints are priced against. Information converts to win
probability, capped by `MAX_VALUE_SHARE`, and the tiebreak means the player who got there on
fewer hints beats the one who bought their way to the same read.

This does three things at once: the resolution is *made of the same currency as the loop*,
device speed and latency are removed from the outcome entirely, and the tiebreak prices
**skill above spend** — enforcing by mechanic what the architecture doc currently asserts by
sentence (*"hints govern discovery, the challenge governs victory"*).

**The four existing minigames are kept and demoted** to XP-only puzzle hunts. They season the
grid; they do not decide cash.

**Telegraph the hunt type before the key is spent.** Today the game is hidden until commit.
That was defensible at 3⚡; with keys capped and unpurchasable (§5.1) it is hostile. Show
type, difficulty and prize on the preview. Keep the *salt* hidden; reveal the *shape*.

**❓ OPEN:** do we eventually want a second telegraphed cash resolution (a speed lane for
players who prefer reflex and have the hardware)? Recommendation: not until The Crack is
proven. Do not add variety before the core is good.

### 4.5 Private fog on a shared zone

> **Decision taken:** zones stay **large and shared** — no instancing, no player caps.
> Everything below is what has to be true for that to work.

Under shared fog, grid size is a function of *population*, and the arithmetic is fatal:

```
cells consumed = players × (energy_per_player ÷ dig_cost)
```

At ~570⚡ per player over 3 days and 2⚡ per dig, **each player alone can strip 285 cells.**
Fifty players exhaust a 3,600-cell world in a day; five hundred exhaust it in under two
hours. There is no renderable grid size that survives an unbounded shared population — a
200-player zone would need ~73,000 cells and would still die the moment it got popular.

**So decouple the two: keep the zone shared, make the fog private.**

| Layer | Scope | Why |
| --- | --- | --- |
| **Hunt locations** | **Global** — one truth per zone epoch | Racing requires everyone to be chasing the same prize |
| **Fog / reveals** | **Per player** | Your map is yours. My digging never uncovers your board |
| **Claims** | **Public** | The social layer: what people *believe*, not what they *know* |
| **Hunt broadcasts** | **Public, on a delay** | See the head start below |

**This single change resolves four separate problems in this document:**

| Problem | How private fog fixes it |
| --- | --- |
| §2.1 exhaustion | Grid size no longer scales with population. A zone lives indefinitely |
| §2.6 free-riding | Discovery is private. You cannot ride on someone else's energy |
| §2.6 map-as-free-hint | The shared map stops solving itself and undercutting hint value |
| §8.1 sybils | **Each burner account must pay its own exploration cost.** Fifty accounts now cost fifty times the energy instead of sharing one map |

The discoverer's head start becomes structural rather than bolted on:

```
you find a hunt        → private. A 20-minute PREPARATION window opens, for you alone
+ HEAD_START (20 min)  → hunt broadcasts to the zone; the Crack window opens for EVERYONE
+ PUBLIC_TTL           → undiscovered hunts broadcast anyway, so none sit dead
```

**The head start buys preparation, not an exclusive attempt.** This distinction is
load-bearing. The Crack resolves in 15 seconds, so an exclusive-attempt head start of any
length would mean the discoverer almost always resolves the hunt solo and **multiplayer
racing quietly disappears from the game.** Instead, the 20 minutes are for narrowing: apply
hints, buy a Scout Report, work the candidate set. Then everyone cracks it together and the
discoverer arrives better prepared.

That is the *"exclusivity must be time-bounded — a head start, not a monopoly"* rule from
`AGENTIC_ARCHITECTURE.md` §5, applied to discovery instead of only to hints — and it is what
keeps the 20 minutes valuable without making it decisive.

**Storage:** do not store per-player reveals as rows — at 3,600 cells × 10,000 players that
is 36M rows per epoch. Store a **bitmap BLOB per (player, zone, epoch)**: 3,600 bits = 450
bytes. Ten thousand players is 4.5 MB. This is a non-issue if you pick the right
representation and a serious one if you do not.

### 4.6 Recommended configuration

| Parameter | Value |
| --- | --- |
| Grid | **60×60 = 3,600 cells** |
| Players per zone | **Unbounded** |
| Fog | **Per player** |
| Cycle | **3 days**, epoch rotates at cycle end |
| Dig 2⚡ · Survey 6⚡ · Trap 4⚡ · Entry 1 key | |
| Live hunts | **24** (0.67% density), of which 2–4/day are cash |
| Head start | **20 min preparation window**, then public and the Crack opens for all |

**Why a big grid is now the point rather than the spectacle.** A player has ~570⚡ per cycle.
Spent as ~45 Surveys (270⚡) plus ~150 Digs (300⚡), they personally uncover **4.2% of the
map.** Brute force is arithmetically hopeless on a 3,600-cell board at 0.67% hunt density —
**deduction stops being a flavour and becomes the only viable strategy.** That is exactly the
game you set out to build, and the large grid is what forces it.

The intended loop: **Survey broadly → trilaterate warm regions → Dig to pinpoint → Hints cut
the digs needed.** Hints now have an obvious, priceable job: they reduce digs-to-confirm.

### 4.7 What you give up, stated plainly

Large shared zones are the harder configuration and it is worth being honest about the cost:

| | Instanced (rejected) | Large shared (chosen) |
| --- | --- | --- |
| Sybil defence | Structural — accounts scatter and dominate nothing | **Must be actively defended** (§8.1) |
| Rivalry | You learn nine specific opponents | Anonymous crowd; rivalry must be manufactured via rank and leaderboards |
| Market liquidity | Twelve traders who know each other's reputation | Deep book, but reputation signal is thinner and wash-trading is easier |
| Engineering | Matchmaking, instance lifecycle | **Per-player fog storage, viewport rendering** |

Two mitigations are therefore non-optional rather than nice-to-have: **Prospector rank
(§4.9)** has to carry the rivalry that small lobbies would have given you for free, and the
**sybil stack in §8.1** has to be built and tested before real money touches a zone.

### 4.8 The event shape

| Phase | What happens |
| --- | --- |
| Days 1–2 | Exploration. Hints accumulate. XP hunts resolve. Scout Reports trade |
| Day 3 | **The Vault** — the cycle's headline hunt. Announced appointment time |
| Weekly | **The Vault Final** — top-ranked players by Prospector rank qualify for one large sponsor-funded pot |
| Cycle end | **Epoch rotates.** Fog clears for everyone, `seedSecret` published, new hunts seeded |

**The finale is load-bearing** and does four jobs: it is the appointment mechanic driving D7,
the drama worth talking about, the reason to accumulate hints all week, and — critically —
**the sybil defence**, because one human cannot play fifty accounts in a live 90-second
window.

### 4.9 The meta that is missing

Add **Prospector rank**, driven by **hint accuracy, not winnings**. Your published per-tier
reliability stats mean you can already score whether a player's applied hints panned out.
**Rank gates entry to cash hunts and to the weekly final.** With instancing declined, this is
not a cosmetic ladder — it is the primary sybil gate (§8.1) and the mechanism that has to
manufacture the rivalry a small lobby would have given you for free.

This makes the *deduction* skill visible and permanent, converting hour-1 novelty into
hour-100 status — and it surfaces the ERC-8004 reputation registry you already deployed and
which is currently invisible to the player.

---

## 5. The currency system

### 5.1 Two currencies. This is the keystone.

| | **Energy** ⚡ | **Keys** 🔑 |
| --- | --- | --- |
| **Buys** | Digging, surveying. Exploration and information | Entry into a cash hunt |
| **Purchasable** | **Yes — this is the product** | **Never.** Not with money, not with referrals |
| **Cap** | 40 · regen 1/6min (4h to full) | **5 per day, per verified wallet** |
| **Faucets** | Regen, daily free refill, referrals, IAP | Flat daily grant + rank milestones |
| **Sinks** | Dig 2⚡ · Survey 6⚡ · Trap 4⚡ | 1 per cash hunt entry |

**Why this is the keystone.** Money buys *information and tempo* — but every player alive
gets exactly five shots at the pot per day. A whale who spends $20 does not get more chances
to win your money; they get a better-informed five. This single boundary:

- **Kills pay-to-win.** Spending improves odds *per attempt*, never *number of attempts*
- **Kills the sybil economics** (§8.1)
- **Moves you decisively off the gambling line** (§8.3) — money never purchases a chance at a
  prize. That is the most important sentence you can hand a lawyer
- **Finally gives the hint market a supply side** (§6.4)

Keys will be **non-binding in normal play** — a player finding 3–5 hunts per cycle spends
well under the 5/day allowance. **That is correct.** A cap should be invisible to normal
players and hard for abusers.

With large shared zones the key cap carries more weight than it would have under instancing,
because it is now one of the few hard per-identity limits you have. Do not raise it casually.

### 5.2 Energy specification

| Parameter | Value | Reasoning |
| --- | --- | --- |
| Cap | **40** | ~20 digs = a 6–8 min session with something to show |
| Regen | **1 per 6 min** | Full from empty = **4 hours** |
| Free daily refill | **+40 on first login** | The appointment hook; also the free-entry path |
| Referral | **+80** per friend who completes a hunt | Replaces rewarded video (§7.2) |

**Never sell energy from an interstitial.** Surface the offer only on an empty bar *while the
player is mid-region on a grid they have been narrowing* — the highest-intent moment in the
session, and currently 108 seconds of dead air.

---

## 6. What is for sale

### 6.1 The rule that decides what you may sell

| Category | Sell it? | Why |
| --- | --- | --- |
| **Tempo** — energy, faster regen | ✅ Freely | Buys attempts at *finding*, not *winning* |
| **Capacity** — hint slots, inventory | ✅ Freely | Storage, not power |
| **Targeting** — which hunt your hints concern | ✅ Freely | Buys focus; still requires digging |
| **Cosmetics, status, analytics** | ✅ Freely | Zero fairness impact |
| **Information** — hints, Scout Reports | ⚠️ **Capped at 25% of prize** | Real edge, must stay bounded |
| **Keys, extra entries, retries, revives** | ❌ **Never** | Cross this and money buys chances at cash |

### 6.2 The catalog

All prices respect the **$0.05 floor**.

| Product | Price | What it does |
| --- | --- | --- |
| Energy refill (+40⚡) | $0.05 | The volume driver |
| Refill 5-pack | $0.20 | 20% off — teaches bundle behaviour |
| **Cycle Pass** (per 3-day cycle) | $0.50 | 2× regen + daily auto-refill. **The revenue backbone** |
| **Prospector's Compass** | $0.10 | Next 5 dug hints all concern **one hunt of your choice** |
| **Scout Report** (P2P) | 5¢–25¢ | The shadowing product (§6.4) |
| **House Scout Report** | 10¢–50¢ | House-listed hints from the committed set (§7.4) |
| Hint slots (+5 capacity) | $0.05 | Lets diggers stockpile inventory to sell |
| **Assay Report** (post-event) | $0.10 | How your hints performed vs. tier, accuracy percentile |
| Mascot skins / grid themes | $0.10–$0.50 | Pure cosmetic |
| Grid flair (winner's mark) | $0.25 | Status, permanent, publicly visible |

**Prospector's Compass is the sleeper.** It sells the scarce thing (targeting) while
*requiring* energy spend to realise the value — the only item that makes another item sell
more.

### 6.3 Why shadowing does not cannibalise energy

```
1 hint ≈ 2.86 digs  (HINT_DROP_PCT = 35)
40⚡ = $0.05        → $0.00125 per ⚡, 2⚡ per dig
∴ producing one hint ≈ $0.007
   buying one hint   = $0.05
```

Buying is ~7× the production cost, so why would anyone buy? Because they are not the same
product:

| | Digging | Buying |
| --- | --- | --- |
| Cost | ~0.7¢ | 5¢ |
| **Which hunt it concerns** | **Nearest** | **The one you chose** |
| When | Eventually | Now |

**Production is cheap and untargeted. Purchase is expensive and targeted.** That gap is the
entire market, and it is why both products sell without killing each other.

### 6.4 Scout Reports

A bundle of 2–4 hints about **one specific hunt**, listed by the player who dug them, bought
by someone about to enter. Every hard part already exists: referee attestation of
authenticity, `HintEscrow` commit-reveal, `HintBond` so the seller has money at risk,
slashing for adverse selection, ERC-8004 reputation. **That build finally becomes
load-bearing.**

Rules to add:

| Rule | Reason |
| --- | --- |
| **Sales close when the finale opens** | Otherwise the finale is a live auction for the answer and "fewer hints used" is meaningless |
| **Max 3 copies per hint per seller** | Matches `DECAY_PER_SALE = 0.35`; the 4th copy is worth less than the floor |
| **A bundle's hints must concern one hunt** | Bundling across hunts recreates the scatter buyers are paying to escape |
| **Seller's own entry is disclosed** | If I am selling directions to a hunt I am entering, you should see that |
| **Reputation is per-tier** | Reliability on tier 1 says nothing about tier 3 |

The strategic tension is the good part and costs nothing to build: **selling your intelligence
arms your competition.** A risk-averse player takes 25¢ now; a risk-tolerant one holds for a
$10 shot.

### 6.5 The $0.05 floor breaks three things in the repo

**(a) The rake goes to zero.** [`market/fees.ts`](../server/src/market/fees.ts) sets
`RAKE_WAIVER_CENTS = 5` — trades at or below 5¢ pay **no rake**. At a 5¢ floor, every
minimum-priced trade is rake-free by construction. **Drop the waiver to 1¢ or delete it**,
and keep it matched to `HintEscrow.rakeWaiverAmount` or the ledger never reconciles.

**(b) The tradeable band collapses on cheap hunts.** `MAX_VALUE_SHARE = 0.25` caps a hint at
a quarter of the prize. Floor 5¢ ÷ 0.25 → a hunt must pay **$0.20 minimum** for any legal
price to exist, and a market needs ceiling ≈ 3× floor to breathe → **prizes of $0.60+.**

| Tier | Prize | Hint ceiling | Tradeable? |
| --- | --- | --- | --- |
| Easy | $0.01 | 0.25¢ | **No — kill this tier** |
| Med | $0.25 | 6¢ | Usable, **not listable** |
| Hard | $2.00 | 50¢ | **Yes — the market lives here** |
| Jackpot | $10.00 | $2.50 | **Yes — the headline market** |

**(c) Price discovery dies at the floor.** At ~0.7¢ production cost and a 5¢ floor, sellers
race to the minimum and everything clears there. **Embrace it — ship fixed prices by tier:**

| Tier | Reliability | Price |
| --- | --- | --- |
| 1 (broad) | 90% | **5¢** |
| 2 | 70% | **12¢** |
| 3 (sharp) | 50% | **25¢** |

Sellers then compete on **reputation and freshness**, not price — a far better fit for a
360px screen and for the ERC-8004 stack. Keep free negotiation for **agent zones**, where
haggling *is* the game and the `negotiation` module finally has a job human UX need not carry.

---

## 7. The business

### 7.1 What losing rewarded video costs

| | With ads | Without |
| --- | --- | --- |
| Revenue/player/event | ~$0.06 | **~$0.03** |
| How non-payers monetise | Attention | **They don't. Directly, ever** |
| Free path to prizes | Time + attention | Time + referrals |

The legal side survives — a genuine free path via regen, daily refill and free keys is a
perfectly good AMOE. The economic side does not. **You now have exactly two revenue sources:
payers and sponsors.**

### 7.2 The compensating advantage, and the replacement free path

**MiniPay is the one place micro-pricing works.** The standard emerging-market IAP problem is
not willingness, it is rails — app-store billing needs a card, has a ~$0.99 practical floor,
and takes 30%. MiniPay users already hold cUSD, pay in one tap from balance, and gas is
payable in the stablecoin via `feeCurrency`. **You can charge five cents and keep five
cents.** Almost nobody in mobile can.

So the ladder is **micro and high-frequency** — not one $0.99 buyer in a hundred, but ten
5-cent buyers in a hundred. Display local currency alongside cUSD, anchored to a data bundle
or a bus fare, never to dollars. **No escalating prices** — a spender's third purchase costs
the same as their first, or it reads as punishment.

**Free players pay in distribution instead of attention:**

| Mechanic | Grant |
| --- | --- |
| Invite a friend who **completes their first hunt** | +80⚡ |
| Friend still active on day 3 | +40⚡ |
| Share a grid result to WhatsApp | +15⚡, capped 2/day |
| 5-day login streak | Escalating energy, resets on miss |

Gate the reward on the invitee **playing**, not installing — a burner account that must
actually play for its bounty is no longer free to farm. And keep referral rewards in **energy
only, never keys.**

### 7.3 Prize budget: small self-funded floor plus sponsored headline

> **Correction to an earlier draft of this document.** A previous version computed revenue
> *per player per event* and compared it against a *monthly* prize budget, producing a
> break-even of ~55,000 players. That conflated two time bases. The corrected figures are
> below and are roughly an order of magnitude lower.

Everything on one monthly basis, per **active player per month** (a player runs ~10 three-day
cycles a month):

| Scenario | Conversion | ARPPU/month | **ARPU/month** |
| --- | --- | --- | --- |
| Pessimistic | 1.5% | $2.00 | **$0.030** |
| **Base** | **3%** | **$3.50** | **$0.105** |
| Optimistic | 6% | $5.00 | **$0.300** |

Break-even MAU on a given monthly prize budget:

| Monthly prize budget | Pessimistic | **Base** | Optimistic |
| --- | --- | --- | --- |
| **$300** | 10,000 | **2,900** | 1,000 |
| $1,000 | 33,300 | 9,500 | 3,300 |
| $2,000 | 66,700 | 19,000 | 6,700 |

**A ~$300/month self-funded floor breaks even at roughly 3,000 MAU in the base case.** That is
a reachable number, and it is a materially more encouraging picture than the earlier draft
implied.

> **Decision taken:** **combined funding, $100–300/month self-funded.** A small floor keeps
> routine cash hunts alive; sponsors scale the headline.

Sized against the actual range, assuming a ~70% claim rate (unclaimed hunts refund through
the escrow's permissionless path, so **funded ≠ burned**):

| Monthly floor | Hard hunts/day @ $2 | Weekly Final (self-funded) | Actual burn | Break-even MAU (base) |
| --- | --- | --- | --- | --- |
| **$100** | 2 | $5 | ~$106 | **~950** |
| **$200** | 3 | $20 | ~$213 | **~1,900** |
| **$300** | 4 | $30 | ~$298 | **~2,900** |

**The Weekly Final is budget-elastic and that is the point.** Same mechanic, same appointment,
same qualification — $5 while self-funded, $300–1,000 the moment a sponsor signs. You never
have to rebuild it, and the habit is already formed when the money arrives.

| Line | Source | Purpose |
| --- | --- | --- |
| **Routine cash hunts** — 2–4/day at $2 (`hard`) | **Self-funded, $100–300/month** | Keeps the hint market alive. It needs $0.60+ prizes to exist at all (§6.5) |
| **Weekly Vault Final** | **Self-funded floor → sponsor-scaled** | The headline. The thing people talk about and share |
| Everything else (~20 of 24 live hunts) | XP-only | Texture at zero cost |

**Working capital is negligible.** Escrow funds upfront, so outstanding float is live cash
hunts × prize — at 4/day on a 3-day TTL that is 12 × $2 = **$24**, plus the weekly pot.

**Break-even lands between 950 and 2,900 monthly actives.** That is a genuinely reachable
first milestone and a much healthier position than a large budget would put you in — a small
floor is easier to defend if conversion comes in at the pessimistic end.

**Concentration is the lever.** One $300 weekly final is a far better headline than a hundred
$3 prizes for the same money — and the qualifier structure means routine play still matters.

**Why the split is the right shape:** the self-funded floor is small enough to survive being
wrong about conversion, and it is the part that must not depend on a sponsor being signed
this month — if the hint market goes dark every time a campaign lapses, the economy never
develops habits. The sponsored headline is the part that scales with someone else's budget
and does the acquisition work you cannot yet pay for.

**❓ OPEN — the single most important unknown:** does one-tap cUSD actually lift conversion
above app-store norms for this audience? The gap between pessimistic and optimistic is **10×**
— the difference between a business and a hobby, and the difference between 1,000 and 10,000
MAU to break even on the same budget. The first cycle should be cheaply funded and
instrumented to answer only this.

### 7.4 Where the money actually comes from, ranked

| # | Line | Realistic scale | Verdict |
| --- | --- | --- | --- |
| 3 | Rake on P2P trades | 0.125¢ per 5¢ trade → 8,000 trades for $10 | **Not revenue.** A market-health mechanism |
| 2 | **House-listed Scout Reports** | 10–50¢ at **100% margin** | Real money |
| 1 | **Energy consumed manufacturing hints for sale** | Every listed hint was dug with purchased energy | **The actual business** |

Line 1 is the thesis: **the hint market's real economic function is to give paying players a
reason to buy far more energy than they can personally use.** A player buying energy to
compete is capped by 5 keys. A player buying energy to *supply the market* has no ceiling.

**On line 2, one non-negotiable condition:** the house may only sell hints **from the
committed set**, truth flags fixed before anyone enters, revealed after resolution. That is
the §5.0 scheme, already built. Without it you are a house that funds the prize, controls the
information, sells the information, and may falsify it. With it, you are a dealer selling a
card from a published, verifiable deck.

### 7.5 The pot does not have to be cash

**Airtime and data bundles are frequently more desirable than equivalent cash** in these
markets, and bulk top-up aggregators sell below face value.

| Tier | Prize | Why |
| --- | --- | --- |
| Instance hunts | Data bundles / airtime | Cheap for you, high perceived value, instantly useful |
| **Weekly Vault Final** | **Cash in cUSD** | The headline must be real money |
| Runners-up (2nd–10th) | Airtime + Prospector rank | More winners per dollar |

**❓ OPEN:** verify the tax and gaming treatment of in-kind prizes per launch market — it
sometimes differs from cash, occasionally favourably.

### 7.6 Publish the payout ratio, prove it on chain

*"70% of everything spent on this grid goes into the pot"* — verifiable by anyone against
your escrow contract. This is the **highest-value use of infrastructure you have already
built**: three phases of escrow and attestation work become a trust claim no competitor in
this space can make.

Players will compute your effective take from your own onchain data. Pick a number you are
willing to defend and put it on the marketing.

---

## 8. Integrity

### 8.1 Sybils — the P0 that eats a funded grid

Free regen yields hundreds of digs per account per day. Fifty burner accounts is hundreds of
cash-hunt entries daily, extracting a pot funded for real players. Jitter analysis catches
*scripts*, not *humans with fifty wallets*.

**Instancing was the strongest available defence and has been declined** (§4.7), so the
remaining stack has to be built deliberately and in full. It is genuinely weaker, and the
correct posture — the same one `AGENTIC_ARCHITECTURE.md` §6 already takes on reputation
wash-trading — is **detect and slash rather than prevent.**

| Defence | Effect | Strength |
| --- | --- | --- |
| **Per-player fog** (§4.5) | **Primary structural wall.** Each account pays its own exploration cost; 50 accounts cost 50× the energy instead of sharing one solved map | High |
| **Prospector rank gate on cash hunts** | Rank is earned by *hint accuracy over time* and cannot be bought or rushed. A fresh burner cannot reach it | High |
| 5 keys/day per wallet, non-purchasable | Hard cap on extraction per identity | Medium |
| Wallet age + MiniPay activity gate on key grants | A fresh empty wallet is free to make; one with history is not | Medium |
| **Simultaneous finale** | One human cannot play 50 accounts in a live 90-second window | High, but only at the finale |
| Per-wallet win cap per cycle | Bounds worst case if the above are beaten | Backstop |
| Skill-resolved outcome (§4.4) | 50 accounts do not make anyone better at deduction | Structural |
| Anomaly detection on win-rate and entry patterns | Catches what the rules miss | Ongoing cost |

**The rank gate is doing the work instancing would have done.** Make it the primary gate on
cash participation, not a cosmetic ladder — this is the single most important consequence of
choosing large shared zones.

**Do not fund a zone with real money until per-player fog, the rank gate and the wallet gate
are all live and tested.**

### 8.2 The four rules that keep this from becoming pay-to-win

Every future monetisation idea will test these:

1. **Money never buys a key, an entry, or a retry.** Five shots per day, for everyone alive
2. **Information is capped at 25% of the prize** — buy every hint and you still must win
3. **The tiebreak rewards fewer hints used**, so spending actively costs you the close ones
4. **The finale is skill-resolved and sales are closed** — the last act cannot be bought

Under those four, someone who spends $20 gets a better-informed five attempts, sellable
inventory, and status. They do not get more chances at your money than the player who spent
nothing.

### 8.3 Legal

Selling energy that a player needs to compete for a cash prize is **an entry fee with extra
steps** — the thing `AGENTIC_ARCHITECTURE.md` §10 already flags for counsel. The two-currency
split is what moves you off it: **money buys information and exploration; it never buys a
chance at the prize.**

Reinforce with: a genuine free path to every prize, prizes not scaled to spend, published
deception rates, an onchain audit trail demonstrating skill-determined outcomes, and
jurisdictional gating at signup. **Get local counsel in the actual launch market** — Kenya and
Nigeria both have active gaming regulators with their own licensing regimes.

**❓ OPEN — platform risk:** confirm MiniPay's Mini App policy permits (a) consumable
purchases and (b) cash-prize contests. The ad restriction was discovered late; assume there
are others.

---

## 9. FTUE — the first eight minutes, prescribed

The current walkthrough on a Tecno Spark over 3G, with failures marked:

| t | Today | Severity |
| --- | --- | --- |
| 0:00 | [`App.jsx:31`](../src/App.jsx:31) hardcodes a **390×844 frame**; device is 360×800 | 🔴 Clips or letterboxes on the majority of target hardware |
| 0:25 | Onboarding: *"pre-funded and locked on-chain"* | 🔴 Jargon. MiniPay users use MiniPay as a money app |
| 0:40 | *"Clues run warm when treasure is near"* | 🔴 **Mechanic does not exist in the code** |
| 0:55 | Zone picker — 4 zones, no stated difference | 🟡 A choice with no information is not a choice |
| 1:12 | First tile reveals `trap`. **Nothing happens** | 🔴 First tap teaches: this game's words mean nothing |
| 1:15–2:30 | 9 more taps, ~3 hints about 3 different hunts, no hunt found (80% likely) | 🔴 **The drop-off point** |
| 2:30 | Energy empty. 108s. No prompt, no offer | 🔴 Highest-intent moment in the session, entirely unused |
| ~5:10 | If a win: **$0.01**, 60% likely | 🔴 Card 3 promised cash |

**Prescribed FTUE:**

1. Onboarding down to **2 cards**, plain language, no "on-chain", no promises the code cannot keep
2. **Scripted hunt on tap 3** — tutorial zone, calibrated bots, unlosable, pays a real `hard` prize
3. **Second guaranteed hunt by tap 15**; randomise only after two completed races
4. Hints positional from the first tap
5. Energy-empty screen offers a refill **and** shows how close the nearest hunt is
6. Weight a new player's first five hunts toward `hard` — never `easy`

Comparables: **Clash Royale**'s tutorial battle cannot be lost. **Candy Crush** level 1 cannot
be failed. Every top-grossing mobile game front-loads the fantasy in under 60 seconds.

---

## 10. Roadmap

**Sequencing, gates, file paths and verification live in
[`IMPLEMENTATION_PLAN_V3.md`](./IMPLEMENTATION_PLAN_V3.md).** Summary only here:

| Wave | Phases | Question it answers |
| --- | --- | --- |
| **A — The world works** | P0–P4 | Does the world survive players, render on target hardware, and is discovery fun? |
| **B — It retains and earns** | P5–P9 | Do players come back, and will they pay? |
| **C — The money is safe and scales** | P10–P14 | Can real money touch this, and can it grow? |

**Wave A carries the project's only real gate.** P3 asks *"is discovery fun?"* with Survey,
private fog and positional hints in place — the question `IMPLEMENTATION_PLAN.md` P1 was
supposed to answer and could not. If the answer is no, stop and redesign; nothing in Waves B
or C rescues it.

---

## 11. Open questions

### Settled since the first draft

| Question | Decision |
| --- | --- |
| Instanced or large shared zones? | **Large shared zones.** Consequences absorbed in §4.5 (private fog), §4.7 (what it costs) and §8.1 (the sybil stack that replaces instancing) |
| Prize funding? | **Combined, $100–300/month self-funded floor**, Weekly Final sponsor-scaled (§7.3) |
| MiniPay policy on consumables and cash prizes? | **Permitted.** P9 is unblocked |
| Head-start duration? | **20 minutes — as a preparation window, not an exclusive attempt** (§4.5). Any exclusive-attempt window would delete multiplayer racing given a 15-second Crack |
| Test surface? | **MiniPay on a real phone only.** No emulator, no throttle profile — see §11 Q3 |

### Still open

| # | Question | Blocks | Recommendation |
| --- | --- | --- | --- |
| 1 | Does one-tap cUSD lift conversion above app-store norms? | All revenue planning | Instrument the first cycle to answer only this. 10× spread; moves break-even between ~950 and ~9,500 MAU |
| 2 | Which five funnel metrics ship first? | §3 | taps-to-first-hunt, hints-at-entry, energy-empty, D1/D7, conversion. In P0 |
| 3 | **Is the dev phone representative of the median MiniPay device?** | P1's perf gate | Almost certainly not — dev phones skew high. Ship **in-app frame-time telemetry** and treat real-user p95 as the truth, not the dev device |
| 4 | Survey bucket granularity | §4.1 | Start at `0–2 / 3–5 / 6–10 / 11+`; tune from probe-count telemetry in P4 |
| 5 | Does a failed Crack reopen the hunt? | §4.4 | **Yes.** A wrong guess must not kill a funded prize — reopen and let it stand until claimed or expired |
| 6 | Second cash resolution (a speed lane)? | §4.4 | Not until The Crack is proven |
| 7 | In-kind prizes (airtime/data) — tax and gaming treatment per market? | §7.5 | Ask counsel alongside §8.3 |
| 8 | Do humans and agents share one hint market? | Carried from `AGENTIC_ARCHITECTURE.md` §10 | Yes — it is what makes the two halves one game |
| 9 | Free-entry sufficiency: does energy alone admit a player to a rewarded hunt? | §8.3 | Carried over, still open, still a legal question |

---

## 12. Constants changelog

Everything that changes, in one table, for whoever implements it.

| Constant | File | Today | Proposed |
| --- | --- | --- | --- |
| `GRID.cols × rows` | `config.ts` | 12 × 18 = 216 | **60 × 60 = 3,600** |
| `ENERGY.max` | `config.ts` | 12 | **40** |
| `ENERGY.regenMs` | `config.ts` | 9,000 | **360,000** (6 min) |
| `ENERGY.costFog` | `config.ts` | 1 | **2** (Dig) |
| — Survey (bucketed distance to nearest hunt) | new | — | **6** |
| — Trap | new | — | **4** |
| Prospector rank gate on cash hunts | new | — | **required** — replaces instancing as sybil defence |
| `ENERGY.costCashHunt` | `config.ts` | 3 | **0 — replaced by 1 key** |
| Keys/day | new | — | **5**, non-purchasable |
| `HUNTS_PER_ZONE` | `config.ts` | 4 | **24** (cash share per §7.3) |
| Players per zone | — | unbounded | **unbounded — unchanged** |
| **Fog scope** | zone repo | **shared** | **per player** (bitmap BLOB per player/zone/epoch) |
| Hunt visibility | `referee.ts` | immediate broadcast | **private → 20 min prep window → public; Crack opens for all at broadcast** |
| Epoch rotation | — | **never** | **every cycle (3 days)** |
| `HINT_DROP_PCT` | `hints/generate.ts:172` | 35 | **60 for first 20 reveals**, positional |
| Hint target selection | `hints/index.ts:104` | random hunt | **nearest live hunt** |
| `PRIZE_CENTS.easy` | `prizes.ts` | 1 | **removed** |
| `PRIZE_CENTS.med` | `prizes.ts` | 50 | **25** (usable, not listable) |
| `PRIZE_CENTS.hard` | `prizes.ts` | 500 | **200** |
| — jackpot | new | — | **1,000** |
| `DIFFICULTY_WEIGHTS` | `prizes.ts` | 60/32/8 | **70 med / 25 hard / 5 jackpot** |
| `RAKE_WAIVER_CENTS` | `market/fees.ts` | 5 | **1 or removed** — must match `HintEscrow` |
| `MIN_TRADE_CENTS` | `market/fees.ts` | 1 | **5** |
| Hint pricing | `market/pricing.ts` | suggested, negotiable | **fixed by tier**: 5¢ / 12¢ / 25¢ (humans) |
| `RACE.settlementWindowMs` | `config.ts` | 400 | superseded by The Crack's 15s locked window |
| Game type disclosure | `http.ts` | hidden until commit | **telegraphed on preview** |
| Fixed frame | [`src/App.jsx:31`](../src/App.jsx:31) | 390 × 844 | **fluid + viewport** |

---

## 13. The two highest-leverage changes

**Gameplay — make fog private and rotate the epoch.** Having chosen large shared zones, these
two together are what let the world survive its own players. Private fog alone resolves
exhaustion, free-riding, the shared-map-as-free-hint problem, and the worst of the sybil
economics — four problems, one change. Epoch rotation is the backstop that makes a zone
evergreen. Everything else in Wave A is downstream of a world that does not die.

Close behind, and inseparable from it: **Survey plus positional hints.** Every system you
have already built — the market, the bond, the slashing, the reputation, ten phases of work —
is currently pricing a commodity that cannot be used for its stated purpose. These are what
make it usable.

**Monetisation — sell the headline to a sponsor, sell energy to the player.** The self-funded
floor keeps the hint market alive and breaks even near 3,000 MAU; the sponsored weekly final
buys the headline you cannot yet afford. Underneath both, the real P&L line is neither the
prize nor the rake but **energy consumed manufacturing hints for sale** (§7.4) — which is
also the line that scales without limit, because a player supplying the market has no key
cap.

It is the rare case where the honest version and the profitable version are the same version.
Right now you are building the other one.
